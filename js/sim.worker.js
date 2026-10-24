'use strict';
// 客流预测 Worker：独占一份自建的 City + Model，全程保温；主线程不参与预测计算。
//
// 设计要点（与 js/simclient.js 成对阅读）：
//   1. Worker 内自建 City + Model（不接收主线程快照——ctxs 有 19~34MB 且持续变化，克隆本身就会卡住主线程）。
//      建城与预热（solveNow）都发生在 Worker 内，主线程无感。
//   2. 只传小输入（草案 C、当前路网，各约 0.09MB）与小输出（result，KB 级）。
//   3. 模块清单由主线程 init 消息的 scripts 数组给出，本文件不硬编码——新城市接入时自动跟随 index.html。
//   4. 预测生成器按时间片推进（CHUNK_MS），片间回到事件循环，才能收到 cancel。
//
// 消息协议（主 → Worker，均为 {id, type, ...}）：
//   init    {mapId, seed, scripts, clock:{y,m,d}, year, dayType, fare, net, warm} → ready
//   sync    {net, netRef, fare, year, dayType}                                    → ack
//   solve   {budget}                                                              → ack
//   predict {C, affected}                                                        → progress* → done
//   cancel  {id}（id 为要取消的请求 id）
//   stop    停止空闲保温
// 消息协议（Worker → 主）：ready / ack / progress{id,p} / done{id,result} / error{id,message,stack} / fatal{message,stack}
self.window = self;

