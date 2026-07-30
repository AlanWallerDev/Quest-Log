/* rules.js — all tunable game math in one place.
 *
 * Nothing here is a commitment. State is derived by folding the event log,
 * so any constant below can change and the whole history recomputes coherently.
 * (The one exception: random outcomes are recorded in events, never re-rolled.)
 */
(function () {
  'use strict';

  var R = {};

  /* ---- domains ------------------------------------------------------ */
  /* One-letter codes must stay unique — the parser depends on it. */
  R.DOMAINS = [
    { code: 'b', name: 'Body',   blurb: 'health, fitness, sleep, food' },
    { code: 'm', name: 'Mind',   blurb: 'learning, reading, skills' },
    { code: 'h', name: 'Hearth', blurb: 'home, chores, maintenance' },
    { code: 'c', name: 'Craft',  blurb: 'work, creative output' },
    { code: 'k', name: 'Kin',    blurb: 'family, friends, relationships' },
    { code: 'p', name: 'Purse',  blurb: 'money, admin, bureaucracy' }
  ];
  R.DOMAIN = {};
  R.DOMAINS.forEach(function (d) { R.DOMAIN[d.code] = d; });
  R.domainName = function (code) { return R.DOMAIN[code] ? R.DOMAIN[code].name : ''; };

  /* ---- payouts ------------------------------------------------------ */
  R.DIFFICULTY_XP = { 1: 5, 2: 15, 3: 40, 4: 100, 5: 250 };
  R.DIFFICULTY_HINT = {
    1: 'one email, the dishes',
    2: 'a 30-minute errand',
    3: "a real evening's work",
    4: 'a whole weekend day',
    5: 'genuinely hard or scary'
  };
  R.DEFAULT_DIFFICULTY = 2;

  R.GOLD_DIVISOR = 4;
  R.BOUNTY_GOLD_PREMIUM = 1.5; // clearing rot deserves cash

  R.baseXp = function (quest) {
    return R.DIFFICULTY_XP[quest.difficulty] || R.DIFFICULTY_XP[R.DEFAULT_DIFFICULTY];
  };

  /* Multipliers apply to XP only, never gold — inflating the treat budget
   * would erode the Shop's pre-commitment. */
  R.goldFor = function (quest, baseXp) {
    var g = baseXp / R.GOLD_DIVISOR;
    if (quest.kind === 'bounty') g *= R.BOUNTY_GOLD_PREMIUM;
    return Math.round(g);
  };

  /* ---- dust (L3) ------------------------------------------------------ */
  /* An avoided bounty grows in value, so the board gets MORE attractive the
   * worse the week has been. Age runs from creation: the honest measure of
   * "how long have I been avoiding this", not "how overdue is it".
   *
   * Known simplification: a bounty filed far ahead of a distant due date
   * accrues dust it hasn't really earned. Judged rare enough to leave alone
   * rather than complicate the rule. */
  R.DUST_GRACE_DAYS = 3;    // nothing accrues at first, or the number is noise
  R.DUST_SPAN_DAYS = 45;    // grace -> cap
  R.DUST_MAX_BONUS = 3;     // 1 + 3 = 4x ceiling
  R.DUST_EXPONENT = 1.25;   // starts slow, accelerates (matches the neglect curve)
  R.DUST_MIN_SHOW = 1.05;   // below this, don't clutter the row with a pill
  R.DUST_LEVEL = 3;

  R.ageDays = function (fromIso, toIso) {
    var a = Date.parse(fromIso), b = Date.parse(toIso);
    if (!isFinite(a) || !isFinite(b)) return 0;
    return Math.max(0, (b - a) / 86400000);
  };

  R.dustMultiplier = function (ageDays) {
    var t = (ageDays - R.DUST_GRACE_DAYS) / R.DUST_SPAN_DAYS;
    if (t <= 0) return 1;
    if (t > 1) t = 1;
    return 1 + R.DUST_MAX_BONUS * Math.pow(t, R.DUST_EXPONENT);
  };

  /* Live dust for an OPEN bounty, for display only. */
  R.questDust = function (quest, level, now) {
    if (!quest || quest.kind !== 'bounty' || level < R.DUST_LEVEL) return 1;
    return R.dustMultiplier(R.ageDays(quest.createdAt, (now || new Date()).toISOString()));
  };

  /* Bonuses stack ADDITIVELY (1 + sum of each bonus above 1), hard-capped, so
   * dust + momentum + neglect can't compound into a runaway payout.
   * Seam remains open for L6 momentum and L7 neglect. */
  R.MULTIPLIER_CAP = 6;
  R.multipliers = function (quest, state, event) {
    var parts = [], total = 1;
    var level = state && state.level || 1;

    if (quest && quest.kind === 'bounty' && level >= R.DUST_LEVEL) {
      var age = R.ageDays(quest.createdAt, event && event.ts);
      var dust = R.dustMultiplier(age);
      if (dust > 1) {
        parts.push({ name: 'dust', value: dust, ageDays: age });
        total += dust - 1;
      }
    }

    return { total: Math.min(total, R.MULTIPLIER_CAP), parts: parts };
  };

  /* ---- level curve --------------------------------------------------- */
  /* cumulative XP to REACH level L = 75 * (L-1)^2
   * At a typical ~75 XP/day this paces the unlock ladder to about a year. */
  R.LEVEL_CONST = 75;
  R.xpForLevel = function (L) { return R.LEVEL_CONST * Math.pow(L - 1, 2); };
  R.levelFromXp = function (xp) {
    return Math.max(1, Math.floor(Math.sqrt(Math.max(0, xp) / R.LEVEL_CONST)) + 1);
  };
  R.levelProgress = function (xp) {
    var L = R.levelFromXp(xp), lo = R.xpForLevel(L), hi = R.xpForLevel(L + 1);
    return { level: L, into: xp - lo, span: hi - lo, next: hi, pct: (xp - lo) / (hi - lo) };
  };

  /* ---- the unlock ladder --------------------------------------------- */
  /* Build order IS unlock order: only levels at or below BUILT exist as code,
   * so the gate is honest — there is nothing above it to peek at. */
  R.BUILT = 3;
  R.UNLOCKS = {
    1: { name: 'The Quest Board', desc: 'Bounties, dailies, and XP. Type a line, tap it done.' },
    2: { name: 'Gold & the Shop', desc: 'Completions now pay gold. Stock the Shop with real rewards and price them now, while you are feeling disciplined.' },
    3: { name: 'Dust', desc: 'Bounties you avoid now gather dust — and dust is worth XP. The longer one sits, the more it pays, up to four times. Nothing here is overdue. It is just getting richer.' }
  };
  R.unlockAt = function (L) { return R.UNLOCKS[L] || null; };

  /* ---- period keys (dailies) ----------------------------------------- */
  R.dateKey = function (d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  };
  R.periodKey = function (recurrence, d) {
    d = d || new Date();
    var unit = recurrence && recurrence.unit || 'd';
    if (unit === 'd') return R.dateKey(d);
    if (unit === 'm') return d.getFullYear() + '-' + pad(d.getMonth() + 1);
    // ISO-ish week, Monday start
    var t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    var dow = (t.getDay() + 6) % 7;
    t.setDate(t.getDate() - dow);
    return t.getFullYear() + '-W' + pad(Math.floor((t - new Date(t.getFullYear(), 0, 1)) / 604800000) + 1);
  };
  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  R.recurrenceLabel = function (rec) {
    if (!rec) return '';
    if (rec.unit === 'd' && rec.times === 1) return 'every day';
    var unit = { d: 'day', w: 'week', m: 'month' }[rec.unit];
    return rec.times + '× / ' + unit;
  };

  window.RULES = R;
})();
