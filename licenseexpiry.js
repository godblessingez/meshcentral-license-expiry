'use strict';

/**
 * MeshCentral plugin: licenseexpiry
 * - Экспорт строго по имени shortName: "licenseexpiry"
 * - Работает с MeshCentral 1.1.x
 */
exports['licenseexpiry'] = function (parent) {
  const fs = require('fs');
  const path = require('path');

  // --- настройки
  const CFG = { timezone: 'Europe/Moscow', runAt: '00:00' };

  // базовый файл-хранилище дат истечения. Поддерживаем оба имени на всякий случай.
  const DATA_FILE1 = path.join((parent && parent.datapath) || process.cwd(), 'licenseexpiry.json');
  const DATA_FILE2 = path.join((parent && parent.datapath) || process.cwd(), 'license-expiry.json');

  // --- лог
  function log() {
    try { parent.debug.apply(parent, ['licenseexpiry:'].concat(Array.prototype.slice.call(arguments))); }
    catch (e) {}
  }

  // --- доступ: только указанные пользователи
  // добавляй в ALLOW других по _id, например "user/company/user1"
  const ALLOW = new Set([
    'user//admin'   // корневой admin
  ]);

  function isAllowedUser(req) {
    try {
      const s = req.session || {};
      const u = req.user || req.sessionUser || s.user || {};
      const byId = (u && u._id) || (s.user && s.user._id) || null;
      const domain = (u && u.domain !== undefined) ? u.domain : (s.domain || '');
      const name = (u && (u.name || u.userid)) || s.userid || '';

      // возможные идентификаторы
      const candidates = [];
      if (byId)            candidates.push(String(byId).toLowerCase());
      if (name)            candidates.push(('user/' + (domain || '') + '/' + name).toLowerCase());
      if (!byId && !name)  return false;

      // доп. поблажка: пустой домен + имя admin
      if ((domain || '') === '' && String(name).toLowerCase() === 'admin') return true;

      for (const c of candidates) { if (ALLOW.has(c)) return true; }
      return false;
    } catch (e) { return false; }
  }

  // --- DB helpers
  function loadDB() {
    try {
      if (fs.existsSync(DATA_FILE1)) return JSON.parse(fs.readFileSync(DATA_FILE1, 'utf8'));
      if (fs.existsSync(DATA_FILE2)) return JSON.parse(fs.readFileSync(DATA_FILE2, 'utf8'));
    } catch (e) { log('loadDB', e); }
    return {};
  }
  function saveDB(db) {
    try { fs.writeFileSync(DATA_FILE1, JSON.stringify(db, null, 2)); }
    catch (e) { log('saveDB', e); }
  }

  // --- users
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
    } catch (e) { log('listUsers', e); return []; }
  }

  async function setLocked(user, flag) {
    try {
      if (parent.userManager && typeof parent.userManager.SetUserLocked === 'function') {
        parent.userManager.SetUserLocked(user, !!flag);
        try {
          if (parent.webserver && parent.webserver.disconnectUserSessions) {
            parent.webserver.disconnectUserSessions(user);
          }
        } catch (e) {}
        return true;
      }
    } catch (e) { log('SetUserLocked', e); }

    // fallback на БД
    try {
      const u = Object.assign({}, user, { locked: !!flag });
      if (u.siteadmin) u.siteadmin.locked = !!flag;

      if (parent.db && typeof parent.db.SetUser === 'function') {
        if (parent.db.SetUser.length >= 2) {
          await new Promise((res, rej) => parent.db.SetUser(u, err => err ? rej(err) : res()));
        } else {
          parent.db.SetUser(u);
        }
        try {
          if (parent.webserver && parent.webserver.disconnectUserSessions) {
            parent.webserver.disconnectUserSessions(user);
          }
        } catch (e) {}
        return true;
      }
    } catch (e) { log('DB fallback', e); }

    return false;
  }

  // --- планировщик: ежедневная проверка
  async function sweep() {
    try {
      const db = loadDB();
      const now = Date.now();
      for (const u of listUsers()) {
        const key = `${u.domain}/${u.userid}`;
        const until = db[key];
        const exp = until ? Date.parse(until) : NaN;
        if (isFinite(exp) && exp <= now && !u.locked) {
          await setLocked(u, true);
          log('locked', key, 'expired', until);
        }
      }
    } catch (e) { log('sweep', e); }
  }

  function msUntil(tz, hhmm) {
    try {
      const [H, M] = hhmm.split(':').map(Number);
      const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(x => [x.type, x.value]));
      const h = parseInt(parts.hour, 10), m = parseInt(parts.minute, 10), s = parseInt(parts.second, 10);
      const now = h * 3600 + m * 60 + s;
      const tgt = H * 3600 + M * 60;
      const d = (tgt > now) ? (tgt - now) : (86400 - (now - tgt));
      return d * 1000;
    } catch (e) { return 60000; }
  }

  function schedule() {
    const delay = msUntil(CFG.timezone, CFG.runAt);
    log('next sweep in', Math.round(delay / 1000), 'sec');
    setTimeout(async () => {
      try { await sweep(); } catch (e) { log('sweepTimer', e); }
      schedule();
    }, delay);
  }

  // --- http helpers
  function ensureBody(req, cb) {
    let b = '';
    req.on('data', d => b += d);
    req.on('end', () => { try { cb(JSON.parse(b || '{}')); } catch (e) { cb({}); } });
  }

  function adminHtml() {
    return `<!doctype html><meta charset="utf-8"><title>License Expiry</title>
<style>
body{font-family:system-ui,Arial;margin:24px;color:#111;background:#fff}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid #ccc;padding:6px 8px}
th{background:#f3f3f3}
button{cursor:pointer}
</style>
<h2>Лицензии пользователей</h2>
<p>Ежедневная проверка в ${CFG.runAt} по ${CFG.timezone}. Клик по дате — редактирование (ISO 8601).</p>
<div id=app>Загрузка…</div>
<script>
async function rq(p,o){const r=await fetch(p,Object.assign({headers:{'content-type':'application/json'}},o||{})); if(!r.ok){ const t=await r.text(); throw new Error(r.status+' '+t); } return r.json();}
async function load(){
  try{
    const d=await rq('api/status');
    const rows=d.users.map(u=>{
      const k=u.domain+'/'+u.userid,until=d.map[k]||'';
      return '<tr><td>'+u.domain+'</td><td>'+u.userid+'</td><td>'+(u.locked?'🔒':'')+'</td>'+
             '<td contenteditable onblur="saveDate(\\''+k+'\\',this.innerText)">'+until+'</td>'+
             '<td><button onclick="ex(\\''+k+'\\',30)">+30д</button> '+
             '<button onclick="ex(\\''+k+'\\',365)">+1г</button> '+
             '<button onclick="lk(\\''+k+'\\',1)">Lock</button> '+
             '<button onclick="lk(\\''+k+'\\',0)">Unlock</button></td></tr>';
    }).join('');
    document.getElementById('app').innerHTML=
      '<p><button onclick="run()">Запустить проверку сейчас</button></p>'+
      '<table><thead><tr><th>Домен</th><th>UserID</th><th>Locked</th><th>Действует до</th><th>Действия</th></tr></thead><tbody>'+rows+'</tbody></table>';
  } catch(e){
    document.getElementById('app').innerHTML='<b>Ошибка: </b>'+e.message+'<br>Проверьте, что вы зашли под разрешённым пользователем.';
  }
}
async function saveDate(k,v){ await rq('api/set',{method:'POST',body:JSON.stringify({key:k,until:v})}); }
async function ex(k,days){ await rq('api/extend',{method:'POST',body:JSON.stringify({key:k,days})}); load(); }
async function lk(k,f){ await rq('api/lock',{method:'POST',body:JSON.stringify({key:k,flag:!!f})}); load(); }
async function run(){ await rq('api/run',{method:'POST',body:'{}'}); load(); }
load();
</script>`;
  }

  // --- маршруты
  function prefixes() {
    const arr = ['/'];
    try {
      const d = (parent && parent.config && parent.config.domains) || {};
      for (const k of Object.keys(d)) { if (k) arr.push('/' + k + '/'); }
    } catch (e) {}
    return Array.from(new Set(arr));
  }

  const plugin = {};

  plugin.hook_setupHttpHandlers = function () {
    const app = parent && parent.webserver && parent.webserver.app;
    if (!app) return;

    // простой fallback-маршрут для диагностики
    app.get('/licenseexpiry-health', function (req, res) { res.end('OK'); });

    for (const pref of prefixes()) {
      const base = pref + 'plugins/licenseexpiry/';

      app.get(base + 'health', function (req, res) { res.end('OK'); });

      app.get(base + 'whoami', function (req, res) {
        const s = req.session || {};
        const u = req.user || req.sessionUser || s.user || {};
        res.set('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({
          user: u.name || u.userid || s.userid || null,
          domain: u.domain || s.domain || null,
          fulladmin: !!(typeof u.fulladmin !== 'undefined' ? u.fulladmin : s.fulladmin),
          serveradmin: !!(typeof u.serveradmin !== 'undefined' ? u.serveradmin : s.serveradmin),
          siteadmin: (typeof u.siteadmin !== 'undefined' ? u.siteadmin : s.siteadmin) || null,
          _id: u._id || (s.user && s.user._id) || null
        }));
      });

      // страница админки
      app.get(base, function (req, res) {
        if (!isAllowedUser(req)) return res.status(401).send('Unauthorized');
        res.set('Content-Type', 'text/html; charset=utf-8');
        res.end(adminHtml());
      });

      // API
      app.get(base + 'api/status', function (req, res) {
        if (!isAllowedUser(req)) return res.status(401).json({ err: 'Unauthorized' });
        res.json({ users: listUsers(), map: loadDB() });
      });

      app.post(base + 'api/set', function (req, res) {
        if (!isAllowedUser(req)) return res.status(401).json({ err: 'Unauthorized' });
        ensureBody(req, function (b) {
          const db = loadDB();
          db[b.key] = b.until;
          saveDB(db);
          res.json({ ok: 1 });
        });
      });

      app.post(base + 'api/extend', function (req, res) {
        if (!isAllowedUser(req)) return res.status(401).json({ err: 'Unauthorized' });
        ensureBody(req, function (b) {
          const db = loadDB();
          const cur = Date.parse(db[b.key] || new Date().toISOString());
          const d = isFinite(cur) ? new Date(cur) : new Date();
          d.setDate(d.getDate() + (parseInt(b.days, 10) || 0));
          db[b.key] = d.toISOString();
          saveDB(db);
          res.json({ ok: 1, until: db[b.key] });
        });
      });

      app.post(base + 'api/lock', function (req, res) {
        if (!isAllowedUser(req)) return res.status(401).json({ err: 'Unauthorized' });
        ensureBody(req, async function (b) {
          const parts = (b.key || ' / ').split('/');
          const domain = parts[0], userid = parts[1];
          const u = listUsers().find(x => x.userid === userid && x.domain === domain);
          if (!u) return res.json({ ok: 0, err: 'user-not-found' });
          await setLocked(u, !!b.flag);
          res.json({ ok: 1 });
        });
      });

      app.post(base + 'api/run', async function (req, res) {
        if (!isAllowedUser(req)) return res.status(401).json({ err: 'Unauthorized' });
        await sweep();
        res.json({ ok: 1 });
      });
    }
  };

  plugin.server_startup = function () {
    try {
      // маркер-файл для отладки (видно, что плагин поднялся)
      const touch = path.join((parent && parent.datapath) || process.cwd(), 'licenseexpiry.touch');
      fs.writeFileSync(touch, new Date().toISOString() + '\n');
    } catch (e) {}
    try { sweep().catch(function () {}); schedule(); log('startup ok'); } catch (e) { log('startup', e); }
  };

  return plugin;
};
