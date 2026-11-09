const EventEmitter = require('events');
const { resolveAi } = require('./user-ai');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const START_TEXTS = ['开始学习', '开始答题', '继续学习', '开始任务', '自动学习', '开始'];

/**
 * 去掉 enc / cpi / _t 之后的学习页地址。
 * 超星的 studentstudy 有些入口不校验 enc，靠 session 重新签发，
 * 所以 enc 失效时值得用它兜底试一次；非超星域名一律返回空。
 */
function stripEnc(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)chaoxing\.com$/i.test(u.hostname)) return '';
    const keep = ['chapterId', 'courseId', 'clazzid', 'knowledgeid', 'nodeId'];
    const q = new URLSearchParams();
    for (const k of keep) {
      const v = u.searchParams.get(k);
      if (v) q.set(k, v);
    }
    if (![...q.keys()].length) return '';
    u.search = q.toString();
    return u.toString();
  } catch (e) {
    return '';
  }
}

/**
 * 平台把页面挡在门外的几种情况。这些页面没有视频，守护循环只会干等，
 * 所以单独识别：能继续等的（登录）就等，不能等的（enc 失效、无权限）直接报错。
 */
const PAGE_GATES = [
  {
    type: 'login',
    title: '需要登录',
    fatal: false,
    match: (url, text) =>
      /passport2\.chaoxing\.com|\/login\b|login\.chaoxing|\/passport\//i.test(url) ||
      /登录已失效|请重新登录|登录超时|该账号已在别处登录|请登录后继续/.test(text),
    tip: '登录态无效或未登录。请在本账号的画面里完成登录（扫码或账号密码），登录成功后会自动继续，不用重启任务。'
  },
  {
    type: 'enc',
    title: 'enc 校验失败',
    fatal: true,
    match: (url, text) => {
      // 只认「enc + 校验/验证 + 失败类词」同时出现在相邻短句里，避免正文误判
      if (!/enc|ENC|Enc/.test(text)) return false;
      return /(enc|ENC|Enc)[^\n]{0,12}(校验|验证)[^\n]{0,6}(失败|错误|无效|过期|不通过)/.test(text)
        || /(校验|验证)失败[^\n]{0,10}(enc|ENC)/.test(text);
    },
    tip:
      '链接里的 enc 与登录身份或申请时间不匹配。常见原因：这个链接是别的账号复制的、复制时被截断、或已过期。' +
      '请在已登录的状态下重新走一遍「课程 → 章节 → 进入学习」，从地址栏复制新的完整链接替换任务地址。'
  },
  {
    type: 'denied',
    title: '无权访问',
    fatal: true,
    match: (url, text) => /没有权限|无权限访问|访问受限|资源不存在|课程已删除|用户不存在/.test(text),
    tip: '这个账号没有这门课的权限，或课程/章节已被删除。请核对链接是否属于当前登录的账号。'
  }
];

class TaskRunner extends EventEmitter {
  constructor({ config, host, logger }) {
    super();
    this.config = config;
    this.host = host;
    this.logger = logger;
    this.queue = [];
    this.current = null;
    this.page = null;
    this.stopped = false;
    this.busy = false;
    this.finishCurrent = null;
    this.watchdog = null;
    this.gateKey = null;
    // 标签页管理：点 target=_blank 打开的新页面要接管，否则画面永远停在旧标签
    this._adopting = new Set();
    this._boundPages = new WeakSet();
    this._pageStack = [];
    this._opening = null;
  }

  addLog(task, level, message) {
    const entry = {
      time: Date.now(),
      level,
      message,
      taskId: task ? task.id : null,
      taskName: task ? task.name : null
    };
    const fn = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
    this.logger[fn](message);
    this.emit('log', entry);
  }

  enqueue(task) {
    if (this.queue.find((t) => t.id === task.id)) return;
    this.queue.push(task);
    this.addLog(task, 'info', `已加入队列：${task.name}`);
    if (!this.busy) this.loop();
  }

  async loop() {
    if (this.busy) return;
    this.busy = true;
    this.stopped = false;
    while (this.queue.length && !this.stopped) {
      const task = this.queue.shift();
      this.current = task;
      task.status = 'running';
      task.startedAt = Date.now();
      task.progress = 0;
      this.emit('change');
      try {
        await this.runTask(task);
        if (task.status === 'running') task.status = 'done';
      } catch (e) {
        task.status = 'error';
        task.error = e.message;
        this.addLog(task, 'error', `任务失败：${e.message}`);
      } finally {
        task.finishedAt = Date.now();
        this.current = null;
        await this.cleanup().catch(() => {});
        this.emit('change');
      }
    }
    this.busy = false;
    this.emit('change');
  }

