#!/usr/bin/env node
'use strict';
// OSM Overpass 分块抓取器（city-and-metro 地理管线）
//   用法：node scripts/fetch-geo.mjs --city sz|xa|sh|cq [--status] [--plan] [--force] [--retry-failed] [--verify] [--ttl N] [--api <url>] [--timeout <sec>]
//      --status        只读索引，显示成功/失败/累计体积与上次运行统计（不发请求）
//      --plan          干跑：只算出「哪些会复用、哪些要新抓、哪些已失效」，不发请求
//      --retry-failed  只重跑上次失败的项（其余跳过，不请求）
//      --verify        复用前对已缓存文件做 sha1 内容校验
//      --ttl N         缓存超过 N 天视为过期
//      --force         忽略索引，全部重抓
//   缓存：<工作区>/data/raw/<city>/*.json，原始 JSON 不入仓库；断点续跑（已存在且非空则跳过）
//   分层：每块两条查询（路网河铁 / 水面+绿地与关系）；另两条全城查询（行政边界 / 地名节点）
//   自适应：查询超时或运行错误时把该块四分递归重试，避免密集区块把服务端 180s 打爆
// 依据：docs/新城市地理管线-sz-xa-v1.md §2.2 分块、§2.3 分层查询（层 C 必须含 water 关系，否则太湖等大水面抓不到）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const WS = path.resolve(REPO, '..');                       // 工作区根：data/raw 放这里，不进仓库
const UA = 'city-and-metro-map-authoring/1.0';
const API0 = 'https://overpass-api.de/api/interpreter';

