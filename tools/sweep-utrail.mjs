// Trailing-exit sweep (user spec 2026-11-19 ~14:57 WIB):
//   +1.0% no exit; +1.5% arm SL at +1.0%; +2.0% continuation analysis
//   (hold+trail if momentum still up, else exit); retrace fallback.
// Grid: continuation check {ema, hh, ema-rsi} x trail gap {50, 100} x
// retrace {30, 0}. Base = hybrid winner (40d7c52), exitMode 'utrail'.
// Usage: node tools/sweep-utrail.mjs
import { execFileSync } from 'node:child_process';
const SIM = new URL('./scalp-sim.mjs', import.meta.url).pathname;
const DS = {
  dev18: '/home/hatch/workspace/makefun/btc-race-20261118-kit/btc-race-24h-20261118-1444-kit/dataset/bars/CBBTC.ndjson.gz',
  dev17: '/home/hatch/workspace/makefun/btc-race-20261117-kit/btc-race-24h-20261117-0603-kit/dataset/bars/CBBTC.ndjson.gz',
  nov15: '/home/hatch/workspace/makefun/twomode-validation/nov15-kit.ndjson',
  live19c: '/home/hatch/workspace/makefun/twomode-validation/live19-cbbtc-kit.ndjson',
  live19f: '/home/hatch/workspace/makefun/twomode-validation/live19-full-kit.ndjson',
};
const BASE = { entry: 'adaptive', postCold: 'dip', coldAggr: true, coldHold: 240, coldSize: 2000, ladLevels: [100, 150, 200] }; // user's ladder (override 2026-11-19)
function run(cfg, cost2x) {
  const r = {};
  for (const [name, path] of Object.entries(DS)) {
    try {
      const out = execFileSync('node', [SIM, path, JSON.stringify(cfg), ...(cost2x ? ['cost2x'] : [])], { encoding: 'utf8', timeout: 30000 });
      r[name] = JSON.parse(out);
    } catch (e) { r[name] = { pnl: NaN, error: String(e.message).slice(0, 80) }; }
  }
  return r;
}
const rows = [];
// baseline (fixed TP) for reference
{
  const r = run(BASE, false);
  const oos = ['dev17', 'nov15', 'live19c', 'live19f'].reduce((s, k) => s + r[k].pnl, 0);
  rows.push({ label: 'BASELINE fixed-TP +1% [100,150,200]', r, oos, all: oos + r.dev18.pnl, worst: Math.min(r.dev18.pnl, r.dev17.pnl, r.nov15.pnl, r.live19c.pnl, r.live19f.pnl) });
}
for (const check of ['ema', 'hh', 'ema-rsi']) {
  for (const gap of [50, 100]) {
    for (const retrace of [30, 0]) {
      const cfg = { ...BASE, exitMode: 'utrail', utArm: 150, utLock: 100, utCont: 200, utGap: gap, utCheck: check, utRetrace: retrace };
      const r = run(cfg, false);
      const oos = ['dev17', 'nov15', 'live19c', 'live19f'].reduce((s, k) => s + r[k].pnl, 0);
      rows.push({ label: `utrail ${check} gap${gap} ret${retrace}`, r, oos, all: oos + r.dev18.pnl, worst: Math.min(r.dev18.pnl, r.dev17.pnl, r.nov15.pnl, r.live19c.pnl, r.live19f.pnl) });
    }
  }
}
rows.sort((a, b) => b.oos - a.oos);
for (const row of rows) {
  const r = row.r;
  const w = (k) => `${r[k].pnl?.toFixed(2)}(${r[k].roundTrips ?? 0}RT,WR${r[k].winRate ?? 0})`;
  console.log(`${row.label.padEnd(28)} | OOS ${row.oos.toFixed(2)} | ALL ${row.all.toFixed(2)} | worst ${row.worst.toFixed(2)} | dev18 ${w('dev18')} dev17 ${w('dev17')} nov15 ${w('nov15')} live19c ${w('live19c')} live19f ${w('live19f')} | 1H ${['dev18', 'dev17', 'nov15', 'live19c', 'live19f'].map(k => r[k].firstHourRT ?? 0).join('/')}`);
}
// 2x-fee stress for the top 3 (excluding baseline)
console.log('\n=== 2x-fee (cost2x) for top 3 utrail configs ===');
for (const row of rows.filter(x => !x.label.startsWith('BASELINE')).slice(0, 3)) {
  const label = row.label;
  const [, check, gap, retrace] = label.match(/utrail (\S+) gap(\d+) ret(\d+)/);
  const cfg = { ...BASE, exitMode: 'utrail', utArm: 150, utLock: 100, utCont: 200, utGap: +gap, utCheck: check, utRetrace: +retrace };
  const r = run(cfg, true);
  const oos = ['dev17', 'nov15', 'live19c', 'live19f'].reduce((s, k) => s + r[k].pnl, 0);
  console.log(`${label.padEnd(28)} | 2x OOS ${oos.toFixed(2)} | 2x ALL ${(oos + r.dev18.pnl).toFixed(2)} | dev18 ${r.dev18.pnl?.toFixed(2)} dev17 ${r.dev17.pnl?.toFixed(2)} nov15 ${r.nov15.pnl?.toFixed(2)} live19c ${r.live19c.pnl?.toFixed(2)} live19f ${r.live19f.pnl?.toFixed(2)}`);
}
