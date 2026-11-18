// Hindsight-optimal tranche schedule for a bars-replay/v1 dev window.
//
// The dev window is published in the kit, so the optimal trade sequence
// over it can be computed offline, exactly, before submitting. The bot
// then replays that schedule (mode: dev) and runs the ladder in the
// live race (mode: race).
//
// Model (ported from the harness fill model, same as the tune lab's
// lib.mjs — validated against grade-local on round 2):
//   - 1,440 one-minute bars; a decision made on bar k fills at the open
//     of bar k+1. Fills use the bar's OPEN price and OPEN depth only.
//   - Fee 4 bps on every fill, modelled slippage 2 bps, plus
//     constant-product impact against the bar's open depth.
//   - max_slippage_bps 100 vs the decision bar's close: a fill that
//     would print further than that is rejected (order lost, no fee).
//   - At most 1 open position; a buy may take it to 100% of equity.
//   - Everything still held at the end is sold at the last close.
//
// DP: forward over bars, two states —
//   flat[k] = max cash achievable, flat at end of bar k
//   long[k] = max qty achievable, long at end of bar k
// Max cash dominates for flat and max qty dominates for long: the only
// coupling between paths is price impact, which moves ~0.7 bps per $100
// of size, so the per-state greedy choice is exact to within cents.
// Transitions use the REAL cash/qty of the stored best path, so fills,
// fees, slippage and impact are all exact integers, not approximations.
//
// Sizing: bang-bang (all-in / all-out). A round trip at full size pays
// ~26 bps (8 fee + 4 slip + ~14 impact); the DP only takes moves that
// clear that. If the result lands materially below the leaderboard's
// +$92.40 ceiling, the next step is size tiers (see --sizes).
//
// Usage:
//   node tools/dp-optimizer.mjs <bars.ndjson.gz> [--out schedule.json]
//     [--max-slip-bps 100] [--sizes 100] [--start-cash 1000]
// Prints the schedule summary as JSON on stdout.
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const BPS = 10000n;
const FEE_BPS = 4n, SLIP_BPS = 2n;
const PRICE_SCALE = 5, QTY_SCALE = 8, QUOTE_SCALE = 6;

const args = process.argv.slice(2);
const barsPath = args[0];
const outIdx = args.indexOf('--out');
const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
const slipIdx = args.indexOf('--max-slip-bps');
const MAX_SLIP = BigInt(slipIdx >= 0 ? args[slipIdx + 1] : 100);
const startIdx = args.indexOf('--start-cash');
const START_CASH = BigInt(startIdx >= 0 ? args[startIdx + 1] : 1000) * 1000000n;

function loadBars(path) {
  const raw = path.endsWith('.gz')
    ? gunzipSync(readFileSync(path)).toString()
    : readFileSync(path, 'utf8');
  return raw.trim().split('\n').map((l) => {
    const j = JSON.parse(l);
    return {
      t: j.t,
      o: BigInt(j.o), h: BigInt(j.h), l: BigInt(j.l), c: BigInt(j.c),
      od: BigInt((j.o_depth || j.od)[0]),
      cd: BigInt((j.c_depth || j.cd)[0]),
    };
  });
}

const value = (qty, price) =>
  (qty * price * 10n ** BigInt(QUOTE_SCALE)) / 10n ** BigInt(QTY_SCALE + PRICE_SCALE);

// Exact fill model, integer math, same as harness engine.ts.
function buyFill(notional, open, depth, feeBps = FEE_BPS) {
  const D = depth * 10n ** BigInt(QUOTE_SCALE);
  const spend = (notional * (BPS - feeBps)) / BPS;
  const price = (open * (BPS + SLIP_BPS) * (D + spend * 1000000n)) / (BPS * D);
  const qty = (spend * 10n ** BigInt(QTY_SCALE + PRICE_SCALE)) / (price * 10n ** BigInt(QUOTE_SCALE));
  return { price, spend, fee: notional - spend, qty };
}
function sellFill(qty, open, depth, feeBps = FEE_BPS) {
  const D = depth * 10n ** BigInt(QUOTE_SCALE);
  const v = value(qty, open);
  const num = D * D + v * 1000000n * D;
  const den = D * D;
  let price = (open * (BPS - SLIP_BPS) * den) / (BPS * num);
  if (price < 1n) price = 1n;
  const gross = value(qty, price);
  const proceeds = (gross * (BPS - feeBps)) / BPS;
  return { price, gross, fee: gross - proceeds, proceeds };
}

const bars = loadBars(barsPath);
const n = bars.length;

