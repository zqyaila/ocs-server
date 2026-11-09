const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.OCS_DATA_DIR || path.join(ROOT, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const USERS_DIR = path.join(DATA_DIR, 'users');
// 旧版共享登录态目录，只在迁移时读一次
const LEGACY_PROFILE_DIR = path.join(DATA_DIR, 'profile');

const DEFAULTS = {
  server: {
    port: Number(process.env.OCS_PORT || 8899),
    host: '0.0.0.0',
    token: '',
    autoRun: false,
    // 启动后自动回到上次关闭时看的那一页：打开那个用户的浏览器并导航到当时的地址
    resumeSession: true
  },
  browser: {
    executablePath: process.env.CHROME_PATH || '',
    headless: true,
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    extraArgs: [],
    // 内存紧凑模式：
    //   tune     合并同站渲染进程 + 低端设备模式 + 限制单页面 JS 堆（重启浏览器生效）
    //   v8HeapMB 单个 renderer 的 JS 堆上限，0 = 不限制；页面报「内存不足」时调大
    //   maxTabs  非锁定模式下，每个账号最多留几个标签页（每个标签一个 renderer，约 200–400MB）
    //   gcMinutes 定时让页面做 GC / 释放缓存，0 = 关闭
    memory: {
      tune: true,
      v8HeapMB: 1024,
      maxTabs: 3,
      gcMinutes: 10
    },
    // 省资源：在浏览器里掐掉不需要的请求。默认全关，行为和以前一致
    resourceSaver: {
      enabled: false,
      blockTrackers: true,
      blockThirdParty: false,
      blockImages: false,
      blockFonts: false,
      blockMedia: false,
      allowlist: [],
      blocklist: []
    }
  },
  ocs: {
    scriptPath: path.join(ROOT, 'userscript', 'ocs.common.user.js'),
    autoStart: true,
    disableConfigSync: true,
    // 加密文字（超星自定义字体打乱码位）的还原方式：
    //   font = 本地字体特征比对（快、免费，默认）
    //   ai   = 把字形画成编号网格图交给视觉模型读（不依赖特征表，慢一点、耗 token）
    //   auto = 先用字体比对，失败或置信度低时自动转 AI
    //   off  = 不还原，直接把乱码交给题库/AI（大概率答不对，仅作对照）
    cryptoText: {
      mode: 'font',
      aiBatch: 24,
      refTableUrl: 'https://cdn.ocsjs.com/resources/font/font_ref_cx.bin'
    },
    // 0 = 关闭无进度检测；maxDurationMinutes 为 0 表示不限时长
    stallTimeoutMinutes: 15,
    maxDurationMinutes: 0,
    maxReloadTimes: 2
  },
  ai: {
    enabled: false,
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.2,
    maxTokens: 1024,
    timeoutSeconds: 60,
    requestType: 'auto',
    supportImages: true,
    retry: 1,
    systemPrompt: '',
    extraPrompt: ''
  },
  answererWrappers: [],
  // 上次关闭时的现场：谁被选中、停在哪个地址、当时是在跑还是停着。
  // 服务启动时按这个恢复，前端也用 lastUserId 选中同一个人。
  session: {
    lastUserId: '',
    lastPageUrl: '',
    lastStatus: '',
    updatedAt: 0
  },
  users: []
};

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function merge(base, override) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const key of Object.keys(override || {})) {
    const b = base ? base[key] : undefined;
    const o = override[key];
    out[key] = isPlainObject(b) && isPlainObject(o) ? merge(b, o) : o;
  }
  return out;
}

/** 配置文件里缺少 merged 里的某些键（升级后新增的默认项）时返回 true */
function lacksKeys(raw, merged) {
  if (!isPlainObject(merged)) return false;
  if (!isPlainObject(raw)) return true;
  for (const key of Object.keys(merged)) {
    if (!(key in raw) || lacksKeys(raw[key], merged[key])) return true;
  }
  return false;
}

/**
 * 每个用户一套独立的浏览器数据目录：cookie、localStorage、IndexedDB、历史记录都在里面。
 * 换用户不会串号，关掉服务再开也不用重新登录。
 */
function userDir(userId) {
  return path.join(USERS_DIR, String(userId));
}
function userProfileDir(userId) {
  return path.join(userDir(userId), 'profile');
}
function userStorePath(userId) {
  return path.join(userDir(userId), 'gm-store.json');
}

class Config {
  constructor() {
    this.data = this.load();
  }

