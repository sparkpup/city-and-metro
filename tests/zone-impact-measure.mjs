#!/usr/bin/env node
'use strict';
// 测量 ZONE 4→8 对上海/苏州的实际影响：小区数、构建耗时、日均地铁客流(zMetro)、
// 总出行(zTrips)与地铁分担率(share)。每次构建前强制重应用 cfg.ZONE（绕过 useMap 缓存）。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const REPO = process.cwd();
global.window = global;
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const fakeCtx = new Proxy({}, { get: () => () => {} });
const fakeCanvas = { getContext: () => fakeCtx, width: 0, height: 0, style: {}, addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) };
global.document = {
  createElement: (t) => (t === 'canvas' ? Object.assign({}, fakeCanvas) : { style: {}, appendChild() {}, addEventListener() {} }),
  createTextNode: (s) => ({ text: String(s) }), getElementById: () => null, querySelector: () => null,
  addEventListener() {}, body: { appendChild() {} }, documentElement: { setAttribute() {}, style: { setProperty() {} } },
};
if (typeof global.performance === 'undefined') global.performance = { now: () => Date.now() };

const order = [
  'js/util.js', 'js/content/config.js', 'js/content/geo_gz.js', 'js/geo.js', 'js/content/data_gz.js',
  'js/content/data_tutorial.js', 'js/content/geo_hz.js', 'js/content/data_hz.js',
  'js/content/geo_sz.js', 'js/content/data_sz.js', 'js/content/geo_sh.js', 'js/content/data_sh.js',
  'js/content/geo_tk.js', 'js/content/data_tk.js',
  'js/maps.js', 'js/facility.js', 'js/city.js', 'js/metro.js', 'js/sim.js', 'js/economy.js', 'js/macro.js',
  'js/game.js', 'js/milestones.js',
];
for (const f of order) vm.runInThisContext(fs.readFileSync(path.join(REPO, f), 'utf8'), { filename: f });
const CM = global.CM;

function build(id, zone) {
  CM.MAPS[id].cfg.ZONE = zone;      // 覆盖该图 ZONE
  CM.mapId = null;                  // 绕过 useMap 缓存，强制重应用 cfg→CFG
  CM.useMap(id);
  const t0 = Date.now();
  const g = CM.Game.create({ name: id, mode: 'free', seed: 19930101 });
  g.model.solveNow(8);
  const ms = Date.now() - t0;
  const d = g.model.daily || {};
  const metro = d.metro || 0, trips = d.trips || 0, share = d.metroShare || 0;
  const net = g.model.net || {};
  return { Z: g.model.Z, N: g.city.N, R: net.R || 0, ms, metro, trips, share };
}

const cities = ['tk', 'hz', 'sh', 'sz'];
const rows = [];
for (const id of cities) {
  const a = build(id, 4), b = build(id, 8);
  const dZ = ((1 - b.Z / a.Z) * 100).toFixed(1);
  const dR = (a.metro ? ((b.metro / a.metro - 1) * 100).toFixed(1) : 'n/a');
  const dS = ((b.share - a.share) * 100).toFixed(2);
  const dMs = ((b.ms / a.ms - 1) * 100).toFixed(0);
  rows.push({ id, a, b, dZ, dR, dS, dMs });
  console.log(`${id}: ZONE4→8  小区 ${a.Z}→${b.Z} (-${dZ}%) | 路网 R=${a.R}/${b.R} 站N=${a.N}/${b.N} | 客流 ${a.metro.toFixed(0)}→${b.metro.toFixed(0)} (${dR}%) | 分担率 ${(a.share*100).toFixed(2)}%→${(b.share*100).toFixed(2)}% (${dS}pp) | 构建 ${a.ms}→${b.ms}ms (${dMs}%)`);
}
// 结论提示
const avgDZ = rows.reduce((s, r) => s + parseFloat(r.dZ), 0) / rows.length;
const avgDR = rows.map(r => parseFloat(r.dR)).reduce((s, v) => s + v, 0) / rows.length;
console.log(`\n平均：小区 -${avgDZ}%，客流 ${avgDR >= 0 ? '+' : ''}${avgDR}%（粗分区略微高估可达性，属预期方向）。`);
