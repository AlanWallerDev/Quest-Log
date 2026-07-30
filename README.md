# Quest Log

A quest log for real-life goals. Static PWA, no build step, offline-first,
with an optional Cloudflare Worker + D1 event mirror for phone↔desktop sync.

Sibling app to the PF1e Character Vault — same stack, no shared code.

---

## The idea

Two problems kill every "gamify my life" app, and the design answers both:

1. **Self-granted rewards are free.** You click "done" yourself, so no
   enforcement will ever be real. Integrity comes from elsewhere: gated
   content, randomness, and rate limits instead of validation.
2. **Maintaining the app becomes its own chore.** Budget is ~10 seconds a day.
   Quest entry is one line of text, never a form.

The spine is **drip-fed mechanics, not plot**: new mechanics unlock as you
level, so the game stays novel without anyone authoring endless story.

**Build order is unlock order.** Only levels at or below `RULES.BUILT` exist
as code, so the gate is honest — there is nothing above it to peek at, and the
header shows `next: ???`. Ship a level, play it, then build the next one.

## The unlock ladder

| Level | Unlock | Status |
|---|---|---|
| 1 | Quest board — bounties, dailies, XP | **built** |
| 2 | Gold & the Shop | **built** |
| 3 | Bounty dust multiplier | designed |
| 4 | Loot rolls + Hoard | designed |
| 5 | Project quests (multi-objective) | designed |
| 6 | Dailies momentum | open question |
| 7 | Domain neglect multipliers | designed |
| 8 | The Map | designed |
| 10 | Stats · 12 Stronghold · 14 Path · 16+ bosses, campaigns, seasons | sketched |

## Grammar

```
<title> [b|m|h|c|k|p] [!1-5] [N/d|N/w|N/m] [@when]
```

Everything optional but the title; flags are order-independent. Sigils were
chosen so all of them sit on the iOS numeric page — none on the `#+=` page.
**Type is inferred, never typed**: a recurrence means daily, else bounty.

| Input | Result |
|---|---|
| `dishes` | Bounty · !2 |
| `taxes !4 p @fri` | Bounty · Purse · !4 · 100 XP · due Friday |
| `gym 3/w b !2` | Daily · Body · 3×/week |
| `read 20min /d m !1` | Daily · Mind · every day |
| `"plan b" !3 c` | quoting escape hatch — title stays "plan b" |

Domains: **b**ody, **m**ind, **h**earth, **c**raft, **k**in, **p**urse.
Due: `@today @tmr @fri @3d @2w @15 @mar3`.

A single bare letter is ambiguous with a title word, which is deliberate — the
**live preview under the input** shows the parse as you type, so you see a
misparse before committing. The preview is load-bearing, not decoration.

## Math

Base XP by difficulty: `!1`=5, `!2`=15, `!3`=40, `!4`=100, `!5`=250 — roughly
×2.5 per step, so one `!5` beats fifty `!1`s and hard things dominate.
Gold = XP÷4, bounties pay a ×1.5 gold premium.
Level curve: `cumulative XP to reach L = 75 × (L−1)²` → about a year to L20.

None of this is a commitment. See below.

## Architecture

**Append-only event log.** Every completion, purchase and level-up is an
immutable `{id, ts, type, payload}`; all state is derived by folding them
(`js/reduce.js`). This buys four things:

- **Sync is a union of events deduped by uuid** — no conflict resolution, no
  last-write-wins data loss, offline works by definition.
- **Idempotent** — `INSERT OR IGNORE` on the uuid PK, so a retried push is free.
- **Retroactive rebalancing** — change a constant in `js/rules.js` and the
  whole history recomputes coherently.
- **The history page is free.**

The governing rule: **deterministic derivations are recomputed, random outcomes
are recorded.** XP and gold are derived at fold time. When loot lands at L4, the
event must store the *resolved item* — never a seed — so replay can't re-roll.

**Replay by `(ts, id)`, never by `seq`.** Server sequence is arrival order,
which diverges from causal order after any offline period and would make two
devices fold to different states. Clock skew between devices is the known
limitation, acceptable for a single user.

