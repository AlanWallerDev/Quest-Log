/* app.js — UI and state wiring. */
(function () {
  'use strict';

  var R = window.RULES, P = window.PARSE, S = window.STORE, R3 = window.REDUCE;

  var events = [];
  var st = null;
  var view = 'board';
  var seenLevel = 1;
  var draft = null;

  var root = null;

  /* ---- boot ---------------------------------------------------------- */
  function boot() {
    /* Scripts are written into <head>, so <body> does not exist yet at module
     * evaluation time — #app must be resolved here, not at the top. */
    root = document.getElementById('app');

    /* Delegated once — render() only swaps innerHTML, so re-binding here
     * every render would stack duplicate handlers and multi-fire each tap. */
    root.addEventListener('click', onClick);

    Promise.all([S.all(), S.getMeta('seenLevel', 1)]).then(function (v) {
      events = v[0];
      seenLevel = v[1];
      refold();
      render();
      kick();
    }).catch(function (e) {
      root.innerHTML = '<div class="pane"><h2>Could not open storage</h2><p class="muted">' +
        esc(String(e)) + '</p></div>';
    });
  }

  function refold() { st = R3(events); }

  /* Append -> fold -> render -> then push. Never blocks on the network. */
  function emit(type, payload) {
    return S.append(type, payload).then(function (e) {
      events.push(e);
      refold();
      render();
      kick();
      return e;
    });
  }

  var kickTimer = null;
  function kick() {
    clearTimeout(kickTimer);
    kickTimer = setTimeout(function () { window.SYNC.run().then(function (r) { if (r && r.pulled) reload(); }); }, 400);
  }

  function reload() { S.all().then(function (rows) { events = rows; refold(); render(); }); }

  /* ---- render -------------------------------------------------------- */
  function render() {
    var prog = R.levelProgress(st.xp);
    root.innerHTML =
      header(prog) +
      '<nav class="tabs">' +
        tab('board', 'Board') +
        tab('shop', 'Shop', st.level < 2) +
        tab('hoard', 'Hoard', st.level < R.LOOT_LEVEL) +
        tab('log', 'Log') +
        tab('settings', '⚙') +
      '</nav>' +
      '<main class="pane">' + paneHtml() + '</main>';

    wire();
    maybeUnlock();
  }

  function header(prog) {
    var next = R.unlockAt(prog.level + 1);
    var teaser = prog.level + 1 <= R.BUILT && next ? next.name : '???';
    return '' +
      '<header class="hdr">' +
        '<div class="lvl">' +
          '<span class="lvnum">Lv ' + prog.level + '</span>' +
          (st.level >= 2 ? '<span class="gold">⛁ ' + st.gold + '</span>' : '') +
        '</div>' +
        '<div class="bar"><i style="width:' + Math.round(prog.pct * 100) + '%"></i></div>' +
        '<div class="barlab">' +
          '<span>' + prog.into + ' / ' + prog.span + ' XP</span>' +
          '<span class="muted">next: ' + esc(teaser) + '</span>' +
        '</div>' +
      '</header>';
  }

  function tab(id, label, locked) {
    return '<button class="tab' + (view === id ? ' on' : '') + (locked ? ' locked' : '') +
      '" data-view="' + id + '">' + label + (locked ? ' 🔒' : '') + '</button>';
  }

  function paneHtml() {
    if (view === 'shop') return st.level >= 2 ? shopHtml() : lockedHtml(2);
    if (view === 'hoard') return st.level >= R.LOOT_LEVEL ? hoardHtml() : lockedHtml(R.LOOT_LEVEL);
    if (view === 'log') return logHtml();
    if (view === 'settings') return settingsHtml();
    return boardHtml();
  }

  function lockedHtml(lvl) {
    return '<div class="locked-pane"><div class="big">🔒</div>' +
      '<h2>Locked</h2><p class="muted">Reach level ' + lvl + ' to unlock this.</p></div>';
  }

  /* ---- board --------------------------------------------------------- */
  function boardHtml() {
    var now = new Date(), today = R.dateKey(now);
    var all = Object.keys(st.quests).map(function (k) { return st.quests[k]; });
    var dailies = all.filter(function (q) { return q.kind === 'daily' && q.state === 'open'; });
    var bounties = all.filter(function (q) { return q.kind === 'bounty' && q.state === 'open'; });

    bounties.sort(function (a, b) {
      if (!!a.due !== !!b.due) return a.due ? -1 : 1;
      if (a.due && b.due && a.due !== b.due) return a.due < b.due ? -1 : 1;
      return a.createdAt < b.createdAt ? -1 : 1;
    });

    /* A real <form> rather than a keydown listener: mobile keyboards send
     * "Go"/"return" as an implicit submit, and IMEs make raw Enter unreliable. */
    var h = '' +
      '<div class="entry">' +
        '<form id="entry-form" autocomplete="off">' +
          '<input id="line" type="text" enterkeyhint="done" autocomplete="off" ' +
            'autocapitalize="none" spellcheck="false" placeholder="taxes !4 p @fri">' +
          '<button type="submit" id="add" aria-label="Add quest">+</button>' +
        '</form>' +
        '<div id="preview" class="preview muted">' + previewHtml(draft) + '</div>' +
      '</div>';

    h += section('Today', dailies.length
      ? dailies.map(function (q) { return dailyRow(q, today, now); }).join('')
      : empty('No dailies yet. Try <code>gym 3/w b !2</code>'));

    h += section('Bounties', bounties.length
      ? bounties.map(bountyRow).join('')
      : empty('Nothing on the board. Try <code>taxes !4 p</code>'));

    return h;
  }

  function section(title, inner) {
    return '<section><h2 class="sech">' + title + '</h2>' + inner + '</section>';
  }
  function empty(msg) { return '<p class="empty muted">' + msg + '</p>'; }

  function dailyRow(q, today, now) {
    var doneToday = R3.doneToday(st, q, today);
    var prog = R3.periodProgress(st, q, now);
    var note = q.recurrence && q.recurrence.times > 1
      ? prog.done + ' of ' + prog.want + ' this ' + ({ d: 'day', w: 'week', m: 'month' }[q.recurrence.unit])
      : R.recurrenceLabel(q.recurrence);
    return row(q, doneToday, note, prog.satisfied);
  }

  function bountyRow(q) {
    var note = q.due ? 'due ' + P.dueLabel(q.due) : '';
    var overdue = q.due && q.due < R.dateKey(new Date());
    return row(q, false, note, false, overdue, R.questDust(q, st.level, new Date()));
  }

  /* Patina tier — a multiplier you can't see doesn't change behaviour. */
  function dustClass(dust) {
    if (dust >= 3) return ' dust-3';
    if (dust >= 2) return ' dust-2';
    if (dust >= 1.3) return ' dust-1';
    return '';
  }

  function row(q, ticked, note, muted, warn, dust) {
    dust = dust || 1;
    var base = R.baseXp(q);
    var xp = Math.round(base * dust);
    return '' +
      '<div class="quest' + (muted ? ' sated' : '') + dustClass(dust) + '">' +
        /* No glyph when done -- the filled green circle carries it. aria-label
           still flips, so screen readers get the state the colour conveys. */
        '<button class="tick' + (ticked ? ' on' : '') + '" data-done="' + q.id + '" ' +
          (ticked ? 'disabled' : '') + ' aria-label="' +
          (ticked ? 'Completed' : 'Complete') + '"></button>' +
        '<div class="qmain">' +
          '<div class="qtitle">' + esc(q.title) + '</div>' +
          '<div class="qmeta">' +
            (q.domain ? '<span class="dot dom-' + q.domain + '"></span>' + R.domainName(q.domain) + ' · ' : '') +
            '!' + q.difficulty + ' · ' + xp + ' XP' +
            (dust > R.DUST_MIN_SHOW ? ' · <span class="dust">×' + dust.toFixed(1) + ' dust</span>' : '') +
            (note ? ' · <span class="' + (warn ? 'warn' : '') + '">' + esc(note) + '</span>' : '') +
          '</div>' +
        '</div>' +
        '<button class="drop" data-drop="' + q.id + '" aria-label="Drop">×</button>' +
      '</div>';
  }

  function previewHtml(d) {
    if (!d || !d.ok) return 'Type a quest. <code>b m h c k p</code> domain · <code>!1-5</code> difficulty · <code>3/w</code> recurrence · <code>@fri</code> due';
    return '<b>' + esc(d.title) + '</b> — ' + esc(P.describe(d));
  }

  /* ---- shop ---------------------------------------------------------- */
  function shopHtml() {
    var rewards = Object.keys(st.rewards).map(function (k) { return st.rewards[k]; });
    rewards.sort(function (a, b) { return a.price - b.price; });

    var h = '<p class="lede">Stock this yourself, and price it <em>now</em> — while you are feeling ' +
      'disciplined. You are bargaining with your future self.</p>';

    h += '<div class="stock">' +
      '<input id="rw-label" type="text" placeholder="a night off, no guilt">' +
      '<input id="rw-price" type="number" min="0" step="10" placeholder="200">' +
      '<button id="rw-add">Stock</button>' +
      '</div>';

    h += rewards.length ? rewards.map(function (r) {
      var can = st.gold >= r.price;
      return '<div class="reward' + (can ? '' : ' poor') + '">' +
        '<div class="rmain"><div class="rlabel">' + esc(r.label) + '</div>' +
          '<div class="qmeta">⛁ ' + r.price + (r.bought ? ' · bought ×' + r.bought : '') + '</div></div>' +
        '<button class="buy" data-buy="' + r.id + '"' + (can ? '' : ' disabled') + '>Buy</button>' +
        '<button class="drop" data-unstock="' + r.id + '" aria-label="Remove">×</button>' +
        '</div>';
    }).join('') : empty('Nothing stocked yet.');

    return h;
  }

  /* ---- hoard --------------------------------------------------------- */
  function hoardHtml() {
    var found = Object.keys(st.hoard).length;
    var h = '<p class="lede">' + found + ' of ' + LOOT.total() + ' found. Curios do nothing ' +
      'but remember which part of your life they came from.</p>';

    h += '<h2 class="sech">Consumables</h2>';
    h += LOOT.ITEMS.filter(function (i) { return i.kind === 'consumable'; }).map(function (i) {
      var n = st.hoard[i.id] || 0;
      var armed = i.id === 'charm' && st.pendingCharm;
      return '<div class="reward' + (n ? '' : ' poor') + '">' +
        '<div class="rmain"><div class="rlabel">' + esc(i.name) + (n > 1 ? ' ×' + n : '') +
          (armed ? ' <span class="dust">armed</span>' : '') + '</div>' +
          '<div class="qmeta">' + esc(i.desc) + '</div></div>' +
        /* A Reroll Token is only spendable at the moment of a drop, so it gets
           no button here — the drop modal offers it instead. */
        (i.id === 'charm' && n && !armed ? '<button class="buy" data-use="charm">Use</button>' : '') +
        '</div>';
    }).join('');

    h += '<h2 class="sech">Curios</h2><div class="curios">';
    h += LOOT.ITEMS.filter(function (i) { return i.kind === 'curio'; }).map(function (i) {
      var n = st.hoard[i.id] || 0;
      if (!n) return '<div class="curio unknown">???</div>';
      return '<div class="curio got r-' + i.rarity + '">' +
        '<span class="dot dom-' + i.domain + '"></span>' + esc(i.name) +
        (n > 1 ? ' <span class="muted">×' + n + '</span>' : '') + '</div>';
    }).join('');
    h += '</div>';
    return h;
  }

  /* ---- log ----------------------------------------------------------- */
  function logHtml() {
    if (!st.log.length) return empty('Nothing yet.');
    var rows = st.log.slice().reverse().slice(0, 200);
    return '<div class="loglist">' + rows.map(function (l) {
      var when = new Date(l.at);
      var label = l.title;
      if (l.kind === 'loot') label = 'Found: ' + itemName(l.itemId);
      if (l.kind === 'use') label = 'Used: ' + itemName(l.itemId);
      return '<div class="logrow">' +
        '<div class="lwhen muted">' + when.toLocaleDateString() + ' ' +
          when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '</div>' +
        '<div class="lwhat">' + esc(label) + '</div>' +
        '<div class="lval">' + (l.xp ? '<span class="xp">+' + l.xp + ' XP</span> ' : '') +
          (l.mult && l.mult > R.DUST_MIN_SHOW ? '<span class="dust">×' + l.mult.toFixed(1) + '</span> ' : '') +
          (l.gold ? '<span class="gold">' + (l.gold > 0 ? '+' : '') + l.gold + '⛁</span>' : '') + '</div>' +
        '</div>';
    }).join('') + '</div>';
  }

  /* ---- settings ------------------------------------------------------ */
  function settingsHtml() {
    return '' +
      '<h2 class="sech">Sync</h2>' +
      '<p class="lede">Optional. Without it the log lives only on this device — ' +
        'export regularly if you leave it off.</p>' +
      '<label class="fld"><span>Worker URL</span>' +
        '<input id="cfg-endpoint" type="url" placeholder="https://questlog.you.workers.dev"></label>' +
      '<label class="fld"><span>Token</span>' +
        '<input id="cfg-token" type="password" placeholder="paste the secret"></label>' +
      '<div class="btnrow"><button id="cfg-save">Save</button>' +
        '<button id="cfg-sync" class="ghost">Sync now</button></div>' +
      '<p id="cfg-status" class="muted"></p>' +
      '<h2 class="sech">Data</h2>' +
      '<div class="btnrow"><button id="do-export" class="ghost">Export events (JSON)</button></div>' +
      '<p class="muted small">' + events.length + ' events on this device.</p>';
  }

  /* ---- unlock moment -------------------------------------------------- */
  function maybeUnlock() {
    if (st.level <= seenLevel) return;
    /* Advance ONE level per call, not straight to st.level. A dusted !5 can
     * pay 1000 XP and cross several thresholds at once, and each unlock has
     * to get its own reveal. Closing the modal re-renders, which calls this
     * again and shows the next one. */
    var lvl = seenLevel + 1;
    var u = R.unlockAt(lvl);
    seenLevel = lvl;
    S.setMeta('seenLevel', seenLevel);
    if (!u) { maybeUnlock(); return; }   // no reveal at this level — keep climbing

    var el = document.createElement('div');
    el.className = 'modal';
    el.innerHTML = '<div class="card">' +
      '<div class="kicker">Level ' + lvl + '</div>' +
      '<h2>' + esc(u.name) + '</h2>' +
      '<p>' + esc(u.desc) + '</p>' +
      '<button class="close">Continue</button></div>';
    el.addEventListener('click', function (ev) {
      if (ev.target === el || ev.target.className === 'close') { el.remove(); render(); }
    });
    document.body.appendChild(el);
  }

  /* ---- loot ---------------------------------------------------------- */
  function itemName(id) {
    var i = window.LOOT && LOOT.get(id);
    return i ? i.name : String(id);
  }

  /* The ONLY place a drop is decided. The outcome is written into the event,
   * so replaying the log can never re-roll it into something else. */
  function rollLoot(quest, dust) {
    if (!quest || st.level < R.LOOT_LEVEL) return;
    var itemId = LOOT.roll(quest, dust);
    if (!itemId) return;
    var rollId = S.uuid();
    emit('loot.rolled', { rollId: rollId, questId: quest.id, itemId: itemId })
      .then(function () { showDrop(itemId, rollId, quest, dust); });
  }

  function doReroll(rollId, quest, dust) {
    emit('item.consumed', { itemId: 'reroll' }).then(function () {
      var newId = LOOT.pick(quest, dust);      // paid for, so it always yields
      var newRoll = S.uuid();
      return emit('loot.rolled', {
        rollId: newRoll, questId: quest.id, itemId: newId, replaces: rollId
      }).then(function () { showDrop(newId, newRoll, quest, dust); });
    });
  }

  function showDrop(itemId, rollId, quest, dust) {
    var item = LOOT.get(itemId);
    if (!item) return;
    var tokens = st.hoard.reroll || 0;

    var el = document.createElement('div');
    el.className = 'modal';
    el.innerHTML = '<div class="card">' +
      '<div class="kicker">' + LOOT.RARITY_LABEL[item.rarity] + ' find</div>' +
      '<h2>' + esc(item.name) + '</h2>' +
      '<p>' + esc(item.desc || 'A curio. It does nothing but remember.') + '</p>' +
      '<div class="btnrow center">' +
        (tokens ? '<button class="reroll ghost">Reroll (' + tokens + ')</button>' : '') +
        '<button class="close">Keep</button>' +
      '</div></div>';

    el.addEventListener('click', function (ev) {
      if (ev.target === el || ev.target.classList.contains('close')) { el.remove(); render(); return; }
      if (ev.target.classList.contains('reroll')) { el.remove(); doReroll(rollId, quest, dust); }
    });
    document.body.appendChild(el);
  }

  /* ---- events -------------------------------------------------------- */
  function wire() {
    var line = document.getElementById('line');
    if (line) {
      line.value = draft ? draft._raw : '';
      line.addEventListener('input', function () {
        draft = P.parse(line.value);
        draft._raw = line.value;
        document.getElementById('preview').innerHTML = previewHtml(draft);
      });
      document.getElementById('entry-form').addEventListener('submit', function (ev) {
        ev.preventDefault();
        var d = P.parse(line.value);
        if (!d.ok) return;
        draft = null;
        emit('quest.created', {
          questId: S.uuid(), title: d.title, kind: d.kind, domain: d.domain,
          difficulty: d.difficulty, recurrence: d.recurrence, due: d.due
        });
      });
      if (view === 'board' && !('ontouchstart' in window)) line.focus();
    }

    var save = document.getElementById('cfg-save');
    if (save) {
      Promise.all([S.getMeta('endpoint', ''), S.getMeta('token', '')]).then(function (v) {
        document.getElementById('cfg-endpoint').value = v[0];
        document.getElementById('cfg-token').value = v[1];
      });
      save.addEventListener('click', function () {
        Promise.all([
          S.setMeta('endpoint', document.getElementById('cfg-endpoint').value.trim()),
          S.setMeta('token', document.getElementById('cfg-token').value.trim())
        ]).then(function () { status('Saved.'); });
      });
      document.getElementById('cfg-sync').addEventListener('click', function () {
        status('Syncing…');
        window.SYNC.run().then(function (r) {
          if (r.off) return status('Not configured.');
          if (r.error) return status('Failed: ' + r.error);
          status('Pulled ' + r.pulled + ', pushed ' + r.pushed + '.');
          reload();
        });
      });
      document.getElementById('do-export').addEventListener('click', function () {
        S.exportAll().then(function (json) {
          var a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
          a.download = 'questlog-' + R.dateKey(new Date()) + '.json';
          a.click();
        });
      });
    }

    var add = document.getElementById('rw-add');
    if (add) add.addEventListener('click', function () {
      var label = document.getElementById('rw-label').value.trim();
      var price = parseInt(document.getElementById('rw-price').value, 10);
      if (!label || !(price >= 0)) return;
      emit('shop.stocked', { rewardId: S.uuid(), label: label, price: price });
    });
  }

  function onClick(ev) {
    var t = ev.target.closest('[data-view],[data-done],[data-drop],[data-buy],[data-unstock],[data-use]');
    if (!t) return;

    if (t.dataset.view) {
      if (t.dataset.view === 'shop' && st.level < 2) { view = 'shop'; render(); return; }
      view = t.dataset.view; render(); return;
    }
    if (t.dataset.done) {
      var q = st.quests[t.dataset.done];
      var dustAt = q ? R.questDust(q, st.level, new Date()) : 1;
      emit('quest.completed', { questId: t.dataset.done, dateKey: R.dateKey(new Date()) })
        .then(function () { rollLoot(q, dustAt); });
      return;
    }
    if (t.dataset.use) { emit('item.consumed', { itemId: t.dataset.use }); return; }
    if (t.dataset.drop) { emit('quest.dropped', { questId: t.dataset.drop, reason: 'abandoned' }); return; }
    if (t.dataset.buy) { emit('shop.purchased', { rewardId: t.dataset.buy }); return; }
    if (t.dataset.unstock) { emit('shop.unstocked', { rewardId: t.dataset.unstock }); return; }
  }

  function status(msg) {
    var el = document.getElementById('cfg-status');
    if (el) el.textContent = msg;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) window.SYNC.run().then(function (r) { if (r && r.pulled) reload(); });
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