  load() {
    let merged;
    let dirty = false;
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      merged = merge(DEFAULTS, raw);
      // 旧版本默认「单任务最长 360 分钟」，现改为不限。只在配置文件里还是这个旧默认值时迁移
      if (raw.ocs && Number(raw.ocs.maxDurationMinutes) === 360) {
        merged.ocs.maxDurationMinutes = 0;
        dirty = true;
      }
      // 新增的默认项（例如省资源、加密文字识别方式）写回配置文件，
      // 这样升级后能直接在 config.json 里看到并修改，而不是藏在代码里
      if (lacksKeys(raw, merged)) dirty = true;
    } catch (e) {
      merged = JSON.parse(JSON.stringify(DEFAULTS));
      dirty = true;
    }
    if (dirty) {
      this.data = merged;
      this.save();
    }

    // 环境变量优先级高于 config.json：多开时每个实例用 OCS_PORT 区分端口，
    // 否则配置文件里存下的 port 会盖掉它，几个实例全去抢同一个端口
    if (process.env.OCS_PORT) merged.server.port = Number(process.env.OCS_PORT);
    if (process.env.OCS_HOST) merged.server.host = process.env.OCS_HOST;
    if (process.env.CHROME_PATH) merged.browser.executablePath = process.env.CHROME_PATH;

    return merged;
  }

  get(pathStr) {
    return pathStr.split('.').reduce((o, k) => (o == null ? o : o[k]), this.data);
  }

  save() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = CONFIG_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, CONFIG_PATH);
  }

  update(patch) {
    this.data = merge(this.data, patch);
    this.save();
    return this.data;
  }

  get users() {
    return Array.isArray(this.data.users) ? this.data.users : [];
  }

  /**
   * 旧版本迁移：
   * - v1.3–v1.5 的 accounts → 单实例
   * - v2.1 以前的 tasks → users，一个任务就是一个用户
   * - 旧的共享登录态（data/profile）与 GM 存储归给第一个用户，省得重新扫码、重配 AI
   */
  migrate() {
    let dirty = false;

    const accounts = this.data.accounts;
    if (Array.isArray(accounts) && accounts.length) {
      const first = accounts[0] || {};
      if ((!Array.isArray(this.data.tasks) || !this.data.tasks.length) && Array.isArray(first.tasks)) {
        this.data.tasks = first.tasks;
      }
      const from = path.join(DATA_DIR, 'accounts', String(first.id || ''), 'profile');
      try {
        if (fs.existsSync(from) && !fs.existsSync(path.join(LEGACY_PROFILE_DIR, 'Default'))) {
          fs.rmSync(LEGACY_PROFILE_DIR, { recursive: true, force: true });
          fs.renameSync(from, LEGACY_PROFILE_DIR);
        }
      } catch (e) {}
      delete this.data.accounts;
      dirty = true;
    }

    if (!Array.isArray(this.data.users)) {
      this.data.users = [];
      dirty = true;
    }

    if (Array.isArray(this.data.tasks) && this.data.tasks.length) {
      for (const t of this.data.tasks) {
        this.data.users.push({
          id: t.id || newId(),
          name: t.name || '用户',
          url: t.url || '',
          pin: !!t.pin
        });
      }
      dirty = true;
    }
    if (this.data.tasks) {
      delete this.data.tasks;
      dirty = true;
    }

    for (const u of this.data.users) {
      if (!u.id) {
        u.id = newId();
        dirty = true;
      }
      if (typeof u.pin !== 'boolean') {
        u.pin = false;
        dirty = true;
      }
      if (!u.name) {
        u.name = '用户';
        dirty = true;
      }
    }

    fs.mkdirSync(USERS_DIR, { recursive: true });

    // 旧共享登录态搬给第一个用户：直接改名，不复制，省磁盘也省时间
    if (fs.existsSync(path.join(LEGACY_PROFILE_DIR, 'Default'))) {
      const owner = this.data.users[0];
      if (owner) {
        const dest = userProfileDir(owner.id);
        if (!fs.existsSync(path.join(dest, 'Default'))) {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          try {
            fs.renameSync(LEGACY_PROFILE_DIR, dest);
          } catch (e) {
            try {
              fs.cpSync(LEGACY_PROFILE_DIR, dest, { recursive: true });
            } catch (e2) {}
          }
        }
      }
    }

    // 旧 GM 存储（AI 配置、题库、进度）也归给第一个用户
    const legacyStore = path.join(DATA_DIR, 'gm-store.json');
    const owner = this.data.users[0];
    if (owner && fs.existsSync(legacyStore)) {
      const dest = userStorePath(owner.id);
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        try {
          fs.copyFileSync(legacyStore, dest);
        } catch (e) {}
      }
    }

    if (dirty) this.save();
    return this.data;
  }

  ensure() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(CONFIG_PATH)) this.save();
    this.migrate();
    return this.data;
  }
}

function newId() {
  return 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

module.exports = {
  Config,
  DEFAULTS,
  DATA_DIR,
  CONFIG_PATH,
  USERS_DIR,
  LEGACY_PROFILE_DIR,
  ROOT,
  userDir,
  userProfileDir,
  userStorePath,
  newId
};
