'use strict';
// 地图：广州（真实地理）与新手教程「青湾」（虚构小城）。
// 各模块在加载时引用同一个 CM.DATA 对象，切换地图时替换它的内容，同时替换 CM.GEO（地理数据源）与网格尺寸、起始日期、人口曲线等参数。
(function (CM) {
  const CFG = CM.CFG, U = CM.U;
  // 随地图切换的配置项：格网、起始日期、人口增长、货币与价格基年、建设与运营成本、票价、财政、城市经济、出行选择与道路参数
  const CFG_KEYS = ['W', 'H', 'ZONE', 'START', 'growth', 'money', 'econBase', 'cost', 'ops', 'fareDefault', 'fareRange', 'economy', 'macro', 'choice', 'road', 'workWeek'];
  const GZ_CFG = {}; for (const k of CFG_KEYS) GZ_CFG[k] = k === 'START' ? Object.assign({}, CFG.START) : CFG[k];
  // 出行选择参数按「发展阶段对应年份」平移并按本城货币缩放：devOffset 为广州曲线年份减本城年份，money 为本城货币相对广州曲线的倍数
  const shift = function (curve, off, k) { return curve.map(function (p) { return [p[0] - off, p[1] * (k || 1)]; }); };
  CM.deriveChoice = function (off, money) {
    const ch = GZ_CFG.choice;
    return {
      choice: Object.assign({}, ch, { vot: shift(ch.vot, off, money), carCostPerKm: shift(ch.carCostPerKm, off, money), parking: shift(ch.parking, off, money), occupancy: shift(ch.occupancy, off), hoRate: shift(ch.hoRate, off), workerRate: shift(ch.workerRate, off), distDecayHW: shift(ch.distDecayHW, off), distDecayHO: shift(ch.distDecayHO, off),
        purposeShare: { sc: shift(ch.purposeShare.sc, off), md: shift(ch.purposeShare.md, off), lz: shift(ch.purposeShare.lz, off) } }),
      road: Object.assign({}, GZ_CFG.road, { capGrowth: shift(GZ_CFG.road.capGrowth, off) }),
    };
  };
  const MAPS = {
    gz: {
      id: 'gz', name: '广州', title: '广州 · 1990', sub: '真实地理 · 1990 年起 · 人民币',
      desc: '从 1990 年尚无地铁的广州开始：珠江水系、道路与桥梁、街道边界和地标都来自真实地理，区域按历史年份逐步开放，并有参考广州地铁发展的历史任务。',
      facts: [['范围', '30 km × 24 km'], ['起始', '1990 年'], ['人口', '约 300 万'], ['货币', '人民币（元）'], ['模式', '经营挑战 / 自由建造']],
      modes: ['challenge', 'free'], kind: 'real', mapVersion: 1, scenario: 'gz-1990',
      // 地图选择页：地区、一句话特色、介绍、特色卡、大事年表、难度（1–4）
      region: '中国内地', tagline: '珠江两岸，从第一条线开始', difficulty: 2, tags: ['无地铁开局', '越江', '新区开放'],
      intro: '1990 年的广州还没有一公里地铁。老城的街巷挤满公交与自行车，天河才刚刚起步，珠江新城仍是一片农田。你要在老城与天河之间画下第一条线，再跟着城市一路向东、向南跨过珠江。',
      features: [['bridge', '珠江越江', '珠江把城市分成两岸，越江段可以建隧道或桥梁'], ['map', '27 个片区逐年开放', '珠江新城、番禺、大学城按真实年份开放'], ['building', '33 处真实地标', '中山纪念堂、广州塔、东塔按落成年份出现'], ['flag', '7 项历史任务', '参考广州地铁的发展需求，不要求复刻真实线路']],
      highlights: [[1993, '珠江新城开始规划'], [1996, '广州东站建成'], [2000, '番禺撤市设区'], [2004, '新白云机场与大学城启用'], [2010, '亚运会，广州塔落成']],
      geo: CM.GEO, data: Object.assign({}, CM.DATA),
      // L8：把史料分界年从 2020 推到 2024（仅改 histEnd，popCurve 沿用默认，避免冲击无头基线）
      cfg: Object.assign({}, GZ_CFG, { growth: Object.assign({}, CFG.growth, { histEnd: 2024 }) }),
      cam: { cx: 30, cy: 41, zoom: 18 },
    },
  };
  // 其他地图（教程与新增城市）由各自的数据文件登记为 CM.MAP_LIST；未写的配置项沿用广州样本
  for (const m of CM.MAP_LIST || []) {
    const cfg = Object.assign({}, GZ_CFG);
    if (m.econ) Object.assign(cfg, CM.deriveChoice(m.econ.devOffset || 0, m.econ.money || 1));
    Object.assign(cfg, m.cfg);
    // 城市经济：只在真实城市启用；没有专门参数的真实地图使用通用参数（'auto'），教程等虚构地图不启用
    cfg.macro = m.kind === 'real' ? (m.cfg.macro || 'auto') : null;
    m.cfg = cfg;
    MAPS[m.id] = m;
  }
  // 地图数据指纹：格网、要素数量与名称表（用于存档识别与诊断；内容修订须同时提高 mapVersion）
  for (const id in MAPS) {
    const m = MAPS[id], G = m.geo;
    m.mapVersion = m.mapVersion || 1;
    m.fp = U.fnv([id, m.cfg.W, m.cfg.H, m.cfg.ZONE, (G.water || []).length, (G.roads || []).length, (G.names || []).length, (m.data.regions || []).map(function (r) { return r.id; }).join(',')].join('|'));
  }
  CM.MAPS = MAPS;
  // 选择列表由易到难；同难度保留既有城市顺序，新地图按登记顺序接在同档末尾。
  const mapOrder = ['tutorial', 'gz', 'hz', 'hk', 'tp', 'tk'];
  for (const id of Object.keys(MAPS)) if (mapOrder.indexOf(id) < 0) mapOrder.push(id);
  const mapRank = new Map(mapOrder.map(function (id, i) { return [id, i]; }));
  CM.MAP_ORDER = mapOrder.filter(function (id) { return MAPS[id]; }).sort(function (a, b) {
    return (MAPS[a].difficulty || 2) - (MAPS[b].difficulty || 2) || mapRank.get(a) - mapRank.get(b);
  });
  // ---- 地图游玩模式（分组）----
  // 只描述「哪些城市归到同一个入口」，是 CM.MAP_ORDER 的只读派生视图；
  // 不改变 CM.MAPS / CM.MAP_LIST / CM.MAP_ORDER 三个既有契约。
  // 字段：id 唯一键 / name 组标题 / sub 副标题 / ids 成员城市 id（一城单归属，先到先得）
  //      / expanded 默认展开 / sort 组间升序（小的在上）/ status 筹备状态 / force 强制可见
  const MODES = [
    // 可见规则要求「ids 里真实存在的城市 ≥ 2」：上海落地后从 ['sz'] 补成 ['sz','sh']，
    // 「长三角都市圈」组才真正出现在选图页（此前只有一个成员，整组被隐藏）。
    // 2026-10-31 无锡落地：补入 'wx' → 组内 苏州 · 上海 · 无锡 三城（常州待建）。
    { id: 'east', name: '长三角都市圈', sub: '苏州 · 上海 · 无锡 · 常州',
      ids: ['sz', 'sh', 'wx'], status: 'live', sort: 10, expanded: true },
    { id: 'chengyu', name: '成渝都市圈', sub: '重庆 · 成都',
      ids: [], status: 'planned', sort: 20, expanded: false },
    { id: 'classic', name: '经典地图', sub: '单城经营 · 组内由易到难',
      ids: [], status: 'live', sort: 90, expanded: true, implicit: true },
  ];
  // 规范化：只保留真实存在的地图；一城单归属（按 MODES 顺序先到先得）
  const claimedMode = {};
  CM.MAP_MODES = MODES.map(function (m) {
    return Object.assign({}, m, {
      ids: (m.ids || []).filter(function (id) { return MAPS[id] && !claimedMode[id] && (claimedMode[id] = m.id); }),
    });
  }).map(function (m) {
    // 可见规则一条：成员 ≥ 2，或显式 force。空壳模式不进渲染，但结构里始终可读
    m.visible = !!m.force || m.ids.length >= 2;
    return m;
  });
  // 渲染视图：[{ mode, ids }]，组间按 sort，组内保持 MAP_ORDER（难度升序）的既有相对顺序
  CM.mapGroups = function () {
    const out = [], claimed = {};
    for (const m of CM.MAP_MODES.slice().sort(function (a, b) { return (a.sort || 50) - (b.sort || 50); })) {
      if (m.implicit || !m.visible) continue;
      const ids = CM.MAP_ORDER.filter(function (id) { return m.ids.indexOf(id) >= 0; });
      if (!ids.length) continue;
      for (const id of ids) claimed[id] = 1;
      out.push({ mode: m, ids: ids });
    }
    // 兜底组：未归入任何可见模式的城市（当前 = 全部 8 城）
    const rest = CM.MAP_ORDER.filter(function (id) { return !claimed[id]; });
    if (rest.length) out.push({ mode: CM.MAP_MODES.filter(function (m) { return m.implicit; })[0], ids: rest });
    return out;
  };
  // ---- 开局年代（starts）：同一张图的多个时代入口 ----
  // 条目字段：id / label / sub / START（覆盖该图 START 的字段）/ initialNetwork（null = 从零开始）/ status（'planned' = 未开放）
  // 未声明 starts 的地图完全走原路：pickStart 返回 null，m.cfg / m.data 一律不动，行为与加本机制前一致。
  function pickStart(m, startId) {
    const list = m.starts;
    if (!list || !list.length) return null;
    const find = function (sid) { for (const s of list) if (s.id === sid) return s; return null; };
    let st = startId ? find(startId) : null;                      // 显式请求优先（planned 也照给，由界面决定是否可选）
    // defaultStart 不能指向未开放项：planned 的语义就是「别自动用」，否则配置一处写错，
    // 玩家开新局会直接进一个设计上还没做完的年代，且不报错（实测踩到）。
    if (!st && m.defaultStart) { const d = find(m.defaultStart); if (d && d.status !== 'planned') st = d; }
    if (!st) { for (const s of list) if (s.status !== 'planned') { st = s; break; } }
    return st || list[0] || null;
  }
  CM.resolveStart = pickStart;   // 供界面/加载提示在切换之前读出年代（不改全局状态）
  CM.mapId = 'gz';
  CM.useMap = function (id, startId) {
    const m = MAPS[id] || MAPS.gz;
    const st = pickStart(m, startId), stId = st ? st.id : null;
    // 早退条件必须含年代：同一张图换年代要重新应用 START 与 initialNetwork
    if (CM.mapId === m.id && CM.GEO === m.geo && (m.activeStart || null) === stId) return m;
    CM.mapId = m.id;
    // 年代先落到「该图自己的」配置与数据上（m.cfg.START 本来就是每图覆盖全局 CFG.START 的通道），
    // 于是 game.js 的 g.clock = CFG.START 与 buildInitialNetwork 读 D.initialNetwork 都不用感知 starts。
    if (st) {
      m.cfg.START = Object.assign({}, m.cfg.START, st.START || {});
      m.data.initialNetwork = st.initialNetwork || null;
    }
    m.activeStart = stId;
    for (const k of Object.keys(CM.DATA)) delete CM.DATA[k];
    Object.assign(CM.DATA, m.data);
    CM.GEO = m.geo;
    for (const k of CFG_KEYS) CFG[k] = k === 'START' ? Object.assign({}, m.cfg.START) : m.cfg[k];
    if (CM.Geo) CM.Geo.init();
    if (CM.Metro && CM.Metro.clearCaches) CM.Metro.clearCaches();
    return m;
  };
  CM.curMap = function () { return MAPS[CM.mapId] || MAPS.gz; };   // 含 activeStart，界面直接读

  // 地图缩略图：水系、主要道路与铁路（不切换当前地图，直接解码该地图的数据），按主题配色，结果缓存
  const thumbs = {};
  CM.mapThumb = function (id, theme) {
    const key = id + ':' + theme;
    if (thumbs[key]) return thumbs[key];
    const m = MAPS[id]; if (!m) return null;
    const G = m.geo, dec = CM.Geo.dec, Wc = m.cfg.W, Hc = m.cfg.H;
    const S = Math.min(640 / Wc, 400 / Hc), cv = document.createElement('canvas');
    cv.width = Math.round(Wc * S); cv.height = Math.round(Hc * S);
    const c = cv.getContext('2d'), dark = theme === 'dark';
    c.fillStyle = dark ? '#1b2533' : '#eef3f0'; c.fillRect(0, 0, cv.width, cv.height);
    c.setTransform(S, 0, 0, S, 0, 0);
    const poly = function (rows, col) {
      c.fillStyle = col; c.beginPath();
      for (const row of rows) for (let k = 1; k < row.length; k++) { if (typeof row[k] !== 'string') continue; const p = dec(row[k], 1); c.moveTo(p[0], p[1]); for (let q = 2; q < p.length; q += 2) c.lineTo(p[q], p[q + 1]); }
      c.fill('evenodd');
    };
    poly(G.woods || [], dark ? '#22362f' : '#dbe9dc');
    poly(G.reserves || [], dark ? '#2a4238' : '#c9dfcc');
    poly(G.parks || [], dark ? '#264034' : '#cfe6cf');
    poly((G.water || []).filter(function (r) { return typeof r[1] !== 'number'; }), dark ? '#2b4f78' : '#a9cdeb');
    c.lineCap = 'round'; c.lineJoin = 'round';
    for (const r of G.water || []) if (typeof r[1] === 'number') { const p = dec(r[2]); c.strokeStyle = dark ? '#2b4f78' : '#a9cdeb'; c.lineWidth = Math.max(r[1], 0.25); c.beginPath(); c.moveTo(p[0], p[1]); for (let q = 2; q < p.length; q += 2) c.lineTo(p[q], p[q + 1]); c.stroke(); }
    for (const r of G.rail || []) { if (r[1] & 2) continue; const p = dec(r[2]); c.strokeStyle = dark ? '#5b6676' : '#9aa3ae'; c.lineWidth = 0.18; c.beginPath(); c.moveTo(p[0], p[1]); for (let q = 2; q < p.length; q += 2) c.lineTo(p[q], p[q + 1]); c.stroke(); }
    for (const cls of [3, 4]) for (const r of G.roads || []) {
      if (r[1] !== cls || (r[2] & 6)) continue;
      const p = dec(r[3]); c.strokeStyle = dark ? (cls === 4 ? '#b8964a' : '#6f7b8c') : (cls === 4 ? '#f0b54a' : '#c4ccd6'); c.lineWidth = cls === 4 ? 0.45 : 0.3;
      c.beginPath(); c.moveTo(p[0], p[1]); for (let q = 2; q < p.length; q += 2) c.lineTo(p[q], p[q + 1]); c.stroke();
    }
    thumbs[key] = cv.toDataURL('image/png');
    return thumbs[key];
  };
})(window.CM);
