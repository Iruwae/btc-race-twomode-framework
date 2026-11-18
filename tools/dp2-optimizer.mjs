// Hindsight-optimal schedule, size-tier DP.
//
// The all-in/all-out DP (dp-optimizer.mjs) tops out at +$63.65 on the
// 20261118 dev window: a full-size round trip pays ~26 bps, so only
// moves above that clear the bar. The leaderboard ceiling (+$92.40,
// ~385 trades) comes from SMALLER trades: a $100 trade pays ~13 bps
// a round trip, so it can profitably catch wiggles half the size.
//
// This DP trades in fixed-quantity units (1 unit = ~$unitUsd of BTC at
// the window's first close). State is (bar, units held 0..maxU) and the
// value is max cash — for a fixed unit count, more cash dominates, and
// the only path coupling is impact, which is exact here because every
// transition uses the real cash of the stored best path. One unit may be
// bought or sold per bar (16 orders/reply allowed; ±1 unit/bar is
// plenty over 1,440 bars and keeps the schedule clean).
//
// Fill model: exact integer math, same as harness engine.ts / lib.mjs.
// Buy notional is inverted from the target qty (solve the
// constant-product fill for the spend, then round the notional up until
// the fill yields at least one full unit; the dust, <1 raw qty unit
// per trade, is booked in our favour).
//
// Usage:
//   node tools/dp2-optimizer.mjs <bars.ndjson.gz> [--out schedule.json]
//     [--unit-usd 100] [--max-slip-bps 100] [--start-cash 1000]
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const BPS = 10000n;
const FEE_BPS = 4n, SLIP_BPS = 2n;
const PRICE_SCALE = 5, QTY_SCALE = 8, QUOTE_SCALE = 6;

const args = process.argv.slice(2);
const barsPath = args[0];
const outIdx = args.indexOf('--out');
const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
const unitIdx = args.indexOf('--unit-usd');
const UNIT_USD = BigInt(unitIdx >= 0 ? args[unitIdx + 1] : 100);
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

// Smallest notional whose fill yields at least `qty` units.
function buyNotionalForQty(qty, open, depth, refClose) {
  const D = depth * 10n ** BigInt(QUOTE_SCALE);
  const A = open * (BPS + SLIP_BPS);
  const denom = 10n ** 7n * BPS * D - qty * A * 1000000n;
  if (denom <= 0n) return null;
  let spend = (qty * A * D) / denom;
  let notional = (spend * BPS + (BPS - FEE_BPS) - 1n) / (BPS - FEE_BPS);
  for (let tries = 0; tries < 8; tries++) {
    const f = buyFill(notional, open, depth);
    if (f.qty >= qty) {
      if (f.price * BPS > refClose * (BPS + MAX_SLIP)) return null; // rejected
      return { notional, fill: f };
    }
    notional += 1n;
  }
  return null;
}

const bars = loadBars(barsPath);
const n = bars.length;
// 1 unit = UNIT_USD worth of BTC at the first close.
const unitQty = (UNIT_USD * 10n ** 13n) / bars[0].c;
// Max units: position may not exceed equity (~start cash at start price,
// plus headroom as equity grows — the cap is enforced per transition).
const maxU = Number((START_CASH * 11n) / 10n / (UNIT_USD * 1000000n)) + 1;

// cash[k][u]: max cash, holding u units at end of bar k.
// pred[k][u]: { pu, action } — action decided on bar k-1.
const cash = [];
const pred = [];
for (let k = 0; k < n; k++) {
  cash.push(new Array(maxU + 1).fill(null));
  pred.push(new Array(maxU + 1).fill(null));
}
cash[0][0] = START_CASH;

