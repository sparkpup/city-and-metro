#!/usr/bin/env node
/*
 * scripts/encode-geo.mjs — OSM 原始块 → js/geo_<id>.js（编码 + 自校验 + 规模报告）
 *
 * 用法：
 *   node scripts/encode-geo.mjs --city sz                 # 读 data/raw/sz/*.json → js/geo_sz.js
 *   node scripts/encode-geo.mjs --city xa --raw <dir> --out js/geo_xa.js --report docs/geo-xa-编码报告.md
 *
 * 编码规则（与 js/geo.js 的 dec/enc 严格一致，内联实现，不 import 游戏 js）：
 *   - 折线：坐标 ×64 取整 → 差分 → zigzag → 每 5 位一字符（bit5=延续位），字符 = 值 + 63
 *   - 多边形环：字符串首字符 'o'（外环）/ 'i'（内环），dec(s,1) 跳过
 *   - streets：多段编码串以 '!' 拼接；water 线行式 [nameIdx, 宽度(格), geom]
 *   - places：明文 [name, x(格), y(格), level]
 * flags 位（roads/rail）：bit0 桥、bit1 隧道、bit2 link/辅路、bit3 恒 1（主理人裁定）、bit4 高铁（仅 rail）
 * cls 口径（主理人裁定 T4）：有名 way→roads（trunk/primary/secondary/tertiary=4/3/2/2，
 *   有名 unclassified/residential/living_street=1）；无名 unclassified/residential/living_street→streets
 * 冻结值（勿改）：
 *   sz: proj={lon0:120.415, lat0:31.456, kx:379.75, ky:444.44} W=120 H=96 bbox=(31.240,120.415,31.456,120.731)
 *   xa: proj={lon0:108.802, lat0:34.4578, kx:367.82, ky:443.62} W=96  H=120 bbox=(34.1873,108.802,34.4578,109.063)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');                                   // reference/city-and-metro/
const WORKSPACE = path.resolve(__dirname, '..', '..');                        // reference/ —— 与 fetch-geo.mjs 的 WS 保持一致（data/raw 落在仓库外）
const GZ_BASE = { names: 2151, water: 2060, roads: 19773, streets: 10375, rail: 354, parks: 445, reserves: 1, woods: 422, admin: 130, places: 615 };

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
const cityKey = arg('city', '');
const CITIES = {
  sz: { id: 'sz', W: 120, H: 96, proj: { lon0: 120.415, lat0: 31.456, kx: 379.75, ky: 444.44 }, bbox: [31.240, 120.415, 31.456, 120.731] },
  xa: { id: 'xa', W: 96, H: 120, proj: { lon0: 108.802, lat0: 34.4578, kx: 367.82, ky: 443.62 }, bbox: [34.1873, 108.802, 34.4578, 109.063] },
};
const city = CITIES[cityKey];
if (!cityKey || !city) { console.error('用法: node scripts/encode-geo.mjs --city sz|xa [--raw dir] [--out file] [--report file] [--simplify 0.08]'); process.exit(2); }
const rawDir = path.resolve(arg('raw', path.join(WORKSPACE, 'data', 'raw', city.id)));
const outFile = path.resolve(REPO, arg('out', 'js/geo_' + city.id + '.js'));
const reportFile = arg('report', '') ? path.resolve(REPO, arg('report', '')) : '';
const EPS = parseFloat(arg('simplify', '0.08'));                              // 抽稀阈值（格，20 m）
const { lon0, lat0, kx, ky } = city.proj, W = city.W, H = city.H;

// ---------- 编解码（js/geo.js:9-42 逐字内联） ----------
function dec(s, from) {
  const out = []; let i = from || 0, x = 0, y = 0;
  while (i < s.length) {
    let r = 0, sh = 0, b;
    do { b = s.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; } while (b >= 32);
    x += (r & 1) ? ~(r >> 1) : (r >> 1);
    r = 0; sh = 0;
    do { b = s.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; } while (b >= 32);
    y += (r & 1) ? ~(r >> 1) : (r >> 1);
    out.push(x / 64, y / 64);
  }
  return out;
}
function enc(pts) {
  let s = '', px = 0, py = 0;
  const put = function (v) { let u = v < 0 ? ~(v << 1) : (v << 1); while (u >= 32) { s += String.fromCharCode((32 | (u & 31)) + 63); u >>>= 5; } s += String.fromCharCode(u + 63); };
  for (let k = 0; k + 1 < pts.length; k += 2) { const x = Math.round(pts[k] * 64), y = Math.round(pts[k + 1] * 64); put(x - px); put(y - py); px = x; py = y; }
  return s;
}

// ---------- 读取与合并 ----------
const files = fs.readdirSync(rawDir).filter((f) => f.endsWith('.json')).sort();
if (!files.length) { console.error('原始缓存为空: ' + rawDir + '，先跑 node scripts/fetch-geo.mjs --city ' + city.id); process.exit(2); }
const els = new Map(); let rawBytes = 0;
for (const f of files) {
  const p = path.join(rawDir, f);
  rawBytes += fs.statSync(p).size;
  let d; try { d = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { console.error('跳过损坏缓存 ' + f + ': ' + e.message); continue; }
  for (const e of d.elements || []) { const k = e.type + ':' + e.id; if (!els.has(k)) els.set(k, e); }
}
console.log(`[${city.id}] 读入 ${files.length} 个缓存文件（${(rawBytes / 1048576).toFixed(1)} MB），合并去重后 ${els.size} 个要素`);

// ---------- 投影 / 抽稀 / 统计 ----------
const stat = { clampPt: 0, dropEl: 0, thinPt: 0, ringChain: 0, ringFail: 0, dropShort: 0 };
const ll = (lat, lon) => [(lon - lon0) * kx, (lat0 - lat) * ky];
function projectPts(geo) {                                    // [{lat,lon}] → 扁平 [x,y,…]（clamp 到图内）
  const out = [];
  for (const g of geo) {
    let x = (g.lon - lon0) * kx, y = (lat0 - g.lat) * ky;
    const cx = Math.min(W, Math.max(0, x)), cy = Math.min(H, Math.max(0, y));
    if (cx !== x || cy !== y) stat.clampPt++;
    out.push(cx, cy);
  }
  return out;
}
function thin(pts) {                                          // 距离阈值抽稀（保留首尾）
  if (pts.length < 4) return pts;
  const out = [pts[0], pts[1]]; let lx = pts[0], ly = pts[1];
  for (let k = 2; k + 1 < pts.length; k += 2) {
    const dx = pts[k] - lx, dy = pts[k + 1] - ly;
    if (dx * dx + dy * dy >= EPS * EPS) { out.push(pts[k], pts[k + 1]); lx = pts[k]; ly = pts[k + 1]; stat.thinPt++; }
  }
  const ex = pts[pts.length - 2], ey = pts[pts.length - 1];
  if (ex !== out[out.length - 2] || ey !== out[out.length - 1]) { out.push(ex, ey); stat.thinPt++; }
  return out;
}
const dist2 = (ax, ay, bx, by) => (ax - bx) * (ax - bx) + (ay - by) * (ay - by);
function closeRing(pts) { const n = pts.length; if (n >= 4 && (pts[0] !== pts[n - 2] || pts[1] !== pts[n - 1])) { pts.push(pts[0], pts[1]); stat.ringChain++; } return pts; }
function chain(ways) {                                        // relation member 贪心拼接；拼不拢各自成环（奇偶规则并集仍正确）
  // 扁平点数组的反转必须按「点对」翻转：Array.prototype.reverse 会把 [x0,y0,x1,y1] 翻成
  // [y1,x1,y0,x0]，x/y 全部互换——界内点 (109.9,89.1) 互换后 y=109.9 直接越界（实测踩坑）。
  const revPts = function (a) { const o = []; for (let k = a.length - 2; k >= 0; k -= 2) o.push(a[k], a[k + 1]); return o; };
  const rings = [], left = ways.slice();
  while (left.length) {
    let ring = left.shift(), go = true;
    while (go) {
      go = false;
      for (let k = 0; k < left.length; k++) {
        const w = left[k], wn = w.length;
        if (dist2(ring[ring.length - 2], ring[ring.length - 1], w[0], w[1]) < 1e-4) { ring = ring.concat(w.slice(2)); left.splice(k, 1); go = true; break; }
        if (dist2(ring[ring.length - 2], ring[ring.length - 1], w[wn - 2], w[wn - 1]) < 1e-4) { ring = ring.concat(revPts(w.slice(0, wn - 2))); left.splice(k, 1); go = true; break; }
        if (dist2(ring[0], ring[1], w[wn - 2], w[wn - 1]) < 1e-4) { ring = w.slice(0, wn - 2).concat(ring); left.splice(k, 1); go = true; break; }
        if (dist2(ring[0], ring[1], w[0], w[1]) < 1e-4) { ring = revPts(w.slice(2)).concat(ring); left.splice(k, 1); go = true; break; }
      }
    }
    rings.push(ring);
  }
  return rings;
}
function polyRings(el) {                                      // way→[外环]；relation→{outer:[…], inner:[…]}（投影+抽稀+闭合）
  if (el.type === 'way' && el.geometry) return { outer: [closeRing(thin(projectPts(el.geometry)))], inner: [] };
  if (el.type === 'relation' && el.members) {
    const ow = [], iw = [];
    for (const m of el.members) {
      if (m.type !== 'way' || !m.geometry || m.geometry.length < 2) continue;
      const p = thin(projectPts(m.geometry));
      (m.role === 'inner' ? iw : ow).push(p);
    }
    return { outer: chain(ow).map(closeRing), inner: chain(iw).map(closeRing) };
  }
  return { outer: [], inner: [] };
}

// ---------- names 表 ----------
const names = [''];
const nameIdx = new Map();
function nid(name) {
  if (!name) return 0;
  let i = nameIdx.get(name);
  if (i === undefined) { i = names.length; names.push(name); nameIdx.set(name, i); }
  return i;
}

// ---------- 分层构建 ----------
const roads = [], streets = [], waterPoly = [], waterLine = [], rail = [], parks = [], reserves = [], woods = [], admin = [], placesSeen = new Map();
const CLS = { trunk: 4, primary: 3, secondary: 2, tertiary: 2 };
const WATER_W_DEF = { river: 0.09, canal: 0.05, stream: 0.03 };
const PLACE_LV = { city: 1, town: 1, suburb: 0, neighbourhood: 0, village: 3, square: 0 };
const count = { roads: 0, streets: 0, waterPoly: 0, waterLine: 0, rail: 0, parks: 0, reserves: 0, woods: 0, admin: 0, places: 0, dropped: 0, relPoly: 0 };

for (const el of els.values()) {
  const t = el.tags || {};
  const hw = t.highway;
  if (hw) {                                                                   // ---- roads 组 ----
    const base = hw.replace(/_link$/, ''), link = /_link$/.test(hw);
    const named = !!(t.name && t.name.trim());
    if (!named && !CLS[base]) {
      if (base === 'unclassified' || base === 'residential' || base === 'living_street') {
        const pts = thin(projectPts(el.geometry));
        if (pts.length >= 4) { streets.push(enc(pts)); count.streets++; } else { stat.dropShort++; count.dropped++; }
      } else count.dropped++;
      continue;
    }
    const flags = (t.bridge && t.bridge !== 'no' ? 1 : 0) | (t.tunnel && t.tunnel !== 'no' ? 2 : 0) | (link ? 4 : 0) | 8;
    const pts = thin(projectPts(el.geometry));
    if (pts.length < 4) { stat.dropShort++; count.dropped++; continue; }
    roads.push([nid(t.name || ''), CLS[base] || 1, flags, enc(pts)]);
    count.roads++;
    continue;
  }
  if (t.natural === 'water' || t.landuse === 'reservoir' || t.waterway === 'riverbank') {   // ---- 水域多边形 ----
    const { outer, inner } = polyRings(el);
    const rings = [];
    for (const r of outer) if (r.length >= 8) rings.push('o' + enc(r));
    for (const r of inner) if (r.length >= 8) rings.push('i' + enc(r));
    if (!rings.length) { stat.dropShort++; count.dropped++; continue; }
    if (el.type === 'relation') count.relPoly++;
    waterPoly.push([nid(t.name || ''), ...rings]);
    count.waterPoly++;
    continue;
  }
  if (t.waterway === 'river' || t.waterway === 'canal' || t.waterway === 'stream') {        // ---- 河川线 ----
    let w = WATER_W_DEF[t.waterway];
    if (t.width) { const m = parseFloat(t.width); if (m > 0) w = Math.min(0.5, m / 250); }
    const pts = thin(projectPts(el.geometry));
    if (pts.length < 4) { stat.dropShort++; count.dropped++; continue; }
    waterLine.push([nid(t.name || ''), Math.round(w * 1000) / 1000, enc(pts)]);
    count.waterLine++;
    continue;
  }
  if (t.leisure === 'park') { const { outer, inner } = polyRings(el); const rs = outer.filter((r) => r.length >= 8).map((r) => 'o' + enc(r)).concat(inner.filter((r) => r.length >= 8).map((r) => 'i' + enc(r))); if (rs.length) { parks.push([nid(t.name || ''), ...rs]); count.parks++; } else { stat.dropShort++; count.dropped++; } continue; }
  if (t.landuse === 'forest' || t.natural === 'wood' || t.natural === 'scrub') { const { outer, inner } = polyRings(el); const rs = outer.filter((r) => r.length >= 8).map((r) => 'o' + enc(r)).concat(inner.filter((r) => r.length >= 8).map((r) => 'i' + enc(r))); if (rs.length) { woods.push([nid(t.name || ''), ...rs]); count.woods++; } else { stat.dropShort++; count.dropped++; } continue; }
  if (t.boundary === 'protected_area' || t.leisure === 'nature_reserve') { const { outer, inner } = polyRings(el); const rs = outer.filter((r) => r.length >= 8).map((r) => 'o' + enc(r)).concat(inner.filter((r) => r.length >= 8).map((r) => 'i' + enc(r))); if (rs.length) { reserves.push([nid(t.name || ''), ...rs]); count.reserves++; } else { stat.dropShort++; count.dropped++; } continue; }
  if (t.railway === 'rail' || t.railway === 'light_rail') {                                   // ---- 铁路 ----
    const flags = (t.bridge && t.bridge !== 'no' ? 1 : 0) | (t.tunnel && t.tunnel !== 'no' ? 2 : 0) | (t.embankment && t.embankment !== 'no' ? 4 : 0) | (t.highspeed === 'yes' ? 16 : 0);
    const pts = thin(projectPts(el.geometry));
    if (pts.length < 4) { stat.dropShort++; count.dropped++; continue; }
    rail.push([nid(t.name || ''), flags, enc(pts)]);
    count.rail++;
    continue;
  }
  if (t.boundary === 'administrative' && el.type === 'relation') {                            // ---- 行政边界 ----
    const lv = parseInt(t.admin_level, 10);
    if (!(lv >= 6 && lv <= 8)) { count.dropped++; continue; }
    const { outer } = polyRings(el);
    const rs = outer.filter((r) => r.length >= 8).map((r) => 'o' + enc(r));
    if (!rs.length) { stat.dropShort++; count.dropped++; continue; }
    admin.push([lv, nid(t.name || ''), ...rs]);
    count.admin++;
    continue;
  }
  if (t.place || (t.railway === 'station' && t.station === 'subway')) {                       // ---- places ----
    if (el.type !== 'node' || el.lat == null) { count.dropped++; continue; }
    let x = (el.lon - lon0) * kx, y = (lat0 - el.lat) * ky;
    if (x < -0.5 || y < -0.5 || x > W + 0.5 || y > H + 0.5) { count.dropped++; continue; }
    x = Math.min(W, Math.max(0, x)); y = Math.min(H, Math.max(0, y));
    const name = (t.name || '').trim();
    if (!name) { count.dropped++; continue; }
    const key = name + '@' + x.toFixed(1) + ',' + y.toFixed(1);
    if (placesSeen.has(key)) continue;
    placesSeen.set(key, true);
    const lv = t.station === 'subway' ? 0 : (PLACE_LV[t.place] !== undefined ? PLACE_LV[t.place] : 0);
    count.places++;
    placesSeen.set('row:' + key, [name, Math.round(x * 100) / 100, Math.round(y * 100) / 100, lv]);
    continue;
  }
  count.dropped++;
}
const places = [...placesSeen.entries()].filter(([k]) => k.startsWith('row:')).map(([, v]) => v);

// ---------- 自校验（内联 dec 解回） ----------
let vFail = 0, vPts = 0;
function verify(s, tag, expectRing) {
  try {
    const p = dec(s, expectRing ? 1 : 0);
    for (let k = 0; k < p.length; k++) if (!Number.isFinite(p[k])) throw new Error('NaN/Inf');
    let ok = true;
    for (let k = 0; k < p.length; k += 2) if (p[k] < -0.001 || p[k] > W + 0.001 || p[k + 1] < -0.001 || p[k + 1] > H + 0.001) ok = false;
    if (!ok) { console.error(`  ✗ ${tag} 有点越界 [0,${W}]×[0,${H}]`); vFail++; }
    vPts += p.length / 2;
  } catch (e) { console.error(`  ✗ ${tag} 解码失败: ${e.message}`); vFail++; }
}
for (const r of roads) verify(r[3], 'road ' + names[r[0]]);
for (const s of streets) verify(s, 'street');
for (const w of waterPoly) for (let k = 1; k < w.length; k++) verify(w[k], 'water-poly', true);
for (const w of waterLine) verify(w[2], 'water-line');
for (const r of rail) verify(r[2], 'rail ' + names[r[0]]);
for (const g of [parks, reserves, woods]) for (const r of g) for (let k = 1; k < r.length; k++) verify(r[k], 'poly', true);
for (const a of admin) for (let k = 2; k < a.length; k++) verify(a[k], 'admin', true);
console.log(`[${city.id}] 自校验：${vFail === 0 ? '✓ 全部通过' : '✗ ' + vFail + ' 条失败'}，解回点数 ${vPts}`);

// ---------- 输出 geo_<id>.js ----------
const q = (v) => JSON.stringify(v);
const lines = [];
lines.push("'use strict';");
lines.push('// 由 OpenStreetMap 数据生成（© OpenStreetMap 贡献者，ODbL）。坐标为游戏格（250 m），折线为增量编码，1/64 格精度。地名已统一为简体中文。');
lines.push('// 抓取 bbox (S,W,N,E) = ' + city.bbox.join(', ') + '；分块 0.06°×0.05°（重叠 0.005°）；编码 scripts/encode-geo.mjs --city ' + city.id + '。');
lines.push('// @generated 本文件由 scripts/encode-geo.mjs 从 OpenStreetMap 生成，属构建产物。禁止手工编辑；修改请改脚本后重生成。坐标口径与层结构见 js/geo.js。');
lines.push('(function (CM) {');
lines.push('  (CM.GEOS = CM.GEOS || {}).' + city.id + ' = {');
lines.push('    proj: { lon0: ' + lon0 + ', lat0: ' + lat0 + ', kx: ' + kx + ', ky: ' + ky + ' },');
lines.push('    names: [' + names.map(q).join(',') + '],');
lines.push('    water: [' + waterPoly.map((r) => '[' + r.map((v) => (typeof v === 'number' ? v : q(v))).join(',') + ']').concat(waterLine.map((r) => '[' + r[0] + ',' + r[1] + ',' + q(r[2]) + ']')).join(',') + '],');
lines.push('    roads: [' + roads.map((r) => '[' + r[0] + ',' + r[1] + ',' + r[2] + ',' + q(r[3]) + ']').join(',') + '],');
// streets 层是「所有段用 ! 拼成的一个巨型字符串」，几千段随机字符里必然出现 \ 和 '。
// 西安首次踩到：未转义直接塞进单引号，产出 "...\xA?..." 这种非法十六进制转义，
// 浏览器加载 geo_xa.js 直接 SyntaxError 白屏。这里按 JS 单引号字面量规则转义 \ 和 '。
const qss = (s) => "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
lines.push('    streets: ' + qss(streets.join('!')) + ',');
lines.push('    rail: [' + rail.map((r) => '[' + r[0] + ',' + r[1] + ',' + q(r[2]) + ']').join(',') + '],');
lines.push('    parks: [' + parks.map((r) => '[' + r.map((v) => (typeof v === 'number' ? v : q(v))).join(',') + ']').join(',') + '],');
lines.push('    reserves: [' + reserves.map((r) => '[' + r.map((v) => (typeof v === 'number' ? v : q(v))).join(',') + ']').join(',') + '],');
lines.push('    woods: [' + woods.map((r) => '[' + r.map((v) => (typeof v === 'number' ? v : q(v))).join(',') + ']').join(',') + '],');
lines.push('    admin: [' + admin.map((r) => '[' + r.map((v) => (typeof v === 'number' ? v : q(v))).join(',') + ']').join(',') + '],');
lines.push('    places: [' + places.map((p) => '[' + p.map(q).join(',') + ']').join(',') + ']');
lines.push('  };');
lines.push('})(CM);');
const out = lines.join('\n') + '\n';
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, out);

// ---------- 规模报告 ----------
const rows = [
  ['names', names.length, GZ_BASE.names], ['water（面）', waterPoly.length, GZ_BASE.water], ['water（线）', waterLine.length, 0],
  ['roads', roads.length, GZ_BASE.roads], ['streets 段', streets.length, GZ_BASE.streets], ['rail', rail.length, GZ_BASE.rail],
  ['parks', parks.length, GZ_BASE.parks], ['reserves', reserves.length, GZ_BASE.reserves], ['woods', woods.length, GZ_BASE.woods],
  ['admin', admin.length, GZ_BASE.admin], ['places', places.length, GZ_BASE.places],
];
const rep = [];
rep.push(`# geo_${city.id}.js 编码报告`);
rep.push('');
rep.push(`- 输入：\`${rawDir}\`（${files.length} 文件 / ${(rawBytes / 1048576).toFixed(1)} MB，合并去重后 ${els.size} 要素）`);
rep.push(`- 输出：\`${path.relative(REPO, outFile)}\`（${(out.length / 1024).toFixed(0)} KB）`);
rep.push(`- proj=\`${JSON.stringify(city.proj)}\`，W=${W}，H=${H}，bbox=${city.bbox.join(',')}`);
rep.push(`- 抽稀阈值 ${EPS} 格（${(EPS * 250).toFixed(0)} m）；flags bit3 恒 1；cls 口径 = 主理人 T4 裁定`);
rep.push('');
rep.push('| 层 | 条目数 | gz 基准 | 备注 |');
rep.push('|---|---|---|---|');
for (const [k, v, g] of rows) rep.push(`| ${k} | ${v} | ${g} | ${g ? (v / g * 100).toFixed(0) + '% of gz' : '—'} |`);
rep.push('');
rep.push(`- 丢弃要素 ${count.dropped}（查询外类型 / <2 点 / 越界 places 等）；抽稀掉点 ${stat.thinPt}；clamp 点 ${stat.clampPt}`);
rep.push(`- 水域多边形中 relation 来源 ${count.relPoly} 个（太湖/金鸡湖/独墅湖/渭河等大水面）；环拼接补闭合 ${stat.ringChain} 处`);
rep.push(`- 自校验：${vFail === 0 ? '✓ 全部通过' : '✗ ' + vFail + ' 条失败'}，解回点数 ${vPts}`);
rep.push(`- places 对照：设计案内容基准落格表见《新城市地理管线-sz-xa-v1.md》§4.1.5/§4.2.5；OSM 候选名与其差异需人工过一遍`);
const repText = rep.join('\n');
console.log(repText);
if (reportFile) { fs.mkdirSync(path.dirname(reportFile), { recursive: true }); fs.writeFileSync(reportFile, repText); console.log('报告已写 ' + reportFile); }
if (vFail > 0) process.exit(1);
console.log(`[${city.id}] ✓ 已生成 ${outFile}`);
