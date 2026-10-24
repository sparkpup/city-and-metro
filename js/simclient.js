'use strict';
// 主线程侧的预测客户端：把 Game.requestPrediction 的客流预测搬到 js/sim.worker.js，主线程保持 60fps。
//
// 对外：
//   CM.SimClient.isSupported()                      → 本机是否可用 Web Worker
//   CM.SimClient.coreScripts()                     → 从 index.html 的 <script src> 推导核心模块清单（新城市自动跟随）
//   CM.SimClient.create(opts)                      → client（有 Worker 走 Worker，否则走进程内同 API 适配）
//
// client：
//   init(opts)                                     → Promise<info>  握手；失败则 client.dead = true
//   sync({net, fare, year, dayType})                → Promise<info>
//   solve(budget)                                  → Promise<info>
//   predict(C, affected, {onProgress, timeout})     → Promise<result> 单飞：新预测取消旧预测
//   cancel(id) / cancelPredict() / terminate()
//   call(type, payload, {onProgress, timeout})      → Promise   （底层，供上面几个复用）
//
// 降级：typeof Worker !== 'function'、构造抛错、握手超时、fatal → 一律走同 API 的进程内适配（直接驱动现有 Model，
// 同步执行），无 Worker 的环境也能玩。失败原因留在 client.failReason。
(function (CM) {
  const DEF_TIMEOUT = 60000;
  const DEF_HANDSHAKE = 20000;
  // 核心模块（无 DOM 依赖的那批）：util / config / geo* / data* / maps / facility / city / metro / sim
  // 用「包含式」白名单而不是「排除式」黑名单：新增城市只增加 geo_<id> / data_<id>，自动被纳入。
  // ⚠️ 本正则区分目录前缀：静态结构（config / geo_* / data_*）已移进 js/content/，业务模块仍在 js/。
  //    `(?:content\/)?` 同时兼容两处（迁移期与将来再挪都用它）；若再改目录必须同步改本行，否则后果是：
  //    coreScripts() 仍返回非 null（白名单各分支独立成支）→ Worker 内 CM.CFG 未定义 → fatal → client.dead
  //    → 静默退回主线程预测（慢 2.4~3.9s）：游戏不报错、无头测试也不失败，仅在 CFG.perf.useWorker=true 时才暴露。
  const CORE_RE = /^js\/(?:content\/)?(util|config|geo|geo_[A-Za-z0-9_]+|data_[A-Za-z0-9_]+|maps|facility|city|metro|sim)\.js$/;

  function coreScripts() {
    if (typeof document === 'undefined' || !document.querySelectorAll) return null;
    const tags = document.querySelectorAll('script[src]');
    const out = [];
    for (let i = 0; i < tags.length; i++) {
      const src = tags[i].getAttribute('src') || '';
      if (!CORE_RE.test(src)) continue;
      // 转成绝对 URL：Worker 里的 importScripts 按 Worker 脚本所在目录解析相对路径，必须给绝对地址
      let abs = src;
      try { if (document.baseURI) abs = new URL(src, document.baseURI).href; } catch (e) { /* 保持原样 */ }
      out.push(abs);
    }
    return out.length ? out : null;
  }

  function isSupported() { return typeof Worker === 'function'; }

  function cancelledError() { const e = new Error('已取消'); e.cancelled = true; return e; }

  // ---------------- Worker 实现 ----------------
  function WorkerClient(worker, opts) {
    const self = this;
    this.mode = 'worker';
    this.worker = worker;
    this.opts = opts || {};
    this.pending = new Map();
    this.next = 1;
    this.dead = false;
    this.failReason = null;
    this.predId = 0;
    this._netRef = null;
    worker.onmessage = function (ev) { self._onMessage(ev && ev.data); };
    worker.onerror = function (e) { self._fatal((e && e.message) || 'worker onerror'); };
    worker.onmessageerror = function () { self._fatal('worker messageerror（结果无法反序列化）'); };
  }

  WorkerClient.prototype._fatal = function (msg) {
    this.dead = true;
    this.failReason = msg;
    const pend = Array.from(this.pending.values());
    this.pending.clear();
    for (const p of pend) { clearTimeout(p.timer); p.reject(new Error('sim worker 失效：' + msg)); }
    if (this.opts.onfatal) try { this.opts.onfatal(msg); } catch (e) { /* ignore */ }
  };

  WorkerClient.prototype._onMessage = function (m) {
    if (!m) return;
    if (m.type === 'progress') {
      const p = this.pending.get(m.id);
      if (p && p.onProgress) { try { p.onProgress(m.p); } catch (e) { /* ignore */ } }
      return;
    }
    if (m.type === 'fatal') { this._fatal(m.message || 'worker fatal'); return; }
    const p = this.pending.get(m.id);
    if (!p) return;                       // 已被取消 / 超时
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.type === 'error') { const e = new Error(m.message || 'sim worker error'); e.stack = m.stack || e.stack; p.reject(e); return; }
    if (m.type === 'done') { p.resolve(m.result); return; }
    // info 里带 cityVersion / roadVersion：主线程据此判断要不要把 city 塞进下一次 sync
    if (m.type === 'ready' || m.type === 'ack') { if (m.info) this.info = m.info; p.resolve(m.info != null ? m.info : true); return; }
    p.reject(new Error('未知响应类型：' + m.type));
  };

  WorkerClient.prototype.call = function (type, payload, o) {
    const self = this;
    o = o || {};
    if (this.dead) return Promise.reject(new Error('sim worker 已失效：' + this.failReason));
    const id = this.next++;
    const msg = { id: id, type: type };
    if (payload) for (const k in payload) if (k !== 'id' && k !== 'type') msg[k] = payload[k];
    return new Promise(function (resolve, reject) {
      const rec = { resolve: resolve, reject: reject, onProgress: o.onProgress || null, timer: null };
      self.pending.set(id, rec);
      const to = o.timeout != null ? o.timeout : (self.opts.timeout || DEF_TIMEOUT);
      if (to > 0) {
        rec.timer = setTimeout(function () {
          if (!self.pending.has(id)) return;
          self.pending.delete(id);
          self._send({ id: id, type: 'cancel' });
          reject(new Error('sim worker 超时（' + type + '，' + to + 'ms）'));
        }, to);
      }
      try { self.worker.postMessage(msg); }
      catch (e) {                          // 典型：DataCloneError（草案对象不可克隆）
        clearTimeout(rec.timer); self.pending.delete(id);
        reject(e);
      }
    });
  };

  WorkerClient.prototype._send = function (m) { try { this.worker.postMessage(m); } catch (e) { /* ignore */ } };

  WorkerClient.prototype.init = function (payload) {
    const self = this;
    const p = payload || {};
    if (!p.scripts && this.scripts) p.scripts = this.scripts;   // 清单通常由 create(opts) 或 coreScripts() 提供
    const hs = (this.opts.handshakeTimeout != null ? this.opts.handshakeTimeout : DEF_HANDSHAKE);
    if (!this._hsTimer) {
      this._hsTimer = setTimeout(function () {
        if (self.pending.size === 0 && !self.dead) return;
        self._hsTimer = null;
        self._fatal('握手超时（' + hs + 'ms 内未收到 ready）');
      }, hs);
    }
    return this.call('init', p, { timeout: hs }).then(function (info) {
      clearTimeout(self._hsTimer); self._hsTimer = null;
      return info;
    }, function (e) {
      clearTimeout(self._hsTimer); self._hsTimer = null;
      self.dead = true; self.failReason = (e && e.message) || String(e);
      throw e;
    });
  };

  WorkerClient.prototype.sync = function (payload) {
    const p = payload || {};
    // 路网对象未变（同一引用）时不必再克隆一次：Worker 侧沿用上一次的网络
    if (p.net && p.net === this._netRef) { delete p.net; p.keepNet = true; }
    else if (p.net) this._netRef = p.net;
    return this.call('sync', p);
  };
  WorkerClient.prototype.solve = function (budget) { return this.call('solve', { budget: budget == null ? 8 : budget }); };

  WorkerClient.prototype.predict = function (C, affected, o) {
    if (this.predId) this.cancel(this.predId);              // 单飞：新预测顶掉旧预测
    const self = this;
    const id = this.next;                                    // call 内自增前的值即本次请求 id
    const pr = this.call('predict', { C: C, affected: affected }, o);
    this.predId = id;
    return pr.then(function (r) { if (self.predId === id) self.predId = 0; return r; },
      function (e) { if (self.predId === id) self.predId = 0; throw e; });
  };

  WorkerClient.prototype.cancel = function (id) {
    const p = this.pending.get(id);
    if (p) { this.pending.delete(id); clearTimeout(p.timer); p.reject(cancelledError()); }
    if (this.predId === id) this.predId = 0;
    this._send({ id: id, type: 'cancel' });
  };
  WorkerClient.prototype.cancelPredict = function () { if (this.predId) this.cancel(this.predId); };
  WorkerClient.prototype.cancelAll = function () { const ids = Array.from(this.pending.keys()); for (const id of ids) this.cancel(id); };
  WorkerClient.prototype.terminate = function () {
    this.dead = true;
    try { this._send({ id: 0, type: 'stop' }); } catch (e) { /* ignore */ }
    try { this.worker.terminate(); } catch (e) { /* ignore */ }
  };

  // ---------------- 进程内降级实现（同 API，同步执行）----------------
  function InlineClient(opts) {
    this.mode = 'inline';
    this.opts = opts || {};
    this.model = this.opts.model || null;
    this.dead = false;
    this.pending = new Map();
    this.predId = 0;
    this._netRef = null;
  }
  InlineClient.prototype.init = function () { return Promise.resolve({ mode: 'inline' }); };
  InlineClient.prototype.sync = function (payload) {
    const m = this.model, p = payload || {};
    if (!m) return Promise.resolve(null);
    try {
      if (p.year != null && p.year !== m.year) m.setYear(p.year);
      if (p.dayType && p.dayType !== m.dayType) m.setDayType(p.dayType);
      if (p.fare) m.fare = p.fare;
      if (p.net && p.net !== this._netRef) { m.setNetwork(p.net); this._netRef = p.net; }
    } catch (e) { return Promise.reject(e); }
    return Promise.resolve({ mode: 'inline' });
  };
  InlineClient.prototype.solve = function (budget) { if (this.model) this.model.step(budget == null ? 8 : budget); return Promise.resolve(null); };
  InlineClient.prototype.predict = function (C, affected, o) {
    const m = this.model;
    if (!m) return Promise.reject(new Error('进程内预测缺少 model'));
    let gen = null, r = null;
    try {
      gen = m.predict(C, affected || [], function () {});
      let last = -1;
      for (;;) {
        r = gen.next();
        if (r.done) break;
        if (o && o.onProgress) {
          const p = (m.predState && m.predState.progress) || 0;
          if (p !== last) { last = p; o.onProgress(p); }
        }
      }
    } catch (e) { m.predJob = null; return Promise.reject(e); }
    m.predJob = null;                    // 不留给 model.step 再驱动一次
    return Promise.resolve(r ? r.value : null);
  };
  InlineClient.prototype.call = function (type, payload) {
    if (type === 'predict') return this.predict(payload && payload.C, payload && payload.affected);
    if (type === 'sync') return this.sync(payload);
    if (type === 'solve') return this.solve(payload && payload.budget);
    if (type === 'init') return this.init(payload);
    return Promise.reject(new Error('进程内适配不支持：' + type));
  };
  InlineClient.prototype.cancel = function () { /* 同步执行，无在途请求 */ };
  InlineClient.prototype.cancelPredict = function () { };
  InlineClient.prototype.cancelAll = function () { };
  InlineClient.prototype.terminate = function () { this.dead = true; };

  // ---------------- 工厂 ----------------
  function create(opts) {
    opts = opts || {};
    const scripts = opts.scripts || coreScripts();
    let werr = null;
    if (isSupported() && scripts && scripts.length) {
      let url = opts.workerUrl || 'js/sim.worker.js';
      try { if (typeof document !== 'undefined' && document.baseURI) url = new URL(url, document.baseURI).href; } catch (e) { /* 保持原样 */ }
      try {
        const w = new Worker(url);
        const c = new WorkerClient(w, opts);
        c.scripts = scripts;
        return c;
      } catch (e) { werr = e; }
    }
    const c = new InlineClient(opts);
    c.scripts = scripts;
    c.failReason = werr ? ('Worker 不可用：' + ((werr && werr.message) || werr)) : (scripts ? '进程内模式（未启用 Worker）' : '无法推导核心模块清单');
    return c;
  }

  CM.SimClient = {
    create: create,
    coreScripts: coreScripts,
    isSupported: isSupported,
    defaultTimeout: DEF_TIMEOUT,
    defaultHandshakeTimeout: DEF_HANDSHAKE,
  };
})(window.CM);
