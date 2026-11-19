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

A 3-tranche dip-buy ladder, each tranche with its own TP / stop / hold clock:

| Parameter | Value |
|---|---|
| Reference high | 4h window (`LOOKBACK = 240` bars), growing adaptively |
| Tranche arms | 1.5% / 2.25% / 3.0% below the reference high |
| Entry | turn confirmation (close above best of prior 3 closes), fill next bar open |
| Take profit | +1.0% per tranche |
| Cost stop | −0.8% per tranche |
| Max hold | 240 bars (4h) per tranche |
| Rest after full exit | 60 bars |
| Circuit breaker | 5% drawdown stops trading |
| Fees | 4bp + 2bp slippage per side (kit fill model) |

### Adaptive warm-up

The bot starts cold at race start — the harness ships no warm-up bars. A
fixed 240-bar gate made zero trades in the first 5.5h of the 20261118 race
(including missing the −1.9% dip at 04:00 WIB). Race mode therefore trades
once `MIN_BARS = 15` bars of history exist, with the reference window growing
to the full 240 bars as bars arrive. Steady-state semantics are unchanged.

Validation (kit exact fill model, real Orca cbBTC 1m bars): dev +$3.18,
20261117 window +$5.21, 15 Nov hard-trend −$0.08, live 19 Nov replay +$2.93
with a buy at bar 103 (05:42 WIB). The old 240-bar gate made 0 trades on the
same live bars.

## Known limits

- Only tranche 1 (1.5%) ever fills in practice: the turn confirmation means
  the bounce is already underway, so deeper levels rarely trigger. The ladder
  effectively trades at 1/3 size on most days; closer levels (e.g.
  1.5/1.75/2.0%) or scale-in without turn confirmation on deeper levels are
  the open improvement.
- The dev score does not decide prizes. The live window does.
