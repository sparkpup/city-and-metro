import { readFileSync } from 'node:fs';
const raw = JSON.parse(readFileSync(new URL('./_cq_metro_raw.json', import.meta.url)));
const pick = (kw) => raw.filter((r) => r.name.includes(kw));
const show = (label, rs) => {
  for (const r of rs) {
    console.log(`\n== ${label} :: ${r.name} (${r.stations.length}) ==`);
    console.log(r.stations.map((s, i) => `${i + 1}.${s.name}`).join('  '));
  }
};
show('1号线', pick('1号线'));
show('2号线', pick('2号线').filter((r) => !r.name.includes('天堂堡')));
show('3号线主线', pick('3号线').filter((r) => !r.name.includes('空港')));
show('3号线空港支线', pick('空港支线'));
show('4号线', pick('4号线').filter((r) => !r.name.includes('直通')));
show('5号线', pick('5号线'));
show('6号线', pick('6号线').filter((r) => !r.name.includes('国博') && !r.name.includes('重庆东站')));
show('国博支线', pick('国博支线'));
show('环线', pick('环线').filter((r) => r.name.includes('顺时针')));
show('10号线', pick('10号线').filter((r) => !r.name.includes('快速')));
