const http = require('http');
const fs = require('fs');
const path = require('path');
const { Config, DATA_DIR, userDir, userProfileDir, userStorePath, newId } = require('./config');
const { createLogger } = require('./logger');
const { GmBridge } = require('./gm-bridge');
const { BrowserHost } = require('./browser');
const { TaskRunner } = require('./task');
const { recognizeGlyphs } = require('./ai-vision');
const { Metrics } = require('./metrics');
const { CameraHub } = require('./camera');
const { resolveAi, summarize: summarizeAi, sanitize: sanitizeUserAi } = require('./user-ai');
const { forceGc, clearProfileCaches, clearPageCaches } = require('./cleanup');
const { exportBackup, importBackup, MAX_IMPORT_BYTES } = require('./backup');
const { version: PKG_VERSION } = require('../package.json');

const config = new Config();
config.ensure();
const logger = createLogger(DATA_DIR);
const metrics = new Metrics({ dataDir: DATA_DIR });
// 人脸核验：页面要摄像头时，画面由控制台那边提供（不落盘，只在内存里转）
const cameraHub = new CameraHub({
  logger: (level, msg) => (logger[level] || logger.info)(msg),
  onChange: () => broadcastCamera()
});

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

/**
 * 用户列表：一个用户 = 一个账号 = 一套独立的浏览器数据。
 * 重启后把「上次是关着窗还是停着」带回来，卡片上的状态才和关闭时一致。
 */
const users = config.users.map((u) => {
  const st = u.lastStatus === 'closed' || u.lastStatus === 'stopped' ? u.lastStatus : 'idle';
  return Object.assign({}, u, { status: st });
});

/**
 * 每个用户一套运行时：独立 GM 存储、独立 Chromium（独立 user-data-dir）、独立守护循环。
 * 互不串 cookie，关掉服务再开也不用重新登录。
 */
const runtimes = new Map(); // userId -> { bridge, host, runner }
// 先把上一次运行留下的日志读回来：重启后控制台不是一片空白，
// 排查「昨天挂到一半为什么停了」不用再翻 data/logs/server.log
const logs = logger.readHistory(300);

function runtimeFor(user) {
  let rt = runtimes.get(user.id);
  if (rt) return rt;

  const bridge = new GmBridge({
    storePath: userStorePath(user.id),
    onLog: (level, msg) => (logger[level] || logger.info)(msg)
  });
  const host = new BrowserHost({ config, bridge, logger, user });
  const runner = new TaskRunner({ config, host, logger });

  // 页面里「AI 识别加密字」把字形图通过 GM 桥接送过来，这里转给视觉模型。
  // 走桥接而不是页面直接 fetch：不受 https 页面请求 http 的混合内容限制，也不用开 CORS。
  bridge.onOcr = async (userId, payload) => {
    // 用这个用户自己的接口：AI 识别加密字也吃他的额度
    const owner = users.find((u) => u.id === userId) || { id: userId };
    const ai = resolveAi(config.data.ai, owner);
    if (!ai.enabled) return { ok: false, error: 'AI 答题未启用，无法使用 AI 识别加密字' };
    if (ai.supportImages === false) return { ok: false, error: '设置里关闭了「允许发送图片」' };
    const r = await recognizeGlyphs({
      ai,
      bridge,
      image: payload && payload.image,
      count: (payload && payload.count) || 0
    });
    return r;
  };

  // 人脸核验：页面里的 getUserMedia 被 shim 接管后，实际画面从这里取。
  // request 只是登记 + 通知控制台；poll 是页面按帧率来拉最新画面。
  bridge.onCamera = (userId, payload) => {
    const action = payload.action || 'request';
    const u = users.find((x) => x.id === userId);
    const name = u ? u.name : userId;
    if (action === 'request') return cameraHub.request(userId, payload, name);
    if (action === 'poll') return cameraHub.poll(userId);
    if (action === 'release') return cameraHub.release(userId);
    return { ok: false, error: '未知操作' };
  };

  // 页面里点 target=_blank / window.open 会新开一个标签页，
  // 交给 runner 接管，否则截图和点击永远停在旧标签上（看着就是"没跳转"）
  host.onPage = (page) => runner.adoptPage(page).catch(() => {});

  runner.on('log', (entry) => {
    logs.push(entry);
    if (logs.length > 1200) logs.shift();
    sseBroadcast(entry);
  });
  // enc 兜底成功会把用户地址改成去掉 enc 的版本，顺手落盘免得下次又踩
  runner.on('task-url', () => persistUsers());
  // 页面跳转、任务开始/结束都记一笔，重启后知道上次停在哪。
  // 多个用户同时跑时，别让他们互相顶掉「控制台正在看谁」：
  // 个人地址照记，session 只在还没有人、或本来就是这个人时才更新。
  runner.on('change', () => {
    try {
      const at = runner.pageUrl();
      if (/^https?:\/\//i.test(at || '') && at !== user.lastUrl) {
        user.lastUrl = at;
        scheduleSessionSave();
      }
      const s = config.data.session || {};
      if (!s.lastUserId || s.lastUserId === user.id) noteSession(user, at);
    } catch (e) {}
  });

  rt = { bridge, host, runner };
  runtimes.set(user.id, rt);
  syncProfiles();
  return rt;
}

/** 把「用户 → profile 目录」交给指标模块，用来认领各自的 Chromium 进程 */
function syncProfiles() {
  const map = new Map();
  for (const [id, rt] of runtimes) map.set(id, rt.host.profileDir);
  metrics.setProfiles(map);
}

/** 所有浏览器实例的省资源拦截计数合计 */
function saverStats() {
  let blocked = 0;
  const byType = {};
  for (const rt of runtimes.values()) {
    if (!rt.host.saver) continue;
    const s = rt.host.saver.stats();
    blocked += s.blocked;
    for (const [k, v] of Object.entries(s.byType)) byType[k] = (byType[k] || 0) + v;
  }
  return { blocked, byType };
}

function hasProfile(user) {
  try {
    return fs.existsSync(path.join(userProfileDir(user.id), 'Default'));
  } catch (e) {
    return false;
  }
}