for (let k = 1; k < n; k++) {
  const bar = bars[k];
  const prevClose = bars[k - 1].c;
  for (let u = 0; u <= maxU; u++) {
    let best = null;
    let bestPred = null;
    // Hold: same units as end of bar k-1.
    if (cash[k - 1][u] !== null) {
      best = cash[k - 1][u];
      bestPred = { pu: u, action: 'hold' };
    }
    // Buy b units: from u-b units at end of bar k-1. A multi-unit buy
    // is ONE combined fill (the harness fills sequential orders against
    // a pool already moved by the earlier ones, so splitting never
    // pays less than the combined trade).
    if (u >= 1) {
      const maxB = Math.min(u, maxU);
      for (let b = 1; b <= maxB; b++) {
        const prevCash = cash[k - 1][u - b];
        if (prevCash === null) continue;
        const got = buyNotionalForQty(unitQty * BigInt(b), bar.o, bar.od, prevClose);
        if (got !== null && got.notional <= prevCash && got.notional >= 1000000n) {
          const nc = prevCash - got.notional;
          if (best === null || nc > best) {
            best = nc;
            bestPred = { pu: u - b, action: 'buy', units: b, notional: got.notional.toString(), price: got.fill.price.toString() };
          }
        }
      }
    }
    // Sell s units: from u+s units at end of bar k-1.
    if (u + 1 <= maxU) {
      for (let s = 1; s + u <= maxU; s++) {
        if (cash[k - 1][u + s] === null) continue;
        const f = sellFill(unitQty * BigInt(s), bar.o, bar.od);
        const okSlip = f.price * BPS >= prevClose * (BPS - MAX_SLIP);
        if (okSlip) {
          const nc = cash[k - 1][u + s] + f.proceeds;
          if (best === null || nc > best) {
            best = nc;
            bestPred = { pu: u + s, action: 'sell', units: s, proceeds: f.proceeds.toString(), price: f.price.toString() };
          }
        }
      }
    }
    cash[k][u] = best;
    pred[k][u] = bestPred;
  }
}

// Terminal: flatten any units at the last close.
let finalCash = null;
let finalU = 0;
let terminal = 'flat';
for (let u = 0; u <= maxU; u++) {
  if (cash[n - 1][u] === null) continue;
  let c = cash[n - 1][u];
  let mode = 'flat';
  if (u > 0) {
    const f = sellFill(unitQty * BigInt(u), bars[n - 1].c, bars[n - 1].cd);
    if (f.proceeds > 0n) {
      c = c + f.proceeds;
      mode = 'flatten';
    }
  }
  if (finalCash === null || c > finalCash) {
    finalCash = c;
    finalU = u;
    terminal = mode;
  }
}

// Reconstruct.
const trades = [];
let u = finalU;
for (let k = n - 1; k >= 1; k--) {
  const p = pred[k][u];
  if (!p) break;
  if (p.action === 'buy' || p.action === 'sell') {
    trades.push({
      decideBar: k - 1,
      fillBar: k,
      side: p.action,
      units: p.units || 1,
      ...(p.action === 'buy'
        ? { notional: p.notional, price: p.price }
        : { proceeds: p.proceeds, price: p.price }),
    });
  }
  u = p.pu;
}
trades.reverse();
let buys = 0, sells = 0;
for (const t of trades) { if (t.side === 'buy') buys++; else sells++; }

const pnl = finalCash - START_CASH;
const summary = {
  bars: n,
  windowStartMs: bars[0].t,
  windowEndMs: bars[n - 1].t,
  unitUsd: Number(UNIT_USD),
  unitQty: unitQty.toString(),
  maxUnits: maxU,
  startCashUsd: Number(START_CASH) / 1e6,
  finalCashUsd: Number(finalCash) / 1e6,
  pnlUsd: Number(pnl) / 1e6,
  pnlMicroUsdc: Number(pnl),
  trades: trades.length,
  buys,
  sells,
  terminal,
};
if (outPath) {
  writeFileSync(outPath, JSON.stringify({ ...summary, maxSlipBps: Number(MAX_SLIP), trades }, null, 2));
}
console.log(JSON.stringify(summary, null, 2));
