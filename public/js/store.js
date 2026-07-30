/* store.js — local append-only event log in IndexedDB.
 *
 * Write path is: append locally -> fold -> render -> THEN enqueue the push.
 * The UI never waits on the network.
 */
(function () {
  'use strict';

  var DB_NAME = 'questlog', DB_VER = 1;
  var _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('events')) db.createObjectStore('events', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      req.onsuccess = function () { _db = req.result; resolve(_db); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function tx(store, mode) {
    return open().then(function (db) { return db.transaction(store, mode).objectStore(store); });
  }

  function wrap(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  var S = {};

  S.uuid = function () {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = crypto.getRandomValues(new Uint8Array(1))[0] % 16;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  };

  /* Create + persist one event. Returns it so the caller can fold immediately. */
  S.append = function (type, payload) {
    var e = { id: S.uuid(), ts: new Date().toISOString(), type: type, payload: payload || {}, dirty: 1 };
    return tx('events', 'readwrite').then(function (s) { return wrap(s.add(e)); }).then(function () { return e; });
  };

  /* Events pulled from the server land here. INSERT-OR-IGNORE semantics:
   * the uuid is the key, so a replayed batch is free. */
  S.merge = function (events) {
    if (!events || !events.length) return Promise.resolve(0);
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction('events', 'readwrite'), s = t.objectStore('events'), added = 0;
        events.forEach(function (e) {
          var g = s.get(e.id);
          g.onsuccess = function () {
            if (!g.result) { s.put({ id: e.id, ts: e.ts, type: e.type, payload: e.payload, dirty: 0 }); added++; }
          };
        });
        t.oncomplete = function () { resolve(added); };
        t.onerror = function () { reject(t.error); };
      });
    });
  };

  S.all = function () {
    return tx('events', 'readonly').then(function (s) { return wrap(s.getAll()); })
      .then(function (rows) { return rows.sort(window.REDUCE.cmp); });
  };

  S.dirty = function () {
    return S.all().then(function (rows) { return rows.filter(function (r) { return r.dirty; }); });
  };

  S.markClean = function (ids) {
    if (!ids.length) return Promise.resolve();
    return open().then(function (db) {
      return new Promise(function (resolve) {
        var t = db.transaction('events', 'readwrite'), s = t.objectStore('events');
        ids.forEach(function (id) {
          var g = s.get(id);
          g.onsuccess = function () { if (g.result) { g.result.dirty = 0; s.put(g.result); } };
        });
        t.oncomplete = resolve;
      });
    });
  };

  S.getMeta = function (k, dflt) {
    return tx('meta', 'readonly').then(function (s) { return wrap(s.get(k)); })
      .then(function (v) { return v === undefined ? dflt : v; });
  };
  S.setMeta = function (k, v) {
    return tx('meta', 'readwrite').then(function (s) { return wrap(s.put(v, k)); });
  };

  S.exportAll = function () {
    return S.all().then(function (rows) {
      return JSON.stringify(rows.map(function (r) {
        return { id: r.id, ts: r.ts, type: r.type, payload: r.payload };
      }), null, 2);
    });
  };

  window.STORE = S;
})();