// 冻结 bbox 与格网（主理人裁定，docs/新城市设计案-sz-xa-v1.md §6.2；sh/cq 见 docs/上海重庆设计案 §6）
//   bbox 一律 [S, W, N, E]；W/H 为格数（每格≈250 m，用 tests/headless/freeze-bbox.mjs 验算过落格）
const CITIES = {
  // 苏州北扩（2026-10-26）：北界 31.456 → 31.501，为把相城区黄埭镇完整镇域纳入可玩范围
  // （原图幅下黄埭镇落格 y=1.3，紧贴最上边一条边，镇域大半被切在图外）。
  // ky 仍为 444.44，每格保持 250 m；格数 11520 → 13920。proj 的 lat0 随之改为 31.501。
  // 影响：苏州既有存档与 city.mjs 基线作废，需重跑。
  sz: { bbox: [31.2400, 120.4150, 31.5010, 120.7310], W: 120, H: 116 },
  xa: { bbox: [34.1873, 108.8020, 34.4578, 109.0630], W: 96, H: 120 },
  // 上海：17952 格（136×132），每格 252×253 m。南界 31.10 为容下莘庄（31.112）；浦东机场(121.808)与嘉定(121.25)按设计留在图外
  sh: { bbox: [31.1000, 121.3200, 31.4000, 121.6800], W: 136, H: 132 },
  // 重庆：9600 格（96×100），每格 242×245 m。江北机场(29.719)留在图外（与苏州同处理）；本阶段只出设计案不抓取
  cq: { bbox: [29.4400, 106.4200, 29.6600, 106.6600], W: 96, H: 100 },
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

if (!CITIES[city]) { console.error('用法: --city sz|xa|sh|cq [--status] [--plan] [--force] [--retry-failed] [--verify] [--ttl N]'); process.exit(2); }
const RAW = path.join(WS, 'data', 'raw', city);
fs.mkdirSync(RAW, { recursive: true });

const B = (b) => `${b[0].toFixed(4)},${b[1].toFixed(4)},${b[2].toFixed(4)},${b[3].toFixed(4)}`;   // S,W,N,E
const Q_ROADS = (b) => `[out:json][timeout:${QT}];(\n way["highway"](${B(b)});\n way["waterway"](${B(b)});\n way["railway"](${B(b)});\n);\nout geom;`;
const Q_AREA = (b) => `[out:json][timeout:${QT}];(\n way["natural"="water"](${B(b)});\n way["landuse"="reservoir"](${B(b)});\n way["waterway"="riverbank"](${B(b)});\n rel["natural"="water"](${B(b)});\n rel["landuse"="reservoir"](${B(b)});\n rel["waterway"="riverbank"](${B(b)});\n way["leisure"="park"](${B(b)});\n way["leisure"="nature_reserve"](${B(b)});\n way["landuse"="forest"](${B(b)});\n way["natural"="wood"](${B(b)});\n way["natural"="scrub"](${B(b)});\n way["boundary"="protected_area"](${B(b)});\n rel["leisure"="nature_reserve"](${B(b)});\n rel["boundary"="protected_area"](${B(b)});\n);\nout geom;`;
const Q_ADMIN = (b) => `[out:json][timeout:${QT}];(\n rel["boundary"="administrative"]["admin_level"~"^(5|6|7|8|9|10)$"](${B(b)});\n);\nout geom;`;
const Q_PLACES = (b) => `[out:json][timeout:120];(\n node["place"~"^(city|town|village|suburb|neighbourhood|square|locality|hamlet)$"](${B(b)});\n);\nout;`;

class SplitErr extends Error {}
let stat = { ok: 0, cached: 0, split: 0, fail: 0, stale: 0, reused: 0 };

// ---------------- 缓存索引（manifest）----------------
// 目标：把「哪些查询已经抓过、抓到了什么、还是否有效」落盘，让多次运行能算增量而不是重来一遍。
//   - bodyHash：查询正文的哈希。bbox 或查询模板一变（比如苏州北扩），相关块的 hash 就变 → 判为失效
//   - sha1：响应内容哈希，用于 --verify 校验文件是否被改坏/截断
//   - status：ok / fail，失败原因也记录，配合 --retry-failed 只重跑失败的
const MANIFEST = path.join(RAW, '_manifest.json');
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const loadManifest = () => {
  try { const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); return m && m.schema === 1 ? m : null; } catch (e) { return null; }
};
let man = loadManifest() || { schema: 1, city: city, api: API, cityCfg: null, queries: {}, runs: [] };
// 城市配置变了（bbox / W/H / proj）→ 整份索引降级为「需重算」：不是全删，而是让 bbox 相关的块重新判 hash
const cfgNow = { bbox: CITIES[city].bbox.slice(), W: CITIES[city].W, H: CITIES[city].H };
const cfgChanged = JSON.stringify(man.cityCfg) !== JSON.stringify(cfgNow);
if (cfgChanged) log(`⚠ 城市配置已变更（${JSON.stringify(man.cityCfg || {})} → ${JSON.stringify(cfgNow)}），受影响的块将按 bodyHash 重新判定`);
man.city = city; man.api = API; man.cityCfg = cfgNow;
const entryOf = (key) => man.queries[key] || null;
const saveManifest = () => {
  man.runs.push({ at: new Date().toISOString(), ...stat });
  if (man.runs.length > 50) man.runs = man.runs.slice(-50);
  const tmp = MANIFEST + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(man, null, 1));      // 先写临时文件再改名，避免中断留下半个 JSON
  fs.renameSync(tmp, MANIFEST);
};
// 索引回填：老缓存是在没有 manifest 的时代抓下来的，目录里有文件但没有索引。
// 首次运行时按文件名（b0400_roads 这类）把它们登记进来，标记 inherited——
// 表示「内容未校验」。信任它们的前提是：块的 bbox 由 (行号,列号) 和 bbox 原点决定，
// 只要南界/西界/步长没变，同名块的查询范围就一致。若改过东西界或南界，请用 --force 重抓。
function backfill() {
  if (Object.keys(man.queries).length) return 0;
  let n = 0;
  for (const f of fs.readdirSync(RAW)) {
    if (!f.endsWith('.json') || f === '_manifest.json') continue;
    const p = path.join(RAW, f), sz = fs.statSync(p).size;
    if (sz <= 200) continue;
    man.queries[f.slice(0, -5)] = { file: f, bodyHash: null, sha1: null, bytes: sz, fetchedAt: null, status: 'ok', inherited: true };
    n++;
  }
  if (n) log(`索引回填：既有缓存 ${n} 项（内容未校验；若曾改动过 bbox 的南界或东西界，请用 --force 重抓）`);
  return n;
}

// 缓存是否仍然有效：文件存在且够大 + 查询正文没变 + 上次是成功 + （可选）未过 TTL
function fresh(key, bodyHash) {
  const e = entryOf(key);
  if (FORCE) return false;
  if (!e || e.status !== 'ok') return false;
  if (e.inherited) { e.bodyHash = bodyHash; delete e.inherited; return true; }   // 继承条目：信任一次并补全 hash，之后按常规判定
  if (e.bodyHash !== bodyHash) { stat.stale++; return false; }     // 查询内容变了 → 失效
  const f = path.join(RAW, e.file);
  if (!fs.existsSync(f) || fs.statSync(f).size <= 200) return false;
  if (TTL > 0 && e.fetchedAt && (Date.now() - Date.parse(e.fetchedAt)) / 86400000 > TTL) { stat.stale++; return false; }
  return true;
}
// 只重跑上次失败的：没开这个开关时不影响常规行为
const RETRY_FAILED = process.argv.includes('--retry-failed');
const VERIFY = process.argv.includes('--verify');
const PLAN = process.argv.includes('--plan');
const TTL = Number((() => { const i = process.argv.indexOf('--ttl'); return i >= 0 ? process.argv[i + 1] : 0; })() || 0);

