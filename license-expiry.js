// meshcentral-license-expiry / license_expiry.js
// Ежесуточный автолок по дате + простая админка.
// Хранение сроков: meshcentral-data/license-expiry.json   { "domain/userid": "ISO8601" }

module.exports = function(parent) {
  const fs = require('fs');
  const path = require('path');
  const plugin = {};
  const DATA_FILE = path.join(parent.datapath, 'license-expiry.json');

  const CFG = { timezone: 'Europe/Moscow', runAt: '00:00' };
  const base = '/plugins/license-expiry/';

  function loadDB() { try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return {}; } }
  function saveDB(db) { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); }

  function listUsers() {
    const um = parent.userManager; const out = [];
    if (um && um.users) for (const k in um.users) {
      const u = um.users[k];
      out.push({ userid: u.name || u.userid || u._id, domain: u.domain || '', locked: !!u.locked || !!(u.siteadmin && u.siteadmin.locked) });
    }
    return out;
  }

  async function setLocked(user, flag) {
    try {
      if (parent.userManager && typeof parent.userManager.SetUserLocked === 'function') {
        parent.userManager.SetUserLocked(user, flag); return true;
      }
    } catch(e){ parent.debug('license-expiry:SetUserLocked fail', e); }
    try {
      const u = Object.assign({}, user);
      u.locked = !!flag; if (u.siteadmin) u.siteadmin.locked = !!flag;
      if (parent.db && typeof parent.db.SetUser === 'function') {
        if (parent.db.SetUser.length >= 2) { await new Promise((res,rej)=>parent.db.SetUser(u,(err)=>err?rej(err):res(true))); }
        else { parent.db.SetUser(u); }
        try { if (parent.webserver && parent.webserver.disconnectUserSessions) parent.webserver.disconnectUserSessions(user); } catch {}
        return true;
      }
    } catch(e){ parent.debug('license-expiry:SetUser DB fallback fail', e); }
    return false;
  }

  async function sweep() {
    const db = loadDB(), now = Date.now(), users = listUsers();
    for (const u of users) {
      const key = `${u.domain}/${u.userid}`, until = db[key], exp = until ? Date.parse(until) : NaN;
      if (isFinite(exp) && exp <= now && !u.locked) { await setLocked(u, true); parent.debug(`license-expiry: locked ${key} (expired ${until})`); }
    }
  }

  function msUntilTzTime(tz, hhmm) {
    const [TH, TM] = hhmm.split(':').map(Number);
    const fmt = new Intl.DateTimeFormat('en-GB',{ timeZone: tz, hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit' });
    const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p=>[p.type,p.value]));
    const h=+parts.hour, m=+parts.minute, s=+parts.second;
    const nowSec=h*3600+m*60+s, targetSec=TH*3600+TM*60;
    const diffSec = targetSec>nowSec ? (targetSec-nowSec) : (86400-(nowSec-targetSec));
    return diffSec*1000;
  }
  function scheduleNextRun() {
    const delay = msUntilTzTime(CFG.timezone, CFG.runAt);
    const nextAt = new Date(Date.now()+delay);
    parent.debug(`license-expiry: next sweep at ${nextAt.toString()} (${CFG.timezone} ${CFG.runAt})`);
    setTimeout(async()=>{ try{ await sweep(); }catch{} scheduleNextRun(); }, delay);
  }

  function ensureBody(req, cb){ let b=''; req.on('data',d=>b+=d); req.on('end',()=>{ try{ cb(JSON.parse(b||'{}')); }catch{ cb({}); } }); }
  function adminHtml(){
    return `<!doctype html><html><head><meta charset="utf-8"/><title>License Expiry</title>
<style>body{font-family:system-ui,Segoe UI,Arial;margin:24px}table{border-collapse:collapse;width:100%}
th,td{border:1px solid #ccc;padding:6px 8px}th{background:#f3f3f3;text-align:left}button,input{padding:6px}</style></head><body>
<h2>Лицензии пользователей</h2>
<p>Ежедневная проверка в ${CFG.runAt} по ${CFG.timezone}. Кликните по дате, чтобы изменить (ISO 8601, напр. 2026-01-31T23:59:59+03:00).</p>
<div id="app"></div>
<script>
async function rq(p,o){const r=await fetch(p,Object.assign({headers:{'content-type':'application/json'}},o||{}));return r.json();}
async function load(){
  const data=await rq('api/status'); const rows=data.users.map(u=>{
    const k=u.domain+'/'+u.userid, until=data.map[k]||'';
    return '<tr>'+
      '<td>'+u.domain+'</td><td>'+u.userid+'</td><td>'+(u.locked?'🔒':'')+'</td>'+
      '<td contenteditable onblur="saveDate(\\''+k+'\\',this.innerText)">'+until+'</td>'+
      '<td><button onclick="extend(\\''+k+'\\',30)">+30д</button> <button onclick="extend(\\''+k+'\\',365)">+1г</button> '+
      '<button onclick="lockNow(\\''+k+'\\')">Lock</button> <button onclick="unlock(\\''+k+'\\')">Unlock</button></td></tr>';
  }).join('');
  document.getElementById('app').innerHTML = '<p><button onclick="runNow()">Запустить проверку сейчас</button></p>'+
    '<table><thead><tr><th>Домен</th><th>UserID</th><th>Locked</th><th>Действует до</th><th>Действия</th></tr></thead><tbody>'+rows+'</tbody></table>';
}
async function saveDate(k,v){await rq('api/set',{method:'POST',body:JSON.stringify({key:k,until:v})});}
async function extend(k,days){await rq('api/extend',{method:'POST',body:JSON.stringify({key:k,days})});load();}
async function lockNow(k){await rq('api/lock',{method:'POST',body:JSON.stringify({key:k,flag:true})});load();}
async function unlock(k){await rq('api/lock',{method:'POST',body:JSON.stringify({key:k,flag:false})});load();}
async function runNow(){await rq('api/run',{method:'POST',body:'{}'});load();}
load();
</script></body></html>`;
  }

  // простая проверка: пускаем только серверных админов
  function isServerAdmin(req){
    try {
      const u = req.user || req.sessionUser || (req.session && req.session.user);
      return !!(u && (u.serveradmin || (u.siteadmin && u.siteadmin.serveradmin)));
    } catch { return false; }
  }

  plugin.hook_setupHttpHandlers = function() {
    const app = parent.webserver.app;
    app.get(base, (req,res)=>{ if(!isServerAdmin(req)) return res.status(401).send('Unauthorized'); res.set('Content-Type','text/html; charset=utf-8'); res.end(adminHtml()); });
    app.get(base + 'api/status', (req,res)=>{ if(!isServerAdmin(req)) return res.status(401).json({err:'Unauthorized'}); res.json({ users: listUsers(), map: loadDB() }); });
    app.post(base + 'api/set', (req,res)=> ensureBody(req, body => { if(!isServerAdmin(req)) return res.status(401).json({err:'Unauthorized'}); const db=loadDB(); db[body.key]=body.until; saveDB(db); res.json({ok:1}); }));
    app.post(base + 'api/extend', (req,res)=> ensureBody(req, body => { if(!isServerAdmin(req)) return res.status(401).json({err:'Unauthorized'}); const db=loadDB(); const cur=Date.parse(db[body.key]||new Date().toISOString()); const baseD=isFinite(cur)?new Date(cur):new Date(); baseD.setDate(baseD.getDate()+(parseInt(body.days,10)||0)); db[body.key]=baseD.toISOString(); saveDB(db); res.json({ok:1,until:db[body.key]}); }));
    app.post(base + 'api/lock', async (req,res)=> ensureBody(req, async body => { if(!isServerAdmin(req)) return res.status(401).json({err:'Unauthorized'}); const [domain,userid]=(body.key||' / ').split('/'); const u=listUsers().find(x=>x.userid===userid && x.domain===domain); if(!u) return res.json({ok:0,err:'user-not-found'}); await setLocked(u, !!body.flag); res.json({ok:1}); }));
    app.post(base + 'api/run', async (req,res)=>{ if(!isServerAdmin(req)) return res.status(401).json({err:'Unauthorized'}); await sweep(); res.json({ok:1}); });
  };

  plugin.server_startup = function() { sweep().catch(()=>{}); scheduleNextRun(); };
  return plugin;
};
