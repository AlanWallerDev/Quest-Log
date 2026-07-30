/* loot.js — the drop table (L4).
 *
 * THE ROLL HAPPENS HERE, NOT IN THE REDUCER. reduce.js must stay pure and
 * deterministic so the XP curve can be rebalanced and replayed; a random
 * outcome folded at replay time would re-roll and rewrite history. So the
 * app rolls once, and records the RESOLVED itemId in the loot.rolled event.
 * This module is called exactly once per drop, from app.js.
 *
 * Design rule for items: loot grants FORGIVENESS, not power. There is no
 * combat to buff, so the useful drops buy you slack instead — a reroll, a
 * doubled payout. Everything else is a curio: pure collection, no effect.
 *
 * Only consumables whose mechanic ALREADY EXISTS live here. Streak Shield
 * (needs L6 momentum) and Downtime Pass (needs downtime) are deliberately
 * absent — build order is unlock order, and an item that does nothing when
 * used is worse than an item you have not found yet.
 */
(function () {
  'use strict';

  var L = {};

  L.RARITIES = ['common', 'uncommon', 'rare'];
  L.RARITY_LABEL = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare' };

  L.ITEMS = [
    /* ---- consumables ------------------------------------------------- */
    { id: 'reroll', name: 'Reroll Token', kind: 'consumable', rarity: 'uncommon',
      desc: 'Discard a drop the moment you find it and roll again.' },
    { id: 'charm', name: 'Doubling Charm', kind: 'consumable', rarity: 'rare',
      desc: 'Adds ×1 to your next completion. Bonuses add rather than multiply, so on an undusted quest this doubles it.' },

    /* ---- curios, themed to the domain that dropped them --------------- */
    { id: 'b1', name: 'A whetstone worn smooth', kind: 'curio', rarity: 'common', domain: 'b' },
    { id: 'b2', name: 'Boots with the tread run down', kind: 'curio', rarity: 'common', domain: 'b' },
    { id: 'b3', name: 'A flask that never quite empties', kind: 'curio', rarity: 'uncommon', domain: 'b' },
    { id: 'b4', name: 'A river stone, still cold', kind: 'curio', rarity: 'rare', domain: 'b' },

    { id: 'm1', name: 'A margin note in a borrowed book', kind: 'curio', rarity: 'common', domain: 'm' },
    { id: 'm2', name: 'A pamphlet you almost understand', kind: 'curio', rarity: 'common', domain: 'm' },
    { id: 'm3', name: 'Spectacles ground from river ice', kind: 'curio', rarity: 'uncommon', domain: 'm' },
    { id: 'm4', name: 'A key to a door you have not found', kind: 'curio', rarity: 'rare', domain: 'm' },

    { id: 'h1', name: 'A brass hinge, freshly oiled', kind: 'curio', rarity: 'common', domain: 'h' },
    { id: 'h2', name: 'A candle burned to the collar', kind: 'curio', rarity: 'common', domain: 'h' },
    { id: 'h3', name: 'A spare key on a red thread', kind: 'curio', rarity: 'uncommon', domain: 'h' },
    { id: 'h4', name: 'A hearthstone swept clean', kind: 'curio', rarity: 'rare', domain: 'h' },

    { id: 'c1', name: 'A chisel with your initials', kind: 'curio', rarity: 'common', domain: 'c' },
    { id: 'c2', name: 'A draft with three crossings-out', kind: 'curio', rarity: 'common', domain: 'c' },
    { id: 'c3', name: 'Sawdust in the shape of a wing', kind: 'curio', rarity: 'uncommon', domain: 'c' },
    { id: 'c4', name: 'A nib worn to your own angle', kind: 'curio', rarity: 'rare', domain: 'c' },

    { id: 'k1', name: 'A letter folded eight times', kind: 'curio', rarity: 'common', domain: 'k' },
    { id: 'k2', name: 'Two cups, one chipped', kind: 'curio', rarity: 'common', domain: 'k' },
    { id: 'k3', name: 'A shared umbrella, still damp', kind: 'curio', rarity: 'uncommon', domain: 'k' },
    { id: 'k4', name: 'A photograph with a thumb in the corner', kind: 'curio', rarity: 'rare', domain: 'k' },

    { id: 'p1', name: 'A coin worn featureless', kind: 'curio', rarity: 'common', domain: 'p' },
    { id: 'p2', name: 'A receipt for something forgotten', kind: 'curio', rarity: 'common', domain: 'p' },
    { id: 'p3', name: 'A purse with a mended seam', kind: 'curio', rarity: 'uncommon', domain: 'p' },
    { id: 'p4', name: 'A ledger balanced at last', kind: 'curio', rarity: 'rare', domain: 'p' }
  ];

  L.BY_ID = {};
  L.ITEMS.forEach(function (i) { L.BY_ID[i.id] = i; });
  L.get = function (id) { return L.BY_ID[id] || null; };
  L.total = function () { return L.ITEMS.length; };

  /* ---- odds ----------------------------------------------------------- */
  /* Harder quests drop more often, and dust improves the odds — clearing rot
   * deserves better loot, and it ties the two mechanics together. */
  L.BASE_CHANCE = { 1: 0.08, 2: 0.15, 3: 0.25, 4: 0.40, 5: 0.60 };
  L.DUST_CHANCE_BONUS = 0.10;   // per whole point of dust above 1
  L.MAX_CHANCE = 0.90;

  L.dropChance = function (quest, dust) {
    var base = L.BASE_CHANCE[quest && quest.difficulty] || L.BASE_CHANCE[2];
    return Math.min(L.MAX_CHANCE, base + Math.max(0, (dust || 1) - 1) * L.DUST_CHANCE_BONUS);
  };

  /* Dust also shifts the rarity mix, taken out of common. */
  L.rarityWeights = function (dust) {
    var d = Math.max(0, (dust || 1) - 1);
    var rare = 6 + d * 5, uncommon = 26 + d * 3;
    return { common: Math.max(5, 100 - rare - uncommon), uncommon: uncommon, rare: rare };
  };

  function pickWeighted(weights, r) {
    var total = 0, k;
    for (k in weights) total += weights[k];
    var x = r * total;
    for (k in weights) { x -= weights[k]; if (x <= 0) return k; }
    return 'common';
  }

  /* ---- the roll -------------------------------------------------------- */
  /* rnd is injectable so the odds can be tested deterministically. */
  L.shouldDrop = function (quest, dust, rnd) {
    return (rnd || Math.random)() < L.dropChance(quest, dust);
  };

  /* Always returns an item — used directly by a reroll, which you paid for. */
  L.pick = function (quest, dust, rnd) {
    rnd = rnd || Math.random;
    var rarity = pickWeighted(L.rarityWeights(dust), rnd());
    var pool = L.ITEMS.filter(function (i) { return i.rarity === rarity; });
    if (!pool.length) pool = L.ITEMS.slice();

    /* Prefer a curio from the quest's own domain, so the Hoard becomes a
     * record of where the year's effort actually went. */
    if (quest && quest.domain) {
      var themed = pool.filter(function (i) { return i.domain === quest.domain; });
      if (themed.length && rnd() < 0.6) pool = themed;
    }
    return pool[Math.min(pool.length - 1, Math.floor(rnd() * pool.length))].id;
  };

  L.roll = function (quest, dust, rnd) {
    rnd = rnd || Math.random;
    if (!L.shouldDrop(quest, dust, rnd)) return null;
    return L.pick(quest, dust, rnd);
  };

  window.LOOT = L;
})();
