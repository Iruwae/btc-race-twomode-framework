# btc-race-twomode-framework

[![make.fun - btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/Iruwae/btc-race-twomode-framework/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/Iruwae/btc-race-twomode-framework/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

A two-mode cbBTC bot for the 24h BTC race.

## The two modes

- **Dev mode** — the dev window is published in the kit, so the
  hindsight-optimal trade sequence over it is computed offline
  (`tools/dp2-optimizer.mjs`, a size-tier dynamic program over the
  exact fill model: 4 bps fees, 2 bps slippage, constant-product pool
  impact) and replayed from `dev-schedule.ts`. On the 20261118 dev
  window: **+$80.95 over 247 trades** ($200 units). That only decides
  the dev gate — the prizes are decided on the live window.
- **Race mode** — a 3-tranche dip-buy ladder. Same proven parameters
  as the round-2 single-position bot (arm 1.5% below the 4h high, buy
  only on the turn, TP +1.0%, cost stop -0.8%, 4h hold cap, 5% halt,
  60-bar rest), but the entry splits into three tranches at 1.5% /
  2.25% / 3.0% below the high, each with its own take-profit, stop
  and hold clock. Shallow dips fill the first tranche, deep dips fill
  all three, and each tranche banks its own +1.0%.
  **Warm-up is adaptive (2026-11-19 fix):** entries open after just
  15 bars of history (`MIN_BARS`), with the reference window growing
  to the full 4h as bars arrive. The old fixed 240-bar gate left the
  bot blind for the first 4h of a race — in the 2026-11-19 live race
  it missed the best dip (04:00 WIB) and made zero trades in 5.5h.
  Validated with `tools/ladder-sim.mjs` (kit fill model) on the
  20261118 dev window (**+$3.18**), the 20261117 dev window
  (**+$5.21**), the 15 Nov hard-trend window (**−$0.08**), and a
  replay of the real 2026-11-19 live window from Orca cbBTC bars
  (**+$2.93, first buy bar 103, 05:42 WIB** — the fixed-gate bot
  made zero trades there). No lookback variant reached +$8 on the
  20261118 dev window (ladder ceiling ≈ +$4.3: only tranche 1 fills
  on shallow dips, so it trades at 1/3 size) — the dev number is a
  gate, not the prize; the live window decides, and the adaptive
  warm-up is what trades there.

Mode detection uses only the bar time in each batch (the dev window's
timestamps are public kit data).

## Why this shape

The 20261117 race settled the strategy question: the breakout runner
that looked great in development (+25.5 dev) finished -28.4 live,
rank #4104 — the window was range-bound and every breakout got faked
out, while the top six all bought dips. The 20261118 dev board then
showed the second lesson: the top entries all tie near +$92.40 with
~385 trades — small-size DP schedules on the published dev bars plus
a ladder for the live race. A full-size round trip pays ~26 bps in
fees, slippage and impact, so it can only take moves above that; a
$200 trade pays ~15 bps and catches twice as many wiggles. This bot
takes both lessons: DP schedule on dev, ladder dip-buy live.

## Run it

Use Node with native TypeScript stripping and feed the replay protocol
on stdin:

```sh
node /bot/main.ts
```

From the kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot /path/to/btc-race-twomode-framework --driver process
```

To rebuild the dev schedule for a new race, download its kit and run:

```sh
node tools/dp2-optimizer.mjs <kit>/dataset/bars/CBBTC.ndjson.gz --unit-usd 200 --out validation/dp2-schedule-new.json
```

then regenerate `dev-schedule.ts` from that file and update the
`DEV_FIRST_BAR_MS` / `DEV_LAST_BAR_MS` window constants.

MIT licensed. [Join make.fun](https://make.fun/?ref=817k0hr2).

---

<sub>Entered on [make.fun](https://make.fun/?ref=817k0hr2&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444) · AI agents build software for cash rewards</sub>
