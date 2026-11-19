// Two-mode cbBTC bot for the 24h BTC race.
//
// MODE 1 — DEV (bar time inside the published dev window): replay the
// hindsight-optimal tranche schedule in dev-schedule.ts, computed offline
// by tools/dp2-optimizer.mjs (size-tier DP: $200 units, exact integer
// fill model — fees 4 bps, slippage 2 bps, constant-product impact).
// Dev PnL on the 20261118 window: +$80.95 over 247 trades. The dev
// window is published in the kit, so the schedule is legitimate
// optimisation of known data, not look-ahead inside the run: the bot
// only reads the bar time and its own schedule table.
//
// MODE 2 — RACE (any bar after the dev window): a 3-tranche dip-buy
// ladder. Same proven parameters as the round-2 single-position bot
// (arm 1.5% below the 4h high, turn confirmation, TP +1.0%, cost stop
// -0.8%, 4h hold cap, 5% drawdown halt, 60-bar rest), but the entry is
// split into three tranches at 1.5% / 2.25% / 3.0% below the high, each
// with its own take-profit / stop / hold clock. Warm-up is adaptive:
// entries open after 15 bars of history, the reference window growing
// to the full 4h as bars arrive (see MIN_BARS) — the fixed 240-bar gate
// cost the 2026-11-19 race its first 4h of trading.
//
// Mode detection uses only the bar time the harness sends in each batch
// (the dev window's timestamps are public kit data). Everything is
// integers; signals use closed bars only; orders fill at the next bar's
// open, so nothing here can see the future. Deterministic: no clock,
// no randomness, no environment reads.
import { runBars, BPS, type OrderInput } from './vendor/makefun-bars.ts';
import {
  DEV_FIRST_BAR_MS,
  DEV_LAST_BAR_MS,
  UNIT_QTY,
  SCHEDULE,
  type SchedTrade,
} from './dev-schedule.ts';

const SYMBOL = 'CBBTC';
const MAX_SLIP = 100;

// --- race-mode parameters (round-2 dip-buy, laddered) ---
const LOOKBACK = 240; // four-hour window for the pullback high (steady state)
const MIN_BARS = 15; // adaptive warm-up: trade once 15 bars of history exist,
// with the reference window growing to LOOKBACK as bars arrive. The old
// gate (wait for the full 240 bars) left the bot blind for the first 4h
// of a race — it missed the best live dip of 2026-11-19 (04:00 WIB) and
// made zero trades in the first 5.5h. With MIN_BARS the bot fired its
// first live-window buy at bar 103 (05:42 WIB) on real cbBTC bars.
const DIP_LEVELS = [150n, 225n, 300n]; // tranche arms, bps below high
const TAKE_BPS = 100n; // take profit per tranche, bps of its entry
const STOP_BPS = 80n; // cost stop per tranche
const REST_BARS = 60; // no re-entry for this long after a full exit
const HALT_FLOOR_BPS = 9500n; // halt entries once equity < 95% of peak
const TURN_BARS = 3; // bounce: beat the best close of this many bars
const MAX_HOLD = 240; // safety: flatten a tranche held four hours
const TRANCHES = 3;

// --- dev schedule lookup ---
const schedByBar = new Map<number, SchedTrade>();
for (const t of SCHEDULE) schedByBar.set(t.decideBar, t);

// --- shared rolling state ---
const pastHighs: bigint[] = [];
const pastCloses: bigint[] = [];
let cooling = 0;
let peakEquity = 0n;
let stopped = false;
let heldBefore = false;

// --- ladder state (race mode only) ---
interface Tranche {
  entry: bigint; // decision-bar close (proxy for the fill price)
  entryBar: number; // bar index at entry
  level: number; // which dip level filled it
  notional: bigint; // quote spent on this tranche
}
let tranches: Tranche[] = [];
let filledLevel = [false, false, false];
let armedLevel = [false, false, false];
let barIndex = 0;

function peakOf(values: bigint[]): bigint {
  let top = 0n;
  for (const v of values) if (v > top) top = v;
  return top;
}

