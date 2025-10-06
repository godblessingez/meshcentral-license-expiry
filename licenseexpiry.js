"use strict";
exports["licenseexpiry"] = function (parent) {
  const plugin = {};
  plugin.hook_setupHttpHandlers = function () {
    const app = parent && parent.webserver && parent.webserver.app; if (!app) return;
    const doms = (parent && parent.config && parent.config.domains) ? Object.keys(parent.config.domains).filter(Boolean) : [];
    const prefixes = ["/"].concat(doms.map(d => "/" + d + "/"));
    prefixes.forEach(function (pref) {
      const base = pref + "plugins/licenseexpiry/";
      app.get(base + "health", function (req, res) { res.end("OK"); });
      app.get(base + "whoami", function (req, res) {
        const s = req.session || {}, u = req.user || req.sessionUser || s.user || {};
        res.set("Content-Type","application/json; charset=utf-8");
        res.end(JSON.stringify({
          user: u.name || u.userid || s.userid || null,
          domain: u.domain || s.domain || null,
          fulladmin: !!(typeof u.fulladmin !== "undefined" ? u.fulladmin : s.fulladmin),
          serveradmin: !!(typeof u.serveradmin !== "undefined" ? u.serveradmin : s.serveradmin),
          siteadmin: (typeof u.siteadmin !== "undefined" ? u.siteadmin : s.siteadmin) || null
        }));
      });
    });
  };
  plugin.server_startup = function(){ try{ parent.debug("licenseexpiry: whoami/health loaded"); }catch(e){} };
  return plugin;
};