```
js/rules.js    all tunable game math + the unlock ladder
js/parse.js    the one-line grammar
js/reduce.js   the fold: events -> state
js/store.js    IndexedDB event log
js/sync.js     Worker client
js/app.js      UI
worker/        Cloudflare Worker + D1 schema
```

Write path: append locally → fold → render → *then* enqueue the push. The UI
never waits on the network.

## Running it

```bash
python -m http.server 8743
```

Then open <http://localhost:8743>. Sync is optional — without it the log lives
only on this device, so export regularly from ⚙.

**Bump `APP_VERSION` in `index.html` on every js/css change.** Assets are
fetched as `?v=N` and the service worker caches them cache-first, so an unbumped
change never reaches the browser. `index.html` itself is deliberately
network-first, since it is the one unversioned file and it *carries* the version.

## Deploying sync

### Prerequisites

**Node 22 or newer.** wrangler 4 declares `engines: { node: '>=22' }` and simply
refuses to start on anything older — the failure reads confusingly like Node
isn't installed at all. Check with `node --version`; upgrade with
`winget install OpenJS.NodeJS.LTS`.

wrangler is a devDependency here:

```bash
npm install
```

**npm 11 blocks postinstall scripts by default**, and wrangler needs two of them
— `workerd` is its runtime, `esbuild` its bundler. Without them wrangler installs
but won't run. Approve exactly those two rather than blanket-allowing:

```bash
npm approve-scripts esbuild workerd
```

### Steps

You need a Cloudflare account first; the free tier is plenty. Then authorize
wrangler — this opens a browser:

```bash
npx wrangler login
```

Create the database:

```bash
npx wrangler d1 create questlog
```

Paste the returned `database_id` into `wrangler.jsonc`, then create the table:

```bash
npm run db:init
```

Generate a token. This prints it to the terminal, so run it somewhere you don't
mind it being visible, and keep a copy:

```bash
npm run token
```

Set it as the Worker secret — this prompts you to paste it:

```bash
npm run secret
```

Use the npm scripts rather than calling `npx wrangler` directly. wrangler only
looks for `wrangler.jsonc` in the current directory, so running it from anywhere
else fails with *"Required Worker name missing"*; npm resolves scripts against
the package root, so `npm run …` works from any subdirectory. (If that error
does appear, it is a working-directory problem, not a broken config. Any
`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` printed alongside it is
unrelated libuv teardown noise on Windows.)

Deploy:

```bash
npm run deploy
```

Then open the deployed URL, go to ⚙, paste the Worker URL and the same token,
and Save. Repeat on each device you want synced.

**On security:** that one token is the entire boundary — anyone holding it can
read and write the log. That is a reasonable trade for a personal quest log;
don't put anything sensitive in here.

### If you lose the token

Cloudflare cannot give it back. Worker secrets are write-only by design —
`wrangler secret list` returns names and types only, and the dashboard never
displays values.

It may still exist locally, though. The app stores it in plaintext in IndexedDB,
so on any device where you already entered it in ⚙, open the devtools console on
the deployed site and run:

```javascript
indexedDB.open('questlog').onsuccess = e => e.target.result.transaction('meta').objectStore('meta').get('token').onsuccess = ev => console.log(ev.target.result)
```

If it is gone everywhere, just rotate it — `npm run token`, then `npm run
secret`. This costs nothing: the token is only a shared secret, so replacing it
loses no data, every event in D1 is untouched, and no redeploy is needed. Any
device still holding the old token will report `Failed: HTTP 401` on Sync now
until you update it.

## Open design question

**Momentum without punishment** (L6) is unresolved. Streaks are the highest
-engagement and highest-abandonment mechanic in this genre — a broken 40-day
streak is when people quit. It needs to decay rather than shatter, and a Streak
Shield has to meaningfully protect it. Worth living with the board for a few
weeks before deciding.

Design principle throughout: **no punishment, ever.** No HP, no damage.
Quests are *dropped*, never *failed*. Downtime is a declared, guilt-free state.
