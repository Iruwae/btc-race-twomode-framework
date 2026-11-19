// Scalping race-mode simulator v2: situational scalping entries with
// concurrent lots (maxPos), trailing exits, no-stop mode, grid entries.
// Mirrors main.ts MODE 2 order semantics (decide on closed bars, fill at
// next bar open, max slippage 100bp) and the kit exact fill model
// (4bp fee + 2bp slippage + constant-product pool impact).
// Usage: node tools/scalp-sim.mjs <barsFile> '<configJson>' [cost2x]
// Config: {entry, tp, stop, maxhold, rest, sizeBps, minBars, maxPos,
//   emaFast, emaSlow, emaTrend, brkN, upN, rsiLen, rsiExit,
//   pullLo, pullHi, highN, trailArm, trailGap, exitMode, gridGap, emaGrid}
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
const BPS = 10000n;
const START = 1000_000000n;
const barsPath = process.argv[2];
const cfg = JSON.parse(process.argv[3]);
const COST2X = process.argv[4] === 'cost2x';
const TRACE = process.env.TRACE === '1';
const fmtT = (t) => new Date(t + 7 * 3600 * 1000).toISOString().slice(11, 16) + ' WIB';
const legOf = (lot) => lot.level !== undefined ? 'LAD' + lot.level : (lot.cold ? 'COLD' : 'RANGE');
const FEE = COST2X ? 8n : 4n, SLIP = COST2X ? 4n : 2n;
const raw = barsPath.endsWith('.gz') ? gunzipSync(readFileSync(barsPath)).toString() : readFileSync(barsPath, 'utf8');
const bars = raw.trim().split('\n').map((l) => { const j = JSON.parse(l); return { t: j.t, o: BigInt(j.o), h: BigInt(j.h), l: BigInt(j.l), c: BigInt(j.c), od: BigInt((j.o_depth || j.od)[0]), cd: BigInt((j.c_depth || j.cd)[0]) }; });
const value = (q, p) => (q * p * 10n ** 6n) / 10n ** 13n;
const buyF = (n, o, d) => { const D = d * 10n ** 6n; const spend = (n * (BPS - FEE)) / BPS; const price = (o * (BPS + SLIP) * (D + spend * 1000000n)) / (BPS * D); const qty = (spend * 10n ** 13n) / (price * 10n ** 6n); return { price, spend, qty }; };
const sellF = (q, o, d) => { const D = d * 10n ** 6n; const v = value(q, o); const num = D * D + v * 1000000n * D, den = D * D; let price = (o * (BPS - SLIP) * den) / (BPS * num); if (price < 1n) price = 1n; const gross = value(q, price); const proceeds = (gross * (BPS - FEE)) / BPS; return { price, proceeds }; };

