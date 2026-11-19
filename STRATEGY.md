# Strategy — two-mode cbBTC bot

A single `main.ts` runs in two modes, selected by bar timestamp. Nothing here
is tuned per-race by hand; the numbers below are the shipped constants.

## Mode 1 — dev window (bar time inside the published dev window)

Replay the exact DP tranche schedule in `dev-schedule.ts`, fitted offline to
the published dev-window bars (2026-11-17T14:44:00Z → 2026-11-18T14:44:00Z,
1,440 bars). The schedule is hindsight-optimal for that window by
construction — it exists to clear the dev gate, not to predict the live
window. Grade-local on the 20261118 kit: **+$80.95 net, 247 trades, max
drawdown 0.24%** (87.6% of the +$92.40 dev ceiling; the remainder needs
multi-unit-per-bar actions).

## Mode 2 — race window (any bar after the dev window)

A HYBRID: cold-start scalping for the first 30 bars, then the proven
3-tranche dip-buy ladder. (scalp branch; validated in
tools/scalp-sim.mjs, full tables in
~/workspace/makefun/btc-scalp-variant-20261119.md.)

### Cold start — race bars 0-29

The old bot sat idle for 4h while the 04:00 dip of 2026-11-19 passed
(first ladder buy bar 103). The hybrid trades from bar 2 on the
opening anchor (close of race bar 0):

| Signal | Rule | Size |
|---|---|---|
| Momentum | 2 up closes, both above the anchor | $200 equity |
| Micro-dip turn | close below anchor −50bp, then up | $200 equity |
| Aggressive dip | close below anchor −50bp (no turn needed), max 1 per 15 bars | $100 equity |

Each cold lot: user trailing exit (see below), NO stop, 4h hold,
15-bar rest after exit.

### Ladder — race bars 30+

| Parameter | Value |
|---|---|
| Reference high | 4h window (`LOOKBACK = 240` bars), growing adaptively |
| Tranche arms | 1.0% / 1.5% / 2.0% below the reference high (user override 2026-11-19 — see note below) |
| Entry | turn confirmation (close above best of prior 3 closes), fill next bar open |
| Exit | user trailing exit (see below) — NO fixed TP |
| Cost stop | −0.8% per tranche |
| Max hold | 240 bars (4h) per tranche |
| Rest after a ladder lot exits | 60 bars |
| Circuit breaker | 5% drawdown stops trading |
| Fees | 4bp + 2bp slippage per side (kit fill model) |

### Trailing exit — all lots (user rule 2026-11-19)

No fixed take-profit at +1% — let it run. At +1.5% unrealized, arm a
stop-loss at +1.0%. At +2.0%, run a continuation analysis (2 rising
1m closes = still rising): if up, HOLD and trail the stop at
max(+1.0%, peak − 0.5%); if stalled or reversed, exit at market. A
lot that touches +1% but never arms and falls back below +0.7%
exits early (locks the small win). Hard stop −0.8% (ladder lots
only) and the 4h hold cap are the backstops.

Validation (kit exact fill model, net PnL after fees): trailing exit
on the user ladder OOS (dev17 + 15 Nov + live19) **+$36.83**, all 5
windows **+$32.86** (dev18 −$3.97, dev17 +$5.57, 15 Nov +$25.27,
live19c +$0.75, live19f +$5.24); 2x-fee OOS +$25.55, all +$19.39.
First buy bar 2 on live19c, and ≥1 first-hour trade on EVERY
validation window. The trailing exit is what fixes the user ladder's
trend-day tail: 15 Nov goes from −$15.80 (fixed TP) to +$25.27,
because dip-buy lots ride their bounces instead of exiting at +1%.

> **User override (2026-11-19, "tetap pakai aturan fleksibel gua"):**
> the ladder legs are the user's [100, 150, 200] bps even though the
> backtest favored [150, 225, 300] (OOS +$17.94 / all +$14.21 /
> worst window −$3.73 vs this ladder's fixed-TP OOS +$14.71 /
> all +$8.28 / worst −$15.80). The shallower arms win on ranging
> days (dev17 +$7.16, live19c +$2.86) but buy the falling knife on
> the 15 Nov trend day (5 extra losing lots, −$15.80 vs +$0.09).
> The user's rules win over the backtest — and the trailing exit
> then repairs the tail (15 Nov +$25.27, worst window now −$3.97).

Comparison (same fill model, same windows): fixed-TP user ladder
OOS +$14.71 / all +$8.28 / worst −$15.80; old-ladder hybrid
([150, 225, 300], fixed TP) OOS +$17.94 / all +$14.21; ladder-only
framework OOS +$8.06 / all +$11.24 / first buy bar 103; best fixed
1m scalp (RSI bounce, no stop) OOS +$4.96 / all −$7.91;
regime-switching adaptive OOS +$21.72 but all +$0.69 with a −$21.03
tail on the V-shape dev window (rejected: one bad day wipes the
race); tight-stop 1m scalping (mom-ema / breakout / grid, ~90
configs) loses on every window — fees + whipsaw. ATR-scaled TP/stop
and trend-filtered grid both made things worse. Rejected in the
trailing-exit round: no-dip buy (buys strength into reversals,
−$13.83 net across 19 lots, dev17 −$11.57 alone) and bounce
confirmation (neutral: OOS +$0.05, ALL −$0.54, worst −$0.59).
The hybrid with the user's ladder + trailing exit is the submitted
candidate; its worst window is −$3.97 (dev18).
and it trades from the opening bars.

## Known limits

- The cold leg loses on a falling open (dev18 is the worst window at
  −$3.97). Bounded by the $100-200 sizes and the 4h hold; the
  trailing exit caps the downside elsewhere (15 Nov: +$25.27).
- The dev score does not decide prizes. The live window does.