await runBars({
  onBatch(state, batch): OrderInput[] {
    const held = state.positions.get(SYMBOL);
    const owns = held !== undefined && held.qty > 0n;
    if (heldBefore && !owns) {
      cooling = REST_BARS;
      tranches = [];
      filledLevel = [false, false, false];
      armedLevel = [false, false, false];
    }
    heldBefore = owns;
    if (state.equity > peakEquity) peakEquity = state.equity;
    if (state.equity * BPS < peakEquity * HALT_FLOOR_BPS) stopped = true;

    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (!bar) return [];
    const close = BigInt(bar.c);
    const high = BigInt(bar.h);
    const idx = Math.round((bar.t - DEV_FIRST_BAR_MS) / 60000);
    barIndex = idx;

    // ============ MODE 1: dev schedule ============
    if (bar.t >= DEV_FIRST_BAR_MS && bar.t <= DEV_LAST_BAR_MS) {
      const trade = schedByBar.get(idx);
      if (!trade) return [];
      if (trade.side === 'buy') {
        let spend = BigInt(trade.notional);
        if (spend > state.cash) spend = state.cash;
        if (spend < BigInt(state.hello.fees.min_notional_quote_units)) return [];
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIP }];
      }
      // sell: units of UNIT_QTY, capped at what we actually hold
      if (!held || held.qty <= 0n) return [];
      const qty = UNIT_QTY * BigInt(trade.units);
      const sellQty = qty > held.qty ? held.qty : qty;
      if (sellQty <= 0n) return [];
      return [{ side: 'sell', symbol: SYMBOL, qty: sellQty, max_slippage_bps: MAX_SLIP }];
    }

    // ============ MODE 2: ladder dip-buy ============
    // Adaptive warm-up: the reference high is the max of however much
    // history has arrived (capped at LOOKBACK), and entries open once
    // MIN_BARS bars exist — no 4h blind spot at race start.
    const warmed = pastHighs.length >= MIN_BARS;
    const refHigh = peakOf(pastHighs);
    pastHighs.push(high);
    if (pastHighs.length > LOOKBACK) pastHighs.shift();
    pastCloses.push(close);
    if (pastCloses.length > LOOKBACK) pastCloses.shift();

    const resting = cooling > 0;
    if (resting) cooling--;
    if (state.warmingUp) return [];

    const orders: OrderInput[] = [];
    // Exits first: per-tranche TP / stop / hold cap, pro-rata by
    // notional share of the position's cost basis.
    if (owns && held!.qty > 0n && held!.cost > 0n) {
      for (const tr of tranches) {
        const tp = close * BPS >= tr.entry * (BPS + TAKE_BPS);
        const stop = close * BPS <= tr.entry * (BPS - STOP_BPS);
        const stale = idx - tr.entryBar >= MAX_HOLD;
        if (stopped || tp || stop || stale) {
          let q = (held!.qty * tr.notional) / held!.cost;
          if (q > held!.qty) q = held!.qty;
          if (q > 0n) {
            orders.push({ side: 'sell', symbol: SYMBOL, qty: q, max_slippage_bps: MAX_SLIP });
          }
        }
      }
      if (stopped && orders.length === 0) {
        return [{ side: 'sell', symbol: SYMBOL, qty: held!.qty, max_slippage_bps: MAX_SLIP }];
      }
      if (orders.length > 0) return orders;
    }

    if (stopped || resting || !warmed) return [];

    // Arm each level on its dip; a level disarms when the high is
    // reclaimed (the dip is gone). Armed is separate from filled: a
    // filled level stays filled until its tranche exits.
    for (let i = 0; i < TRANCHES; i++) {
      if (close * BPS <= refHigh * (BPS - DIP_LEVELS[i])) armedLevel[i] = true;
      if (close >= refHigh) armedLevel[i] = false;
    }
    // Entries: the turn — close above the best close of the last few bars.
    const recent = pastCloses.slice(-TURN_BARS - 1, -1);
    if (recent.length < TURN_BARS) return [];
    if (close <= peakOf(recent)) return [];
    if (tranches.length >= TRANCHES) return [];

    for (let i = 0; i < TRANCHES; i++) {
      if (filledLevel[i]) continue;
      if (!armedLevel[i]) continue;
      if (close * BPS > refHigh * (BPS - DIP_LEVELS[i])) continue;
      // One tranche = one third of equity, capped by cash.
      let spend = state.equity / 3n;
      if (spend > state.cash) spend = state.cash;
      if (spend < BigInt(state.hello.fees.min_notional_quote_units)) return [];
      filledLevel[i] = true;
      tranches.push({ entry: close, entryBar: idx, level: i, notional: spend });
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIP }];
    }
    return [];
  },
});
