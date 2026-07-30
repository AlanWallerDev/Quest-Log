/* sync.js — talks to the Cloudflare Worker.
 *
 * Sync is a union of append-only events deduped by uuid, so there is no
 * conflict resolution and no last-write-wins data loss. Offline works by
 * definition: local writes are authoritative, the server is a mirror.
 */
(function () {
  'use strict';

  var Y = {};
  var busy = false;

  Y.config = function () {
    return Promise.all([
      window.STORE.getMeta('endpoint', ''),
      window.STORE.getMeta('token', '')
    ]).then(function (v) { return { endpoint: v[0], token: v[1] }; });
  };

  Y.configured = function () {
    return Y.config().then(function (c) { return !!(c.endpoint && c.token); });
  };

  function call(cfg, path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Authorization': 'Bearer ' + cfg.token }, opts.headers || {});
    return fetch(cfg.endpoint.replace(/\/+$/, '') + path, opts).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  /* Pull anything the server has that we don't, then push anything we have
   * that it doesn't. Errors are swallowed — this is best-effort background
   * work and the app is fully usable without it. */
  Y.run = function () {
    if (busy) return Promise.resolve({ skipped: true });
    busy = true;
    var result = { pulled: 0, pushed: 0 };

    return Y.config().then(function (cfg) {
      if (!cfg.endpoint || !cfg.token) { result.off = true; throw 'unconfigured'; }

      return window.STORE.getMeta('lastSeq', 0).then(function (since) {
        return call(cfg, '/events?since=' + encodeURIComponent(since));
      }).then(function (res) {
        result.pulled = (res.events || []).length;
        return window.STORE.merge(res.events || []).then(function () {
          if (res.seq !== undefined) return window.STORE.setMeta('lastSeq', res.seq);
        });
      }).then(function () {
        return window.STORE.dirty();
      }).then(function (pending) {
        if (!pending.length) return null;
        result.pushed = pending.length;
        return call(cfg, '/events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            events: pending.map(function (e) {
              return { id: e.id, ts: e.ts, type: e.type, payload: e.payload };
            })
          })
        }).then(function (res) {
          return window.STORE.markClean(pending.map(function (e) { return e.id; }))
            .then(function () { if (res.seq !== undefined) return window.STORE.setMeta('lastSeq', res.seq); });
        });
      }).then(function () {
        return window.STORE.setMeta('lastSync', new Date().toISOString());
      }).then(function () { return result; });

    }).catch(function (err) {
      result.error = (err && err.message) || String(err);
      return result;
    }).then(function (r) { busy = false; return r; });
  };

  window.SYNC = Y;
})();
