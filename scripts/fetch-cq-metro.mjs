// 一次性脚本：抓取重庆轨道交通 2020 年底前已运营线路的路线关系与站点坐标。
// 输出到 scripts/_cq_metro_raw.json（关系 → 有序站点 [name, lat, lon, id]）。
// 用法：node scripts/fetch-cq-metro.mjs
import { writeFileSync } from 'node:fs';

const BBOX = [29.25, 106.2, 29.87, 106.7]; // S,W,N,E
const S = BBOX[0], W = BBOX[1], N = BBOX[2], E = BBOX[3];
const EPS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];
const UA = 'city-and-metro-map-authoring/1.0';

// route=train 在中国常被用于地铁/单轨；route=subway 也常见；monorail 较少。
const ql = `[out:json][timeout:180];
(
  relation["route"="subway"](${S},${W},${N},${E});
  relation["route"="train"](${S},${W},${N},${E});
  relation["route"="monorail"](${S},${W},${N},${E});
);
out;
(
  relation["route"="subway"](${S},${W},${N},${E});
  relation["route"="train"](${S},${W},${N},${E});
  relation["route"="monorail"](${S},${W},${N},${E});
);
>;
out body;`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const run = async () => {
  let lastErr = null;
  for (const EP of EPS) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.error('trying', EP, 'attempt', attempt);
        const res = await fetch(EP, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'text/plain' }, body: ql, signal: AbortSignal.timeout(150000) });
        if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
        const j = await res.json();
        if (j.remark || j.error) console.error('  server remark:', j.remark || j.error);
        const elems = j.elements || [];
        const rels = elems.filter((e) => e.type === 'relation');
        if (!rels.length) { console.error('  empty result, trying next endpoint'); continue; }
        const nodeMap = new Map();
        for (const e of elems) if (e.type === 'node' && e.lat != null) nodeMap.set(e.id, { name: (e.tags && e.tags.name) || null, lat: e.lat, lon: e.lon });
        const out = [];
        for (const r of rels) {
          const tags = r.tags || {};
          const name = tags.name || tags.ref || '?';
          const route = tags.route;
          const members = (r.members || []).filter((m) => m.type === 'node' && nodeMap.has(m.ref));
          const stations = members.map((m) => {
            const n = nodeMap.get(m.ref);
            return { role: m.role || '', name: n.name, lat: n.lat, lon: n.lon, id: m.ref };
          });
          out.push({ id: r.id, name, route, ref: tags.ref || null, members: stations.length, stations });
        }
        writeFileSync(new URL('./_cq_metro_raw.json', import.meta.url), JSON.stringify(out, null, 1));
        console.log('relations:', out.length);
        for (const r of out) console.log(`  ${r.route}\t${r.name}\tstations=${r.stations.length}`);
        return;
      } catch (e) {
        lastErr = e;
        console.error(`attempt ${EP} #${attempt} failed: ${e.message}`);
        if (attempt < 3) await sleep(6000 * attempt);
      }
    }
  }
  throw lastErr;
};
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
