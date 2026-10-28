#!/usr/bin/env node
'use strict';
// 探针：把上海格网临时放大到 W/H，验证求解器是否崩溃（无头，不落盘）。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
const REPO = process.cwd();
global.window = global;
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const fakeCtx = new Proxy({}, { get: () => () => {} });
const fakeCanvas = { getContext: () => fakeCtx, width: 0, height: 0, style: {}, addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) };
global.document = { createElement: (t) => (t === 'canvas' ? Object.assign({}, fakeCanvas) : { style: {}, appendChild() {}, addEventListener() {} }), createTextNode: (s) => ({ text: String(s) }), getElementById: () => null, querySelector: () => null, addEventListener() {}, body: { appendChild() {} }, documentElement: { setAttribute() {}, style: { setProperty() {} } } };
if (typeof global.performance === 'undefined') global.performance = { now: () => Date.now() };
const order = ['js/util.js','js/content/config.js','js/content/geo_gz.js','js/geo.js','js/content/data_gz.js','js/content/data_tutorial.js','js/content/geo_hz.js','js/content/data_hz.js','js/content/geo_sz.js','js/content/data_sz.js','js/content/geo_sh.js','js/content/data_sh.js','js/maps.js','js/facility.js','js/city.js','js/metro.js','js/sim.js','js/economy.js','js/macro.js','js/game.js','js/milestones.js'];
for (const f of order) vm.runInThisContext(fs.readFileSync(path.join(REPO, f), 'utf8'), { filename: f });
const CM = global.CM;
const W = parseInt(process.argv[2] || '272', 10), H = parseInt(process.argv[3] || '132', 10);
CM.MAPS.sh.cfg.W = W; CM.MAPS.sh.cfg.H = H; CM.mapId = null;
try {
  const t0 = Date.now();
  const g = CM.Game.create({ name: 'sh', mode: 'free', seed: 19930101 });
  g.model.solveNow(2);
  const ms = Date.now() - t0;
  console.log(`OK  W=${W} H=${H} cells=${W*H} Z=${g.model.Z} build=${ms}ms`);
} catch (e) {
  console.log(`CRASH W=${W} H=${H} cells=${W*H}: ${e && e.message}`);
  console.log((e && e.stack || '').split('\n').slice(0, 4).join('\n'));
}
