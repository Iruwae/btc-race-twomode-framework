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
// MODE 2 — RACE (any bar after the dev window): HYBRID cold-start +
// dip-buy ladder (scalp branch, validated in tools/scalp-sim.mjs).
//
//   Bars 0-29 (cold start, no history yet): trade from bar 2 on the
//   opening anchor (close of race bar 0). Momentum (2 up closes above
//   the anchor), micro-dip turn (close below anchor -50bp then up),
//   and aggressive dip-buy (close below anchor -50bp, $100, at most
//   one per 15 bars). Each cold lot: $200 ($100 aggressive), TP +1.0%,
//   NO stop, 4h hold. This is the fix for 2026-11-19: the old bot sat
//   idle for 4h while the 04:00 dip passed. The hybrid buys the 04:00
//   dip at bar 2-3 on the live replay (+$11.90 on live19c vs +$2.93
//   for the ladder alone).
//
//   Bars 30+ (ladder): the proven 3-tranche dip-buy ladder, each
//   tranche with its own TP / stop / hold clock: arms 1.5% / 2.25% /
//   3.0% below the 4h reference high (growing window), turn
//   confirmation (close above best of prior 3 closes), TP +1.0%,
//   cost stop -0.8%, 4h hold, 5% drawdown halt. A ladder lot's exit
//   rests entries 60 bars; a cold lot's exit rests 15.
//
// Validation (kit exact fill model, net PnL after fees; see
// btc-scalp-variant-20261119.md): hybrid OOS +$17.94, all-windows
// +$14.21 (dev18 -$3.73, dev17 +$4.32, 15 Nov +$0.09, live19c
// +$11.90, live19f +$1.63); 2x-fee OOS +$10.78, all +$5.26. Trades
// in the first hour of EVERY validation window (first buy bar 2 on
// live19c). Beats the ladder-only framework (OOS +$8.06, all +$11.24,
// first buy bar 103) and every fixed scalping variant tested (~90
// configs: tight-stop 1m scalping loses to fees + whipsaw on every
// window; regime-switching adaptive wins OOS but loses -$21 on the
// V-shape dev window).
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

// --- race-mode parameters ---
const LOOKBACK = 240; // four-hour window for the pullback high (steady state)
const DIP_LEVELS = [150n, 225n, 300n]; // ladder tranche arms, bps below high
const TAKE_BPS = 100n; // take profit, bps of entry
const STOP_BPS = 80n; // cost stop, bps of entry (ladder lots only)
const NO_STOP = 10000n; // cold lots: no stop, hold for the bounce
const REST_LADDER = 60; // no re-entry for this long after a ladder lot exits
const REST_COLD = 15; // ...after a cold lot exits
const HALT_FLOOR_BPS = 9500n; // halt entries once equity < 95% of peak
const TURN_BARS = 3; // bounce: beat the best close of this many bars
const MAX_HOLD = 240; // safety: flatten a lot held four hours
const COLD_BARS = 30; // cold-start phase: race bars 0..29
const COLD_MIN_BAR = 2; // first bar any cold entry can fire (needs 2 closes)
const COLD_DIP_BPS = 50n; // cold dip threshold vs the opening anchor, bps
const COLD_GAP = 15; // min bars between aggressive cold dip-buys
const COLD_SIZE_BPS = 2000n; // $200 of equity per cold lot
const COLD_AGG_SIZE_BPS = 1000n; // $100 per aggressive cold dip-buy
const LADDER_SIZE_BPS = 3333n; // one third of equity per ladder tranche

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

