// Ladder race-mode simulator: mirrors main.ts MODE 2 exactly (same
// params, same order semantics), run over historical bars to validate
// the ladder before it ever races. Fill model identical to lib.mjs.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
const BPS = 10000n, FEE = 4n, SLIP = 2n;
const START = 1000_000000n;
const barsPath = process.argv[2];
const raw = barsPath.endsWith('.gz') ? gunzipSync(readFileSync(barsPath)).toString() : readFileSync(barsPath, 'utf8');
const bars = raw.trim().split('\n').map((l) => { const j = JSON.parse(l); return { t: j.t, o: BigInt(j.o), h: BigInt(j.h), l: BigInt(j.l), c: BigInt(j.c), od: BigInt((j.o_depth || j.od)[0]), cd: BigInt((j.c_depth || j.cd)[0]) }; });
const value = (q, p) => (q * p * 10n ** 6n) / 10n ** 13n;
const buyF = (n, o, d) => { const D = d * 10n ** 6n; const spend = (n * (BPS - FEE)) / BPS; const price = (o * (BPS + SLIP) * (D + spend * 1000000n)) / (BPS * D); const qty = (spend * 10n ** 13n) / (price * 10n ** 6n); return { price, spend, qty }; };
const sellF = (q, o, d) => { const D = d * 10n ** 6n; const v = value(q, o); const num = D * D + v * 1000000n * D, den = D * D; let price = (o * (BPS - SLIP) * den) / (BPS * num); if (price < 1n) price = 1n; const gross = value(q, price); const proceeds = (gross * (BPS - FEE)) / BPS; return { price, proceeds }; };

const LOOKBACK = Number(process.argv[3] || 240), MINBARS = Number(process.argv[4] || 0);
// MINBARS>0 = adaptive warm-up: trade once MINBARS bars of history exist,
// with the reference window growing to LOOKBACK (kills the cold-start blind
// spot while keeping the LOOKBACK-high semantics in steady state).
const WARM = MINBARS > 0 ? MINBARS : LOOKBACK;
const DIP = [150n, 225n, 300n], TAKE = 100n, STOP = 80n, REST = 60, HALT = 9500n, TURN = 3, MAXHOLD = 240;
const pastH = [], pastC = [];
let cash = START, qty = 0n, cost = 0n, cooling = 0, peak = 0n, stopped = false, wasHeld = false;
let tranches = [], filled = [false, false, false], armed = [false, false, false];
let pending = [];
let trades = 0, wins = 0, fees = 0n, maxDD = 0n, roundPnl = 0n, rts = 0;
let firstBuy = null; // {bar, t} of the first buy decision
const peakOf = (a) => { let t = 0n; for (const v of a) if (v > t) t = v; return t; };
for (let k = 0; k < bars.length; k++) {
  const bar = bars[k];
  for (const p of pending) {
    if (p.side === 'buy') {
      const f = buyF(p.amount, bar.o, bar.od);
      if (f.price * BPS <= p.ref * (BPS + 100n) && f.qty > 0n) {
        cash -= p.amount; qty += f.qty; cost += p.amount; trades++; fees += p.amount - f.spend; roundPnl = -p.amount;
        tranches.push({ entry: p.entry, entryBar: p.entryBar, level: p.level, notional: p.amount });
      }
    } else {
      const f = sellF(p.qty, bar.o, bar.od);
      if (f.price * BPS >= p.ref * (BPS - 100n)) {
        cash += f.proceeds; cost = (cost * (qty - p.qty)) / qty; qty -= p.qty; trades++; fees += value(p.qty, f.price) - f.proceeds; roundPnl += f.proceeds;
        if (qty === 0n) { if (roundPnl > 0n) wins++; rts++; }
      }
    }
  }
  pending = [];
  const owns = qty > 0n;
  if (wasHeld && !owns) { cooling = REST; tranches = []; filled = [false, false, false]; armed = [false, false, false]; }
  wasHeld = owns;
  const equity = cash + value(qty, bar.c);
  if (equity > peak) peak = equity;
  if (equity * BPS < peak * HALT) stopped = true;
  const dd = peak > 0n ? (peak - equity) * BPS / peak : 0n;
  if (dd > maxDD) maxDD = dd;
  const close = bar.c, high = bar.h;
  const warmed = pastH.length >= WARM;
  const refHigh = peakOf(pastH);
  pastH.push(high); if (pastH.length > LOOKBACK) pastH.shift();
  pastC.push(close); if (pastC.length > LOOKBACK) pastC.shift();
  const resting = cooling > 0; if (resting) cooling--;
  if (owns) {
    let sold = false;
    for (const tr of [...tranches]) {
      const tp = close * BPS >= tr.entry * (BPS + TAKE);
      const stop = close * BPS <= tr.entry * (BPS - STOP);
      const stale = k - tr.entryBar >= MAXHOLD;
      if (stopped || tp || stop || stale) {
        let q = (qty * tr.notional) / cost;
        if (q > qty) q = qty;
        if (q > 0n) { pending.push({ side: 'sell', qty: q, ref: close }); tranches.splice(tranches.indexOf(tr), 1); sold = true; }
      }
    }
    if (sold) continue;
    if (stopped) { pending.push({ side: 'sell', qty, ref: close }); tranches = []; continue; }
    continue;
  }
  if (stopped || resting || !warmed) continue;
  for (let i = 0; i < 3; i++) {
    if (close * BPS <= refHigh * (BPS - DIP[i])) armed[i] = true;
    if (close >= refHigh) armed[i] = false;
  }
  const recent = pastC.slice(-TURN - 1, -1);
  if (recent.length < TURN) continue;
  if (close <= peakOf(recent)) continue;
  if (tranches.length >= 3) continue;
  for (let i = 0; i < 3; i++) {
    if (filled[i] || !armed[i]) continue;
    if (close * BPS > refHigh * (BPS - DIP[i])) continue;
    let spend = equity / 3n;
    if (spend > cash) spend = cash;
    if (spend < 1000000n) continue;
    filled[i] = true;
    if (!firstBuy) firstBuy = { bar: k, t: bar.t };
    pending.push({ side: 'buy', amount: spend, ref: close, entry: close, entryBar: k, level: i });
    break;
  }
}
if (qty > 0n) { const last = bars[bars.length - 1]; const f = sellF(qty, last.c, last.cd); cash += f.proceeds; roundPnl += f.proceeds; if (roundPnl > 0n) wins++; rts++; qty = 0n; }
const pnl = cash - START;
console.log(JSON.stringify({ lookback: LOOKBACK, minBars: MINBARS, pnl: Number(pnl) / 1e6, trades, roundTrips: rts, wins, fees: Number(fees) / 1e6, maxDD: Number(maxDD) / 10000, bars: bars.length, firstBuyBar: firstBuy ? firstBuy.bar : null, firstBuyT: firstBuy ? firstBuy.t : null }));
