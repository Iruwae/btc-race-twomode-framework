// Sweep driver: run scalp-sim over a config grid x datasets, rank by
// out-of-sample sum (dev17 + nov15 + live19c + live19f). Usage:
//   node tools/sweep-scalp.mjs [phase]   (phase 1 = entry grid, phase 2 = refine)
import { execFileSync } from 'node:child_process';
const SIM = new URL('./scalp-sim.mjs', import.meta.url).pathname;
const DS = {
  dev18: '/home/hatch/workspace/makefun/btc-race-20261118-kit/btc-race-24h-20261118-1444-kit/dataset/bars/CBBTC.ndjson.gz',
  dev17: '/home/hatch/workspace/makefun/btc-race-20261117-kit/btc-race-24h-20261117-0603-kit/dataset/bars/CBBTC.ndjson.gz',
  nov15: '/home/hatch/workspace/makefun/twomode-validation/nov15-kit.ndjson',
  live19c: '/home/hatch/workspace/makefun/twomode-validation/live19-cbbtc-kit.ndjson',
  live19f: '/home/hatch/workspace/makefun/twomode-validation/live19-full-kit.ndjson',
};
const phase = process.argv[2] || '1';
const grid = [];
if (phase === '1') {
  const add = (entry, tps, stops, holds, extra = {}) => {
    for (const tp of tps) for (const stop of stops) for (const maxhold of holds)
      grid.push({ entry, tp, stop, maxhold, rest: 15, sizeBps: 3333, ...extra });
  };
  add('mom-ema', [60, 100, 150], [40, 80], [30, 60]);
  add('mom-ema', [100], [40, 80], [60], { emaTrend: 60 });
  add('mom-br', [60, 100], [40, 80], [30, 60]);
  add('mr-rsi', [40, 60], [30, 40], [30, 60]);
  add('mr-rsi', [100], [80], [60]);
  add('mr-reclaim', [60, 100], [40, 80], [30, 60]);
  add('brk', [100, 150], [40, 80], [60]);
} else if (phase === '2') {
  // HIGH-FREQUENCY phase (user order: as many scalps as possible).
  // Shorter holds, REST 0/5, lower entry thresholds, smaller sizes,
  // trailing exits, no-stop mean reversion, concurrent lots, grid.
  const add = (c) => grid.push(c);
  // mr-rsi, tighter + more frequent
  for (const rsiExit of [35, 40]) for (const tp of [40, 60]) for (const maxhold of [15, 30])
    add({ entry: 'mr-rsi', tp, stop: 30, maxhold, rest: 0, sizeBps: 2000, rsiExit });
  add({ entry: 'mr-rsi', tp: 60, stop: 40, maxhold: 60, rest: 0, sizeBps: 2000, rsiExit: 35 });
  add({ entry: 'mr-rsi', tp: 60, stop: 40, maxhold: 60, rest: 0, sizeBps: 3333, rsiExit: 35, rsiLen: 7 });
  // mr-rsi, no stop (hold for the bounce, MAXHOLD caps the bleed)
  for (const tp of [60, 100]) for (const maxhold of [120, 240])
    add({ entry: 'mr-rsi', tp, stop: 10000, maxhold, rest: 0, sizeBps: 2000, rsiExit: 35 });
  // mr-rsi trailing: let winners run
  for (const [arm, gap] of [[40, 25], [60, 30]]) for (const rest of [0, 5])
    add({ entry: 'mr-rsi', tp: 200, stop: 40, maxhold: 120, rest, sizeBps: 3333, rsiExit: 35, exitMode: 'trail', trailArm: arm, trailGap: gap });
  // mr-rsi concurrent lots (3 simultaneous scalps)
  for (const maxPos of [2, 3])
    add({ entry: 'mr-rsi', tp: 60, stop: 40, maxhold: 60, rest: 0, sizeBps: 3333, rsiExit: 35, maxPos });
  // mom-up (3 consecutive up closes), fast momentum, REST 0
  for (const tp of [60, 100]) for (const maxhold of [15, 30])
    add({ entry: 'mom-up', tp, stop: 40, maxhold, rest: 0, sizeBps: 3333, upN: 3 });
  for (const maxhold of [15, 30])
    add({ entry: 'mom-up', tp: 100, stop: 40, maxhold, rest: 0, sizeBps: 3333, upN: 2 });
  // mom-br with brkN=3, REST 0
  for (const tp of [60, 100]) for (const maxhold of [15, 30])
    add({ entry: 'mom-br', tp, stop: 40, maxhold, rest: 0, sizeBps: 3333, brkN: 3 });
  // mr-reclaim wider band, REST 0
  for (const maxhold of [15, 30])
    add({ entry: 'mr-reclaim', tp: 60, stop: 40, maxhold, rest: 0, sizeBps: 3333, pullLo: 10, pullHi: 100 });
  // grid: buy below EMA30 every gridGap bars, up to 3 lots
  for (const tp of [40, 60]) for (const maxhold of [120, 240]) for (const gridGap of [10, 15])
    add({ entry: 'grid', tp, stop: 100, maxhold, rest: 0, sizeBps: 2000, maxPos: 3, gridGap });
  // brk trailing
  add({ entry: 'brk', tp: 200, stop: 80, maxhold: 120, rest: 0, sizeBps: 3333, brkN: 10, exitMode: 'trail', trailArm: 60, trailGap: 30 });
} else if (phase === '3') {
  // Phase 3: refine the only positive family (no-stop mean reversion) +
  // trend-filtered grid (the grid's nov15 falling-knife problem).
  const add = (c) => grid.push(c);
  for (const tp of [60, 100, 150]) for (const maxhold of [120, 240, 360]) for (const sizeBps of [2000, 3333])
    add({ entry: 'mr-rsi', tp, stop: 10000, maxhold, rest: 0, sizeBps, rsiExit: 35 });
  for (const tp of [60, 100]) for (const maxhold of [120, 240])
    add({ entry: 'mr-reclaim', tp, stop: 10000, maxhold, rest: 0, sizeBps: 2000, pullLo: 20, pullHi: 60 });
  for (const maxhold of [120, 240])
    add({ entry: 'mom-ema', tp: 100, stop: 10000, maxhold, rest: 0, sizeBps: 2000 });
  // grid, uptrend-only (close > EMA240) — skip buying the falling knife
  for (const tp of [40, 60]) for (const maxhold of [120, 240]) for (const gridGap of [10, 15])
    add({ entry: 'grid', tp, stop: 100, maxhold, rest: 0, sizeBps: 2000, maxPos: 3, gridGap, trendFilter: 240 });
  // grid, smaller size + wider stop
  for (const tp of [60]) for (const maxhold of [240])
    add({ entry: 'grid', tp, stop: 150, maxhold, rest: 0, sizeBps: 1000, maxPos: 3, gridGap: 10, trendFilter: 240 });
} else if (phase === '4') {
  // ADAPTIVE: regime switch (ER30) + cold start from bar 2 + ATR scaling.
  const add = (c) => grid.push(c);
  add({ entry: 'adaptive' }); // A: regime switch, fixed params, chop sits out
  add({ entry: 'adaptive', atrScale: true }); // B: A + ATR-scaled TP/stop
  add({ entry: 'adaptive', chopMode: 'tiny' }); // C: B-style chop tiny scalp
  add({ entry: 'adaptive', atrScale: true, chopMode: 'tiny' });
  add({ entry: 'adaptive', erHi: 0.35, erLo: 0.2 }); // tighter thresholds
  add({ entry: 'adaptive', erHi: 0.45, erLo: 0.3 }); // looser thresholds
  add({ entry: 'adaptive', rangeHold: 240, trendHold: 240 });
  add({ entry: 'adaptive', rangeSize: 3333, trendSize: 3333 });
  // E: phase-3 best fixed scalp + cold start only (isolates cold-start value)
  add({ entry: 'mr-rsi', tp: 100, stop: 10000, maxhold: 360, rest: 0, sizeBps: 3333, rsiExit: 35, minBars: 2 });
} else if (phase === '5') {
  // Phase 5: HYBRID — cold start (bars 0-29) + proven dip-buy after,
  // and RANGE-leg variants that stop the nov15 bleed.
  const add = (c) => grid.push(c);
  add({ entry: 'adaptive', postCold: 'dip' }); // cold start + dip-buy ladder leg
  add({ entry: 'adaptive', postCold: 'dip', coldAggr: true }); // + aggressive cold dip-buy
  add({ entry: 'adaptive', postCold: 'dip', erHi: 0.45, erLo: 0.3 });
  add({ entry: 'adaptive', rangeStop: 100, rangeHold: 120 }); // RANGE with a stop
  add({ entry: 'adaptive', rangeStop: 150, rangeHold: 240 });
  add({ entry: 'adaptive', postCold: 'dip', rangeStop: 100, rangeHold: 120 });
  add({ entry: 'adaptive', postCold: 'dip', coldAggr: true, rangeStop: 100, rangeHold: 120 });
}
const rows = [];
for (const cfg of grid) {
  const r = { cfg };
  for (const [name, path] of Object.entries(DS)) {
    try {
      const out = execFileSync('node', [SIM, path, JSON.stringify(cfg)], { encoding: 'utf8', timeout: 30000 });
      r[name] = JSON.parse(out);
    } catch (e) { r[name] = { error: String(e.message).slice(0, 120) }; }
  }
  const oos = ['dev17', 'nov15', 'live19c', 'live19f'].reduce((s, k) => s + (r[k].pnl ?? 0), 0);
  const all = oos + (r.dev18.pnl ?? 0);
  rows.push({ ...r, oos, all });
  console.log(JSON.stringify({ cfg, dev18: r.dev18.pnl, dev17: r.dev17.pnl, nov15: r.nov15.pnl, live19c: r.live19c.pnl, live19f: r.live19f.pnl, oos: +oos.toFixed(2), all: +all.toFixed(2), rt: ['dev17', 'nov15', 'live19c'].map(k => r[k].roundTrips ?? 0).join('/'), wr: ['dev17', 'nov15', 'live19c'].map(k => r[k].winRate ?? 0).join('/'), fh: ['dev18','dev17','nov15','live19c','live19f'].map(k => r[k].firstHourRT ?? 0).join('/') }));
}
rows.sort((a, b) => b.oos - a.oos);
console.log('\n=== TOP 10 by OOS (dev17+nov15+live19c+live19f) ===');
for (const r of rows.slice(0, 10)) {
  console.log(`${r.oos.toFixed(2)} | ${r.cfg.entry} tp${r.cfg.tp} st${r.cfg.stop} hold${r.cfg.maxhold} size${r.cfg.sizeBps} rest${r.cfg.rest}${r.cfg.maxPos > 1 ? ' maxPos' + r.cfg.maxPos : ''}${r.cfg.emaTrend ? ' trend' + r.cfg.emaTrend : ''}${r.cfg.rsiExit && r.cfg.rsiExit !== 30 ? ' rsiX' + r.cfg.rsiExit : ''}${r.cfg.rsiLen ? ' rsiLen' + r.cfg.rsiLen : ''}${r.cfg.brkN && r.cfg.brkN !== 5 ? ' brkN' + r.cfg.brkN : ''}${r.cfg.upN ? ' upN' + r.cfg.upN : ''}${r.cfg.gridGap ? ' gap' + r.cfg.gridGap : ''}${r.cfg.exitMode === 'trail' ? ' trail' + r.cfg.trailArm + '/' + r.cfg.trailGap : ''} | dev18 ${r.dev18.pnl?.toFixed(2)} dev17 ${r.dev17.pnl?.toFixed(2)} nov15 ${r.nov15.pnl?.toFixed(2)} live19c ${r.live19c.pnl?.toFixed(2)} live19f ${r.live19f.pnl?.toFixed(2)} | RT/d ${['dev17', 'nov15', 'live19c', 'live19f'].map(k => r[k].rtPerDay).join('/')} 1H ${['dev18','dev17','nov15','live19c','live19f'].map(k => r[k].firstHourRT ?? 0).join('/')} WR ${['dev17', 'nov15', 'live19c', 'live19f'].map(k => r[k].winRate).join('/')}`);
}
