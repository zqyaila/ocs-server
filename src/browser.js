const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { buildGmShim } = require('./gm-shim');
const { ResourceSaver } = require('./resource-saver');
const { userProfileDir } = require('./config');
const { resolveAi } = require('./user-ai');

const CANDIDATE_BINARIES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/opt/google/chrome/chrome',
  '/usr/lib/chromium/chromium',
  '/snap/bin/chromium'
];

// GM 存储的命名空间由 user.id 决定（见 BrowserHost.scope）

function resolveExecutable(configured) {
  if (configured && fs.existsSync(configured)) return configured;
  for (const p of CANDIDATE_BINARIES) {
    if (fs.existsSync(p)) return p;
  }
  // 回退到 playwright 自带缓存目录
  const cache = path.join(process.env.HOME || '/root', '.cache', 'ms-playwright');
  try {
    for (const dir of fs.readdirSync(cache)) {
      if (!dir.startsWith('chromium-')) continue;
      for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
        const p = path.join(cache, dir, sub);
        if (fs.existsSync(p)) return p;
      }
    }
  } catch (e) {}
  return undefined;
}

/** 从油猴脚本头部读版本号：GM_info.script.version 要跟脚本一致，界面上才不会显示旧版本 */
function parseUserscriptVersion(src) {
  const m = /^\/\/\s*@version\s+(\S+)/m.exec(src || '');
  return m ? m[1] : '';
}

/** 让用户脚本按油猴默认语义（document-idle）执行，避免 document-start 时 body 不存在 */
function wrapToDocumentIdle(src) {
  return `(function(){
  var done = false;
  function __run(){
    if (done) return; done = true;
    try { ${src} } catch (e) { console.error("[OCS-Server] 用户脚本异常", e && e.stack || e); }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", __run, { once: true });
  } else { __run(); }
})();`;
}

/** 一个用户一个浏览器：一个 Chromium 进程 + 一个独立的 user-data-dir */
class BrowserHost {
  constructor({ config, bridge, logger, user }) {
    this.config = config;
    this.bridge = bridge;
    this.logger = logger;
    // 每个用户独立作用域：GM 存储、cookie、localStorage 都按用户隔离
    this.user = user || { id: 'default', name: '默认' };
    this.scope = String(this.user.id);
    this.context = null;
    this.launchArgs = [];
    // 新标签页回调：由 TaskRunner 接管（target=_blank / window.open 打开时）
    this.onPage = null;
    // 省资源：拦截不需要的请求（默认关闭，开关在配置里）
    this.saver = new ResourceSaver({ config, logger });
    // 最后一次有交互的时间，清理闲置浏览器时用
    this.lastActiveAt = Date.now();
  }

  get running() {
    return !!this.context;
  }

  get profileDir() {
    return userProfileDir(this.user.id);
  }

  buildArgs() {
    const c = this.config.data.browser;
    const mem = c.memory || {};
    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      // 自动播放：网课视频无需用户手势即可开始
      '--autoplay-policy=no-user-gesture-required',
      // 后台标签不降频，否则定时器/视频会卡
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion,Translate',
      // 页面里的 window.open / target=_blank 要能真的开出来，否则点了等于没点
      '--disable-popup-blocking',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--mute-audio',
      `--window-size=${c.width},${c.height}`
    ];

    // 内存紧凑模式（默认开）：
    // - process-per-site：同一站点共用一个 renderer，超星一堆 iframe 不会一个域名一个进程
    // - disable-site-isolation-trials：跨站 iframe 也允许合并，进一步减少 renderer 数量
    // - enable-low-end-device-mode：按低内存设备策略跑，栅格缓存和后台缓存都更小
    // - js-flags：给单个 renderer 的 V8 堆封顶，防止挂一晚上涨到 1GB+
    if (mem.tune !== false) {
      args.push(
        '--process-per-site',
        '--disable-site-isolation-trials',
        '--enable-low-end-device-mode'
      );
      const heap = Math.floor(Number(mem.v8HeapMB));
      if (Number.isFinite(heap) && heap >= 128) {
        args.push(`--js-flags=--max-old-space-size=${Math.min(heap, 4096)}`);
      }
    }

