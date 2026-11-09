/**
 * GM API 桥接层（node 侧）
 * 页面调用 window.gmBridge(op, payload) → 这里处理 → 返回 Promise
 *
 * 多账号说明：
 * - GM 存储（配置、题库缓存、AI 答题缓存）全局共享一份，多账号不重复请求
 * - 但「带 cookie 的请求」必须用发起方账号的 context，所以 context 按账号注册
 */
const fs = require('fs');
const path = require('path');

class GmBridge {
  constructor(options) {
    this.storePath = options.storePath;
    this.onLog = options.onLog || (() => {});
    this.contexts = new Map(); // accountId -> BrowserContext
    this.store = this.loadStore();
    this.tabs = new Map();
    this.inflight = new Map();
    this._persistTimer = null;
    // 广播节流 / 熔断状态：页面里的 tab 同步会互相触发写入，
    // 不设限的话一次 setValue 能放大成成百上千次 evaluate
    this._bcPending = new Map(); // key -> { old, val, origin, timer }
    this._bcRate = new Map(); // key -> { n, at, mutedUntil }
    this._bcWarnedAt = new Set();
    this._bigStoreWarned = false;
    // 加密字形识别（页面里画好编号网格图 → 这里转给视觉模型）
    this.onOcr = null;
    this._ocrCount = 0;
    // 摄像头接管：页面调 getUserMedia 时由 server 侧的 CameraHub 处理
    this.onCamera = null;
  }

