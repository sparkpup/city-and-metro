#!/usr/bin/env node
'use strict';
// 无头构建冒烟测试：在 Node 里按 index.html 顺序加载逻辑模块（跳过渲染/UI/存档等浏览器专用模块），
// 用最小 document 垫片跑通 Game.create（含 generate → Model → solveNow），验证 ZONE=8 下上海/苏州不崩溃、产出有限。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const REPO = process.cwd();
// ---- 最小 DOM / 浏览器垫片 ----
global.window = global;
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const fakeCtx = new Proxy({}, { get: () => () => {} });
const fakeCanvas = { getContext: () => fakeCtx, width: 0, height: 0, style: {}, addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) };
global.document = {
  createElement: (t) => (t === 'canvas' ? Object.assign({}, fakeCanvas) : { style: {}, appendChild() {}, addEventListener() {} }),
  createTextNode: (s) => ({ text: String(s) }),
  getElementById: () => null, querySelector: () => null, addEventListener() {}, body: { appendChild() {} },
  documentElement: { setAttribute() {}, style: { setProperty() {} } },
};
if (typeof global.performance === 'undefined') global.performance = { now: () => Date.now() };

// ---- 加载序（index.html 子集，去掉浏览器专用层）----
const order = [
  'js/util.js', 'js/content/config.js', 'js/content/geo_gz.js', 'js/geo.js', 'js/content/data_gz.js',
  'js/content/data_tutorial.js', 'js/content/geo_sz.js', 'js/content/data_sz.js', 'js/content/geo_sh.js', 'js/content/data_sh.js',
  'js/maps.js', 'js/facility.js', 'js/city.js', 'js/metro.js', 'js/sim.js', 'js/economy.js', 'js/macro.js',
  'js/game.js', 'js/milestones.js',
];
for (const f of order) vm.runInThisContext(fs.readFileSync(path.join(REPO, f), 'utf8'), { filename: f });

const CM = global.CM;
function build(id, startId) {
  CM.useMap(id, startId);
  const g = CM.Game.create({ name: id, mode: 'free', seed: 19930101 });
  return g;
}
function finiteArr(a) { for (let k = 0; k < a.length; k++) if (!Number.isFinite(a[k])) return false; return true; }

let fail = 0;
for (const [id, expectZ, expectN] of [['gz', 720, 120 * 96], ['sh', 289, 136 * 132], ['sz', 465, 248 * 116]]) {
  const t0 = Date.now();
  let g;
  try { g = build(id); } catch (e) { console.log(`✗ ${id} 构建抛出异常: ${e.stack || e}`); fail++; continue; }
  const ms = Date.now() - t0;
  const Z = g.model.Z, N = g.city.N;
  const pop = g.model.zPop.reduce((a, b) => a + b, 0);
  const popOK = Number.isFinite(pop) && pop > 0;
  // 再跑若干步，检查 OD/流量有限
  let stepOK = true, shareTxt = 'n/a';
  try {
    g.model.solveNow(8);
    stepOK = finiteArr(g.model.zPop) && finiteArr(g.model.zJobs) && (g.model.share == null || Number.isFinite(g.model.share));
    if (g.model.share != null) shareTxt = g.model.share.toFixed(4);
  } catch (e) { stepOK = false; console.log(`✗ ${id} solveNow 异常: ${e.stack || e}`); }
  const ZOK = (Z === expectZ), NOK = (N === expectN);
  const ok = popOK && stepOK && ZOK && NOK;
  if (!ok) fail++;
  console.log(`${ok ? '✓' : '✗'} ${id.padEnd(3)} 构建=${ms}ms | Z=${Z}(期望${expectZ}${ZOK ? '✓' : '✗'}) N=${N}(期望${expectN}${NOK ? '✓' : '✗'}) 人口=${pop.toFixed(0)} 共享率=${shareTxt} | 人口有限=${popOK} OD有限=${stepOK}`);
}
console.log(fail === 0 ? '\n上海/苏州在 ZONE=8 下构建与求解均无异常，小区数/格数与预期一致。' : `\n${fail} 个地图构建失败。`);
process.exit(fail === 0 ? 0 : 1);
