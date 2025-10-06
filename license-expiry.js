'use strict';
exports['license-expiry'] = function (parent) {
  const fs = require('fs'), path = require('path');
  const CFG = { timezone: 'Europe/Moscow', runAt: '00:00' };
  const DATA_FILE = path.join((parent && parent.datapath) || process.cwd(), 'license-expiry.json');

  function log(){ try { parent.debug.apply(parent, ['license-expiry:'].concat(Array.prototype.slice.call(arguments))); } catch (e) {} }
  function loadDB(){ try { return JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); } catch(e){ return {}; } }
  function saveDB(db){ try { fs.writeFileSync(DATA_FILE, JSON.stringify(db,null,2)); } catch(e){ log('saveDB',e); } }

  function isSrvAdmin(req){
    try{
      const s=req.session||{};
      const u=req.user||req.sessionUser||s.user||{name:s.userid,domain:s.domain,fulladmin:s.fulladmin,serveradmin:s.serveradmin,siteadmin:s.siteadmin};
      if (!u) return false;
      if (u.fulladmin===true || u.serveradmin===true) return true;
      if (u.siteadmin===true) return true;
      if (typeof u.siteadmin==='number' && (u.siteadmin>>>0)===0xFFFFFFFF) return true;
      if (typeof u.siteadmin==='object' && (u.siteadmin.serveradmin===true || (u.siteadmin.rights>>>0)===0xFFFFFFFF)) return true;
      return false;
    } catch(e){ return false; }
  }

  function listUsers(){
    try{
      const um=parent && parent.userManager, out=[];
      if (um && um.users) for (const k in um.users){
        const u=um.users[k];
        out.push({ userid:u.name||u.userid||u._id, domain:u.domain||'', locked:!!u.locked||!!(u.siteadmin&&u.siteadmin.locked) });
      }
      return out;
    } catch(e){ log('listUsers',e); return []; }
  }
  async function setLocked(user, flag){
    try{
      if (parent.userManager && typeof parent.userManager.SetUserLocked==='function'){
        parent.userManager.SetUserLocked(user, !!flag);
        try { if (parent.webserver && parent.webserver.disconnectUserSessions) parent.webserver.disconnectUserSessions(user); } catch(e){}
        return true;
      }
    } catch(e){ log('SetUserLocked',e); }
    try{
      const u=Object.assign({}, user, {locked:!!flag}); if (u.siteadmin) u.siteadmin.locked=!!flag;
      if (parent.db && typeof parent.db.SetUser==='function'){
        if (parent.db.SetUser.length>=2) await new Promise((res,rej)=>parent.db.SetUser(u,(err)=>err?rej(err):res()));
        else parent.db.SetUser(u);
        try { if (parent.webserver && parent.webserver.disconnectUserSessions) parent.webserver.disconnectUserSessions(user); } catch(e){}
        return true;
      }
    } catch(e){ log('DB fallback',e); }
    return false;
  }

  async function sweep(){
    try{
      const db=loadDB(), now=Date.now();
      for (const u of listUsers()){
        const k=`${u.domain}/${u.userid}`, until=db[k], exp=until?Date.parse(until):NaN;
        if (isFinite(exp) && exp<=now && !u.locked){ await setLocked(u,true); log('locked',k,'expired',until); }
      }
    } catch(e){ log('sweep',e); }
  }
  function msUntil(tz,hhmm){
    try{
      const [H,M]=hhmm.split(':').map(Number);
      const fmt=new Intl.DateTimeFormat('en-GB',{timeZone:tz,hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
      const p=Object.fromEntries(fmt.formatToParts(new Date()).map(x=>[x.type,x.value]));
      const h=parseInt(p.hour,10), m=parseInt(p.minute,10), s=parseInt(p.second,10);
      const now=h*3600+m*60+s, tgt=H*3600+M*60;
      const d=(tgt>now)?(tgt-now):(86400-(now-tgt));
      return d*1000;
    } catch(e){ return 60000; }
  }
  function schedule(){
    const delay=msUntil(CFG.timezone, CFG.runAt);
    log('next sweep in', Math.round(delay/1000),'sec');
    setTimeout(async()=>{ try{ await sweep(); }catch(e){ log('sweepTimer',e); } schedule(); }, delay);
  }

  function ensureBody(req,cb){ let b=''; req.on('data',d=>b+=d); req.on('end',()=>{ try{ cb(JSON.parse(b||'{}')); }catch(e){ cb({}); } }); }
  function adminHtml(){ return `<!doctype html><meta charset="utf-8"><title>License Expiry</title>
<style>body{font-family:system-ui,Arial;margin:24px;color:#111;background:#fff}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:6px 8px}th{background:#f3f3f3}</style>
<h2>Лицензии пользователей</h2>
<p>Ежедневная проверка в ${CFG.runAt} по ${CFG.timezone}. Клик по дате — редактирование (ISO 8601).</p>
<div id=app>Загрузка…</div>
<script>
async function rq(p,o){const r=await fetch(p,Object.assign({headers:{'content-type':'application/json'}},o||{}));return r.json();}
async function load(){const d=await rq('api/status');const rows=d.users.map(u=>{const k=u.domain+'/'+u.userid,until=d.map[k]||'';return '<tr><td>'+u.domain+'</td><td>'+u.userid+'</td><td>'+(u.locked?'🔒':'')+'</td><td contenteditable onblur="saveDate(\\''+k+'\\',this.innerText)">'+until+'</td><td><button onclick="ex(\\''+k+'\\',30)">+30д</button> <button onclick="ex(\\''+k+'\\',365)">+1г</button> <button onclick="lk(\\''+k+'\\',1)">Lock</button> <button onclick="lk(\\''+k+'\\',0)">Unlock</button></td></tr>'}).join('');document.getElementById('app').innerHTML='<p><button onclick="run()">Запустить проверку сейчас</button></p><table><thead><tr><th>Домен</th><th>UserID</th><th>Locked</th><th>Действует до</th><th>Действия</th></tr></thead><tbody>'+rows+'</tbody></table>';}
async function saveDate(k,v){await rq('api/set',{method:'POST',body:JSON.stringify({key:k,until:v})});}
async function ex(k,days){await rq('api/extend',{method:'POST',body:JSON.stringify({key:k,days})});load();}
async function lk(k,f){await rq('api/lock',{method:'POST',body:JSON.stringify({key:k,flag:!!f})});load();}
async function run(){await rq('api/run',{method:'POST',body:'{}'});load();}
load();</script>`;}

  function prefixes(){
    const arr=['/']; try{ const d=(parent && parent.config && parent.config.domains)||{}; for (const k of Object.keys(d)){ if (k) arr.push('/'+k+'/'); } } catch(e){}
    return Array.from(new Set(arr));
  }

  const plugin = {};
  plugin.hook_setupHttpHandlers = function(){
    const app = parent && parent.webserver && parent.webserver.app; if (!app) return;
    for (const pref of prefixes()){
      const base=pref+'plugins/license-expiry/';
      app.get(base+'health', (req,res)=>res.end('OK'));
      app.get(base+'whoami', (req,res)=>{ const s=req.session||{}, u=req.user||req.sessionUser||s.user||{}; res.json({ user:u.name||u.userid||s.userid||null, domain:u.domain||s.domain||null, fulladmin:!!(u.fulladmin??s.fulladmin), serveradmin:!!(u.serveradmin??s.serveradmin), siteadmin:(u.siteadmin??s.siteadmin)??null }); });
      app.get(base, (req,res)=>{ if(!isSrvAdmin(req)) return res.status(401).send('Unauthorized'); res.set('Content-Type','text/html; charset=utf-8'); res.end(adminHtml()); });
      app.get(base+'api/status', (req,res)=>{ if(!isSrvAdmin(req)) return res.status(401).json({err:'Unauthorized'}); res.json({ users:listUsers(), map:loadDB() }); });
      app.post(base+'api/set', (req,res)=> ensureBody(req,b=>{ if(!isSrvAdmin(req)) return res.status(401).json({err:'Unauthorized'}); const db=loadDB(); db[b.key]=b.until; saveDB(db); res.json({ok:1}); }));
      app.post(base+'api/extend', (req,res)=> ensureBody(req,b=>{ if(!isSrvAdmin(req)) return res.status(401).json({err:'Unauthorized'}); const db=loadDB(); const cur=Date.parse(db[b.key]||new Date().toISOString()); const d=isFinite(cur)?new Date(cur):new Date(); d.setDate(d.getDate()+(parseInt(b.days,10)||0)); db[b.key]=d.toISOString(); saveDB(db); res.json({ok:1,until:db[b.key]}); }));
      app.post(base+'api/lock', async (req,res)=> ensureBody(req, async b=>{ if(!isSrvAdmin(req)) return res.status(401).json({err:'Unauthorized'}); const [domain,userid]=(b.key||' / ').split('/'); const u=listUsers().find(x=>x.userid===userid && x.domain===domain); if(!u) return res.json({ok:0,err:'user-not-found'}); await setLocked(u,!!b.flag); res.json({ok:1}); }));
      app.post(base+'api/run', async (req,res)=>{ if(!isSrvAdmin(req)) return res.status(401).json({err:'Unauthorized'}); await sweep(); res.json({ok:1}); });
    }
  };

  plugin.server_startup = function(){ try{ sweep().catch(function(){}); schedule(); log('startup ok'); } catch(e){ log('startup',e); } };
  return plugin;
};
