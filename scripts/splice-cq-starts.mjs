// 把 build-cq-2020.mjs 生成的 starts 块写入 data_cq.js，替换原有的单年代 starts。
import { readFileSync, writeFileSync } from 'node:fs';
const SRC = new URL('../js/content/data_cq.js', import.meta.url);
const GEN = new URL('./_cq_2020_starts.txt', import.meta.url);
let src = readFileSync(SRC, 'utf8');
const gen = readFileSync(GEN, 'utf8').replace(/\n+$/, '\n');

const OLD = `    starts: [
      { id: 'y2004', label: '2004 · 轻轨起步', sub: '中国首条跨座式单轨通车', START: { y: 2004, m: 11, d: 6, minute: 360 }, initialNetwork: null, status: 'live' },
    ],`;
if (!src.includes(OLD)) throw new Error('OLD starts block not found — abort');
if (src.includes("id: 'y2020'")) throw new Error('y2020 already present — abort');
src = src.replace(OLD, gen);
writeFileSync(SRC, src);
console.log('spliced y2020 starts into data_cq.js; new length', src.length);
