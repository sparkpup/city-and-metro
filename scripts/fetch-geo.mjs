#!/usr/bin/env node
'use strict';
// OSM Overpass 分块抓取器（city-and-metro 地理管线）
//   用法：node scripts/fetch-geo.mjs --city sz|xa [--status] [--force] [--api <url>] [--timeout <sec>]
//   缓存：<工作区>/data/raw/<city>/*.json，原始 JSON 不入仓库；断点续跑（已存在且非空则跳过）
//   分层：每块两条查询（路网河铁 / 水面+绿地与关系）；另两条全城查询（行政边界 / 地名节点）
//   自适应：查询超时或运行错误时把该块四分递归重试，避免密集区块把服务端 180s 打爆
// 依据：docs/新城市地理管线-sz-xa-v1.md §2.2 分块、§2.3 分层查询（层 C 必须含 water 关系，否则太湖等大水面抓不到）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const WS = path.resolve(REPO, '..');                       // 工作区根：data/raw 放这里，不进仓库
const UA = 'city-and-metro-map-authoring/1.0';
const API0 = 'https://overpass-api.de/api/interpreter';

// 冻结 bbox 与格网（主理人裁定，docs/新城市设计案-sz-xa-v1.md §6.2）
const CITIES = {
  sz: { bbox: [31.2400, 120.4150, 31.4560, 120.7310], W: 120, H: 96 },
  xa: { bbox: [34.1873, 108.8020, 34.4578, 109.0630], W: 96, H: 120 },
};
const BLKX = 0.060, BLY = 0.050, STPX = 0.055, STPY = 0.045, MINX = 0.020, MINY = 0.018;

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const city = arg('city');
const API = arg('api', API0);
const QT = arg('timeout', '240');
const FORCE = process.argv.includes('--force');
const STATUS = process.argv.includes('--status');
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const log = (m) => { console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`); };

if (!CITIES[city]) { console.error('用法: --city sz|xa [--status] [--force]'); process.exit(2); }
const RAW = path.join(WS, 'data', 'raw', city);
fs.mkdirSync(RAW, { recursive: true });

const B = (b) => `${b[0].toFixed(4)},${b[1].toFixed(4)},${b[2].toFixed(4)},${b[3].toFixed(4)}`;   // S,W,N,E
const Q_ROADS = (b) => `[out:json][timeout:${QT}];(\n way["highway"](${B(b)});\n way["waterway"](${B(b)});\n way["railway"](${B(b)});\n);\nout geom;`;
const Q_AREA = (b) => `[out:json][timeout:${QT}];(\n way["natural"="water"](${B(b)});\n way["landuse"="reservoir"](${B(b)});\n way["waterway"="riverbank"](${B(b)});\n rel["natural"="water"](${B(b)});\n rel["landuse"="reservoir"](${B(b)});\n rel["waterway"="riverbank"](${B(b)});\n way["leisure"="park"](${B(b)});\n way["leisure"="nature_reserve"](${B(b)});\n way["landuse"="forest"](${B(b)});\n way["natural"="wood"](${B(b)});\n way["natural"="scrub"](${B(b)});\n way["boundary"="protected_area"](${B(b)});\n rel["leisure"="nature_reserve"](${B(b)});\n rel["boundary"="protected_area"](${B(b)});\n);\nout geom;`;
const Q_ADMIN = (b) => `[out:json][timeout:${QT}];(\n rel["boundary"="administrative"]["admin_level"~"^(5|6|7|8|9|10)$"](${B(b)});\n);\nout geom;`;
const Q_PLACES = (b) => `[out:json][timeout:120];(\n node["place"~"^(city|town|village|suburb|neighbourhood|square|locality|hamlet)$"](${B(b)});\n);\nout;`;

class SplitErr extends Error {}
let stat = { ok: 0, cached: 0, split: 0, fail: 0 };

async function post(q) {
  const res = await fetch(API, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'text/plain' }, body: q });
  const txt = await res.text();
  return { status: res.status, txt };
}

async function get(q, file, tries = 4) {
  if (!FORCE && fs.existsSync(file) && fs.statSync(file).size > 200) { stat.cached++; return 'cached'; }
  let last = '';
  for (let a = 0; a < tries; a++) {
    try {
      const { status, txt } = await post(q);
      if (status === 429) { log(`  429 限流，等待 60s（第 ${a + 1} 次）`); await sleep(60); continue; }
      if (status >= 500 || status === 504) { log(`  ${status} 服务端，等待 30s`); await sleep(30); continue; }
      if (status !== 200) { last = 'HTTP ' + status; await sleep(10); continue; }
      const head = txt.slice(0, 3000);
      if (/runtime error|Query timed out|Dispatcher_Client|out of memory/i.test(head)) throw new SplitErr(head.replace(/\s+/g, ' ').slice(0, 160));
      if (!txt.includes('"elements"')) { last = '无 elements 字段'; await sleep(10); continue; }
      fs.writeFileSync(file, txt);
      stat.ok++;
      return 'ok:' + (txt.length / 1048576).toFixed(2) + 'MB';
    } catch (e) {
      if (e instanceof SplitErr) throw e;
      last = e.message || String(e);
      await sleep(8 * (a + 1));
    }
  }
  stat.fail++;
  return 'FAIL:' + last;
}

async function fetchBox(bbox, tag, key) {
  const q = tag === 'roads' ? Q_ROADS(bbox) : tag === 'area' ? Q_AREA(bbox) : tag === 'admin' ? Q_ADMIN(bbox) : Q_PLACES(bbox);
  const file = path.join(RAW, key + '_' + tag + '.json');
  const r = await get(q, file);
  if (r.startsWith('FAIL')) log(`  ✗ ${key}_${tag} ${r}`);
  return r;
}

// 自适应：块太大导致超时就四分递归
async function doBlock(bbox, tag, key) {
  const r = await fetchBox(bbox, tag, key);
  if (r.includes('runtime error') || r.includes('timed out') || r === 'FAIL' || r.startsWith('FAIL')) {
    const w = bbox[3] - bbox[1], h = bbox[2] - bbox[0];
    if (w / 2 >= MINX && h / 2 >= MINY) {
      stat.split++;
      log(`  ↳ 四分重试 ${key}_${tag}（${bbox.map((v) => v.toFixed(3)).join(',')}）`);
      const mx = bbox[1] + w / 2, my = bbox[0] + h / 2;
      const quads = [
        [bbox[0], bbox[1], my, mx], [bbox[0], mx, my, bbox[3]],
        [my, bbox[1], bbox[2], mx], [my, mx, bbox[2], bbox[3]],
      ];
      for (let i = 0; i < 4; i++) await doBlock(quads[i], tag, `${key}q${i}`);
      return 'split';
    }
  }
  return r;
}

async function main() {
  const { bbox } = CITIES[city];
  const [S, W, N, E] = bbox;
  if (STATUS) {
    const files = fs.readdirSync(RAW).filter((f) => f.endsWith('.json'));
    const mb = files.reduce((a, f) => a + fs.statSync(path.join(RAW, f)).size, 0) / 1048576;
    let cols = 0, rows = 0;
    for (let x = W; x < E - 1e-9; x += STPX) cols++;
    for (let y = S; y < N - 1e-9; y += STPY) rows++;
    console.log(`${city}: 已缓存 ${files.length} 个文件 / ${mb.toFixed(1)} MB（基础块 ${cols}×${rows}=${cols * rows}，每块 2 条查询 + 2 条全城查询）`);
    return;
  }
  log(`开始抓取 ${city}  bbox=${B(bbox)}  W×H=${CITIES[city].W}×${CITIES[city].H}  api=${API}`);
  let i = 0;
  for (let y = S; y < N - 1e-9; y += STPY, i++) {
    let j = 0;
    for (let x = W; x < E - 1e-9; x += STPX, j++) {
      const box = [y, x, Math.min(y + BLY, N), Math.min(x + BLKX, E)];
      const key = `b${String(i).padStart(2, '0')}${String(j).padStart(2, '0')}`;
      const r1 = await doBlock(box, 'roads', key);
      const r2 = await doBlock(box, 'area', key);
      log(`块 ${key} [${B(box)}] roads=${r1} area=${r2}  (ok:${stat.ok} cached:${stat.cached} split:${stat.split} fail:${stat.fail})`);
      await sleep(1);
    }
  }
  const r3 = await doBlock(bbox, 'admin', 'city');
  log(`全城 admin=${r3}`);
  const r4 = await doBlock(bbox, 'places', 'city');
  log(`全城 places=${r4}`);
  log(`完成 ${city}：ok=${stat.ok} cached=${stat.cached} split=${stat.split} fail=${stat.fail}`);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
