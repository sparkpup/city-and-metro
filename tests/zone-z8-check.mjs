#!/usr/bin/env node
'use strict';
// 验证「容错小区」逻辑（sim.js / city.js 改动后）：
//   1) 非整除格网（上海 136×132 @ ZONE=8、苏州 248×116 @ ZONE=8）下，
//      zoneOf 必须落在 [0, Z) 且每个格恰好归属一个小区；skim 数组 Z*Z 不越界。
//   2) 整除格网（六图 ZONE=4）行为与原公式完全一致（零回归）。
// 本脚本复刻改动后的 zoneOf 与 zoneCells，不依赖游戏运行环境。

function zoneOf(W, H, ZONE, c) {
  const Z = ZONE, ZW = Math.ceil(W / Z), ZH = Math.ceil(H / Z);
  const i = c % W, j = (c / W) | 0;
  const zi = Math.min((i / Z) | 0, ZW - 1), zj = Math.min((j / Z) | 0, ZH - 1);
  return zj * ZW + zi;
}
function build(W, H, ZONE) {
  const Z = ZONE, ZW = Math.ceil(W / Z), ZH = Math.ceil(H / Z), ZN = ZW * ZH;
  const zoneCells = [];
  for (let z = 0; z < ZN; z++) {
    const zi = z % ZW, zj = (z / ZW) | 0, arr = [];
    const j0 = zj * Z, j1 = Math.min(j0 + Z, H), i0 = zi * Z, i1 = Math.min(i0 + Z, W);
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) arr.push(j * W + i);
    zoneCells.push(arr);
  }
  return { ZW, ZH, ZN, zoneCells };
}

const cases = [
  // 本次目标：非整除格网 + ZONE=8
  { name: '上海 sh', W: 136, H: 132, ZONE: 8 },
  { name: '苏州 sz', W: 248, H: 116, ZONE: 8 },
  // 整除格网（六图，零回归）
  { name: '广州 gz', W: 120, H: 96, ZONE: 4 },
  { name: '整除边界', W: 248, H: 120, ZONE: 8 }, // 故意整除，验证 ceil 不引入偏移
];

let fail = 0;
for (const { name, W, H, ZONE } of cases) {
  const { ZW, ZH, ZN, zoneCells } = build(W, H, ZONE);
  const N = W * H;
  const cov = new Int32Array(N);
  let zoneMax = -1;
  for (let z = 0; z < ZN; z++) for (const c of zoneCells[z]) { cov[c]++; if (z > zoneMax) zoneMax = z; }
  // 覆盖完整性
  let minCov = Infinity, maxCov = -Infinity, sum = 0;
  for (let c = 0; c < N; c++) { if (cov[c] < minCov) minCov = cov[c]; if (cov[c] > maxCov) maxCov = cov[c]; sum += cov[c]; }
  const coverageOK = (minCov === 1 && maxCov === 1 && sum === N);
  // zoneOf 与 zoneCells 一一对应
  let mapOK = true;
  for (let c = 0; c < N; c++) {
    const z = zoneOf(W, H, ZONE, c);
    if (z < 0 || z >= ZN) { mapOK = false; break; }
    if (cov[c] !== 1) { mapOK = false; break; }
    if (!zoneCells[z].includes(c)) { mapOK = false; break; }
  }
  // 整除时与原公式一致
  let legacyOK = true;
  if ((W % ZONE === 0) && (H % ZONE === 0)) {
    for (let c = 0; c < N; c += 7) {
      const i = c % W, j = (c / W) | 0;
      const old = ((j / ZONE) | 0) * (W / ZONE) + ((i / ZONE) | 0);
      if (zoneOf(W, H, ZONE, c) !== old) { legacyOK = false; break; }
    }
  }
  const ok = coverageOK && mapOK && (legacyOK || (W % ZONE !== 0));
  if (!ok) fail++;
  console.log(`${ok ? '✓' : '✗'} ${name.padEnd(10)} W=${W} H=${H} ZONE=${ZONE} → ZW=${ZW} ZH=${ZH} Z=${ZN} | 覆盖=${coverageOK ? '每格唯一' : '异常(min' + minCov + '/max' + maxCov + ')'} 映射=${mapOK ? 'OK' : '异常'} 旧公式一致=${legacyOK ? 'OK' : 'n/a'}`);
}
console.log(fail === 0 ? '\n全部通过：非整除格网下小区索引稳定、无越界、无遗漏。' : `\n${fail} 个用例失败。`);
process.exit(fail === 0 ? 0 : 1);