  loadStore() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
      // tab 同步键是运行时临时数据，每次启动清掉，否则会越积越多
      for (const k of Object.keys(raw)) {
        if (k.startsWith('_tab_change_')) delete raw[k];
      }
      return raw;
    } catch (e) {
      return {};
    }
  }

  registerContext(accountId, ctx) {
    this.contexts.set(accountId, ctx);
    ctx.on('close', () => {
      if (this.contexts.get(accountId) === ctx) this.contexts.delete(accountId);
    });
  }

  contextFor(accountId) {
    return this.contexts.get(accountId) || this.contexts.values().next().value || null;
  }

  /** 合并短时间内的多次写入，避免答题高峰把整个题库反复落盘 */
  persist() {
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this.flush();
    }, 800);
  }

  flush() {
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      const json = JSON.stringify(this.store);
      if (json.length > 32 * 1024 * 1024 && !this._bigStoreWarned) {
        this._bigStoreWarned = true;
        this.onLog(
          'warn',
          `[GM] 本地存储已 ${Math.round(json.length / 1048576)}MB，页面缓存偏大，必要时可停服后删除 data/gm-store.json`
        );
      }
      const tmp = this.storePath + '.tmp';
      fs.writeFileSync(tmp, json);
      fs.renameSync(tmp, this.storePath);
    } catch (e) {
      this.onLog('error', '[GM] 存储写入失败: ' + e.message);
    }
  }

  /** 同一个键短时间内的多次写入合并成一次广播，避免一次答题触发上百次 evaluate */
  broadcast(key, oldValue, newValue, originFrame) {
    let slot = this._bcPending.get(key);
    if (!slot) {
      slot = { old: oldValue, val: newValue, origin: originFrame || null, timer: null };
      this._bcPending.set(key, slot);
    } else {
      slot.val = newValue;
    }
    if (slot.timer) return;
    slot.timer = setTimeout(() => {
      this._bcPending.delete(key);
      try {
        this.doBroadcast(key, slot.old, slot.val, slot.origin);
      } catch (e) {}
    }, 120);
  }

  /**
   * 真正下发。两道闸：
   * 1) 同一键 3 秒内超过 15 次 → 判定页面里有写-广播回环，静默 5 秒；
   * 2) 单个值超过 512KB → 只落盘不广播，避免每次给每个 frame 深拷贝一份。
   */
  doBroadcast(key, oldValue, newValue, originFrame) {
    const now = Date.now();
    if (this._bcRate.size > 800) this._bcRate.clear();
    const st = this._bcRate.get(key) || { n: 0, at: now, mutedUntil: 0 };
    if (now - st.at > 3000) {
      st.n = 0;
      st.at = now;
    }
    st.n += 1;
    this._bcRate.set(key, st);

    if (st.mutedUntil && now < st.mutedUntil) return;
    // 正常业务（视频进度、答题记录）3 秒内不会写同一个键 15 次；
    // 超过就说明页面里的监听器在互相触发，先停 5 秒把环断掉
    if (st.n > 15) {
      st.mutedUntil = now + 5000;
      this.onLog('warn', `[GM] 键「${key}」3 秒内写入 ${st.n} 次，疑似页面内回环，暂停广播 5 秒`);
      return;
    }

    let size = 0;
    try {
      size = JSON.stringify(newValue === undefined ? null : newValue).length;
    } catch (e) {
      size = 0;
    }
    if (size > 512 * 1024) {
      if (!this._bcWarnedAt) this._bcWarnedAt = new Set();
      if (!this._bcWarnedAt.has(key)) {
        this._bcWarnedAt.add(key);
        this.onLog(
          'warn',
          `[GM] 键「${key}」的值约 ${Math.round(size / 1024)}KB，已保存但不再跨 frame 广播`
        );
      }
      return;
    }

    const jobs = [];
    for (const ctx of this.contexts.values()) {
      let pages = [];
      try {
        pages = ctx.pages();
      } catch (e) {
        continue;
      }
      for (const page of pages) {
        for (const frame of page.frames()) {
          // 发起方在本地已经触发过监听器，不用再回灌一次
          if (originFrame && frame === originFrame) continue;
          jobs.push(
            frame
              .evaluate(
                ([k, o, n]) => {
                  if (typeof window.__OCS_GM_APPLY__ === 'function') window.__OCS_GM_APPLY__(k, o, n);
                },
                [key, oldValue === undefined ? null : oldValue, newValue === undefined ? null : newValue]
              )
              .catch(() => {})
          );
        }
      }
    }
    if (jobs.length) Promise.allSettled(jobs);
  }

  /** tab 同步键每个 frame 一个，不落盘，数量也要有上限 */
  trimTabKeys(limit = 200) {
    const keys = [];
    for (const k of Object.keys(this.store)) {
      if (k.startsWith('_tab_change_')) keys.push(k);
    }
    if (keys.length <= limit) return;
    for (const k of keys.slice(0, keys.length - limit)) delete this.store[k];
  }

  async http(payload, accountId) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), payload.timeout || 30000);
    try {
      const init = {
        method: payload.method || 'GET',
        headers: payload.headers || {},
        signal: controller.signal,
        redirect: 'follow'
      };
      if (payload.data !== null && payload.data !== undefined && init.method !== 'GET') {
        init.body = typeof payload.data === 'string' ? payload.data : JSON.stringify(payload.data);
      }
      if (payload.anonymous === false) {
        // 需要携带站点 cookie（用于题库/平台接口），必须用发起账号自己的 context
        const ctx = this.contextFor(accountId);
        if (ctx) {
          try {
            const cookies = await ctx.cookies(payload.url);
            if (cookies.length) {
              init.headers = Object.assign({}, init.headers, {
                Cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ')
              });
            }
          } catch (e) {}
        }
      }
      const res = await fetch(payload.url, init);
      const text = await res.text();
      const headers = [];
      res.headers.forEach((v, k) => headers.push(k + ': ' + v));
      return {
        status: res.status,
        statusText: res.statusText,
        responseText: text,
        responseHeaders: headers.join('\r\n'),
        finalUrl: res.url
      };
    } catch (e) {
      const msg = e.name === 'AbortError' ? '请求超时' : e.message;
      this.onLog('warn', `[GM] ${payload.method} ${payload.url} 失败: ${msg}`);
      return { error: msg };
    } finally {
      clearTimeout(timer);
    }
  }

  async handle(accountId, source, op, payload) {
    switch (op) {
      case 'set': {
        const key = payload.key;
        const oldValue = this.store[key];
        this.store[key] = payload.value;
        const origin = source && source.frame;
        if (typeof key === 'string' && key.startsWith('_tab_change_')) {
          // 标签页间同步用的临时键：只广播，不落盘，超出上限就丢最旧的
          this.trimTabKeys();
          this.broadcast(key, oldValue, payload.value, origin);
          return true;
        }
        this.persist();
        this.broadcast(key, oldValue, payload.value, origin);
        return true;
      }
      case 'delete': {
        const key = payload.key;
        const oldValue = this.store[key];
        delete this.store[key];
        if (typeof key === 'string' && key.startsWith('_tab_change_')) return true;
        this.persist();
        this.broadcast(key, oldValue, undefined, source && source.frame);
        return true;
      }
      case 'http':
        return this.http(payload, accountId);
      case 'ocr': {
        if (typeof this.onOcr !== 'function') return { ok: false, error: '未启用 AI 识别' };
        this._ocrCount += 1;
        const size = Math.round(String((payload && payload.image) || '').length / 1024);
        this.onLog('info', `[AI识别] 收到字形图 ${size}KB，共 ${(payload && payload.count) || '?'} 格`);
        try {
          const r = await this.onOcr(accountId, payload);
          if (r && r.ok) {
            this.onLog('info', `[AI识别] 识别到 ${Object.keys(r.map || {}).length} 个字`);
          } else if (r && r.error) {
            this.onLog('warn', `[AI识别] 失败：${r.error}`);
          }
          return r;
        } catch (e) {
          this.onLog('warn', `[AI识别] 异常：${e.message}`);
          return { ok: false, error: e.message };
        }
      }
      case 'camera':
        if (typeof this.onCamera !== 'function') return { ok: false, error: '未启用摄像头接管' };
        return this.onCamera(accountId, payload || {});
      case 'saveTab':
        // 页面每开一个新标签就往这里塞一份，不设上限会一直涨
        if (this.tabs.size > 120) this.tabs.clear();
        this.tabs.set(accountId + ':' + payload.tabId, payload.data);
        return true;
      case 'notify':
        this.onLog('info', `[通知] ${payload.title || ''} ${payload.text || ''}`.trim());
        return true;
      case 'abort':
        return true;
      default:
        return null;
    }
  }
}

module.exports = { GmBridge };