    return [...args, ...(c.extraArgs || [])];
  }

  /**
   * 把控制台里的 AI 配置直接写进 GM 存储。
   * 脚本每次读 cfg 都是从 GM 里取的，只靠运行期改内存对象不够——
   * 页面一换（进作业、切章节）就回到旧值，AI 就"莫名其妙不生效"。
   * 题库已彻底移除，这里顺手把残留的题库配置清空。
   */
  syncConfigToStore() {
    // 每个用户可以有自己的接口/Key（见 user-ai.js），这里取这个人实际生效的那份
    const ai = resolveAi(this.config.data.ai, this.user);
    if (ai && typeof ai === 'object') {
      this.bridge.store['common.settings.aiAnswerer'] = JSON.parse(JSON.stringify(ai));
    }
    // 题库通道已删除：清掉旧存储，免得脚本以为还有题库可用
    this.bridge.store['common.settings.answererWrappers'] = [];
    if (this.config.data.ocs && this.config.data.ocs.imageOptimize !== undefined) {
      this.bridge.store['common.settings.imageOptimize'] = !!this.config.data.ocs.imageOptimize;
    }
    // 加密文字还原方式要落到脚本自己的设置里，否则页面换一次就回到脚本默认值
    const ct = (this.config.data.ocs && this.config.data.ocs.cryptoText) || {};
    const mode = String(ct.mode || 'font').toLowerCase();
    this.bridge.store['common.settings.cryptoTextMode'] = ['font', 'ai', 'auto', 'off'].includes(mode) ? mode : 'font';
    this.bridge.store['common.settings.cryptoTextBatch'] = Math.min(60, Math.max(6, Number(ct.aiBatch) || 24));
    if (ct.refTableUrl) this.bridge.store['common.settings.cryptoTextRefTable'] = String(ct.refTableUrl);
    this.bridge.persist();
  }

  async start() {
    // 并发调用（两个任务同时起来 / 接口重复点）时只启动一次，
    // 否则第二个 launch 会把第一个 context 的引用覆盖掉，留下关不掉的浏览器
    if (this.context) return this.context;
    if (this._starting) return this._starting;
    this._starting = this._doStart();
    try {
      return await this._starting;
    } finally {
      this._starting = null;
    }
  }

  async _doStart() {
    const c = this.config.data.browser;
    const executablePath = resolveExecutable(c.executablePath);
    if (!executablePath) {
      throw new Error('未找到 Chromium/Chrome，可执行文件路径不存在。请安装 chromium 或在配置中指定 browser.executablePath');
    }
    const userDataDir = userProfileDir(this.user.id);
    fs.mkdirSync(userDataDir, { recursive: true });
    this.launchArgs = this.buildArgs();
    this.syncConfigToStore();

    this.context = await chromium.launchPersistentContext(userDataDir, {
      executablePath,
      headless: !!c.headless,
      args: this.launchArgs,
      // deviceScaleFactor 必须放在 context 顶层，放进 viewport 会被静默忽略
      deviceScaleFactor: Number(c.deviceScaleFactor) || 1,
      viewport: { width: c.width, height: c.height },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      userAgent: c.userAgent,
      acceptDownloads: false,
      ignoreHTTPSErrors: true
    });

    this.context.on('close', () => {
      this.context = null;
    });

    // 用户点 target=_blank 的链接、或页面 window.open 时，Chromium 会在同一个
    // context 里新开一个标签页。它不属于 runner 的 this.page，如果不接管，
    // 截图和点击就还停在旧标签上——表现就是「点了没反应、页面没跳」。
    this.context.on('page', (page) => {
      if (page.__ocsSelf) return;
      this.attachNewPage(page).catch(() => {});
    });

    // GM API 桥接：页面里的 window.gmBridge 由此注入
    await this.context.exposeBinding('gmBridge', (source, op, payload) =>
      this.bridge.handle(this.scope, source, op, payload)
    );
    this.bridge.registerContext(this.scope, this.context);

    // 省资源：路由只在开启时挂载，关着的时候零开销
    if (this.saver.enabled) {
      await this.context.route('**/*', (route) => this.saver.handle(route));
      this.logger.info(`[${this.user.name}] 已开启省资源模式，拦截统计/第三方等请求`);
    }

    // 用户脚本全局注入（含所有 iframe），语义与油猴一致
    const scriptPath = this.config.data.ocs.scriptPath;
    if (!fs.existsSync(scriptPath)) throw new Error('用户脚本不存在: ' + scriptPath);
    this.userscript = fs.readFileSync(scriptPath, 'utf8');
    this.scriptVersion = parseUserscriptVersion(this.userscript);
    await this.context.addInitScript({ content: wrapToDocumentIdle(this.userscript) });

    this.logger.info(`[浏览器] 已启动 ${executablePath}（${c.headless ? '无头' : '有头'}，软解）`);
    const mem = c.memory || {};
    if (mem.tune !== false) {
      const heap = Math.floor(Number(mem.v8HeapMB));
      this.logger.info(
        `[内存] 紧凑模式：同站进程合并${heap >= 128 ? `，单页面 JS 堆上限 ${heap}MB` : ''}，` +
          `每个账号最多 ${Math.min(10, Math.max(1, Number(mem.maxTabs) || 3))} 个标签页`
      );
    }
    return this.context;
  }

  /** GM 兼容层必须每次导航前重建，才能携带最新的持久化配置 */
  async installGm(page) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Page.enable');
    const res = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: buildGmShim(JSON.stringify(this.bridge.store), { scriptVersion: this.scriptVersion })
    });
    page.__ocsCdp = { session: cdp, scriptId: res.identifier };
    return cdp;
  }

  async refreshGm(page) {
    // 每次导航都重新生成 shim，顺带把最新的 AI / 题库配置写进去，
    // 这样新文档（含 iframe）一加载就能从 GM_getValue 读到配置
    this.syncConfigToStore();
    const prev = page.__ocsCdp;
    if (prev) {
      await prev.session
        .send('Page.removeScriptToEvaluateOnNewDocument', { identifier: prev.scriptId })
        .catch(() => {});
      await prev.session.detach().catch(() => {});
    }
    return this.installGm(page);
  }

  /** 新标签页：装 GM 兼容层后交给 runner 决定是否接管 */
  async attachNewPage(page) {
    this.lastActiveAt = Date.now();
    try {
      page.setDefaultTimeout(30000);
    } catch (e) {}
    // 用户脚本是 context 级注入的，新标签页里也会执行；但 GM_getValue 这套
    // 是 page 级 CDP 脚本，必须给新页面单独补上，否则脚本一进来就报错
    await this.installGm(page).catch(() => {});
    await this.ensureGm(page).catch(() => {});
    if (typeof this.onPage === 'function') await this.onPage(page);
  }

  /**
   * 新标签页有时是带 URL 直接打开的，CDP 的「新文档注入」来不及覆盖当前这一份，
   * 脚本里就没有 GM_getValue。这里就地补一次，避免整个脚本在新标签里失效。
   */
  async ensureGm(page) {
    if (!page || page.isClosed()) return false;
    const ok = await page.evaluate(() => typeof window.GM_getValue === 'function').catch(() => true);
    if (ok) return true;
    await page.evaluate(buildGmShim(JSON.stringify(this.bridge.store), { scriptVersion: this.scriptVersion })).catch(() => {});
    return page.evaluate(() => typeof window.GM_getValue === 'function').catch(() => false);
  }

  async newPage() {
    // 并发调用（新建用户的同时又点了「前往」）只开一个页面，
    // 否则第二个调用会多开一张 about:blank，一直挂在标签列表里
    if (this._opening) return this._opening;
    const ctx = await this.start();
    // start() 期间可能已经有别的调用把页面开出来了，这里必须再判一次
    if (this._opening) return this._opening;
    this.lastActiveAt = Date.now();
    this._opening = (async () => {
      // launchPersistentContext 启动时自带一张 about:blank，直接用它，
      // 否则每个用户都多一个后台标签页（点标签还会切到它）
      const idle = ctx.pages().find((p) => {
        try {
          return !p.__ocsClaimed && !p.isClosed() && p.url() === 'about:blank';
        } catch (e) {
          return false;
        }
      });
      if (idle) {
        idle.__ocsClaimed = true;
        idle.__ocsSelf = true;
        idle.setDefaultTimeout(30000);
        await this.installGm(idle).catch(() => {});
        return idle;
      }
      const page = await ctx.newPage();
      page.__ocsSelf = true;
      page.setDefaultTimeout(30000);
      await this.installGm(page);
      return page;
    })();
    try {
      return await this._opening;
    } finally {
      this._opening = null;
    }
  }

  /** 当前 context 里还活着的标签页，按打开顺序 */
  pages() {
    if (!this.context) return [];
    return this.context.pages().filter((p) => {
      try {
        return !p.isClosed();
      } catch (e) {
        return false;
      }
    });
  }

  async navigate(page, url) {
    this.lastActiveAt = Date.now();
    await this.refreshGm(page);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => {
      this.logger.warn('[浏览器] 打开页面失败: ' + e.message);
    });
    return page;
  }

  async stop() {
    if (!this.context) return;
    const ctx = this.context;
    this.context = null;
    await ctx.close().catch(() => {});
  }
}

module.exports = { BrowserHost, resolveExecutable, wrapToDocumentIdle };
