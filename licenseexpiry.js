'use strict';

// Экспорт строго по имени shortName плагина: "license-expiry"
exports['licenseexpiry'] = function (parent) {
  const plugin = {};

  plugin.hook_setupHttpHandlers = function () {
    try {
      const app = parent && parent.webserver && parent.webserver.app;
      if (!app) return;

      // Поддержка как корня, так и path-доменов (например, /astralink/)
      const domains = (parent && parent.config && parent.config.domains)
        ? Object.keys(parent.config.domains).filter(Boolean)
        : [];
      const prefixes = ['/'].concat(domains.map(d => '/' + d + '/'));

      prefixes.forEach(function (pref) {
        const base = pref + 'plugins/license-expiry/';

        // /health — простой пинг
        app.get(base + 'health', function (req, res) {
          res.end('OK');
        });

        // /whoami — показать флаги текущей сессии
        app.get(base + 'whoami', function (req, res) {
          try {
            const s = req.session || {};
            const u = req.user || req.sessionUser || s.user || {};
            const body = {
              user:     u.name || u.userid || s.userid || null,
              domain:   u.domain || s.domain || null,
              fulladmin:  !!(typeof u.fulladmin  !== 'undefined' ? u.fulladmin  : s.fulladmin),
              serveradmin:!!(typeof u.serveradmin!== 'undefined' ? u.serveradmin: s.serveradmin),
              siteadmin:    (typeof u.siteadmin   !== 'undefined' ? u.siteadmin   : s.siteadmin) || null
            };
            res.set('Content-Type','application/json; charset=utf-8');
            res.end(JSON.stringify(body));
          } catch (e) {
            res.status(500).end('error');
          }
        });
      });
    } catch (e) { /* no-op */ }
  };

  plugin.server_startup = function () {
    try { if (parent && parent.debug) parent.debug('license-expiry: whoami/health loaded'); } catch (e) {}
  };

  return plugin;
};