(function () {
  var CHUNK_MS = 30;     // 预测生成器每次连续推进的时间片
  var IDLE_MS = 250;     // 空闲保温节拍
  var IDLE_BUDGET = 6;   // 空闲保温每拍的时间盒（ms）

  var CM = null, city = null, model = null;
  var ready = false;
  var queue = [], busy = false, idleTimer = null;
  var cancelled = Object.create(null);
  var curId = 0;
  var warmIdle = true;
  var netSigCache = '';

  function post(m) { try { self.postMessage(m); } catch (e) { /* 无法序列化时无处上报 */ } }

  function fail(id, e) {
    post({ id: id, type: 'error', message: (e && e.message) != null ? String(e.message) : String(e), stack: (e && e.stack) ? String(e.stack).slice(0, 2000) : '' });
  }

  // 未捕获异常也必须通知主线程，否则预测会永远停在 running
  function fatal(msg, err) {
    post({ id: curId, type: 'fatal', message: String(msg), stack: (err && err.stack) ? String(err.stack).slice(0, 2000) : '' });
  }
  self.onerror = function (e) { fatal((e && e.message) || 'worker 内部错误', e && e.error); };
  if (self.addEventListener) {
    self.addEventListener('error', function (e) { fatal((e && e.message) || 'worker 内部错误', e && e.error); });
    self.addEventListener('unhandledrejection', function (e) {
      const r = e && e.reason;
      fatal('worker 未处理的 Promise 拒绝：' + ((r && r.message) || r || ''), r);
    });
  }

  // ---------------- 城市与模型 ----------------
  function netSig(C) {
    if (!C) return '';
    const rs = C.routes || [];
    let s = '';
    for (let i = 0; i < rs.length; i++) s += rs[i].lineId + ':' + (rs[i].stIds || []).join(',') + '|';
    return s + '#' + ((C.stations && C.stations.length) || 0) + '#' + ((C.segs && C.segs.size) || 0);
  }

  function doInit(m) {
    const list = m.scripts;
    if (!list || !list.length) throw new Error('init 缺少 scripts 清单');
    importScripts.apply(self, list);
    CM = self.CM;
    if (!CM || !CM.City || !CM.Model) throw new Error('核心模块加载失败（util/config/city/sim 缺失）');

    CM.useMap(m.mapId || (CM.mapId || 'gz'));
    const clk = m.clock || {};
    const y0 = clk.y != null ? clk.y : CM.CFG.START.y;
    city = new CM.City();
    city.generate(m.seed != null ? m.seed : CM.CFG.START.y * 10000 + 101, y0);
    model = new CM.Model(city);
    model.setYear(m.year != null ? m.year : y0);
    model.setDayType(m.dayType === 'we' ? 'we' : 'wd');
    if (m.fare) model.fare = m.fare;
    if (m.net) { model.setNetwork(m.net); netSigCache = netSig(m.net); }
    // 预热：冷收敛 0.6~0.9s，发生在 Worker 内
    model.solveNow(m.warm != null ? m.warm : 1);
    warmIdle = m.idleWarm !== false;
    ready = true;
    scheduleIdle();
  }

  function doSync(m) {
    if (!ready) throw new Error('尚未 init');
    if (m.year != null && m.year !== model.year) model.setYear(m.year);
    if (m.dayType && m.dayType !== model.dayType) model.setDayType(m.dayType);
    if (m.fare && m.fare.flat !== model.fare.flat) model.fare = Object.assign({}, m.fare);
    if (m.city) {
      // 城市状态同步：走 sim.js 现成的 refreshCityGen（buildZones → buildDemandGen → syncRoad → setNetwork），
      // 覆盖 growMonth / applyRoads / demolish / applyReclaim / openRegion 造成的全部变化。
      // Worker 内不需要时间盒，一次性跑完。
      // postMessage 的结构化克隆会丢掉 City 原型（方法全没了，city.cellAt 直接崩），必须先恢复原型：
      // new 一个真 City 实例，再把快照的 own 数据盖上去（实测：恢复后跨 12 个月预测偏差 0.53%，直接赋值必崩）。
      const c = new CM.City();
      Object.assign(c, m.city);
      city = c;
      model.city = c;
      const g = model.refreshCityGen(m.net || null);
      for (let r = g.next(); !r.done; r = g.next()) { /* run */ }
      if (m.net) netSigCache = netSig(m.net);
      // refreshCityGen 会 wake（gen=null、settled=false），重新热一次，避免从周期 0 起算
      if (m.warmCity !== 0) model.solveNow(m.warmCity != null ? m.warmCity : 1);
    } else if (m.net) {
      const s = netSig(m.net);
      if (s !== netSigCache) { model.setNetwork(m.net); netSigCache = s; }
    }
    scheduleIdle();
  }

  function doSolve(m) { if (!ready) throw new Error('尚未 init'); model.step(m.budget != null ? m.budget : IDLE_BUDGET); }

  function info() {
    if (!ready) return null;
    return {
      mapId: CM.mapId, Z: model.Z, stations: model.net ? model.net.N : 0, routes: model.net ? model.net.R : 0,
      settled: !!model.settled, cycles: model.cycles || 0, year: model.year, dayType: model.dayType,
      fare: model.fare ? model.fare.flat : null, cityVersion: city.version, roadVersion: city.roadVersion,
      netSig: netSigCache,
    };
  }

  // ---------------- 预测：分片推进，片间可收 cancel ----------------
  function doPredict(m, cb) {
    if (!ready) { fail(m.id, new Error('尚未 init')); cb(); return; }
    const id = m.id;
    let gen = null;
    try {
      // 回调不是出口：返回值从 gen.next() 取，避免 model.step 之后误触 predJob
      gen = model.predict(m.C, m.affected || [], function () {});
    } catch (e) { fail(id, e); cb(); return; }

    function chunk() {
      if (cancelled[id]) { delete cancelled[id]; model.predJob = null; cb(); return; }
      let r = null;
      try {
        const t0 = performance.now();
        do { r = gen.next(); } while (!r.done && performance.now() - t0 < CHUNK_MS);
      } catch (e) { model.predJob = null; fail(id, e); cb(); return; }
      if (!r.done) {
        const p = (model.predState && model.predState.progress) || 0;
        post({ id: id, type: 'progress', p: p });
        setTimeout(chunk, 0);
        return;
      }
      model.predJob = null;
      post({ id: id, type: 'done', result: r.value });
      cb();
    }
    chunk();
  }

  // ---------------- 串行队列 ----------------
  function runOne(msg, cb) {
    const id = msg.id;
    try {
      if (cancelled[id]) { delete cancelled[id]; cb(); return; }
      switch (msg.type) {
        case 'init': doInit(msg); post({ id: id, type: 'ready', info: info() }); break;
        case 'sync': doSync(msg); post({ id: id, type: 'ack', ok: true, info: info() }); break;
        case 'solve': doSolve(msg); post({ id: id, type: 'ack', ok: true, info: info() }); break;
        case 'predict': doPredict(msg, cb); return;                       // 自管 cb
        case 'stop': warmIdle = false; if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } post({ id: id, type: 'ack', ok: true }); break;
        default: fail(id, new Error('未知消息类型：' + msg.type));
      }
    } catch (e) { fail(id, e); }
    cb();
  }

  function pump() {
    if (busy || !queue.length) return;
    busy = true;
    const msg = queue.shift();
    curId = msg.id;
    runOne(msg, function () { busy = false; curId = 0; scheduleIdle(); pump(); });
  }

  // 空闲保温：只在未收敛时占用极少的后台时间，收敛后 step 立即返回
  function scheduleIdle() {
    if (!warmIdle || !ready || !model || !model.net) return;
    if (idleTimer) return;
    idleTimer = setTimeout(function () {
      idleTimer = null;
      if (!warmIdle || !model || !model.net || busy) return;
      try { if (!model.settled) model.step(IDLE_BUDGET); } catch (e) { /* 保温失败不影响请求 */ }
      scheduleIdle();
    }, IDLE_MS);
  }

  self.onmessage = function (ev) {
    const m = ev && ev.data;
    if (!m || !m.type) return;
    if (m.type === 'cancel') {
      const t = m.target != null ? m.target : m.id;
      cancelled[t] = true;
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].id === t) queue.splice(i, 1);
      return;
    }
    queue.push(m);
    pump();
  };
})();