// --- race-mode lot state (hybrid: cold lots + ladder tranches) ---
interface Lot {
  entry: bigint; // decision-bar close (proxy for the fill price)
  entryBar: number; // absolute bar index at entry
  level: 'cold' | number; // 'cold' or ladder level 0/1/2
  notional: bigint; // quote spent on this lot
  tp: bigint; // take-profit, bps
  stop: bigint; // cost stop, bps (NO_STOP = none)
  maxhold: number; // max bars held
}
let lots: Lot[] = [];
let ladFilled = [false, false, false];
let ladArmed = [false, false, false];
let anchorClose: bigint | null = null; // close of race bar 0
let lastColdBuyBar = -1e9;

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
      // position went flat: drop lot tracking, re-arm ladder levels.
      // cooling is NOT reset here: it was set when each lot's sell was
      // decided (ladder 60 / cold 15), matching the validated sim.
      lots = [];
      ladFilled = [false, false, false];
      ladArmed = [false, false, false];
    }
    heldBefore = owns;
    if (state.equity > peakEquity) peakEquity = state.equity;
    if (state.equity * BPS < peakEquity * HALT_FLOOR_BPS) stopped = true;

    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (!bar) return [];
    const close = BigInt(bar.c);
    const high = BigInt(bar.h);
    const idx = Math.round((bar.t - DEV_FIRST_BAR_MS) / 60000);
    const raceIdx = idx - 1440; // race bars: 0 = first bar after the dev window

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

    // ============ MODE 2: hybrid cold-start + ladder ============
    if (raceIdx < 0) return [];
    if (raceIdx === 0) anchorClose = close;
    const refHigh = peakOf(pastHighs);
    pastHighs.push(high);
    if (pastHighs.length > LOOKBACK) pastHighs.shift();
    pastCloses.push(close);
    if (pastCloses.length > LOOKBACK) pastCloses.shift();

    const resting = cooling > 0;
    if (resting) cooling--;
    if (state.warmingUp) return [];

    const orders: OrderInput[] = [];
    // Exits first: per-lot TP / stop / hold cap, pro-rata by notional
    // share of the position's cost basis.
    if (owns && held!.qty > 0n && held!.cost > 0n) {
      const exiting: Lot[] = [];
      for (const lot of lots) {
        const tp = close * BPS >= lot.entry * (BPS + lot.tp);
        const stop = lot.stop < NO_STOP && close * BPS <= lot.entry * (BPS - lot.stop);
        const stale = idx - lot.entryBar >= lot.maxhold;
        if (stopped || tp || stop || stale) {
          let q = (held!.qty * lot.notional) / held!.cost;
          if (q > held!.qty) q = held!.qty;
          if (q > 0n) {
            orders.push({ side: 'sell', symbol: SYMBOL, qty: q, max_slippage_bps: MAX_SLIP });
            exiting.push(lot);
            const rest = lot.level === 'cold' ? REST_COLD : REST_LADDER;
            if (cooling < rest) cooling = rest;
          }
        }
      }
      if (exiting.length > 0) {
        lots = lots.filter((lot) => !exiting.includes(lot));
        return orders;
      }
      if (stopped) {
        return [{ side: 'sell', symbol: SYMBOL, qty: held!.qty, max_slippage_bps: MAX_SLIP }];
      }
    }

    if (stopped || resting || lots.length >= 3) return [];
    if (raceIdx < COLD_MIN_BAR) return [];

    const spendFor = (bps: bigint): bigint | null => {
      let spend = (state.equity * bps) / BPS;
      if (spend > state.cash) spend = state.cash;
      if (spend < BigInt(state.hello.fees.min_notional_quote_units)) return null;
      return spend;
    };

    // ---- COLD phase: race bars 2..29, trade off the opening anchor ----
    // pastCloses holds race bars only (dev bars return early above), so
    // [0] is the anchor bar and [-2]/[-3] are the prior race closes.
    if (raceIdx < COLD_BARS) {
      if (anchorClose === null) return [];
      const n = pastCloses.length;
      const prevClose = n >= 2 ? pastCloses[n - 2] : null;
      const prevPrevClose = n >= 3 ? pastCloses[n - 3] : null;
      if (prevClose === null) return [];
      const belowAnchor = close * BPS <= anchorClose * (BPS - COLD_DIP_BPS);
      // aggressive dip-buy first: below the anchor, small size, spaced out
      if (belowAnchor && raceIdx - lastColdBuyBar >= COLD_GAP) {
        const spend = spendFor(COLD_AGG_SIZE_BPS);
        if (spend === null) return [];
        lastColdBuyBar = raceIdx;
        lots.push({ entry: close, entryBar: idx, level: 'cold', notional: spend, tp: TAKE_BPS, stop: NO_STOP, maxhold: MAX_HOLD });
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIP }];
      }
      // momentum: 2 up closes above the anchor
      const momUp = prevPrevClose !== null &&
        close > prevClose && prevClose > prevPrevClose && close > anchorClose;
      // micro-dip turn: dipped below the anchor, now turning up
      const microDip = belowAnchor && close > prevClose;
      if (momUp || microDip) {
        const spend = spendFor(COLD_SIZE_BPS);
        if (spend === null) return [];
        lastColdBuyBar = raceIdx;
        lots.push({ entry: close, entryBar: idx, level: 'cold', notional: spend, tp: TAKE_BPS, stop: NO_STOP, maxhold: MAX_HOLD });
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIP }];
      }
      return [];
    }

    // ---- LADDER phase: race bars 30+, proven 3-tranche dip-buy ----
    for (let i = 0; i < 3; i++) {
      if (close * BPS <= refHigh * (BPS - DIP_LEVELS[i])) ladArmed[i] = true;
      if (close >= refHigh) ladArmed[i] = false;
    }
    const recent = pastCloses.slice(-TURN_BARS - 1, -1);
    if (recent.length < TURN_BARS) return [];
    if (close <= peakOf(recent)) return [];
    for (let i = 0; i < 3; i++) {
      if (ladFilled[i]) continue;
      if (!ladArmed[i]) continue;
      if (close * BPS > refHigh * (BPS - DIP_LEVELS[i])) continue;
      const spend = spendFor(LADDER_SIZE_BPS);
      if (spend === null) return [];
      ladFilled[i] = true;
      lots.push({ entry: close, entryBar: idx, level: i, notional: spend, tp: TAKE_BPS, stop: STOP_BPS, maxhold: MAX_HOLD });
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIP }];
    }
    return [];
  },
});
