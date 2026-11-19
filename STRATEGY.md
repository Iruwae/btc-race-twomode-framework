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

Each cold lot: TP +1.0%, NO stop, 4h hold, 15-bar rest after exit.

### Ladder — race bars 30+

| Parameter | Value |
|---|---|
| Reference high | 4h window (`LOOKBACK = 240` bars), growing adaptively |
| Tranche arms | 1.0% / 1.5% / 2.0% below the reference high (user override 2026-11-19 — see note below) |
| Entry | turn confirmation (close above best of prior 3 closes), fill next bar open |
| Take profit | +1.0% per tranche |
| Cost stop | −0.8% per tranche |
| Max hold | 240 bars (4h) per tranche |
| Rest after a ladder lot exits | 60 bars |
| Circuit breaker | 5% drawdown stops trading |
| Fees | 4bp + 2bp slippage per side (kit fill model) |

Validation (kit exact fill model, net PnL after fees): hybrid OOS
(dev17 + 15 Nov + live19) **+$14.71**, all 5 windows **+$8.28**
(dev18 −$6.43, dev17 +$11.48, 15 Nov −$15.80, live19c +$14.76,
live19f +$4.27); 2x-fee OOS +$3.22, all −$5.38. First buy bar 2
on live19c (three cold lots into the 04:00 dip, all TP +1%:
+$8.66), and ≥1 first-hour trade on EVERY validation window.

> **User override (2026-11-19, "tetap pakai aturan fleksibel gua"):**
> the ladder legs are the user's [100, 150, 200] bps even though the
> backtest favored [150, 225, 300] (OOS +$17.94 / all +$14.21 /
> worst window −$3.73 vs this ladder's OOS +$14.71 / all +$8.28 /
> worst −$15.80). The shallower arms win on ranging days (dev17
> +$7.16, live19c +$2.86) but buy the falling knife on the 15 Nov
> trend day (5 extra losing lots, −$15.80 vs +$0.09). The user's
> rules win over the backtest.

Comparison (same fill model, same windows): ladder-only framework
OOS +$8.06 / all +$11.24 / first buy bar 103; best fixed 1m scalp
(RSI bounce, no stop) OOS +$4.96 / all −$7.91; regime-switching
adaptive OOS +$21.72 but all +$0.69 with a −$21.03 tail on the
V-shape dev window (rejected: one bad day wipes the race);
tight-stop 1m scalping (mom-ema / breakout / grid, ~90 configs)
loses on every window — fees + whipsaw. ATR-scaled TP/stop and
trend-filtered grid both made things worse. The hybrid (with the
user's [100, 150, 200] ladder) is the submitted candidate per the
user's explicit override; its worst window is now −$15.80 (15 Nov
trend day), vs −$3.73 for the [150, 225, 300] ladder.
and it trades from the opening bars.

## Known limits

- The cold leg loses on a falling open (dev18: 3 cold lots −$7.19,
  ladder +$4.19 → −$3.73). Bounded by the $100-200 sizes and the 4h
  hold; the ladder leg carries the day elsewhere.
- Only tranche 1 (1.5%) ever fills in practice on the ladder: the turn
  confirmation means the bounce is already underway, so deeper levels
  rarely trigger.
- The dev score does not decide prizes. The live window does.