function snapshotUser(u) {
  const rt = runtimes.get(u.id);
  return {
    id: u.id,
    name: u.name,
    url: u.url || '',
    pageUrl: rt ? rt.runner.pageUrl() : null,
    // 窗口关着的时候前端用这个显示「上次停在哪」
    lastUrl: u.lastUrl || '',
    status: u.status || 'idle',
    running: !!(rt && rt.runner.current),
    browserRunning: !!(rt && rt.host.running),
    progress: u.progress || 0,
    pin: !!u.pin,
    pinUrl: u.pinUrl || null,
    tabs: rt ? rt.runner.tabs() : { total: 0, index: 0 },
    error: u.error || null,
    saved: hasProfile(u),
    // 只给摘要：这个用户是不是单独配了 AI、用的哪个模型。Key 永远不出服务端
    ai: summarizeAi(config.data.ai, u),
    startedAt: u.startedAt || null,
    finishedAt: u.finishedAt || null
  };
}

/**
 * 单个用户的 AI 配置视图（给面板用）。
 * - ai：这个人的可编辑项，Key 只回 hasKey / ownKey，不回明文
 * - global：全局那份的摘要，面板上用来说明「留空就用这个」
 * - effective：合并后真正在用的接口，面板上直接显示，省得自己算
 */
function userAiView(user) {
  const own = user.ai && typeof user.ai === 'object' ? user.ai : {};
  const eff = resolveAi(config.data.ai, user);
  const g = config.data.ai || {};
  const custom = !!own.custom;
  return {
    ai: {
      custom,
      enabled: custom && own.enabled !== undefined ? !!own.enabled : !!eff.enabled,
      provider: custom ? own.provider || '' : '',
      baseUrl: custom ? own.baseUrl || '' : '',
      model: custom ? own.model || '' : '',
      temperature: Number(custom && own.temperature !== undefined ? own.temperature : eff.temperature ?? 0.2),
      maxTokens: Number(custom && own.maxTokens !== undefined ? own.maxTokens : eff.maxTokens ?? 1024),
      supportImages: custom && own.supportImages !== undefined ? !!own.supportImages : eff.supportImages !== false,
      hasKey: !!eff.apiKey,
      ownKey: !!(custom && own.apiKey)
    },
    global: {
      enabled: !!g.enabled,
      provider: g.provider || '',
      model: g.model || '',
      baseUrl: g.baseUrl || '',
      hasKey: !!g.apiKey
    },
    effective: {
      enabled: !!eff.enabled,
      provider: eff.provider || '',
      model: eff.model || '',
      baseUrl: eff.baseUrl || ''
    }
  };
}

function persistUsers() {
  config.data.users = users.map((u) => {
    const row = { id: u.id, name: u.name, url: u.url || '', pin: !!u.pin };
    // 记住最后停留的页面，重启后能回到原处（登录页、课程页、考试页都算）
    if (u.lastUrl) row.lastUrl = u.lastUrl;
    if (u.lastStatus) row.lastStatus = u.lastStatus;
    // 每个用户自己的 AI 配置要跟着存，否则重启就丢、下次跑又变回全局接口
    if (u.ai && typeof u.ai === 'object') row.ai = u.ai;
    return row;
  });
  config.save();
}

let sessionTimer = null;
/**
 * 记住「现在在看谁、停在哪个地址、是在跑还是停着」。
 * 前端每 2 秒拉一次状态，这里只在内容真的变化时才落盘，
 * 并且把 3 秒内的多次变化合并成一次写文件（config.json 不大，但没必要每秒写）。
 */
function noteSession(user, pageUrl) {
  if (!user) return;
  const s = config.data.session || (config.data.session = {});
  const url = String(pageUrl || '');
  const httpUrl = /^https?:\/\//i.test(url) ? url : '';
  const status = user.status || 'idle';
  if (httpUrl) user.lastUrl = httpUrl;
  user.lastStatus = status;
  if (s.lastUserId === user.id && s.lastPageUrl === (httpUrl || s.lastPageUrl) && s.lastStatus === status) return;
  s.lastUserId = user.id;
  if (httpUrl) s.lastPageUrl = httpUrl;
  s.lastStatus = status;
  s.updatedAt = Date.now();
  scheduleSessionSave();
}

function scheduleSessionSave() {
  if (sessionTimer) return;
  sessionTimer = setTimeout(() => {
    sessionTimer = null;
    try {
      persistUsers();
    } catch (e) {}
  }, 3000);
  if (typeof sessionTimer.unref === 'function') sessionTimer.unref();
}

function send(res, code, body, headers) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {}));
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 2 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        resolve({});
      }
    });
  });
}

