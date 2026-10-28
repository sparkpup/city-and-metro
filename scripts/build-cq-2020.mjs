// 生成 data_cq.js 的 y2020 接管年代 starts 块（真实 2020 年底前已运营线路）。
// 读取 _cq_metro_raw.json，按线路裁剪到 2020 范围，自动识别换乘站（≥2 线）标 L。
// 输出到 scripts/_cq_2020_starts.txt（供 splice 脚本写入 data_cq.js）。
import { readFileSync, writeFileSync } from 'node:fs';

const raw = JSON.parse(readFileSync(new URL('./_cq_metro_raw.json', import.meta.url)));
const find = (kw, exclude = []) => raw.find((r) => r.name.includes(kw) && !exclude.some((e) => r.name.includes(e)));

// 每条线：匹配关系名 / 方向（取含起点的那条）/ 颜色 / 类型 / 开通年（填 built）/ 裁剪起止站名
const LINES = [
  { key: '1号线', dir: '璧山 → 朝天门', color: '#E2231A', type: 'underground', year: 2011, cut: ['璧山', '小什字'] },
  { key: '2号线', dir: '鱼洞 → 较场口', color: '#00A651', type: 'elevated', year: 2004, cut: ['鱼洞', '较场口'], ex: ['天堂堡'] },
  { key: '3号线', dir: '鱼洞 → 江北机场T2航站楼', color: '#F39800', type: 'elevated', year: 2004, cut: ['鱼洞', '江北机场T2航站楼'], ex: ['空港'] },
  { key: '3号线空港支线', dir: '举人坝 → 碧津', color: '#F39800', type: 'elevated', year: 2016, cut: ['举人坝', '碧津'] },
  { key: '4号线', dir: '石马河立交→ 黄岭', color: '#00A0E9', type: 'underground', year: 2018, cut: ['民安大道', '唐家沱'], ex: ['直通'] },
  { key: '5号线', dir: '跳磴 → 悦港北路', color: '#00B7B0', type: 'underground', year: 2017, cut: ['大石坝', '园博中心'] },
  { key: '6号线', dir: '北碚 → 茶园', color: '#E4007F', type: 'underground', year: 2012, cut: ['北碚', '茶园'], ex: ['国博', '重庆东站'] },
  { key: '国博支线', dir: '礼嘉 → 悦来', color: '#E66AB0', type: 'underground', year: 2013, cut: ['礼嘉', '悦来'] },
  { key: '环线', dir: '顺时针', color: '#F0C419', type: 'underground', year: 2018, cut: ['重庆西站', '重庆西站'], loop: true },
  { key: '10号线', dir: '王家庄 → 兰花路', color: '#008ECC', type: 'underground', year: 2017, cut: ['王家庄', '鲤鱼池'], ex: ['快速'] },
];

// 实际裁剪实现
const selected = [];
for (const L of LINES) {
  const r = find(L.key, L.ex || []);
  if (!r) { console.error('MISSING', L.key); continue; }
  let s = r.stations.slice();
  const ai = s.findIndex((x) => x.name === L.cut[0]);
  const bi = s.findIndex((x) => x.name === L.cut[1]);
  if (ai < 0 || bi < 0) { console.error('CUT FAIL (name missing)', L.key, L.cut); continue; }
  // 关系方向与裁剪方向相反时（cut[0] 在 cut[1] 之后）整体反转，再取首末出现处切片
  if (ai > bi) s = s.slice().reverse();
  const i0 = s.findIndex((x) => x.name === L.cut[0]);
  const i1 = s.length - 1 - [...s].reverse().findIndex((x) => x.name === L.cut[1]);
  if (i0 < 0 || i1 < 0 || i1 < i0) { console.error('CUT FAIL', L.key, L.cut, i0, i1); continue; }
  const seg = s.slice(i0, i1 + 1).map((x) => ({ name: x.name, lat: +x.lat.toFixed(5), lon: +x.lon.toFixed(5) }));
  selected.push({ ...L, seg });
}

// 换乘站统计（跨所有选中线的站名出现次数）
const cnt = new Map();
for (const L of selected) for (const st of L.seg) cnt.set(st.name, (cnt.get(st.name) || 0) + 1);

// 投影 sanity（cq proj: lon0 106.2, lat0 29.87, kx 388, ky 446.77, W194 H277）
const P = { lon0: 106.2, lat0: 29.87, kx: 388, ky: 446.77 };
let oob = 0;
for (const L of selected) for (const st of L.seg) {
  const x = (st.lon - P.lon0) * P.kx, y = (P.lat0 - st.lat) * P.ky;
  if (x < 0 || x > 194 || y < 0 || y > 277) { oob++; console.error('  OOB', L.key, st.name, x.toFixed(1), y.toFixed(1)); }
}
console.error('out-of-grid stations:', oob, '/ total', selected.reduce((a, L) => a + L.seg.length, 0));

// 生成 lines 字面量
const lineFrag = (L) => {
  const sizeOf = (name, isTerm) => (cnt.get(name) >= 2 ? "'L'" : "'M'");
  const sts = L.seg.map((st, i) => {
    const isTerm = i === 0 || i === L.seg.length - 1;
    const sz = sizeOf(st.name, isTerm);
    return `        st(${JSON.stringify(st.name)}, ${st.lat}, ${st.lon}, ${sz}, ${L.year})`;
  }).join(',\n');
  const loop = L.loop ? ', loop: true' : '';
  return `      { name: ${JSON.stringify(L.key.replace('主线', '').replace('空港支线', '（空港支线）'))}, color: '${L.color}', type: '${L.type}', year: ${L.year}${loop}, stations: [\n${sts}\n      ] }`;
};

const linesText = selected.map(lineFrag).join(',\n');

const out = `    starts: [
      { id: 'y2004', label: '2004 · 轻轨起步', sub: '中国首条跨座式单轨通车', START: { y: 2004, m: 11, d: 6, minute: 360 }, initialNetwork: null, status: 'live' },
      { id: 'y2020', label: '2020 · 接管现有线网', sub: '名下已有真实 2020 线网（1/2/3/4/5/6/国博/环线/10）', START: { y: 2020, m: 1, d: 1, minute: 360 },
        initialNetwork: {
          year: 2020,
          note: '2020 年重庆轨道交通现状（图内段）：1/2/3 号线、4 号线民安大道—唐家沱、5 号线大石坝—园博中心、6 号线与国博支线、环线、10 号线鲤鱼池—王家庄，由你接管运营，不收历史建设费',
          lines: [
${linesText}
          ],
        },
        status: 'live' },
    ],`;

writeFileSync(new URL('./_cq_2020_starts.txt', import.meta.url), out);
console.log('lines:', selected.length, 'total stations:', selected.reduce((a, L) => a + L.seg.length, 0));
for (const L of selected) console.log(`  ${L.key}: ${L.seg.length} 站  (${L.seg[0].name}—${L.seg[L.seg.length - 1].name})`);
