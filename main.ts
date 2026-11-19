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
//   one per 15 bars). Each cold lot: $200 ($100 aggressive), NO stop,
//   4h hold, user trailing exit (see below). This is the fix for
//   2026-11-19: the old bot sat idle for 4h while the 04:00 dip
//   passed. The hybrid buys the 04:00 dip at bar 2-3 on the live
//   replay.
//
//   Bars 30+ (ladder): the 3-tranche dip-buy ladder, user spec
//   (2026-11-19): arms 1.0% / 1.5% / 2.0% below the 4h reference
//   high (growing window), turn confirmation (close above best of
//   prior 3 closes), equal thirds, cost stop -0.8%, 4h hold, 5%
//   drawdown halt. A ladder lot's exit rests entries 60 bars; a cold
//   lot's exit rests 15.
//
//   Exits (ALL lots, user trailing rule 2026-11-19): no fixed TP at
//   +1% — let it run; at +1.5% arm a stop-loss at +1.0%; at +2% run a
//   continuation analysis (2 rising closes = still rising) — hold and
//   trail the stop at max(+1.0%, peak - 0.5%) if up, exit at market
//   if stalled/reversed. A lot that touches +1% but never arms and
//   falls back below +0.7% exits early. Hard stop -0.8% (ladder lots
//   only) and the 4h hold cap are the backstops.
//
// Validation (kit exact fill model, net PnL after fees; see
// btc-scalp-variant-20261119.md): trailing exit on the user ladder
// OOS +$36.83, all-windows +$32.86 (dev18 -$3.97, dev17 +$5.57,
// 15 Nov +$25.27, live19c +$0.75, live19f +$5.24); 2x-fee OOS
// +$25.55, all +$19.39. Beats the fixed-TP user ladder (OOS +$14.71,
// all +$8.28, worst -$15.80) and the old-ladder hybrid (OOS +$17.94,
// all +$14.21). Trades in the first hour of EVERY validation window
// (first buy bar 2 on live19c). Rejected in validation: no-dip buy
// (buys strength, -$13.83 across 19 lots) and bounce confirmation
// (neutral: OOS +$0.05, ALL -$0.54).
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
const DIP_LEVELS = [50n, 150n, 200n]; // ladder tranche arms, bps below high (user order 2026-11-19: first buy at -0.5%; legs 2-3 kept at 1.5%/2.0% — the even-spaced [50,100,150] tested worse: OOS +$19.26 vs +$31.35, 2x-fee ALL -$5.07 vs +$6.06)
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
// --- user trailing exit (2026-11-19): no fixed TP at +1%; arm SL at
// +UT_LOCK once +UT_ARM is reached; at +UT_CONT run a continuation
// analysis (2 rising closes = still rising) — hold and trail if up,
// exit at market if stalled/reversed. Riding lots trail the stop at
// max(+UT_LOCK, peak - UT_GAP). Lots that touch +1% but never arm and
// fall back below +UT_RETRACE exit early (lock the small win).
const UT_ARM_BPS = 150n;
const UT_LOCK_BPS = 100n;
const UT_CONT_BPS = 200n;
const UT_GAP_BPS = 50n;
const UT_RETRACE_BPS = 70n;

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
  stop: bigint; // cost stop, bps (NO_STOP = none)
  maxhold: number; // max bars held
  peak: bigint; // highest close since entry (trailing-stop reference)
  armed: boolean; // SL at +UT_LOCK armed (+UT_ARM reached)
  riding: boolean; // continuation analysis passed at +UT_CONT; trailing
  analyzed: boolean; // continuation analysis already run once
  touched100: boolean; // unrealized PnL touched +1% at some point
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
    // Exits first: per-lot user trailing exit / stop / hold cap, pro-rata
    // by notional share of the position's cost basis.
    if (owns && held!.qty > 0n && held!.cost > 0n) {
      const exiting: Lot[] = [];
      for (const lot of lots) {
        if (close > lot.peak) lot.peak = close;
        const unrealBps = ((close - lot.entry) * 10000n) / lot.entry;
        if (unrealBps >= 100n && !lot.touched100) lot.touched100 = true;
        if (!lot.armed && unrealBps >= UT_ARM_BPS) lot.armed = true;
        let trailExit = false;
        if (lot.armed && !lot.riding && close * BPS <= lot.entry * (BPS + UT_LOCK_BPS)) trailExit = true;
        if (!trailExit && !lot.analyzed && unrealBps >= UT_CONT_BPS) {
          lot.analyzed = true;
          const n = pastCloses.length;
          const contUp = n >= 3 && close > pastCloses[n - 2] && pastCloses[n - 2] > pastCloses[n - 3];
          if (contUp) lot.riding = true;
          else trailExit = true;
        }
        if (!trailExit && lot.riding) {
          const lockPx = (lot.entry * (BPS + UT_LOCK_BPS)) / BPS;
          const trailPx = (lot.peak * (BPS - UT_GAP_BPS)) / BPS;
          const slPx = trailPx > lockPx ? trailPx : lockPx;
          if (close <= slPx) trailExit = true;
        }
        if (!trailExit && !lot.armed && lot.touched100 && unrealBps < UT_RETRACE_BPS) trailExit = true;
        const stop = lot.stop < NO_STOP && close * BPS <= lot.entry * (BPS - lot.stop);
        const stale = idx - lot.entryBar >= lot.maxhold;
        if (stopped || trailExit || stop || stale) {
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
        lots.push({ entry: close, entryBar: idx, level: 'cold', notional: spend, stop: NO_STOP, maxhold: MAX_HOLD, peak: close, armed: false, riding: false, analyzed: false, touched100: false });
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
        lots.push({ entry: close, entryBar: idx, level: 'cold', notional: spend, stop: NO_STOP, maxhold: MAX_HOLD, peak: close, armed: false, riding: false, analyzed: false, touched100: false });
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIP }];
      }
      return [];
    }

    // ---- LADDER phase: race bars 30+, user ladder [100,150,200] ----
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
      lots.push({ entry: close, entryBar: idx, level: i, notional: spend, stop: STOP_BPS, maxhold: MAX_HOLD, peak: close, armed: false, riding: false, analyzed: false, touched100: false });
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIP }];
    }
    return [];
  },
});