async function post(q) {
  const res = await fetch(API, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'text/plain' }, body: q });
  const txt = await res.text();
  return { status: res.status, txt };
}

async function get(q, file, key, tries = 4) {
  const bodyHash = sha1(q);
  const e0 = entryOf(key);
  // 命中缓存（查询正文未变、上次成功、文件还在）
  if (fresh(key, bodyHash)) {
    if (VERIFY) {                                    // 内容校验：文件被改坏/截断能被发现
      const cur = sha1(fs.readFileSync(path.join(RAW, e0.file)));
      if (e0.sha1 && cur !== e0.sha1) { log(`  ⚠ ${key} 内容校验不符（期望 ${e0.sha1.slice(0, 8)}… 实际 ${cur.slice(0, 8)}…），将重新抓取`); stat.stale++; }
      else { stat.cached++; stat.reused++; return 'cached✓'; }
    } else { stat.cached++; stat.reused++; return 'cached'; }
  }
  // --retry-failed：只重跑上次失败的，其余跳过（不请求、不改缓存）
  if (RETRY_FAILED && (!e0 || e0.status !== 'fail')) return 'skip';
  // --plan：只算计划，不发请求
  if (PLAN) return (e0 ? 'stale' : 'new');

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
      man.queries[key] = { file: path.basename(file), bodyHash: bodyHash, sha1: sha1(txt), bytes: txt.length, fetchedAt: new Date().toISOString(), status: 'ok', tries: a + 1 };
      stat.ok++;
      return 'ok:' + (txt.length / 1048576).toFixed(2) + 'MB';
    } catch (e) {
      if (e instanceof SplitErr) throw e;
      last = e.message || String(e);
      await sleep(8 * (a + 1));
    }
  }
  man.queries[key] = Object.assign({}, e0, { file: path.basename(file), bodyHash: bodyHash, status: 'fail', lastError: last, failedAt: new Date().toISOString() });
  stat.fail++;
  return 'FAIL:' + last;
}

async function fetchBox(bbox, tag, key) {
  const q = tag === 'roads' ? Q_ROADS(bbox) : tag === 'area' ? Q_AREA(bbox) : tag === 'admin' ? Q_ADMIN(bbox) : Q_PLACES(bbox);
  const file = path.join(RAW, key + '_' + tag + '.json');
  const r = await get(q, file, key + '_' + tag);
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
  backfill();
  if (STATUS) {
    const q = Object.keys(man.queries);
    const ok = q.filter((k) => man.queries[k].status === 'ok');
    const bad = q.filter((k) => man.queries[k].status === 'fail');
    const mb = ok.reduce((a, k) => a + (man.queries[k].bytes || 0), 0) / 1048576;
    let cols = 0, rows = 0;
    for (let x = W; x < E - 1e-9; x += STPX) cols++;
    for (let y = S; y < N - 1e-9; y += STPY) rows++;
    console.log(`${city}: 索引 ${q.length} 条查询，成功 ${ok.length} / 失败 ${bad.length}，累计 ${mb.toFixed(1)} MB`);
    console.log(`  基础块 ${cols}×${rows}=${cols * rows}（每块 2 条查询）+ 2 条全城查询；分裂子块另计`);
    if (bad.length) console.log(`  失败清单（可用 --retry-failed 重跑）：${bad.slice(0, 20).join(', ')}${bad.length > 20 ? ' …' : ''}`);
    if (man.runs && man.runs.length) { const r = man.runs[man.runs.length - 1]; console.log(`  上次运行 ${r.at}：ok=${r.ok} cached=${r.cached} split=${r.split} fail=${r.fail} stale=${r.stale || 0}`); }
    return;
  }
  log(`开始抓取 ${city}  bbox=${B(bbox)}  W×H=${CITIES[city].W}×${CITIES[city].H}  api=${API}${PLAN ? '  【--plan 只算计划，不发请求】' : ''}${RETRY_FAILED ? '  【--retry-failed 只重跑失败项】' : ''}${TTL ? `  【TTL ${TTL} 天】` : ''}`);
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
  saveManifest();
  const bad = Object.keys(man.queries).filter((k) => man.queries[k].status === 'fail');
  log(`完成 ${city}：ok=${stat.ok} cached=${stat.cached} reuse=${stat.reused} stale=${stat.stale} split=${stat.split} fail=${stat.fail}`);
  if (bad.length) log(`  ✗ 失败 ${bad.length} 项，已记入索引；修复后跑 --retry-failed 只重跑这些：${bad.slice(0, 10).join(', ')}${bad.length > 10 ? ' …' : ''}`);
  if (!PLAN) log(`  索引已写入 ${MANIFEST}（下次运行按 bodyHash 判定增量，配置不变则直接复用）`);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