const closes = bars.map(b => Number(b.c));
const highs = bars.map(b => Number(b.h));
const opens = bars.map(b => Number(b.o));
const lows = bars.map(b => Number(b.l));
const ema = (n) => {
  const k = 2 / (n + 1); const out = new Array(closes.length).fill(null);
  let s = 0; for (let i = 0; i < n; i++) s += closes[i];
  out[n - 1] = s / n;
  for (let i = n; i < closes.length; i++) out[i] = closes[i] * k + out[i - 1] * (1 - k);
  return out;
};
const rsi = (n) => {
  const out = new Array(closes.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
  let ag = g / n, al = l / n;
  out[n] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (n - 1) + Math.max(d, 0)) / n;
    al = (al * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
};
const EF = cfg.emaFast || 5, ES = cfg.emaSlow || 13;
const emaF = ema(EF), emaS = ema(ES), ema9 = ema(9), ema30 = ema(30);
const emaT = cfg.emaTrend ? ema(cfg.emaTrend) : null;
const emaTF = cfg.trendFilter ? ema(cfg.trendFilter) : null;
// --- regime indicators (adaptive mode): efficiency ratio + ATR, float ---
const atr = (n) => {
  const out = new Array(closes.length).fill(null);
  // true range per bar in bps of close, Wilder-smoothed
  const trs = closes.map((c, i) => {
    if (i === 0) return (highs[0] - Math.min(highs[0], closes[0])) / closes[0] * 10000;
    const prevC = closes[i - 1];
    const tr = Math.max(highs[i] - Math.min(highs[i], prevC), Math.abs(highs[i] - prevC), Math.abs(Math.min(highs[i], prevC) - prevC));
    return tr / closes[i] * 10000;
  });
  let s = 0; for (let i = 0; i < n; i++) s += trs[i];
  out[n - 1] = s / n;
  for (let i = n; i < closes.length; i++) out[i] = (out[i - 1] * (n - 1) + trs[i]) / n;
  return out;
};
const atr14 = atr(14);
const effRatio = (n) => {
  const out = new Array(closes.length).fill(null);
  for (let i = n; i < closes.length; i++) {
    let path = 0;
    for (let j = i - n + 1; j <= i; j++) path += Math.abs(closes[j] - closes[j - 1]);
    out[i] = path > 0 ? Math.abs(closes[i] - closes[i - n]) / path : 0;
  }
  return out;
};
const er30 = effRatio(30);
const ER_HI = cfg.erHi ?? 0.4, ER_LO = cfg.erLo ?? 0.25;
const ATR_SCALE = !!cfg.atrScale;
const CHOP_MODE = cfg.chopMode || 'sit';
let dipArmed = false;
let ladArmed = [false, false, false], ladFilled = [false, false, false];
let ndLastBar = -1e9; // last no-dip buy bar (cooldown)
let ndRTs = 0, ndWins = 0, ndPnL = 0n; // no-dip buy standalone stats
const LAD_LEVELS = cfg.ladLevels ?? [50, 150, 200]; // bps below the running high (user ladder, first buy at -0.5%)
// Precomputed regime per bar: COLD <30 bars, else ER(30) target with
// 3-bar persistence (a regime only takes over after 3 straight bars).
const regimeArr = (() => {
  const out = new Array(closes.length).fill('COLD');
  let cur = 'COLD', pend = null, cnt = 0;
  for (let k = 30; k < closes.length; k++) {
    const er = er30[k];
    const target = er === null ? cur : er >= ER_HI ? 'TREND' : er <= ER_LO ? 'RANGE' : 'CHOP';
    if (target === cur) { pend = null; cnt = 0; }
    else if (pend !== target) { pend = target; cnt = 1; }
    else if (++cnt >= 3) { cur = target; pend = null; cnt = 0; }
    out[k] = cur;
  }
  return out;
})();
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function adaptiveSignal(k) {
  // returns {tp, stop, maxhold, sizeBps} or null. COLD = bars 0-29.
  const c = closes[k], pc = closes[k - 1];
  let rg = regimeArr[k];
  if (cfg.postCold === 'dip' && k >= 30) rg = 'TREND'; // cold start, then proven dip-buy
  const atrBps = atr14[k] || 15;
  if (rg === 'COLD') {
    const anchor = closes[0];
    const momUp = k >= 2 && c > pc && pc > closes[k - 2] && c > anchor;
    const microDip = c < anchor * 0.995 && c > pc; // turned up after dipping below anchor
    if (cfg.coldAggr && c < anchor * 0.995 && k - lastBuyBar >= (cfg.coldGap ?? 15)) {
      return { tp: 100, stop: 10000, maxhold: cfg.coldHold ?? 240, sizeBps: 1000, cold: true }; // buy the dip now, small
    }
    if (!momUp && !microDip) return null;
    return { tp: 100, stop: 10000, maxhold: cfg.coldHold ?? 240, sizeBps: cfg.coldSize ?? 2000, cold: true };
  }
  if (rg === 'RANGE') {
    if (rsiArr[k] === null || rsiArr[k - 1] === null) return null;
    if (!(rsiArr[k - 1] < 35 && rsiArr[k] >= 35 && c > pc)) return null;
    const tp = ATR_SCALE ? clamp(Math.round(3 * atrBps), 60, 150) : (cfg.rangeTP ?? 100);
    const stop = cfg.rangeStop ?? 10000;
    return { tp, stop, maxhold: cfg.rangeHold ?? 360, sizeBps: cfg.rangeSize ?? 2000 };
  }
  if (rg === 'TREND') {
    // Dip-buy leg. Default 'ladder' = the proven framework: 3 tranches at
    // 150/225/300bp below the running 240-bar high, turn confirmation,
    // TP +1.0% / stop -0.8% / 4h hold per tranche, 60-bar rest after a
    // FULL exit (all tranches flat). 'single' = one tranche at 150bp.
    let h = -Infinity;
    for (let i = Math.max(0, k - 240); i < k; i++) if (highs[i] > h) h = highs[i];
    let m = -Infinity;
    for (let i = k - 3; i < k; i++) if (closes[i] > m) m = closes[i];
    if (cfg.trendLeg === 'single') {
      if (c <= h * (1 - 0.015)) dipArmed = true;
      if (c >= h) dipArmed = false;
      if (!dipArmed || !(c > m) || c > h * (1 - 0.015)) return null;
      const tp = ATR_SCALE ? clamp(Math.round(4 * atrBps), 80, 150) : (cfg.trendTP ?? 100);
      const stop = ATR_SCALE ? clamp(Math.round(2 * atrBps), 40, 100) : (cfg.trendStop ?? 80);
      return { tp, stop, maxhold: cfg.trendHold ?? 240, sizeBps: cfg.trendSize ?? 3333 };
    }
    for (let i = 0; i < 3; i++) {
      if (c <= h * (1 - LAD_LEVELS[i] / 10000)) ladArmed[i] = true;
      if (c >= h) ladArmed[i] = false;
    }
    if (!(c > m)) return null;
    if (cfg.bounceConfirm && !(bars[k].l > bars[k - 1].l)) return null; // best entry: wait for a higher low
    for (let i = 0; i < 3; i++) {
      if (ladFilled[i] || !ladArmed[i]) continue;
      if (c > h * (1 - LAD_LEVELS[i] / 10000)) continue;
      ladFilled[i] = true;
      const tp = ATR_SCALE ? clamp(Math.round(4 * atrBps), 80, 150) : (cfg.trendTP ?? 100);
      const stop = ATR_SCALE ? clamp(Math.round(2 * atrBps), 40, 100) : (cfg.trendStop ?? 80);
      return { tp, stop, maxhold: cfg.trendHold ?? 240, sizeBps: cfg.trendSize ?? 3333, level: i, rest: 60 };
    }
    // No-dip buy (user rule 2026-11-19): momentum clearly up and no
    // pullback forming — buy a tranche now instead of waiting for the
    // -1% leg. One tranche per trigger, 60-bar cooldown, max 3 lots.
    if (cfg.noDip) {
      const nearHigh = c > h * (1 - 0.005);
      const upCloses = k >= 2 && c > closes[k - 1] && closes[k - 1] > closes[k - 2];
      const emaUp = emaF[k] !== null && emaF[k - 1] !== null && c > emaF[k] && emaF[k] > emaF[k - 1];
      const higherLow = k >= 1 && bars[k].l > bars[k - 1].l;
      if (nearHigh && upCloses && emaUp && higherLow && k - ndLastBar >= (cfg.noDipGap ?? 60)) {
        ndLastBar = k;
        return { tp: cfg.trendTP ?? 100, stop: cfg.trendStop ?? 80, maxhold: cfg.trendHold ?? 240, sizeBps: cfg.trendSize ?? 3333, level: 'nd', rest: 60 };
      }
    }
    return null;
  }
  // CHOP
  if (CHOP_MODE === 'tiny') {
    if (rsiArr[k] === null || rsiArr[k - 1] === null) return null;
    if (!(rsiArr[k - 1] < 35 && rsiArr[k] >= 35 && c > pc)) return null;
    return { tp: 60, stop: 10000, maxhold: 120, sizeBps: 1000 };
  }
  return null;
}
const rsiArr = rsi(cfg.rsiLen || 14);

const TP = BigInt(cfg.tp ?? 60), STOP = BigInt(cfg.stop ?? 40);
const NO_STOP = STOP >= 10000n;
const MAXHOLD = cfg.maxhold ?? 45, REST = cfg.rest ?? 15;
const SIZE = BigInt(cfg.sizeBps ?? 3333);
const MINBARS = cfg.minBars ?? (cfg.entry === 'adaptive' ? 2 : 30);
const MAXPOS = cfg.maxPos ?? 1;
const HALT = 9500n;
const BRKN = cfg.brkN || 5, UPN = cfg.upN || 3, HIGHN = cfg.highN || 30;
const PULL_LO = cfg.pullLo ?? 20, PULL_HI = cfg.pullHi ?? 60;
const RSI_EXIT = cfg.rsiExit ?? 30;
const TRAIL_ARM = cfg.trailArm ?? 0, TRAIL_GAP = cfg.trailGap ?? 0;
const EXIT_MODE = cfg.exitMode || 'fixed';
// --- user's trailing exit (2026-11-19): no TP at +1%; arm SL at +utLock
// once +utArm is reached; at +utCont run a continuation analysis —
// hold (trailing) if momentum still up, exit if stalled/reversed.
const UT_ARM = cfg.utArm ?? 150, UT_LOCK = cfg.utLock ?? 100, UT_CONT = cfg.utCont ?? 200;
const UT_GAP = cfg.utGap ?? 50, UT_CHECK = cfg.utCheck || 'ema', UT_RETRACE = cfg.utRetrace ?? 30;
const UT_GRACE = cfg.utGrace ?? 0; // min bars after first +1% touch before a retrace exit may fire
function contCheck(k, which) {
  const c = closes[k];
  if (which === 'hh') return k >= 2 && c > closes[k - 1] && closes[k - 1] > closes[k - 2];
  if (which === 'ema-rsi') return emaF[k] !== null && emaF[k - 1] !== null && c > emaF[k] && emaF[k] > emaF[k - 1] && rsiArr[k] !== null && rsiArr[k] < 70;
  return emaF[k] !== null && emaF[k - 1] !== null && c > emaF[k] && emaF[k] > emaF[k - 1]; // 'ema'
}
const GRID_GAP = cfg.gridGap ?? 15;

function entrySignal(k) {
  if (cfg.entry === 'adaptive') return adaptiveSignal(k);
  if (k < 2) return null;
  const c = closes[k], pc = closes[k - 1];
  const P = { tp: Number(TP), stop: Number(STOP), maxhold: MAXHOLD, sizeBps: Number(SIZE) };
  switch (cfg.entry) {
    case 'mom-ema': {
      if (emaF[k] === null || emaS[k] === null) return null;
      const cross = emaF[k - 1] <= emaS[k - 1] && emaF[k] > emaS[k];
      if (!cross || c <= emaF[k]) return null;
      if (emaT && (emaT[k] === null || c <= emaT[k])) return null;
      return P;
    }
    case 'mom-br': {
      let m = -Infinity;
      for (let i = k - BRKN; i < k; i++) if (closes[i] > m) m = closes[i];
      if (!(c > m && c > opens[k])) return null;
      if (emaT && (emaT[k] === null || c <= emaT[k])) return null;
      return P;
    }
    case 'mom-up': {
      for (let i = 0; i < UPN; i++) if (!(closes[k - i] > closes[k - i - 1])) return null;
      if (!(c > opens[k])) return null;
      if (emaT && (emaT[k] === null || c <= emaT[k])) return null;
      return P;
    }
    case 'mr-rsi': {
      if (rsiArr[k] === null || rsiArr[k - 1] === null) return null;
      return (rsiArr[k - 1] < RSI_EXIT && rsiArr[k] >= RSI_EXIT && c > pc) ? P : null;
    }
    case 'mr-reclaim': {
      if (ema9[k] === null) return null;
      let h = -Infinity;
      for (let i = k - HIGHN; i < k; i++) if (highs[i] > h) h = highs[i];
      const dipBps = (h - c) / h * 10000;
      return (dipBps >= PULL_LO && dipBps <= PULL_HI && c > ema9[k] && c > pc) ? P : null;
    }
    case 'brk': {
      let h = -Infinity;
      for (let i = k - BRKN; i < k; i++) if (highs[i] > h) h = highs[i];
      return (c > h && c > opens[k]) ? P : null;
    }
    case 'grid': {
      if (ema30[k] === null) return null;
      if (!(c < ema30[k])) return null;
      if (emaTF && (emaTF[k] === null || c <= emaTF[k])) return null; // uptrend-only grid
      return P;
    }
    default: return null;
  }
}

let cash = START, cooling = 0, peak = 0n, stopped = false;
let lots = []; // {qty, cost, entryBar, entryPrice, peakSinceEntry, pnl}
let pending = []; // {side, amount|qty, ref, lot}
let trades = 0, wins = 0, fees = 0n, maxDD = 0n, rts = 0, firstHourRT = 0;
let firstBuy = null, lastBuyBar = -1e9;
const totalQty = () => lots.reduce((s, l) => s + l.qty, 0n);
const totalCost = () => lots.reduce((s, l) => s + l.cost, 0n);
for (let k = 0; k < bars.length; k++) {
  const bar = bars[k];
  for (const p of pending) {
    if (p.side === 'buy') {
      const f = buyF(p.amount, bar.o, bar.od);
      if (f.price * BPS <= p.ref * (BPS + 100n) && f.qty > 0n) {
        cash -= p.amount; trades++; fees += p.amount - f.spend;
        const nl = { qty: f.qty, cost: p.amount, entryBar: k, entryPrice: bar.c, peakSinceEntry: bar.c, pnl: -p.amount, tp: BigInt(p.tp), stop: BigInt(p.stop), maxhold: p.maxhold, level: p.level, cold: p.cold, armed: false, riding: false, analyzed: false, touched100: false, touched100Bar: 0 };
        lots.push(nl);
        if (TRACE) console.error(`BUY  bar ${k} ${fmtT(bar.t)} ${legOf(nl)} $${Number(p.amount) / 1e6} @ ${Number(bar.o) / 1e5}`);
        lastBuyBar = k;
      }
      // buy rejected (fill moved >100bp): no lot opened, nothing lost.
    } else {
      const f = sellF(p.qty, bar.o, bar.od);
      if (f.price * BPS >= p.ref * (BPS - 100n)) {
        cash += f.proceeds; trades++; fees += value(p.qty, f.price) - f.proceeds;
        p.lot.pnl += f.proceeds;
        if (p.lot.pnl > 0n) wins++;
        if (p.lot.level === 'nd') { ndPnL += p.lot.pnl; ndRTs++; if (p.lot.pnl > 0n) ndWins++; }
        rts++;
        if (p.lot.entryBar < 60) firstHourRT++;
        if (TRACE) console.error(`SELL bar ${k} ${fmtT(bar.t)} ${legOf(p.lot)} $${Number(f.proceeds) / 1e6} lotPnL $${(Number(p.lot.pnl) / 1e6).toFixed(2)} entryBar ${p.lot.entryBar}`);
        cooling = p.rest ?? REST;
        // ladder full exit: no ladder lots left open -> re-arm all levels
        // (no-dip lots do not block the ladder re-arm)
        if (typeof p.lot.level === 'number' && !lots.some(l => typeof l.level === 'number')) {
          ladFilled = [false, false, false];
          ladArmed = [false, false, false];
        }
      } else {
        // sell rejected (price moved >100bp against the decision close):
        // the position is STILL HELD — re-open the lot so the bot can
        // retry next bar, exactly like the real harness. Never vaporize.
        lots.push(p.lot);
      }
    }
  }
  pending = [];
  const qty = totalQty();
  const equity = cash + value(qty, bar.c);
  if (equity > peak) peak = equity;
  if (equity * BPS < peak * HALT) stopped = true;
  const dd = peak > 0n ? (peak - equity) * BPS / peak : 0n;
  if (dd > maxDD) maxDD = dd;
  if (cooling > 0) cooling--;
  const close = bar.c;
  // exits per lot
  const exiting = [];
  for (const lot of lots) {
    if (close > lot.peakSinceEntry) lot.peakSinceEntry = close;
    if (EXIT_MODE === 'utrail') {
      // User's trailing exit: no fixed TP at +1%; arm SL at +UT_LOCK once
      // +UT_ARM is reached; at +UT_CONT run a continuation analysis.
      const unrealBps = Number((close - lot.entryPrice) * 10000n / lot.entryPrice);
      if (unrealBps >= 100 && !lot.touched100) { lot.touched100 = true; lot.touched100Bar = k; }
      if (!lot.armed && unrealBps >= UT_ARM) lot.armed = true;
      let trailExit = false;
      if (lot.armed && !lot.riding) {
        if (close * BPS <= lot.entryPrice * (BPS + BigInt(UT_LOCK))) trailExit = true;
      }
      if (!trailExit && !lot.analyzed && unrealBps >= UT_CONT) {
        lot.analyzed = true;
        if (contCheck(k, UT_CHECK)) lot.riding = true;
        else trailExit = true;
      }
      if (!trailExit && lot.riding) {
        const lockPx = lot.entryPrice * (BPS + BigInt(UT_LOCK)) / BPS;
        const trailPx = lot.peakSinceEntry * (BPS - BigInt(UT_GAP)) / BPS;
        const slPx = trailPx > lockPx ? trailPx : lockPx;
        if (close <= slPx) trailExit = true;
        else if (cfg.utEmaExit !== false && emaF[k] !== null && close < emaF[k]) trailExit = true; // lost the short trend
      }
      // Fallback: touched +1% but never armed, then fell back below
      // +UT_RETRACE — take the small win instead of riding it to the
      // hard stop / MAXHOLD. UT_RETRACE 0 disables this.
      if (!trailExit && !lot.armed && lot.touched100 && UT_RETRACE > 0 && unrealBps < UT_RETRACE && k - lot.touched100Bar >= UT_GRACE) trailExit = true;
      const stop = lot.stop < 10000n && close * BPS <= lot.entryPrice * (BPS - lot.stop);
      const stale = k - lot.entryBar >= lot.maxhold;
      if (stopped || trailExit || stop || stale) exiting.push(lot);
      continue;
    }
    const tp = close * BPS >= lot.entryPrice * (BPS + lot.tp);
    let stopPx = lot.entryPrice * (BPS - lot.stop);
    if (EXIT_MODE === 'trail' && TRAIL_ARM > 0) {
      const armPx = lot.entryPrice * (BPS + BigInt(TRAIL_ARM));
      if (lot.peakSinceEntry >= armPx) {
        const trailPx = lot.peakSinceEntry * (BPS - BigInt(TRAIL_GAP)) / BPS;
        if (trailPx > stopPx) stopPx = trailPx;
      }
    }
    const stop = lot.stop < 10000n && close * BPS <= stopPx;
    const stale = k - lot.entryBar >= lot.maxhold;
    if (stopped || tp || stop || stale) exiting.push(lot);
  }
  for (const lot of exiting) {
    pending.push({ side: 'sell', qty: lot.qty, ref: close, lot, rest: lot.level !== undefined ? 60 : undefined });
    lots.splice(lots.indexOf(lot), 1);
    // cooling is set only when the sell actually fills (see pending loop);
    // a rejected sell leaves the lot open and re-tries next bar.
  }
  if (exiting.length > 0) continue;
  if (stopped || cooling > 0 || k < MINBARS) continue;
  if (lots.length >= (cfg.entry === 'adaptive' ? 3 : MAXPOS)) continue;
  if (cfg.entry === 'grid' && k - lastBuyBar < GRID_GAP) continue;
  const sig = entrySignal(k);
  if (!sig) continue;
  let spend = (equity * BigInt(sig.sizeBps)) / BPS;
  if (spend > cash) spend = cash;
  if (spend < 1000000n) continue;
  if (!firstBuy) firstBuy = { bar: k, t: bar.t };
  pending.push({ side: 'buy', amount: spend, ref: close, tp: sig.tp, stop: sig.stop, maxhold: sig.maxhold, level: sig.level, rest: sig.rest, cold: sig.cold });
}
if (lots.length > 0 || pending.length > 0) {
  const last = bars[bars.length - 1];
  // Settle orders still pending at end of data at the last bar's close
  // (the real harness fills them on the next batch; dropping them would
  // vaporize a whole lot — a $200-333 accounting artifact, not a loss).
  for (const p of pending) {
    if (p.side === 'buy') {
      const f = buyF(p.amount, last.c, last.cd);
      if (f.qty > 0n) { cash -= p.amount; trades++; fees += p.amount - f.spend; lots.push({ qty: f.qty, cost: p.amount, entryBar: bars.length - 1, entryPrice: last.c, peakSinceEntry: last.c, pnl: -p.amount, tp: BigInt(p.tp), stop: BigInt(p.stop), maxhold: p.maxhold, level: p.level, armed: false, riding: false, analyzed: false, touched100: false, touched100Bar: 0 }); }
    } else {
      const f = sellF(p.qty, last.c, last.cd);
      cash += f.proceeds; trades++; fees += value(p.qty, f.price) - f.proceeds;
      p.lot.pnl += f.proceeds;
      if (p.lot.pnl > 0n) wins++;
      if (p.lot.level === 'nd') { ndPnL += p.lot.pnl; ndRTs++; if (p.lot.pnl > 0n) ndWins++; }
      rts++;
      if (p.lot.entryBar < 60) firstHourRT++;
    }
  }
  pending = [];
  for (const lot of lots) {
    const f = sellF(lot.qty, last.c, last.cd);
    cash += f.proceeds; trades++; fees += value(lot.qty, f.price) - f.proceeds;
    lot.pnl += f.proceeds;
    if (lot.pnl > 0n) wins++;
    if (lot.level === 'nd') { ndPnL += lot.pnl; ndRTs++; if (lot.pnl > 0n) ndWins++; }
    rts++;
    if (lot.entryBar < 60) firstHourRT++;
  }
  lots = [];
}
const pnl = cash - START;
const rtPerDay = +(rts / (bars.length / 1440)).toFixed(1);
const firstHour = firstHourRT;
console.log(JSON.stringify({ entry: cfg.entry, tp: cfg.tp, stop: cfg.stop, maxhold: MAXHOLD, rest: REST, sizeBps: Number(SIZE), maxPos: MAXPOS, cost2x: COST2X, pnl: Number(pnl) / 1e6, trades, roundTrips: rts, rtPerDay, firstHourRT: firstHour, wins, winRate: rts ? +(wins / rts).toFixed(2) : 0, fees: Number(fees) / 1e6, maxDD: Number(maxDD) / 10000, bars: bars.length, firstBuyBar: firstBuy ? firstBuy.bar : null, firstBuyT: firstBuy ? firstBuy.t : null, ndRTs, ndWins, ndPnL: Number(ndPnL) / 1e6 }));