/** 上传备份用：readBody 是拼字符串的，二进制走这个 */
function readBinary(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function auth(req, res) {
  const token = config.data.server.token;
  if (!token) return true;
  const url = new URL(req.url, 'http://localhost');
  const provided = req.headers['x-token'] || url.searchParams.get('token');
  if (provided !== token) {
    send(res, 401, { error: '未授权，请提供正确的访问令牌' });
    return false;
  }
  return true;
}

const sseClients = new Set();
function sseBroadcast(entry) {
  const payload = `data: ${JSON.stringify(entry)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (e) {}
  }
}

/** 带事件名的推送：前端用 addEventListener('camera') 接 */
function sseSend(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (e) {}
  }
}

/**
 * 同时写进控制台日志区、SSE 和文件。
 * 配置类操作以前只写文件，用户在面板上看不到「到底生效了没」，只能猜。
 */
function consoleLog(level, message, taskName) {
  const entry = { time: Date.now(), level, message, taskId: null, taskName: taskName || null };
  logs.push(entry);
  if (logs.length > 1200) logs.shift();
  sseBroadcast(entry);
  const fn = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
  logger[fn]((taskName ? `[${taskName}] ` : '') + message);
}

/** 摄像头会话状态变了就推一把，前端不用轮询 */
function broadcastCamera() {
  sseSend('camera', { list: cameraHub.list() });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(filePath, (err, buf) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      // 升级后必须拿到新前端：以前缓存的旧页面会去调已经变了的接口
      'Cache-Control': 'no-store'
    });
    res.end(buf);
  });
}

/** 找用户：?user= 优先，否则第一个有页面的 */
function pickUser(hint) {
  if (hint) {
    const u = users.find((x) => x.id === hint);
    if (u) return u;
  }
  return (
    users.find((u) => {
      const rt = runtimes.get(u.id);
      return rt && rt.runner.page && !rt.runner.page.isClosed();
    }) || null
  );
}

function openUserBrowser(user, opts) {
  const rt = runtimeFor(user);
  const target = String((opts && opts.url) || user.lastUrl || user.url || '').trim();
  // 浏览器启动要一两秒，放后台做，别把请求卡住
  Promise.resolve()
    .then(() => rt.runner.openBlank())
    .then(async () => {
      // 有上次停留的地址就顺手打开，这样重启服务（或重新开窗）就停在原处
      if (/^https?:\/\//i.test(target) && rt.runner.pageUrl() !== target) {
        await rt.runner.goto(target).catch((e) => logger.warn(`[${user.name}] 打开页面失败：${e.message}`));
        logger.info(`[${user.name}] 已回到上次的页面：${target}`);
      } else {
        logger.info(`[${user.name}] 已打开独立浏览器，可以填地址了`);
      }
    })
    .catch((e) => {
      user.status = 'error';
      user.error = '打开浏览器失败：' + e.message;
      logger.error(`[${user.name}] 打开浏览器失败：${e.message}`);
    });
}

async function stopUser(user) {
  const rt = runtimes.get(user.id);
  if (!rt) return;
  await rt.runner.stopAll().catch(() => {});
  // 关掉这个用户的浏览器进程，登录态已经落在磁盘上，下次启动直接复用
  await rt.host.stop().catch(() => {});
  // Chromium 退出后还要一点时间把 cookie / localStorage 刷到磁盘，
  // 立刻重开同一个 profile 会有概率读到上一次的旧库（登录态丢失）
  await sleep(250);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const method = req.method.toUpperCase();
  let pathname = url.pathname;

  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  // 启动器用它判断「这个端口上是不是已经跑着本程序」，不走 token，避免设了令牌就误判成别的程序
  if (pathname === '/api/ping' && method === 'GET') {
    return send(res, 200, { ok: true, name: 'ocs-server', version: PKG_VERSION });
  }

  if (!auth(req, res)) return;

  // 兼容 v2.1 的旧前端（浏览器可能还缓存着 /api/tasks）
  pathname = pathname.replace(/^\/api\/tasks/, '/api/users');

  try {
    /* ---------------- 状态 ---------------- */
    if (pathname === '/api/state' && method === 'GET') {
      const mem = process.memoryUsage();
      // 前端一直用 ?task=，老接口用 ?user=，两个都认
      const focus = pickUser(url.searchParams.get('user') || url.searchParams.get('task'));
      // 顺手记下「谁在被看、停在哪一页」，服务重启时据此恢复现场
      if (focus) {
        const frt = runtimes.get(focus.id);
        noteSession(focus, frt ? frt.runner.pageUrl() : '');
      }
      const list = users.map(snapshotUser);
      let browserCount = 0;
      let browserRunning = false;
      let anyBusy = false;
      for (const rt of runtimes.values()) {
        if (rt.host.running) {
          browserCount += 1;
          browserRunning = true;
        }
        if (rt.runner.busy) anyBusy = true;
      }
      const snap = metrics.snapshot();
      const saver = saverStats();
      // 这里不放 config：题库和 API Key 可能有几十 KB，而前端 1.5 秒拉一次。
      // 配置改成打开设置面板时单独取（/api/config），只有宽高这些常用值留在这里。
      return send(res, 200, {
        browser: {
          running: browserRunning,
          count: browserCount,
          headless: config.data.browser.headless,
          width: config.data.browser.width,
          height: config.data.browser.height,
          deviceScaleFactor: config.data.browser.deviceScaleFactor
        },
        runner: {
          running: users.some((u) => (u.status || '') === 'running'),
          busy: anyBusy
        },
        page: { url: focus ? (runtimes.get(focus.id) || { runner: { pageUrl: () => null } }).runner.pageUrl() : null },
        mem: {
          heapMB: Math.round(mem.heapUsed / 1048576),
          rssMB: Math.round(mem.rss / 1048576),
          chromeMB: snap.chrome.rssMB,
          diskMB: snap.disk.dataMB,
          blocked: saver.blocked
        },
        users: list
      });
    }

    /* ---------------- 上次的现场（选中的用户 / 停留的页面）---------------- */
    if (pathname === '/api/session' && method === 'GET') {
      const s = config.data.session || {};
      return send(res, 200, {
        ok: true,
        lastUserId: s.lastUserId || '',
        lastPageUrl: s.lastPageUrl || '',
        lastStatus: s.lastStatus || '',
        updatedAt: s.updatedAt || 0,
        resumeSession: config.data.server.resumeSession !== false,
        users: users.map((u) => ({
          id: u.id,
          name: u.name,
          lastUrl: u.lastUrl || '',
          lastStatus: u.lastStatus || ''
        }))
      });
    }
    // 前端切到哪个用户就报一下，下次用别的电脑打开控制台也能选回同一个人
    if (pathname === '/api/session' && method === 'PUT') {
      const body = await readBody(req);
      const u = users.find((x) => x.id === body.lastUserId);
      if (!u) return send(res, 400, { error: '用户不存在' });
      const s = config.data.session || (config.data.session = {});
      const urt = runtimes.get(u.id);
      const pageUrl = urt ? urt.runner.pageUrl() : '';
      s.lastUserId = u.id;
      s.lastStatus = u.status || 'idle';
      if (pageUrl) {
        u.lastUrl = pageUrl;
        s.lastPageUrl = pageUrl;
      } else if (u.lastUrl) {
        s.lastPageUrl = u.lastUrl;
      }
      s.updatedAt = Date.now();
      persistUsers();
      return send(res, 200, { ok: true });
    }

    /* ---------------- AI 连通性测试（服务端发起，不受同源限制）---------------- */
    if (pathname === '/api/ai/test' && method === 'POST') {
      const body = await readBody(req);
      // 面板只回传用户填的项：留空的部分（尤其是已保存的 Key）从这个人生效的配置里补，
      // 这样「改个模型名、不重填 Key」也能直接测；没带 userId 就按全局补
      const owner = body.userId ? users.find((u) => u.id === body.userId) : null;
      const eff = resolveAi(config.data.ai, owner || {});
      if (!body.baseUrl) body.baseUrl = eff.baseUrl;
      if (!body.model) body.model = eff.model;
      if (!body.apiKey) body.apiKey = eff.apiKey;
      if (body.temperature === undefined) body.temperature = eff.temperature;
      if (body.maxTokens === undefined) body.maxTokens = eff.maxTokens;
      const base = String(body.baseUrl || '').trim().replace(/\/+$/, '');
      if (!base) return send(res, 200, { ok: false, error: '请先填写接口地址' });
      const target = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
      const headers = { 'Content-Type': 'application/json' };
      if (body.apiKey) headers.Authorization = 'Bearer ' + body.apiKey;
      // 借任意一个 GM 桥接发请求即可，没有就用临时实例
      const firstRt = [...runtimes.values()][0];
      const probe =
        (firstRt && firstRt.bridge) ||
        new GmBridge({ storePath: path.join(DATA_DIR, 'gm-store.probe.json'), onLog: () => {} });
      const t0 = Date.now();
      const r = await probe.http({
        url: target,
        method: 'POST',
        headers,
        data: JSON.stringify({
          model: body.model,
          temperature: body.temperature ?? 0.2,
          max_tokens: Math.min(body.maxTokens || 256, 512),
          messages: [{ role: 'user', content: '用一个字母回答：2+2 等于几？A. 3  B. 4' }]
        }),
        timeout: 30000
      });
      if (r.error) return send(res, 200, { ok: false, error: r.error });
      if (r.status >= 400) {
        let detail = r.responseText.slice(0, 200);
        try {
          const j = JSON.parse(r.responseText);
          detail = (j.error && (j.error.message || j.error)) || detail;
        } catch (e) {}
        return send(res, 200, { ok: false, error: `HTTP ${r.status}：${detail}` });
      }
      let answer = '';
      try {
        const j = JSON.parse(r.responseText);
        answer = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
      } catch (e) {}
      return send(res, 200, { ok: true, answer: answer.trim().slice(0, 80) || '(空回复)', ms: Date.now() - t0 });
    }

    /* ---------------- 配置（AI、题库、浏览器参数）---------------- */
    if (pathname === '/api/config' && method === 'GET') {
      // 每个用户的 API Key 单独走 /api/users/:id/ai 读写，不回传明文，
      // 否则打开一次全局设置就把所有人（可能十来个）的 Key 全发到浏览器
      const pub = JSON.parse(JSON.stringify(config.data));
      if (Array.isArray(pub.users)) {
        for (const u of pub.users) {
          if (u && u.ai && 'apiKey' in u.ai) {
            u.ai.hasKey = !!u.ai.apiKey;
            delete u.ai.apiKey;
          }
        }
      }
      return send(res, 200, pub);
    }
    if (pathname === '/api/config' && method === 'PUT') {
      const patch = await readBody(req);
      const beforeSaver = !!(config.data.browser.resourceSaver && config.data.browser.resourceSaver.enabled);
      config.update(patch);
      const afterSaver = !!(config.data.browser.resourceSaver && config.data.browser.resourceSaver.enabled);

      // 先把响应返回给前端，页面热更新放到后台跑：
      // 每个 frame 都要重试到脚本初始化完，最坏能等 8 秒，没必要让「保存」按钮一直转圈
      const jobs = [...runtimes.values()].map(async (rt) => {
        rt.host.syncConfigToStore();
        const page = rt.runner.page;
        if (!page || page.isClosed()) return;
        await rt.host.refreshGm(page).catch(() => {});
        await rt.runner.applyConfigWithRetry(page, 8000).catch(() => {});
      });
      Promise.all(jobs).catch(() => {});

      // 全局 AI 改动只影响「跟随全局」的人，这点最容易误会成「改了没生效」
      if (patch && patch.ai) {
        const followers = users.filter((u) => !(u.ai && u.ai.custom));
        const own = users.length - followers.length;
        const eff = config.data.ai || {};
        consoleLog(
          'info',
          `全局 AI 已更新为 ${eff.model || '未填模型'}${eff.enabled ? '' : '（未启用）'}：` +
            `${followers.length} 个用户跟随全局，立即生效` +
            (own ? `；${own} 个用户配了独立接口，不受这次修改影响` : '')
        );
      }

      if (beforeSaver !== afterSaver) {
        logger.info(
          afterSaver
            ? '[省资源] 已开启，重启浏览器（停止后重新运行）后生效'
            : '[省资源] 已关闭，重启浏览器后恢复加载全部资源'
        );
      }
      return send(res, 200, { ok: true, config: config.data });
    }

    /* ---------------- 资源占用 ---------------- */
    if (pathname === '/api/metrics' && method === 'GET') {
      metrics.setSaverStats(saverStats());
      syncProfiles();
      const snap = metrics.snapshot();
      return send(res, 200, snap);
    }

    /**
     * 一键清理。scope:
     *   idle = 只处理没在跑任务的用户（会把它们的浏览器整个关掉，最省内存）
     *   all  = 所有用户（运行中的只关多余标签、清缓存，不打断任务）
     */
    if (pathname === '/api/maintenance/cleanup' && method === 'POST') {
      const body = await readBody(req);
      const scope = body.scope === 'all' ? 'all' : 'idle';
      const doTabs = body.tabs !== false;
      const doCache = body.cache !== false;
      const doGc = body.gc !== false;
      const doDisk = !!body.disk;
      const doLogs = !!body.logs;
      const before = metrics.snapshot();
      const details = [];
      let diskFreed = 0;

      for (const user of users) {
        const rt = runtimes.get(user.id);
        if (!rt) continue;
        const busy = !!(rt.runner.current || rt.runner.busy);
        if (scope === 'idle' && busy) continue;

        if (!busy && rt.host.running) {
          await stopUser(user).catch(() => {});
          details.push(`${user.name}：已关闭空闲浏览器`);
        } else if (rt.host.running) {
          if (doTabs) {
            const n = await rt.runner.closeExtraTabs().catch(() => 0);
            if (n) details.push(`${user.name}：关闭 ${n} 个多余标签页`);
          }
          if (doCache && rt.runner.page && !rt.runner.page.isClosed()) {
            const ok = await clearPageCaches(rt.runner.page).catch(() => false);
            if (ok) details.push(`${user.name}：已清空浏览器缓存并触发页面 GC`);
          }
        }
        if (doDisk && !rt.host.running) {
          const freed = clearProfileCaches(rt.host.profileDir);
          if (freed > 0) {
            diskFreed += freed;
            details.push(`${user.name}：清理磁盘缓存 ${Math.round(freed / 1048576)}MB`);
          }
        }
      }
      if (doGc) {
        const ok = forceGc();
        details.push(ok ? 'Node 堆已回收' : '当前 Node 不支持手动 GC（可忽略）');
      }
      if (doLogs) {
        logs.length = 0;
        details.push('已清空内存中的日志');
      }
      await sleep(600);
      metrics.sample();
      const after = metrics.snapshot();
      const beforeMB = before.node.rssMB + before.chrome.rssMB;
      const afterMB = after.node.rssMB + after.chrome.rssMB;
      const freedMB = Math.max(0, beforeMB - afterMB) + Math.round(diskFreed / 1048576);
      logger.info(
        `[清理] ${scope === 'all' ? '全部用户' : '空闲用户'}：内存 ${beforeMB}MB → ${afterMB}MB` +
          (diskFreed ? `，磁盘 ${Math.round(diskFreed / 1048576)}MB` : '')
      );
      return send(res, 200, { ok: true, freedMB, beforeMB, afterMB, details });
    }

    /* ---------------- 备份 / 迁移 ---------------- */
    /**
     * 导出：把 config.json + 每个用户的 profile / gm-store 打成一个 zip。
     * 缓存目录（Cache / Code Cache / GPUCache …）不进包，体积能小一个数量级。
     */
    if (pathname === '/api/backup/export' && method === 'GET') {
      try {
        const busy = users.filter((u) => {
          const rt = runtimes.get(u.id);
          return rt && rt.host && rt.host.running;
        }).length;
        if (busy) {
          logger.warn(`[备份] 有 ${busy} 个账号的浏览器正在运行，正在打包它当前的登录态（建议跑完再导出）`);
        }
        const out = exportBackup(DATA_DIR, config);
        const ts = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-');
        const name = 'ocs-backup-' + ts + '.zip';
        logger.info(
          `[备份] 已导出：${out.manifest.users} 个用户、${out.count} 个文件、${Math.round(out.buffer.length / 1048576)}MB`
        );
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': 'attachment; filename="' + name + '"',
          'Content-Length': out.buffer.length,
          'Cache-Control': 'no-store'
        });
        return res.end(out.buffer);
      } catch (e) {
        logger.error('[备份] 导出失败：' + e.message);
        return send(res, 500, { error: '导出失败：' + e.message });
      }
    }

    /**
     * 导入：接收 zip 覆盖 config.json 与 users/。
     * 导入前必须把所有浏览器关掉，否则文件被占用，Windows 上会 EBUSY。
     * 旧数据会留在 data.bak-<时间>/ 里，导错了还能拿回来。
     */
    if (pathname === '/api/backup/import' && method === 'POST') {
      let buf;
      try {
        buf = await readBinary(req, MAX_IMPORT_BYTES);
      } catch (e) {
        return send(res, 413, { error: '备份文件太大（上限 512MB），请直接拷贝 data 目录' });
      }
      if (!buf.length) return send(res, 400, { error: '没有收到文件内容' });

      for (const u of users) {
        try {
          await stopUser(u);
        } catch (e) {}
      }
      runtimes.clear();

      // 访问令牌 / 端口 / 监听地址是「这台机器怎么访问」，不该跟着账号数据走。
      // 服务器上设了 token 的话，照搬过来会让本机控制台直接 401，看着像导入坏了。
      const localServer = JSON.parse(JSON.stringify(config.data.server || {}));

      let result;
      try {
        result = importBackup(buf, DATA_DIR);
      } catch (e) {
        logger.error('[备份] 导入失败：' + e.message);
        return send(res, 400, { error: '导入失败：' + e.message });
      }

      // 重新读一遍配置：脚本路径 / 浏览器路径指向别的机器时会被换成本机的
      try {
        config.data = config.load();
        if (localServer && Object.keys(localServer).length) {
          config.data.server = Object.assign({}, config.data.server, localServer);
          config.save();
        }
      } catch (e) {
        logger.error('[备份] 配置重载失败：' + e.message);
      }
      const next = config.users.map((u) => ({
        ...u,
        status: u.lastStatus === 'closed' || u.lastStatus === 'stopped' ? u.lastStatus : 'idle'
      }));
      users.length = 0;
      users.push(...next);

      logger.info(
        `[备份] 已导入 ${next.length} 个用户、${result.files} 个文件` +
          (result.backup ? `，原数据已备份到 ${path.basename(result.backup)}` : '')
      );

      // Chromium 的 Cookie 在 Linux 上用固定密钥、Windows 上走 DPAPI，两边密文互不通用。
      // 跨系统迁移时登录态基本解不开，得让用户知道要重新扫一次码，而不是以为导入坏了。
      const from = result.manifest && result.manifest.platform;
      const crossPlatform = !!(from && from !== process.platform);
      if (crossPlatform) {
        logger.warn(
          `[备份] 备份来自 ${from}，当前是 ${process.platform}：` +
            '账号和配置都过来了，但浏览器 Cookie 无法跨系统解密，可能需要重新登录一次'
        );
      }

      return send(res, 200, {
        ok: true,
        users: next.length,
        files: result.files,
        backup: result.backup ? path.basename(result.backup) : '',
        names: next.map((u) => u.name),
        fromPlatform: from || '',
        crossPlatform
      });
    }

    /* ---------------- 用户 ---------------- */
    if (pathname === '/api/users' && method === 'GET') {
      return send(res, 200, { users: users.map(snapshotUser) });
    }

    if (pathname === '/api/users' && method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      if (!name) return send(res, 400, { error: '请先给用户起个名字' });
      if (users.some((u) => u.name === name)) return send(res, 400, { error: '已经有同名用户了，换个名字吧' });
      const user = {
        id: newId(),
        name,
        url: String(body.url || '').trim(),
        status: 'idle',
        pin: !!body.pin
      };
      users.push(user);
      persistUsers();
      openUserBrowser(user); // 新建即开一个独立浏览器
      return send(res, 200, { ok: true, user: snapshotUser(user) });
    }

    const userMatch = pathname.match(
      /^\/api\/users\/([^/]+)(?:\/(run|pin|relock|stop|goto|open|tabs|ai|window))?$/
    );
    if (userMatch) {
      const user = users.find((u) => u.id === userMatch[1]);
      if (!user) return send(res, 404, { error: '用户不存在' });
      const action = userMatch[2];
      const rt = runtimeFor(user);
      const r = rt.runner;

      // 这个用户自己的 AI 接口：不同账号可以用不同服务商、不同 Key、不同额度
      if (action === 'ai') {
        if (method === 'GET') return send(res, 200, { ok: true, ...userAiView(user) });
        if (method === 'PUT' || method === 'POST') {
          const body = await readBody(req);
          user.ai = sanitizeUserAi(body, user.ai);
          persistUsers();
          // 立刻生效：GM 存储先换掉（快），页面内存里的 cfg 放后台改，
          // 免得某个页面脚本没初始化完把「保存」按钮卡上几秒
          rt.host.syncConfigToStore();
          const pages = rt.host.pages();
          const eff = resolveAi(config.data.ai, user);
          const keySrc = user.ai.apiKey ? '独立 Key' : eff.apiKey ? '用全局 Key' : '没有 Key';
          const who = user.ai.custom
            ? `独立接口 ${eff.model || '未填模型'}（${keySrc}）`
            : `跟随全局 ${eff.model || '未配置'}`;
          // 推一条到控制台：用户能看见「到底切没切、切到哪」，不用猜
          consoleLog('info', `AI 接口已切换为${who}`, user.name);

          if (pages.length) {
            Promise.all(pages.map((p) => rt.runner.applyConfigWithRetry(p, 10000).catch(() => null))).then((rs) => {
              const ok = rs.filter((x) => x && x.ok).length;
              if (ok) {
                consoleLog('info', `新的 AI 配置已推送到 ${ok} 个页面，正在答题的话下一题就会用新接口`, user.name);
              } else {
                // 页面脚本还没初始化（刚打开/正在跳转），存储已经换好了
                consoleLog('warn', '页面还没准备好，配置已保存；刷新一次这个用户的页面即可生效', user.name);
              }
            });
          } else {
            consoleLog('info', '这个用户的浏览器还没打开，下次打开/运行会自动用新配置', user.name);
          }
          return send(res, 200, { ok: true, ...userAiView(user) });
        }
      }

      // 删除用户
      if (method === 'DELETE' && !action) {
        await stopUser(user);
        runtimes.delete(user.id);
        syncProfiles();
        users.splice(users.indexOf(user), 1);
        persistUsers();
        // 连浏览器数据一起删掉，否则换同名用户会继承上一个账号的登录态
        Promise.resolve()
          .then(() => fs.rmSync(userDir(user.id), { recursive: true, force: true }))
          .catch((e) => logger.warn(`[${user.name}] 清理数据目录失败：${e.message}`));
        return send(res, 200, { ok: true });
      }

      // 打开浏览器但不动任务（用于「先在页面上登录一次」）
      if (method === 'POST' && action === 'open') {
        openUserBrowser(user);
        return send(res, 200, { ok: true });
      }

      // 切换锁定开关；运行中的用户立即生效（把锁点设在当前页）
      if (method === 'POST' && action === 'pin') {
        const body = await readBody(req);
        user.pin = body.pin === void 0 ? !user.pin : !!body.pin;
        if (!user.pin) user.pinUrl = null;
        persistUsers();
        if (user.pin && r.current && r.current.id === user.id) r.relock();
        return send(res, 200, { ok: true, user: snapshotUser(user) });
      }

      // 把锁定点更新为「当前画面所在的页面」
      if (method === 'POST' && action === 'relock') {
        const pinUrl = r.relock();
        if (!pinUrl) return send(res, 409, { error: '当前没有运行中的页面' });
        return send(res, 200, { ok: true, pinUrl });
      }

      // 地址栏「前往」：没在跑就带着地址启动，在跑就直接导航过去
      if (method === 'POST' && action === 'goto') {
        const body = await readBody(req);
        const target = String(body.url || '').trim();
        if (!target) return send(res, 400, { error: '地址不能为空' });
        user.url = target;
        user.error = null;
        if (user.pin) user.pinUrl = target;
        persistUsers();
        if (r.current) {
          await r.goto(target);
          return send(res, 200, { ok: true, pageUrl: r.pageUrl() });
        }
        user.status = 'queued';
        r.enqueue(user);
        return send(res, 200, { ok: true });
      }

      // 切换标签页：点开新页面后想回原来那页时用
      if (method === 'POST' && action === 'tabs') {
        const body = await readBody(req);
        const info = r.tabs();
        if (info.total < 2) return send(res, 409, { error: '当前只有一个标签页' });
        const next = await r.switchTab(Number(body.dir) < 0 ? -1 : 1).catch(() => null);
        if (!next) return send(res, 409, { error: '切换标签页失败' });
        return send(res, 200, { ok: true, url: r.pageUrl(), tabs: next });
      }

      if (method === 'POST' && action === 'stop') {
        await stopUser(user);
        user.status = 'stopped';
        // 主动停止 = 这次不看了，重启时不再自动把窗口开回来
        user.lastStatus = 'stopped';
        const s = config.data.session || (config.data.session = {});
        if (s.lastUserId === user.id) s.lastStatus = 'stopped';
        persistUsers();
        return send(res, 200, { ok: true });
      }

      /**
       * 单独开关这个用户的浏览器窗口（不动任务队列）：
       * - close：只关窗口，登录态 / 上次地址都留着，下次点开直接回到那一页
       * - open ：重新开窗并回到上次的页面
       * 想彻底停下任务用 /stop，想在后台继续挂课就别关窗。
       */
      if (method === 'POST' && action === 'window') {
        const body = await readBody(req);
        const s = config.data.session || (config.data.session = {});
        if (body.action === 'open') {
          if (rt.host.running) return send(res, 200, { ok: true, already: true });
          if (user.status === 'closed') user.status = 'idle';
          user.lastStatus = 'idle';
          s.lastUserId = user.id;
          s.lastStatus = 'idle';
          s.updatedAt = Date.now();
          openUserBrowser(user);
          persistUsers();
          logger.info(`[${user.name}] 已打开浏览器窗口`);
          return send(res, 200, { ok: true });
        }
        if (!rt.host.running) return send(res, 200, { ok: true, already: true });
        await stopUser(user);
        // 关窗是「暂时不用了」，不是「任务跑完了」：状态单独标成 closed，
        // 下次启动看到 closed 就不会又自动把窗口开起来
        user.status = 'closed';
        user.lastStatus = 'closed';
        s.lastUserId = user.id;
        s.lastStatus = 'closed';
        if (user.lastUrl) s.lastPageUrl = user.lastUrl;
        s.updatedAt = Date.now();
        persistUsers();
        logger.info(`[${user.name}] 浏览器窗口已关闭（登录态已保存，随时可以再打开）`);
        return send(res, 200, { ok: true });
      }

      if (method === 'POST' && action === 'run') {
        if (!user.url) return send(res, 400, { error: '先在这个用户下面的地址栏填一个地址' });
        if (r.current || r.busy) return send(res, 409, { error: '这个用户已经在运行了' });
        user.status = 'queued';
        user.error = null;
        user.pinDrift = 0;
        r.enqueue(user);
        return send(res, 200, { ok: true });
      }
    }

    // 停止全部
    if ((pathname === '/api/stop' || pathname === '/api/stop-all') && method === 'POST') {
      await Promise.all(users.map((u) => stopUser(u).catch(() => {})));
      users.forEach((u) => {
        if (u.status === 'running' || u.status === 'queued') u.status = 'stopped';
        u.lastStatus = 'stopped';
      });
      const s = config.data.session;
      if (s && s.lastUserId) s.lastStatus = 'stopped';
      persistUsers();
      return send(res, 200, { ok: true });
    }

    /* ---------------- 画面与输入（用于首次登录）---------------- */
    if (pathname === '/api/screen' && method === 'GET') {
      const user = pickUser(url.searchParams.get('user') || url.searchParams.get('task'));
      if (!user) return send(res, 404, { error: '当前没有打开的用户页面' });
      const rt = runtimeFor(user);
      const buf = await rt.runner
        .screenshot(Number(url.searchParams.get('q') || 60), url.searchParams.get('hd') === '1')
        .catch(() => null);
      if (!buf) return send(res, 404, { error: '当前没有运行中的页面' });
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
      return res.end(buf);
    }

    if (pathname === '/api/input' && method === 'POST') {
      const body = await readBody(req);
      const user = pickUser(body.user || body.task);
      if (!user) return send(res, 409, { error: '当前没有可操作的用户页面' });
      const r = runtimeFor(user).runner;
      if (body.type === 'click') await r.click(body.x, body.y);
      else if (body.type === 'dblclick') await r.dblclick(body.x, body.y);
      else if (body.type === 'type') await r.type(body.text || '');
      else if (body.type === 'key') await r.press(body.key || 'Enter');
      else if (body.type === 'goto') await r.goto(body.url);
      else if (body.type === 'wheel') await r.scroll(body.deltaY, body.x, body.y);
      else if (body.type === 'back') await r.back();
      else if (body.type === 'reload' && r.page) await r.page.reload().catch(() => {});
      return send(res, 200, { ok: true, url: r.pageUrl() });
    }

    /* ---------------- 排查用：在页面里执行一小段脚本 ----------------
     * 加密文字识别、跳转这类问题，光看日志看不出页面里到底发生了什么，
     * 这里留一个只允许本机访问的探针（例如读 document.body.innerText）。
     */
    if (pathname === '/api/eval' && method === 'POST') {
      const ip = req.socket.remoteAddress || '';
      if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(ip)) {
        return send(res, 403, { error: '只允许本机调用' });
      }
      const body = await readBody(req);
      const user = pickUser(body.user);
      if (!user) return send(res, 409, { error: '当前没有可操作的用户页面' });
      const page = runtimeFor(user).runner.page;
      if (!page || page.isClosed()) return send(res, 409, { error: '没有打开的页面' });
      try {
        const result = await page.evaluate(body.code || 'null');
        return send(res, 200, { ok: true, result });
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message });
      }
    }

    /* ---------------- 人脸核验（摄像头接管） ---------------- */
    if (pathname === '/api/camera' && method === 'GET') {
      return send(res, 200, { list: cameraHub.list(), now: Date.now() });
    }

    const camMatch = pathname.match(/^\/api\/camera\/([^/]+)\/(preview|frame|stop|refuse|start)$/);
    if (camMatch) {
      const userId = decodeURIComponent(camMatch[1]);
      const what = camMatch[2];

      // 预览：直接把最新一帧当图片吐出去，前端 <img> 换 src 就行
      if (what === 'preview' && method === 'GET') {
        const url = cameraHub.frameOf(userId);
        const m = /^data:image\/(jpeg|png|webp);base64,([\s\S]+)$/.exec(url || '');
        if (!m) return send(res, 404, { error: '暂无画面' });
        const buf = Buffer.from(m[2], 'base64');
        res.writeHead(200, {
          'Content-Type': 'image/' + m[1],
          'Cache-Control': 'no-store',
          'Content-Length': buf.length
        });
        return res.end(buf);
      }

      if (what === 'frame' && method === 'POST') {
        const body = await readBody(req);
        const r = cameraHub.pushFrame(userId, body.image);
        return send(res, r.ok ? 200 : 400, r);
      }

      if (what === 'start' && method === 'POST') {
        const body = await readBody(req);
        return send(res, 200, cameraHub.start(userId, body.mode));
      }

      if (what === 'stop' && method === 'POST') {
        return send(res, 200, cameraHub.stop(userId));
      }

      if (what === 'refuse' && method === 'POST') {
        return send(res, 200, cameraHub.refuse(userId));
      }
    }

    /* ---------------- 日志 ---------------- */
    if (pathname === '/api/logs' && method === 'GET') {
      return send(res, 200, { logs: logs.slice(-300) });
    }
    if (pathname === '/api/logs/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      // 刚连上先给一份当前的人脸核验状态，否则要等下一个人脸请求才知道
      try {
        res.write(`event: camera\ndata: ${JSON.stringify({ list: cameraHub.list() })}\n\n`);
      } catch (e) {}
      req.on('close', () => sseClients.delete(res));
      return;
    }

    return send(res, 404, { error: 'unknown api' });
  } catch (e) {
    logger.error('[API] ' + e.message);
    return send(res, 500, { error: e.message });
  }
});

const PORT = config.data.server.port;

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    logger.error(`端口 ${PORT} 已被占用，多半是上一次的进程还没退干净。`);
    logger.error(`查占用者：ss -ltnp | grep :${PORT}   然后 kill <PID>`);
    logger.error(`或者换个端口启动：OCS_PORT=${PORT + 1} npm start`);
  } else {
    logger.error('服务启动失败：' + e.message);
  }
  process.exit(1);
});

server.listen(PORT, config.data.server.host || '0.0.0.0', () => {
  logger.info(`控制台已启动： http://<本机局域网IP>:${PORT}  (v${PKG_VERSION})`);
  logger.info(`用户 ${users.length} 个${users.length ? '：' + users.map((u) => u.name).join('、') : ''}`);
  const saver = config.data.browser.resourceSaver || {};
  if (saver.enabled) logger.info('[省资源] 已开启：统计域名/第三方/图片等请求会被拦截');
  metrics.start(3000);

  // 定时内存回收：挂一晚上不重启，渲染进程的缓存和临时对象会一直涨，
  // 每 N 分钟让每个页面做一次 GC，后台页再施压释放缓存（0 = 关闭）
  const gcMin = Math.max(0, Number((config.data.browser.memory || {}).gcMinutes));
  if (gcMin > 0) {
    logger.info(`[内存] 每 ${gcMin} 分钟回收一次页面内存（可在配置里调）`);
    setInterval(() => {
      for (const rt of runtimes.values()) {
        if (!rt.host.running) continue;
        rt.runner.reclaimMemory().catch(() => {});
      }
    }, gcMin * 60000).unref();
  }
  if (config.data.server.autoRun) {
    logger.info('已开启自动运行，正在逐个启动用户');
    users.forEach((u) => {
      if (!u.url) return;
      u.status = 'queued';
      runtimeFor(u).runner.enqueue(u);
    });
  } else if (config.data.server.resumeSession !== false) {
    // 回到关闭时的现场：只打开那一个用户的窗口并导航到当时的地址，
    // 不自动开跑（上次在跑的任务点「运行」即可继续，避免一启动就乱答题）
    const s = config.data.session || {};
    const u = users.find((x) => x.id === s.lastUserId);
    const target = u && (u.lastUrl || s.lastPageUrl || '');
    // 关闭时窗口本来就是关着的（主动点过「关窗」或「停止」），就别再自动开
    const last = (u && u.lastStatus) || s.lastStatus || '';
    const wasClosed = last === 'closed' || last === 'stopped';
    if (u && target && !wasClosed) {
      logger.info(`正在恢复上次关闭时的页面：[${u.name}] ${target}`);
      openUserBrowser(u, { url: target });
    }
  }
});