  async stopAll() {
    this.stopped = true;
    this.queue = [];
    if (this.current) {
      this.current.status = 'stopped';
      this.addLog(this.current, 'info', '收到停止指令，正在结束当前任务');
    }
    if (this.finishCurrent) this.finishCurrent();
    await sleep(300);
    await this.cleanup().catch(() => {});
    this.busy = false;
    this.emit('change');
  }

  async cleanup() {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
    this.gateKey = null;
    this.gateHit = null;
    this.gateAt = 0;
    // 先断开当前页引用，否则 close 回调会以为"用户关了页面"去救场
    const pages = this.host.pages();
    this.page = null;
    this._pageStack = [];
    // 点击打开过的标签页可能攒下好几个，任务结束时一起关掉，不留后台页占内存
    for (const p of pages) {
      await p.close().catch(() => {});
    }
  }

  /** 新建任务时先开一个空白页，等用户把地址填进来 */
  async openBlank() {
    if (this.page && !this.page.isClosed()) return this.page;
    if (this._opening) return this._opening;
    this._opening = (async () => {
      const page = await this.host.newPage();
      if (!this.page || this.page.isClosed()) this.page = page;
      return this.page;
    })();
    try {
      return await this._opening;
    } finally {
      this._opening = null;
    }
  }

  /**
   * 页面级事件只绑一次。切标签后新页面也要接上，
   * 否则新页面里的答题输出、页面报错全都看不见。
   */
  bindPage(page, task) {
    if (!page || this._boundPages.has(page)) return;
    this._boundPages.add(page);
    const current = () => this.current || task || null;

    page.on('pageerror', (e) => {
      // OCS 会探测本机 15319 端口的配置同步服务，服务端环境没有它，
      // 产生的 Promise 拒绝会被序列化成 "Object"，对使用无影响，直接忽略
      const msg = e && e.message;
      if (!msg || msg === 'Object') return;
      this.addLog(current(), 'warn', `[页面错误] ${msg}`);
    });

    // 把页面里与答题有关的输出转进日志：不然「跳过 / 没搜到 / 提交失败」
    // 全发生在浏览器里，服务端这边什么都看不到
    page.on('console', (msg) => {
      try {
        const text = String(msg.text() || '').trim();
        if (!text || text.length > 400) return;
        if (!/答题|题目|题库|搜题|答案|提交|作业|章节|AI|解析|填空|判断|选择|失败|错误|超时|加密|解密|字形|字体/.test(text)) return;
        this.addLog(current(), msg.type() === 'error' ? 'error' : 'info', `[页面] ${text}`);
      } catch (e) {}
    });

    page.on('close', () => {
      // 已经被别的标签接管了（旧标签关掉不影响画面）
      if (this.page !== page) return;
      const alt = this.pickFallbackPage(page);
      if (alt) {
        this.adoptPage(alt, { force: true, auto: false, reason: '当前标签页已关闭，切回上一个页面' }).catch(() => {});
        return;
      }
      const t = this.current;
      if (t && t.status === 'running') {
        t.status = 'closed';
        this.addLog(t, 'warn', '页面被关闭');
      }
      if (this.finishCurrent) this.finishCurrent();
    });

    // 子 frame 每次导航都重灌配置。用 WeakMap 记录时间，避免 iframe 频繁跳转时
    // 每 1.2 秒就 evaluate 一次整份配置（题库大的时候这会产生大量临时对象）
    const frameAppliedAt = new WeakMap();
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) return;
      const now = Date.now();
      if (now - (frameAppliedAt.get(frame) || 0) < 3000) return;
      frameAppliedAt.set(frame, now);
      setTimeout(() => {
        this.applyFrameConfigWhenReady(frame, this.config.data).catch(() => {});
      }, 1200).unref();
    });
  }

  /** 新标签页拿到真实地址再接管；window.open 常常先给一个 about:blank */
  async waitForRealUrl(page, timeoutMs = 9000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (page.isClosed()) return '';
      let u = '';
      try {
        u = page.url();
      } catch (e) {
        return '';
      }
      if (u && u !== 'about:blank' && !/^(chrome-error|devtools):/.test(u)) {
        // 有的站点先开空页、再由 opener 写地址/提交表单，等一拍看是不是还要跳
        await sleep(200);
        try {
          return page.url() || u;
        } catch (e) {
          return u;
        }
      }
      await sleep(150);
    }
    try {
      return page.url() === 'about:blank' ? '' : page.url();
    } catch (e) {
      return '';
    }
  }

  /**
   * 接管新标签页：截图、点击、地址栏、答题日志全部跟着它走。
   * 这是「点了带 target=_blank 的链接，画面却还在原页面」的根因所在。
   */
  async adoptPage(page, opts = {}) {
    if (!page || page.isClosed()) return false;
    if (this.page === page) return false;
    if (this._adopting.has(page)) return false;
    this._adopting.add(page);
    try {
      const prev = this.page;
      const first = !prev;
      const url = await this.waitForRealUrl(page, first ? 3000 : 9000);
      if (page.isClosed()) return false;
      // 纯 about:blank 的弹窗（广告、统计脚本）没有真实地址，不抢画面
      if (!url && !opts.force) return false;

      const task = this.current;
      // 锁定模式的含义就是「固定这一页」，自动切走会让挂课的进度统计断掉。
      // 页面仍在后台开着，需要时点地址栏旁的标签按钮切过去。
      if (task && task.pin && opts.auto !== false) {
        this.bindPage(page, task);
        this.addLog(task, 'info', `已在新标签页打开：${url || page.url()}（锁定模式不切页，可点标签按钮切换）`);
        return false;
      }

      this.page = page;
      page.__ocsClaimed = true;
      this.bindPage(page, task);
      // 必须把标签切到前台：后台标签里的 window.open / 键盘输入 / 弹窗
      // 会被 Chromium 当成"非用户操作"而静默丢弃
      await page.bringToFront().catch(() => {});
      this._pageStack = [prev, ...this._pageStack.filter((p) => p && p !== prev && !p.isClosed())].slice(0, 8);

      if (task && task.pin && url) {
        task.pinUrl = url;
        task.pinDrift = 0;
      }

      if (!first) {
        this.addLog(task, 'info', `${opts.reason || '点击打开了新标签页，已跟随'}：${url || page.url()}`);
        if (task && task.pin) this.addLog(task, 'info', `锁定目标已更新为：${task.pinUrl}`);
      }
      this.emit('change');

      // 新页面里的 OCS 是全新的一份，AI / 题库配置得重新写进去
      if (task) {
        this.applyConfigWithRetry(page, 10000)
          .then((r) => {
            if (!r || !r.ok) return;
            this.addLog(
              task,
              'info',
              `新标签页配置已生效：AI ${r.aiEnabled ? '已启用(' + r.model + ')' : '未启用'}，题库 ${r.wrappers} 个`
            );
          })
          .catch(() => {});
      }
      this.trimTabs();
      return true;
    } finally {
      this._adopting.delete(page);
    }
  }

  /** 关掉多余的标签页：点一晚上的链接能攒出十几个，每个都占几十 MB */
  trimTabs() {
    const list = this.host.pages();
    if (list.length <= 4) return;
    let extra = list.length - 4;
    const keep = new Set([this.page, ...this._pageStack.slice(0, 2)]);
    for (const p of list) {
      if (extra <= 0) break;
      if (keep.has(p)) continue;
      p.close().catch(() => {});
      this._pageStack = this._pageStack.filter((x) => x !== p);
      extra -= 1;
    }
  }

  /** 清理资源用：只留当前页面，其余标签全部关掉（每个标签几十 MB） */
  async closeExtraTabs() {
    const list = this.host.pages();
    if (list.length <= 1) return 0;
    const keep = this.page && !this.page.isClosed() ? this.page : list[list.length - 1];
    let closed = 0;
    for (const p of list) {
      if (p === keep) continue;
      await p.close().catch(() => {});
      closed += 1;
    }
    this._pageStack = [keep];
    if (!this.page) this.page = keep;
    return closed;
  }

  pickFallbackPage(exclude) {
    const list = this.host.pages().filter((p) => p !== exclude && p !== this.page);
    for (const p of this._pageStack) {
      if (list.includes(p)) return p;
    }
    return list.length ? list[list.length - 1] : null;
  }

  /** 当前用户有几个标签页、现在在第几个 */
  tabs() {
    const list = this.host.pages();
    const urls = list.map((p) => {
      try {
        return p.url();
      } catch (e) {
        return '';
      }
    });
    if (!this.page || this.page.isClosed()) return { total: list.length, index: 0, urls };
    const idx = list.indexOf(this.page);
    return { total: list.length, index: idx < 0 ? 0 : idx, urls };
  }

  /** 在标签页之间切换（dir=1 下一个，-1 上一个） */
  async switchTab(dir = 1) {
    const list = this.host.pages();
    if (list.length < 2) return null;
    let idx = list.indexOf(this.page);
    if (idx < 0) idx = 0;
    const next = list[((idx + (dir > 0 ? 1 : -1)) % list.length + list.length) % list.length];
    if (!next || next === this.page) return null;
    const ok = await this.adoptPage(next, { force: true, auto: false, reason: '已切换到标签页' });
    return ok ? this.tabs() : null;
  }

  /** 把服务端配置写进页面里的 OCS（所有 frame，含 iframe） */
  async applyConfig(task, targetPage) {
    const cfg = this.config.data;
    let last = null;
    for (const frame of targetPage.frames()) {
      const r = await this.applyConfigToFrame(frame, cfg).catch(() => null);
      if (r && r.ok) last = r;
    }
    return last;
  }

  /**
   * 等每个 frame 里的 OCS 真正初始化完再写配置。
   * iframe 里的脚本要一两秒才挂上 window.OCS，只写一次很容易扑空——
   * 扑空的直接后果就是「你还没设置题库 / AI 答题不生效」。
   */
  async applyConfigWithRetry(targetPage, timeoutMs = 15000) {
    if (!targetPage || targetPage.isClosed()) return null;
    // AI 段按用户解析：这个人可能配了别的服务商/Key，不能把全局那份直接塞给他
    const cfg = Object.assign({}, this.config.data, {
      ai: resolveAi(this.config.data.ai, this.host.user)
    });
    const ready = new WeakSet();
    const start = Date.now();
    let last = null;
    while (Date.now() - start < timeoutMs) {
      let pending = 0;
      for (const frame of targetPage.frames()) {
        if (ready.has(frame)) continue;
        const r = await this.applyConfigToFrame(frame, cfg).catch(() => null);
        if (r && r.ok) {
          ready.add(frame);
          last = r;
        } else {
          pending += 1;
        }
      }
      if (!pending) break;
      if (targetPage.isClosed()) break;
      await sleep(700);
    }
    return last;
  }

  async applyFrameConfigWhenReady(frame, cfg, timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const r = await this.applyConfigToFrame(frame, cfg).catch(() => null);
      if (r && r.ok) return r;
      if (frame.isDetached()) return null;
      await sleep(600);
    }
    return null;
  }

  /**
   * 点击/回车之后盯几秒：出现 document 级请求就说明页面要跳了，
   * 先把目标地址写进日志，免得用户只看到画面一变、不知道去了哪。
   */
  watchNavigation(beforeUrl, ms = 4000) {
    const page = this.page;
    const task = this.current;
    if (!page || page.isClosed()) return;
    let reported = '';
    const report = (target, verb) => {
      if (!target || target === beforeUrl || target === 'about:blank' || target.startsWith('data:')) return;
      if (target === reported) return;
      reported = target;
      this.addLog(task, 'info', `${verb}${target}`);
    };
    const onRequest = (req) => {
      try {
        if (req.resourceType() === 'document') report(req.url(), '即将跳转到：');
      } catch (e) {}
    };
    const onNav = (frame) => {
      try {
        if (frame === page.mainFrame()) report(page.url(), '页面已跳转到：');
      } catch (e) {}
    };
    const timer = setTimeout(() => {
      page.off('request', onRequest);
      page.off('framenavigated', onNav);
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
    page.on('request', onRequest);
    page.on('framenavigated', onNav);
  }

  async applyConfigToFrame(frame, cfg) {
    return frame.evaluate(
      (c) => {
        const OCS = window.OCS;
        if (!OCS || !OCS.CommonProject || !OCS.CommonProject.scripts) return { ok: false, reason: 'no-ocs' };
        const settings = OCS.CommonProject.scripts.settings;
        if (!settings || !settings.cfg) return { ok: false, reason: 'no-settings' };
        if (c.ai) {
          settings.cfg.aiAnswerer = Object.assign({}, settings.cfg.aiAnswerer || {}, c.ai);
        }
        if (Array.isArray(c.wrappers) && c.wrappers.length) {
          settings.cfg.answererWrappers = c.wrappers;
        }
        if (c.disableSync) settings.cfg.closeSync = true;
        if (c.cryptoTextMode) settings.cfg.cryptoTextMode = c.cryptoTextMode;
        if (c.cryptoTextBatch) settings.cfg.cryptoTextBatch = c.cryptoTextBatch;
        if (c.cryptoTextRefTable) settings.cfg.cryptoTextRefTable = c.cryptoTextRefTable;
        const ai = settings.cfg.aiAnswerer || {};
        return {
          ok: true,
          aiEnabled: !!ai.enabled,
          model: ai.model || '',
          wrappers: (settings.cfg.answererWrappers || []).length
        };
      },
      {
        ai: cfg.ai,
        wrappers: cfg.answererWrappers,
        disableSync: cfg.ocs && cfg.ocs.disableConfigSync,
        cryptoTextMode: cfg.ocs && cfg.ocs.cryptoText && cfg.ocs.cryptoText.mode,
        cryptoTextBatch: cfg.ocs && cfg.ocs.cryptoText && cfg.ocs.cryptoText.aiBatch,
        cryptoTextRefTable: cfg.ocs && cfg.ocs.cryptoText && cfg.ocs.cryptoText.refTableUrl
      }
    );
  }

  async waitForOcs(task, targetPage, timeoutMs = 45000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ok = await targetPage
        .evaluate(() => !!(window.OCS && window.OCS.CommonProject && window.OCS.CommonProject.scripts))
        .catch(() => false);
      if (ok) return true;
      await sleep(1000);
    }
    return false;
  }

  /**
   * 停在登录页时等用户手动登录。登录成功后重新打开任务地址，
   * 保证进入的是原本要挂的那一节，而不是平台首页。
   */
  async waitForLogin(task, timeoutMs = 15 * 60000) {
    const start = Date.now();
    while (!this.stopped && this.page && !this.page.isClosed() && Date.now() - start < timeoutMs) {
      await sleep(3000);
      const g = await this.detectGate();
      if (g && g.type === 'login') continue;
      this.gateKey = g ? g.type : null;
      this.addLog(task, 'info', '已离开登录页，重新打开任务地址');
      await this.host.navigate(this.page, task.url).catch(() => {});
      await sleep(1500);
      return true;
    }
    return false;
  }

  /**
   * enc 校验失败时，去掉 enc 再进一次。
   * 能进就说明只是链接过期/被截断，把任务地址顺手改掉；
   * 仍然拦着就判定这个链接不可用，让上层报错，不要白等一晚上。
   */
  async tryEncFallback(task, gate) {
    const alt = stripEnc(task.url);
    if (!alt || alt === task.url) return gate;
    this.addLog(task, 'warn', `enc 无效，去掉 enc 参数重试一次：${alt}`);
    await this.host.navigate(this.page, alt).catch(() => {});
    await sleep(2500);
    this.gateAt = 0;
    const next = await this.checkGate(task);
    if (!next) {
      task.url = alt;
      task.error = null;
      task.gate = null;
      this.emit('task-url', task);
      this.addLog(task, 'info', '去掉 enc 可以正常进入，已把任务地址更新为上面这条');
      return null;
    }
    task.error = `${gate.title}：${gate.tip.replace(/\*\*/g, '')}`;
    this.emit('change');
    this.addLog(task, 'error', '去掉 enc 后仍被拦截，这个链接需要重新获取');
    return gate;
  }

  async clickByText(task, texts) {
    for (const frame of this.page.frames()) {
      for (const text of texts) {
        const clicked = await frame
          .evaluate((t) => {
            const nodes = Array.from(document.querySelectorAll('button, a, div, span, li'));
            const target = nodes.find(
              (n) => n.offsetParent !== null && n.textContent && n.textContent.trim() === t && n.children.length <= 2
            );
            if (!target) return false;
            target.click();
            return true;
          }, text)
          .catch(() => false);
        if (clicked) {
          this.addLog(task, 'info', `已自动点击「${text}」`);
          return true;
        }
      }
    }
    return false;
  }

  async sampleProgress() {
    if (!this.page || this.page.isClosed()) return null;
    let time = 0;
    let playing = 0;
    for (const frame of this.page.frames()) {
      const res = await frame
        .evaluate(() => {
          const videos = Array.from(document.querySelectorAll('video'));
          return {
            time: videos.reduce((s, v) => s + (v.currentTime || 0), 0),
            playing: videos.filter((v) => !v.paused && !v.ended).length
          };
        })
        .catch(() => null);
      if (res) {
        time += res.time;
        playing += res.playing;
      }
    }
    return { time, playing, url: this.page.url() };
  }

  /** 读页面正文，判断是否被登录页 / enc 失效页挡住 */
  async detectGate() {
    if (!this.page || this.page.isClosed()) return null;
    const url = this.page.url();
    // 超星的学习页是 iframe 套 iframe，提示文案常常打在内层框架里，
    // 只读主框架会漏判，所以逐个框架都看一遍
    for (const frame of this.page.frames()) {
      const text = await frame
        .evaluate(() => {
          const body = document.body;
          if (!body) return '';
          return (body.innerText || '').replace(/\s+/g, '').slice(0, 6000);
        })
        .catch(() => '');
      if (!text) continue;
      const hit = PAGE_GATES.find((g) => g.match(url, text));
      if (hit) return hit;
    }
    return null;
  }

  /**
   * 首次加载和守护循环里都会调用。
   * 同一状态只报一次，避免每 20 秒刷屏。
   */
  async checkGate(task) {
    // 锁定模式下 tick 每 2 秒一次，没必要每轮都去读一遍页面
    if (Date.now() - (this.gateAt || 0) < 5000) return this.gateHit || null;
    this.gateAt = Date.now();

    const gate = await this.detectGate();
    this.gateHit = gate;
    const key = gate ? gate.type : null;
    if (key === this.gateKey) return gate;
    const prev = this.gateKey;
    this.gateKey = key;

    if (!gate) {
      if (prev) this.addLog(task, 'info', '页面已恢复正常');
      return null;
    }

    // enc 先按 warn 记：调用方紧接着会试着去掉 enc 重进，失败了才升级成错误
    const level = gate.fatal && gate.type !== 'enc' ? 'error' : 'warn';
    this.addLog(task, level, `[${gate.title}] ${gate.tip.replace(/\*\*/g, '')}`);
    if (gate.fatal) {
      task.error = `${gate.title}：${gate.tip.replace(/\*\*/g, '')}`;
      task.gate = { type: gate.type, title: gate.title, tip: gate.tip };
      this.emit('change');
    }
    return gate;
  }

  async runTask(task) {
    const cfg = this.config.data;
    const pin = !!task.pin;
    // 0 = 关闭无进度检测（一直等下去）
    const stallLimit = Math.max(0, Number(cfg.ocs.stallTimeoutMinutes ?? 15) || 0) * 60000;
    // 0 = 不限单任务时长，跑到课程结束或手动停止
    const maxDuration = Math.max(0, Number(cfg.ocs.maxDurationMinutes ?? 0) || 0) * 60000;
    let reloadTimes = Math.max(0, Number(cfg.ocs.maxReloadTimes ?? 2));

    this.addLog(task, 'info', `开始任务：${task.name}${task.url ? ' → ' + task.url : ''}`);
    // 新建任务时已经开过空白页，直接用；页面被关了才新开
    this.page = this.page && !this.page.isClosed() ? this.page : await this.host.newPage();
    const page = this.page;
    this.bindPage(page, task);
    // 之前手动点开、还留着的标签也接上日志，切过去时不用再等
    for (const p of this.host.pages()) this.bindPage(p, task);

    await this.host.navigate(page, task.url);
    await sleep(1200);

    // 先看是不是被挡在登录页 / enc 失效页，否则后面只会等来一句
    // 「脚本注入超时」或「未找到开始学习按钮」，看不出真实原因
    let gate = await this.checkGate(task);
    if (gate && gate.type === 'enc') gate = await this.tryEncFallback(task, gate);
    if (gate && gate.fatal) {
      throw new Error(`${gate.title}：${gate.tip.replace(/\*\*/g, '')}`);
    }
    if (gate && gate.type === 'login') {
      const ok = await this.waitForLogin(task);
      if (!ok) throw new Error('等待登录超时（15 分钟）：请在本账号的画面里先完成登录，再运行任务');
      gate = null;
    }

    const ready = await this.waitForOcs(task, page);
    if (!ready) throw new Error('等待 OCS 脚本注入超时（页面未加载完，或该站点不被脚本支持）');
    this.addLog(task, 'info', 'OCS 脚本已注入');

    const mainApplied = await this.applyConfigWithRetry(page);
    if (mainApplied && mainApplied.ok) {
      this.addLog(
        task,
        'info',
        `配置已生效：AI ${mainApplied.aiEnabled ? '已启用(' + mainApplied.model + ')' : '未启用'}，题库 ${mainApplied.wrappers} 个`
      );
    }

    if (cfg.ocs.autoStart) {
      await sleep(3000);
      const clicked = await this.clickByText(task, START_TEXTS);
      if (!clicked) this.addLog(task, 'warn', '未找到「开始学习」按钮，请在控制台画面中手动点击');
    }

    if (pin) {
      // 等跳转稳定后再钉住，否则可能锁在跳转过程中的空白页
      await sleep(1500);
      const cur = (this.page && !this.page.isClosed() ? this.page : page).url();
      // 页面还停在入口地址 → 锁入口；已被「开始学习」带走 → 锁新页面
      task.pinUrl = this.isSamePage(cur, task.url) ? task.url : cur;
      task.pinDrift = 0;
      this.addLog(task, 'info', `已锁定当前页面：${task.pinUrl}`);
    }

    this.addLog(
      task,
      'info',
      pin
        ? `进入锁定守护：固定在此页面持续执行，不刷新、不切页，直到手动停止`
        : `进入守护状态：${stallLimit > 0 ? `无进度 ${Math.round(stallLimit / 60000)} 分钟会尝试刷新` : '不检测无进度'}，${
            maxDuration > 0
              ? `单任务最长 ${maxDuration >= 60000 ? Math.round(maxDuration / 60000) + ' 分钟' : Math.round(maxDuration / 1000) + ' 秒'}`
              : '不限单任务时长'
          }`
    );

    const deadline = maxDuration > 0 ? Date.now() + maxDuration : Infinity;
    let last = await this.sampleProgress();
    let lastChangeAt = Date.now();

    await new Promise((resolve) => {
      this.finishCurrent = () => {
        this.finishCurrent = null;
        resolve();
      };
      const tick = async () => {
        if (this.stopped || !this.page || this.page.isClosed()) return resolve();
        if (Date.now() > deadline) {
          this.addLog(task, 'info', '已达到单任务最长运行时间，结束该任务');
          return resolve();
        }

        // 页面可能中途被踢回登录页，或 enc 失效，及时暴露而不是干等一晚上
        const gate = await this.checkGate(task);
        if (gate && gate.fatal) {
          this.addLog(task, 'error', `已停止该任务：${gate.title}`);
          return resolve();
        }

        // 锁定模式：不刷新、不因无进度结束，只负责把页面拉回锁定地址
        if (pin) {
          if (gate && gate.type === 'login') {
            // 用户正在登录，这时拉回锁定页会让他永远登不上
            this.watchdog = setTimeout(tick, 4000);
            return;
          }
          // 正在接管新标签页时别拉回，否则会把刚打开的新页面拽回旧地址
          if (this._adopting.size) {
            this.watchdog = setTimeout(tick, 1500);
            return;
          }
          // 页面可能已经被切到别的标签，用当前页面判断，别拉回已经不在前台的旧页
          const cur = this.page;
          if (!cur || cur.isClosed()) return resolve();
          if (task.pinUrl && !this.isSamePage(cur.url(), task.pinUrl)) {
            task.pinDrift = (task.pinDrift || 0) + 1;
            if (task.pinDrift <= 5) {
              this.addLog(task, 'warn', `页面跳到别处（${cur.url()}），正在拉回锁定页`);
              await this.host.navigate(cur, task.pinUrl).catch(() => {});
              await sleep(2500);
              await this.applyConfig(task, cur);
            } else {
              this.addLog(task, 'error', '多次离开锁定页，已停止拉回（可点「重新锁定」更新目标）');
              task.pinUrl = cur.url();
            }
          }
          this.watchdog = setTimeout(tick, 5000);
          return;
        }

        const now = await this.sampleProgress();
        if (now && last && (now.time > last.time + 0.5 || now.url !== last.url)) {
          lastChangeAt = Date.now();
          task.progress = Math.round(now.time);
        }
        last = now;
        const stalled = Date.now() - lastChangeAt;
        if (stallLimit > 0 && stalled > stallLimit) {
          if (reloadTimes > 0) {
            reloadTimes--;
            this.addLog(task, 'warn', `已 ${Math.round(stalled / 60000)} 分钟无进度，刷新页面（剩余重试 ${reloadTimes} 次）`);
            lastChangeAt = Date.now();
            const cur = this.page;
            if (!cur || cur.isClosed()) return resolve();
            await cur.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
            await sleep(4000);
            await this.applyConfig(task, cur);
            if (cfg.ocs.autoStart) await this.clickByText(task, START_TEXTS);
          } else {
            this.addLog(task, 'info', '多次刷新后仍无进度，判定该课程已完成，切换到下一任务');
            return resolve();
          }
        }
        this.watchdog = setTimeout(tick, 20000);
      };
      // 锁定模式只读一次 URL，可以查得勤一点，跳走能立刻拉回
      this.watchdog = setTimeout(tick, pin ? 2000 : 20000);
    });
  }

  async screenshot(quality = 60, hd = false) {
    if (!this.page || this.page.isClosed()) return null;
    // 手机 + 电脑同时开着控制台时，几个请求可能同一瞬间到达，
    // 合并成一次截图，避免同一帧被重复渲染编码 N 次
    const key = `${quality}:${hd ? 1 : 0}`;
    if (this._shot && this._shot.key === key) return this._shot.promise;

    let promise;
    promise = this.page
      .screenshot({
        type: 'jpeg',
        quality,
        fullPage: false,
        // hd 时按设备像素截图；需要 browser.deviceScaleFactor > 1 才有实际提升
        scale: hd ? 'device' : 'css',
        // 页面卡死时不要一直挂着占住请求
        timeout: 8000
      })
      .catch(() => null)
      .then((buf) => {
        if (this._shot && this._shot.promise === promise) this._shot = null;
        return buf;
      });

    this._shot = { key, promise };
    return promise;
  }

  async click(x, y) {
    if (!this.page || this.page.isClosed()) return false;
    const before = this.page.url();
    await this.page.mouse.click(x, y);
    this.watchNavigation(before);
    return true;
  }

  async dblclick(x, y) {
    if (!this.page || this.page.isClosed()) return false;
    const before = this.page.url();
    // delay 压到 80ms，太慢的话页面会当成两次独立单击，而不是双击
    await this.page.mouse.dblclick(x, y, { delay: 80 });
    this.watchNavigation(before);
    return true;
  }

  async type(text) {
    if (!this.page || this.page.isClosed()) return false;
    await this.page.keyboard.type(text, { delay: 30 });
    return true;
  }

  async press(key) {
    if (!this.page || this.page.isClosed()) return false;
    const before = this.page.url();
    await this.page.keyboard.press(key);
    this.watchNavigation(before, 3000);
    return true;
  }

  async goto(url) {
    if (!this.page || this.page.isClosed()) return false;
    await this.host.navigate(this.page, url);
    return true;
  }

  async back() {
    if (!this.page || this.page.isClosed()) return false;
    await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    return true;
  }

  /** 滚轮转发：x/y 为页面坐标，缺省则不移动鼠标（沿用上次位置） */
  async scroll(deltaY, x, y) {
    if (!this.page || this.page.isClosed()) return false;
    if (Number.isFinite(x) && Number.isFinite(y)) {
      await this.page.mouse.move(x, y).catch(() => {});
    }
    const dy = Math.max(-3000, Math.min(3000, Number(deltaY) || 0));
    if (!dy) return true;
    await this.page.mouse.wheel(0, dy).catch(() => {});
    return true;
  }

  /** 只比较 origin + pathname，忽略 query/hash（避免答题时参数变化被误判为离开） */
  isSamePage(a, b) {
    try {
      const u1 = new URL(a);
      const u2 = new URL(b);
      return u1.origin === u2.origin && u1.pathname === u2.pathname;
    } catch (e) {
      return a === b;
    }
  }

  pageUrl() {
    if (!this.page || this.page.isClosed()) return null;
    try {
      return this.page.url();
    } catch (e) {
      return null;
    }
  }

  /** 把锁定点更新为当前页面 */
  relock() {
    const task = this.current;
    if (!task || !this.page || this.page.isClosed()) return null;
    task.pin = true;
    task.pinUrl = this.page.url();
    task.pinDrift = 0;
    this.addLog(task, 'info', `已重新锁定到当前页面：${task.pinUrl}`);
    this.emit('change');
    return task.pinUrl;
  }
}

module.exports = { TaskRunner, PAGE_GATES, stripEnc };
