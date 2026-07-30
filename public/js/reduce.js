/* reduce.js — the fold. events -> state, pure and deterministic.
 *
 * Governing rule: DETERMINISTIC DERIVATIONS ARE RECOMPUTED, RANDOM OUTCOMES
 * ARE RECORDED. XP, gold and levels are derived here from the recorded facts,
 * which is exactly what lets the curve in rules.js be rebalanced later and the
 * whole history recomputed coherently. Anything random (loot, L4) must instead
 * store its resolved outcome in the event so replay can't re-roll it.
 *
 * Events are folded in (ts, id) order — NOT server sequence order. Server seq
 * is arrival order, which diverges from causal order after any offline period
 * and would make two devices fold to different states.
 */
(function () {
  'use strict';

  function cmp(a, b) {
    if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }

  function reduce(events) {
    var R = window.RULES;
    var st = {
      quests: {},        // id -> quest
      xp: 0, gold: 0, level: 1,
      rewards: {},       // id -> {label, price, bought}
      done: {},          // questId -> [dateKey, ...]
      log: [],           // newest last
      levelUps: [],      // [{level, at}]
      allocation: null,
      downtime: false
    };

    var evts = events.slice().sort(cmp);
    var credited = {};   // "questId|dateKey" -> true

    for (var i = 0; i < evts.length; i++) {
      var e = evts[i], p = e.payload || {};

      switch (e.type) {

        case 'quest.created':
          if (!p.questId) break;
          st.quests[p.questId] = {
            id: p.questId,
            title: p.title || '(untitled)',
            kind: p.kind === 'daily' ? 'daily' : 'bounty',
            domain: p.domain || null,
            difficulty: p.difficulty || R.DEFAULT_DIFFICULTY,
            recurrence: p.recurrence || null,
            due: p.due || null,
            createdAt: e.ts,
            state: 'open'
          };
          break;

        case 'quest.updated':
          if (st.quests[p.questId] && p.patch) {
            var q0 = st.quests[p.questId];
            for (var k in p.patch) if (Object.prototype.hasOwnProperty.call(p.patch, k)) q0[k] = p.patch[k];
          }
          break;

        case 'quest.dropped':
          if (st.quests[p.questId]) st.quests[p.questId].state = 'dropped';
          break;

        case 'quest.restored':
          if (st.quests[p.questId]) st.quests[p.questId].state = 'open';
          break;

        case 'quest.completed': {
          var q = st.quests[p.questId];
          if (!q || q.state === 'dropped') break;

          /* dateKey dedupe — a double-tap or an odd sync can't double-credit. */
          var key = p.questId + '|' + p.dateKey;
          if (credited[key]) break;
          credited[key] = true;

          var base = R.baseXp(q);
          var mult = R.multipliers(q, st, e);
          var xp = Math.round(base * Math.min(mult.total, R.MULTIPLIER_CAP));
          var gold = R.goldFor(q, base);

          var before = st.level;
          st.xp += xp;
          st.gold += gold;
          st.level = R.levelFromXp(st.xp);
          for (var L = before + 1; L <= st.level; L++) st.levelUps.push({ level: L, at: e.ts });

          st.log.push({
            at: e.ts, kind: 'complete', questId: q.id, title: q.title,
            questKind: q.kind, domain: q.domain, xp: xp, gold: gold, dateKey: p.dateKey
          });

          if (q.kind === 'bounty') q.state = 'done';
          else (st.done[q.id] || (st.done[q.id] = [])).push(p.dateKey);
          break;
        }

        case 'shop.stocked':
          if (!p.rewardId) break;
          st.rewards[p.rewardId] = {
            id: p.rewardId, label: p.label || '(reward)',
            price: Math.max(0, p.price | 0), bought: 0
          };
          break;

        case 'shop.unstocked':
          delete st.rewards[p.rewardId];
          break;

        case 'shop.purchased': {
          var r = st.rewards[p.rewardId];
          if (!r || st.gold < r.price) break;    // can't go negative on replay
          st.gold -= r.price;
          r.bought++;
          st.log.push({ at: e.ts, kind: 'purchase', title: r.label, gold: -r.price });
          break;
        }

        case 'allocation.set':
          st.allocation = p.targets || null;
          break;

        case 'downtime.started': st.downtime = true; break;
        case 'downtime.ended':   st.downtime = false; break;
      }
    }

    st.level = R.levelFromXp(st.xp);
    return st;
  }

  /* Has this daily been done today? */
  reduce.doneToday = function (st, quest, dateKey) {
    var list = st.done[quest.id] || [];
    return list.indexOf(dateKey) >= 0;
  };

  /* Distinct days credited within the current recurrence period. */
  reduce.periodProgress = function (st, quest, now) {
    var R = window.RULES;
    var want = quest.recurrence ? quest.recurrence.times : 1;
    var pk = R.periodKey(quest.recurrence, now);
    var list = st.done[quest.id] || [], n = 0;
    for (var i = 0; i < list.length; i++) {
      var parts = list[i].split('-');
      var d = new Date(+parts[0], +parts[1] - 1, +parts[2]);
      if (R.periodKey(quest.recurrence, d) === pk) n++;
    }
    return { done: n, want: want, satisfied: n >= want };
  };

  reduce.cmp = cmp;
  window.REDUCE = reduce;
})();
