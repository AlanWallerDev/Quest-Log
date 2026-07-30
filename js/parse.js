/* parse.js — the one-line quest grammar.
 *
 *   <title> [b|m|h|c|k|p] [!1-5] [N/d|N/w|N/m] [@when]
 *
 * Everything optional but the title; flags are order-independent.
 * Sigils were picked so every one sits on the iOS numeric page — nothing
 * lives on the #+= third page.
 *
 * Type is INFERRED, never typed: a recurrence means daily, else bounty.
 * (Projects and their `>` objective syntax are L5 — deliberately not parsed
 *  yet, so `>` stays literal title text until that level is built.)
 *
 * Ambiguity — a title word like "b" — is handled by the live preview in the
 * UI, not by the grammar. Quoting is the escape hatch: "plan b" !3 c
 */
(function () {
  'use strict';

  var P = {};
  var TOKEN = /"([^"]*)"|(\S+)/g;
  var WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  var MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  P.parse = function (line, now) {
    now = now || new Date();
    var out = {
      title: '', domain: null, difficulty: null,
      recurrence: null, due: null, kind: 'bounty', ok: false
    };
    var words = [], m;

    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(line || ''))) {
      if (m[1] !== undefined) { words.push(m[1]); continue; }   // quoted -> literal
      var t = m[2];

      if (/^![1-5]$/.test(t)) { out.difficulty = +t.charAt(1); continue; }

      if (!out.domain && /^[bmhckp]$/i.test(t)) { out.domain = t.toLowerCase(); continue; }

      var rec = recurrence(t);
      if (rec) { out.recurrence = rec; continue; }

      if (t.charAt(0) === '@') {
        var due = P.parseDue(t.slice(1), now);
        if (due) { out.due = due; continue; }
      }

      words.push(t);
    }

    out.title = words.join(' ').trim();
    if (out.difficulty === null) out.difficulty = window.RULES.DEFAULT_DIFFICULTY;
    out.kind = out.recurrence ? 'daily' : 'bounty';
    out.ok = out.title.length > 0;
    return out;
  };

  function recurrence(t) {
    var m = /^(\d*)\/([dwm])$/i.exec(t);
    if (!m) return null;
    var times = m[1] === '' ? 1 : parseInt(m[1], 10);
    if (times < 1 || times > 30) return null;
    return { times: times, unit: m[2].toLowerCase() };
  }

  /* @today @tmr @fri @3d @2w @15 @mar3  ->  'YYYY-MM-DD' */
  P.parseDue = function (s, now) {
    s = (s || '').toLowerCase();
    if (!s) return null;
    var base = new Date(now.getFullYear(), now.getMonth(), now.getDate()), m;

    if (s === 'today') return iso(base);
    if (s === 'tmr' || s === 'tomorrow') return iso(add(base, 1));

    for (var i = 0; i < 7; i++) {
      if (WEEKDAYS[i] === s.slice(0, 3) && s.length <= 9) {
        var delta = (i - base.getDay() + 7) % 7;   // today counts
        return iso(add(base, delta));
      }
    }

    if ((m = /^(\d+)d$/.exec(s))) return iso(add(base, +m[1]));
    if ((m = /^(\d+)w$/.exec(s))) return iso(add(base, +m[1] * 7));

    if ((m = /^([a-z]{3})(\d{1,2})$/.exec(s))) {
      var mo = MONTHS.indexOf(m[1]);
      if (mo >= 0) {
        var y = now.getFullYear();
        var d = new Date(y, mo, +m[2]);
        if (d < base) d = new Date(y + 1, mo, +m[2]);
        return iso(d);
      }
    }

    if (/^\d{1,2}$/.test(s)) {                     // day of month
      var day = +s;
      if (day >= 1 && day <= 31) {
        var t = new Date(now.getFullYear(), now.getMonth(), day);
        if (t < base) t = new Date(now.getFullYear(), now.getMonth() + 1, day);
        return iso(t);
      }
    }
    return null;
  };

  function add(d, n) { var t = new Date(d.getTime()); t.setDate(t.getDate() + n); return t; }
  function iso(d) {
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  }
  function p2(n) { return n < 10 ? '0' + n : '' + n; }

  /* Human-readable echo of a parse, for the live preview line. */
  P.describe = function (q) {
    var R = window.RULES, bits = [];
    bits.push(q.kind === 'daily' ? 'Daily' : 'Bounty');
    if (q.domain) bits.push(R.domainName(q.domain));
    bits.push('!' + q.difficulty);
    bits.push(R.DIFFICULTY_XP[q.difficulty] + ' XP');
    if (q.recurrence) bits.push(R.recurrenceLabel(q.recurrence));
    if (q.due) bits.push('due ' + P.dueLabel(q.due));
    return bits.join(' · ');
  };

  P.dueLabel = function (isoStr) {
    var parts = isoStr.split('-');
    var d = new Date(+parts[0], +parts[1] - 1, +parts[2]);
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var days = Math.round((d - today) / 86400000);
    if (days === 0) return 'today';
    if (days === 1) return 'tomorrow';
    if (days < 0) return Math.abs(days) + 'd overdue';
    if (days < 7) return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
    return (d.getMonth() + 1) + '/' + d.getDate();
  };

  window.PARSE = P;
})();