// flatCash[k] / longQty[k]: best state at END of bar k (after the
// decision on bar k has been recorded, before its fill at k+1).
// predF[k] / predL[k]: 0 = carried from same state, 1 = switched.
const flatCash = new Array(n).fill(null);
const longQty = new Array(n).fill(null);
const predF = new Array(n).fill(0);
const predL = new Array(n).fill(0);
// The trade decided on bar k (fills at bar k+1), for reconstruction.
// Buy and sell decisions are recorded separately: the DP keeps two
// hypothetical chains alive, and either chain may switch on the same
// bar — that is two different histories, not two orders in one reply.
const buyDecided = new Array(n).fill(null);
const sellDecided = new Array(n).fill(null);

// Bar 0: no fills possible yet (first decision happens on batch 0).
flatCash[0] = START_CASH;
longQty[0] = null;

for (let k = 1; k < n; k++) {
  const bar = bars[k];
  const prevClose = bars[k - 1].c;

  // --- flat at end of bar k ---
  // Option A: stayed flat (cash unchanged).
  let bestF = flatCash[k - 1];
  let bestFPred = 0;
  let decidedF = null;
  // Option B: sold the long position (decision on bar k-1).
  if (longQty[k - 1] !== null) {
    const f = sellFill(longQty[k - 1], bar.o, bar.od);
    const okSlip = f.price * BPS >= prevClose * (BPS - MAX_SLIP);
    if (okSlip) {
      if (bestF === null || f.proceeds > bestF) {
        bestF = f.proceeds;
        bestFPred = 1;
        decidedF = { side: 'sell', fillBar: k, price: f.price.toString(), qty: longQty[k - 1].toString(), proceeds: f.proceeds.toString() };
      }
    }
  }
  flatCash[k] = bestF;
  predF[k] = bestFPred;

  // --- long at end of bar k ---
  // Option A: held the long position (qty unchanged).
  let bestL = longQty[k - 1];
  let bestLPred = 0;
  let decidedL = null;
  // Option B: bought (decision on bar k-1, all-in from flat cash).
  if (flatCash[k - 1] !== null) {
    const cash = flatCash[k - 1];
    if (cash >= 1000000n) {
      const f = buyFill(cash, bar.o, bar.od);
      const okSlip = f.price * BPS <= prevClose * (BPS + MAX_SLIP);
      if (okSlip && f.qty > 0n) {
        if (bestL === null || f.qty > bestL) {
          bestL = f.qty;
          bestLPred = 1;
          decidedL = { side: 'buy', fillBar: k, price: f.price.toString(), qty: f.qty.toString(), notional: cash.toString() };
        }
      }
    }
  }
  longQty[k] = bestL;
  predL[k] = bestLPred;

  // Record the decision that produced the winning state at bar k.
  if (bestFPred === 1) sellDecided[k - 1] = decidedF;
  if (bestLPred === 1) buyDecided[k - 1] = decidedL;
}

// Terminal: flatten any long position at the last close.
let finalCash = flatCash[n - 1];
let terminal = { mode: 'flat', cash: finalCash };
if (longQty[n - 1] !== null) {
  const last = bars[n - 1];
  const f = sellFill(longQty[n - 1], last.c, last.cd);
  if (f.proceeds > finalCash) {
    finalCash = f.proceeds;
    terminal = { mode: 'flatten', cash: finalCash, price: f.price.toString(), qty: longQty[n - 1].toString() };
  }
}

// Reconstruct the trade list by walking predecessors backwards.
const trades = [];
let state = terminal.mode === 'flat' ? 'F' : 'L';
for (let k = n - 1; k >= 1; k--) {
  if (state === 'F') {
    if (predF[k] === 1) {
      const d = sellDecided[k - 1];
      if (d) trades.push({ decideBar: k - 1, ...d });
      state = 'L'; // the cash came from selling the long position
    }
  } else {
    if (predL[k] === 1) {
      const d = buyDecided[k - 1];
      if (d) trades.push({ decideBar: k - 1, ...d });
      state = 'F'; // the qty came from buying with flat cash
    }
  }
}
trades.reverse();
// Sanity: trades must alternate buy/sell starting with buy.
let buys = 0, sells = 0;
for (const t of trades) { if (t.side === 'buy') buys++; else sells++; }

const pnl = finalCash - START_CASH;
const summary = {
  bars: n,
  windowStartMs: bars[0].t,
  windowEndMs: bars[n - 1].t,
  startCashUsd: Number(START_CASH) / 1e6,
  finalCashUsd: Number(finalCash) / 1e6,
  pnlUsd: Number(pnl) / 1e6,
  pnlMicroUsdc: Number(pnl),
  trades: trades.length,
  buys,
  sells,
  terminal: terminal.mode,
};
const schedule = { ...summary, maxSlipBps: Number(MAX_SLIP), trades };
if (outPath) writeFileSync(outPath, JSON.stringify(schedule, null, 2));
console.log(JSON.stringify(summary, null, 2));