/**
 * 内存看护：正常挂一晚堆占用在 150–400MB 之间波动。
 * 持续爬升说明有东西在攒（页面缓存、GM 存储、未释放的 Promise），
 * 分级报警，只报一次，不刷屏。
 */
const MEM_LEVELS = [700, 1200, 1800, 2500];
let memLevel = 0;
setInterval(() => {
  const m = process.memoryUsage();
  const heapMB = Math.round(m.heapUsed / 1048576);
  while (memLevel < MEM_LEVELS.length && heapMB >= MEM_LEVELS[memLevel]) {
    logger.warn(
      `[内存] node 堆已用 ${heapMB}MB（常驻 ${Math.round(m.rss / 1048576)}MB）。若继续上涨，把控制台日志和 data/users/*/gm-store.json 的大小发我`
    );
    memLevel += 1;
  }
  if (heapMB < MEM_LEVELS[0] / 2) memLevel = 0;
}, 60000).unref();

let shuttingDown = false;
async function shutdown(why) {
  // 第二次 Ctrl+C 直接强退，不再等浏览器
  if (shuttingDown) {
    logger.warn('再次收到退出信号，强制结束');
    process.exit(1);
  }
  shuttingDown = true;
  logger.info(`正在退出…${why ? '（' + why + '）' : ''}`);
  metrics.stop();
  cameraHub.dispose();

  // 兜底：浏览器卡住时最多等 12 秒，避免 node 赖着不退、下次启动撞端口
  const force = setTimeout(() => {
    logger.warn('退出超时，强制结束（浏览器可能在等待响应）');
    process.exit(1);
  }, 12000);

  try {
    await Promise.all(
      [...runtimes.values()].map(async (rt) => {
        await rt.runner.stopAll().catch(() => {});
        await rt.host.stop().catch(() => {});
        try { rt.bridge.flush(); } catch (e) {}
      })
    );
  } catch (e) {}
  // context.close() 返回时 Chromium 进程刚退，磁盘写入还没落稳。
  // 这里直接 exit 会让刚存的 cookie 丢掉，重启后又要重新登录 —— 等一会儿。
  await sleep(900);
  try {
    logger.flush();
  } catch (e) {}
  await sleep(150); // 留给异步追写最后一两行日志
  clearTimeout(force);
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => shutdown('SIGHUP'));
/**
 * 单个账号的页面出问题（页面被关、frame 被 detach、evaluate 抛错），
 * 不该把整个多账号服务带走 —— 之前一次读 null 的 frames 就让 6 个账号一起停了。
 * 所以这里默认只记录、不退出；只有短时间内疯狂出错（多半是句柄/内存耗尽）才自杀重启。
 */
let crashCount = 0;
let crashWindow = 0;
function noteCrash(label, e) {
  logger.error(label + '：' + ((e && e.stack) || e));
  const now = Date.now();
  if (now - crashWindow > 60000) {
    crashWindow = now;
    crashCount = 0;
  }
  crashCount++;
  if (crashCount > 20) {
    logger.error(`1 分钟内 ${crashCount} 次未捕获异常，判定无法自愈，退出`);
    shutdown('异常退出');
  }
}

process.on('uncaughtException', (e) => noteCrash('未捕获异常', e));
process.on('unhandledRejection', (e) => noteCrash('未处理的 Promise 异常', e));
