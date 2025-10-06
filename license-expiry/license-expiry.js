// meshcentral-data/plugins/license-expiry/license-expiry.js
// Автолок пользователей по дате: ежедневно в 00:00 Europe/Moscow.
// Простая админка: /plugins/license-expiry/  (только для серверных/фулл-админов)
//
// Даты храним в: meshcentral-data/license-expiry.json
// Формат: { "domain/userid": "ISO8601", ... }  пример: " /ivan": "2026-01-31T23:59:59+03:00"

'use strict';

module.exports = function(parent) {
  const fs   = require('fs');
  const path = require('path');

  const plugin = {};
  const BASE = '/plugins/license-expiry/';
  const CFG  = { timezone: 'Europe/Moscow', runAt: '00:00' };
  const DATA_FILE = path.join((parent && parent.datapath) || process.cwd(), 'license-expiry.json');

  // ---------- утилиты ----------
  function log(){ try { parent.debug.apply(parent, ['license-expiry:'].concat([].slice.call(arguments))); } catch {} }

  function loadDB() {
    try {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch { return {}; }
  }
  function saveDB(db) {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); }
    catch (e) { log('saveDB error', e); }
  }

  // Пускаем: Full Administrator / Server admin / любые siteadmin с полными правами
  function isSrvAdmin(req) {
    try {
      const u = req.user || req.sessionUser || (req.session && req.session.user);
      if (!u) return false;

      if (u.fulladmin === true) return true;                       // MeshCentral 1.1.x "Full Administrator"
      if (u.serveradmin === true) return true;                     // некоторые сборки помечают так
      if (u.siteadmin === true) return true;                       // bool
      if (typeof u.siteadmin === 'number' && u.siteadmin > 0) return true;     // маска прав
      if (typeof u.siteadmin === 'object' && (u.siteadmin.serveradmin || u.siteadmin.rights === 0xFFFFFFFF)) return true;

      return false;
    } catch { return false; }
  }

  // ---------- пользователи ----------
  function listUsers() {
    try {
      const um = parent && parent.userManager;
      const out = [];
      if (um && um.users) {
        for (const k in um.users) {
          const u = um.users[k];
          out.push({
            userid:  u.name || u.userid || u._id,
            domain:  u.domain || '',
            locked:  !!u.locked || !!(u.siteadmin && u.siteadmin.locked)
          });
        }
      }
      return out;
    } catch (e) {
      log('listUsers error', e);
      return [];
    }
  }

  // ---------- Lock/Unlock ----------
  async function setLocked(user, flag) {
    try {
      if (parent.userManager && typeof parent.userManager.SetUserLocked === 'function') {
        parent.userManager.SetUserLocked(user, !!flag);
        try { parent.webserver && parent.webserver.disconnectUserSessions && parent.webserver.disconnectUserSessions(user); } catch {}
        return true;
      }
    } catch (e) { log('SetUserLocked fail', e); }

    // Фолбэк через БД — на случай отсутствия SetUserLocked
    try {
      const u = Object.assign({}, user);
      u.locked = !!flag;
      if (u.siteadmin) u.siteadmin.locked = !!flag;
      if (parent.db && typeof parent.db.SetUser === 'function') {
        if (parent.db.SetUser.length >= 2) {
          await new Promise((res, rej) => parent.db.SetUser(u, (err) => err ? rej(err) : res(true)));
        } else {
          parent.db.SetUser(u);
        }
        try { parent.webserver && parent.webserver.disconnectUserSessions && parent.webserver.disconnectUserSessions(user); } catch {}
        return true;
      }
    } catch (e) { log('DB fallback fail', e); }

    return false;
  }

  // ---------- ежедневная проверка ----------
  async function sweep() {
    try {
      const db = loadDB();
      const now = Date.now();
      const users = listUsers();

      for (const u of users) {
        const key   = `${u.domain}/${u.userid}`;
        const until = db[key];
        const exp   = until ? Date.parse(until) : NaN;

        if (isFinite(exp) && exp <= now && !u.locked) {
          await setLocked(u, true);
          log(`locked ${key} (expired ${until})`);
        }
      }
    } catch (e) {
      log('sweep error', e);
    }
  }

  // точное «до полуночи по Москве»
  function msUntilTzTime(tz, hhmm) {
    try {
      const [TH, TM] = hhmm.split(':').map(Number);
      const fmt = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
      const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
      const h = +parts.hour, m = +parts.minute, s = +parts.second;
      const nowSec = h*3600 + m*60 + s;
      const targetSec = TH*3600 + TM*60;
      const diffSec = targetSec > nowSec ? (targetSec - nowSec) : (86400 - (nowSec - targetSec));
      return diffSec * 1000;
    } catch {
      return 60 * 1000; // запасная минута
    }
  }
  function scheduleNextRun() {
    try {
      const delay = msUntilTzTime(CFG.timezone, CFG.runAt);
      const nextAt = new Date(Date.now() + delay);
      log(`next sweep at ${nextAt.toString()} (tz ${CFG.timezone} ${CFG.runAt})`);
      setTimeout(async () => {
        try { await sweep(); } catch (e) { log('sweep(timer) error', e); }
        scheduleNextRun(); // планируем следующие сутки
      }, delay);
    } catch (e) { log('schedule error', e); }
  }

  // ---------- HTTP: админка ----------
  function ensureBody(req, cb) {
    try {
      let b = '';
      req.on('data', d => b += d);
      req.on('end', () => { try { cb(JSON.parse(b || '{}')); } catch { cb({}); } });
    } catch { cb({}); }
  }

  function adminHtml() {
    return `<!doctype html><html><head><meta charset="utf-8"/>
<title>License Expiry</title>
<style>
body{font-family:system-ui,Segoe UI,Arial;margin:24px}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid #ccc;padding:6px 8px}
th{background:#f3f3f3;text-align:left}
button,input{padding:6px}
</style></head><body>
<h2>Лицензии пользователей</h2>
<p>Ежедневная проверка в ${CFG.runAt} по ${CFG.timezone}. Клик по дате — редактирование (ISO 8601, напр. 2026-01-31T23:59:59+03:00).</p>
<div id="app"></div>
<script>
async function rq(p,o){const r=await fetch(p,Object.assign({headers:{'content-type':'application/json'}},o||{}));return r.json();}
async function load(){
  const data=await rq('api/status');
  const rows=data.users.map(u=>{
    const k=u.domain+'/'+u.userid, until=data.map[k]||'';
    return '<tr>'+
      '<td>'+u.domain+'</td>'+
      '<td>'+u.userid+'</td>'+
      '<td>'+(u.locked?'🔒':'')+'</td>'+
      '<td contenteditable onblur="saveDate(\\''+k+'\\',this.innerText)">'+until+'</td>'+
      '<td>'+
        '<button onclick="extend(\\''+k+'\\',30)">+30д</button> '+
        '<button onclick="extend(\\''+k+'\\',365)">+1г</button> '+
        '<button onclick="lockNow(\\''+k+'\\')">Lock</button> '+
        '<button onclick="unlock(\\''+k+'\\')">Unlock</button>'+
      '</td>'+
    '</tr>';
  }).join('');
  document.getElementById('app').innerHTML =
    '<p><button onclick="runNow()">Запустить проверку сейчас</button></p>'+
    '<table><thead><tr><th>Домен</th><th>UserID</th><th>Locked</th><th>Действует до</th><th>Действия</th></tr></thead>'+
    '<tbody>'+rows+'</tbody></table>';
}
async function saveDate(k,v){await rq('api/set',{method:'POST',body:JSON.stringify({key:k,until:v})});}
async function extend(k,days){await rq('api/extend',{method:'POST',body:JSON.stringify({key:k,days})});load();}
async function lockNow(k){await rq('api/lock',{method:'POST',body:JSON.stringify({key:k,flag:true})});load();}
async function unlock(k){await rq('api/lock',{method:'POST',body:JSON.stringify({key:k,flag:false})});load();}
async function runNow(){await rq('api/run',{method:'POST',body:'{}'});load();}
load();
</script></body></html>`;
  }

  plugin.hook_setupHttpHandlers = function() {
    try {
      const app = parent && parent.webserver && parent.webserver.app;
      if (!app) return;

      // Страница админки
      app.get(BASE, (req, res) => {
        if (!isSrvAdmin(req)) return res.status(401).send('Unauthorized');
        res.set('Content-Type', 'text/html; charset=utf-8');
        res.end(adminHtml());
      });

      // API
      app.get(BASE + 'api/status', (req, res) => {
        if (!isSrvAdmin(req)) return res.status(401).json({ err: 'Unauthorized' });
        res.json({ users: listUsers(), map: loadDB() });
      });

      app.post(BASE + 'api/set', (req, res) => ensureBody(req, body => {
        if (!isSrvAdmin(req)) return res.status(401).json({ err: 'Unauthorized' });
        const db = loadDB(); db[body.key] = body.until; saveDB(db); res.json({ ok: 1 });
      }));

      app.post(BASE + 'api/extend', (req, res) => ensureBody(req, body => {
        if (!isSrvAdmin(req)) return res.status(401).json({ err: 'Unauthorized' });
        const db = loadDB();
        const cur = Date.parse(db[body.key] || new Date().toISOString());
        const d = isFinite(cur) ? new Date(cur) : new Date();
        d.setDate(d.getDate() + (parseInt(body.days, 10) || 0));
        db[body.key] = d.toISOString(); saveDB(db);
        res.json({ ok: 1, until: db[body.key] });
      }));

      app.post(BASE + 'api/lock', async (req, res) => ensureBody(req, async body => {
        if (!isSrvAdmin(req)) return res.status(401).json({ err: 'Unauthorized' });
        const [domain, userid] = (body.key || ' / ').split('/');
        const u = listUsers().find(x => x.userid === userid && x.domain === domain);
        if (!u) return res.json({ ok: 0, err: 'user-not-found' });
        await setLocked(u, !!body.flag);
        res.json({ ok: 1 });
      }));

      app.post(BASE + 'api/run', async (req, res) => {
        if (!isSrvAdmin(req)) return res.status(401).json({ err: 'Unauthorized' });
        await sweep(); res.json({ ok: 1 });
      });

      // health-пинг на всякий (можно убрать)
      app.get(BASE + 'health', (req, res) => res.end('OK'));

    } catch (e) {
      log('hook_setupHttpHandlers error', e);
    }
  };

  plugin.server_startup = function() {
    try {
      sweep().catch(()=>{});
      scheduleNextRun();
      log('startup ok');
    } catch (e) {
      log('startup error', e);
    }
  };

  return plugin;
};
