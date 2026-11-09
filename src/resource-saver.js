/**
 * 省资源：在浏览器里直接掐掉不需要的网络请求。
 *
 * 挂课真正需要的只有：主文档、脚本、同站的 XHR、样式、以及视频流。
 * 剩下的大量请求是统计/广告/推荐图/字体——吃带宽、吃内存、还拖慢首屏。
 *
 * 所有规则都可单独开关，默认全关（保持和以前一模一样的行为）：
 * - 统计域名：内置常见统计/广告域名，拦掉基本无副作用
 * - 第三方：和当前页面不同主域的脚本/图片/字体/媒体
 * - 图片 / 字体 / 媒体：更激进，会影响图片题、加密字体、视频进度，界面上有明确提示
 */

const TRACKER_HOSTS = [
  'hm.baidu.com',
  'tongji.baidu.com',
  'cnzz.com',
  'umeng.com',
  'google-analytics.com',
  'googletagmanager.com',
  'googlesyndication.com',
  'doubleclick.net',
  'facebook.net',
  'hotjar.com',
  'clarity.ms',
  'sentry.io',
  'bugly.qq.com',
  'pingjs.qq.com',
  'beacon.qq.com',
  '51.la',
  'vpon.com',
  'imedia.cn',
  'irs01.com',
  'miaozhen.com',
  'admaster.com.cn'
];

// 用户脚本自己要用的资源（字体特征表、版本检查），拦了整个脚本就废了
const ALWAYS_ALLOW = ['cdn.ocsjs.com', 'ocsjs.com'];

const THIRD_PARTY_TYPES = new Set(['script', 'image', 'media', 'font']);

function rootDomain(host) {
  const parts = String(host || '').toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const two = parts.slice(-2).join('.');
  const THREE = new Set(['com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'co.uk', 'com.hk', 'com.tw', 'co.jp']);
  return THREE.has(two) ? parts.slice(-3).join('.') : two;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (e) {
    return '';
  }
}

function hostMatches(host, list) {
  for (const raw of list || []) {
    const item = String(raw || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!item) continue;
    if (host === item || host.endsWith('.' + item)) return true;
  }
  return false;
}

class ResourceSaver {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger || { info() {}, warn() {} };
    this.blocked = 0;
    this.byType = {};
    this._summaryAt = Date.now();
    this._summaryCount = 0;
    this._warned = new Set();
  }

  get options() {
    return (this.config.data.browser && this.config.data.browser.resourceSaver) || {};
  }

  get enabled() {
    return !!this.options.enabled;
  }

  stats() {
    return { blocked: this.blocked, byType: Object.assign({}, this.byType) };
  }

  _note(kind, host) {
    this.blocked += 1;
    this._summaryCount += 1;
    this.byType[kind] = (this.byType[kind] || 0) + 1;
    const now = Date.now();
    if (now - this._summaryAt > 60000) {
      const parts = Object.entries(this.byType)
        .map(([k, v]) => `${k} ${v}`)
        .join('、');
      this.logger.info(`[省资源] 累计拦截 ${this.blocked} 个请求（${parts}）`);
      this._summaryAt = now;
      this._summaryCount = 0;
    }
  }

  /** Playwright 的路由回调：这里每多一次 await，页面就多等一帧，所以尽量走同步分支 */
  async handle(route) {
    const opt = this.options;
    if (!opt.enabled) return route.continue().catch(() => {});

    const req = route.request();
    const url = req.url();
    if (!/^https?:/i.test(url)) return route.continue().catch(() => {});
    const type = req.resourceType();
    // 文档、长连接一律放行：挂了它们页面就废了
    if (type === 'document' || type === 'websocket' || type === 'eventsource') {
      return route.continue().catch(() => {});
    }

    const host = hostOf(url);
    if (!host) return route.continue().catch(() => {});
    if (hostMatches(host, ALWAYS_ALLOW)) return route.continue().catch(() => {});
    if (hostMatches(host, opt.allowlist)) return route.continue().catch(() => {});

    const hit = (kind) => {
      this._note(kind, host);
      return route.abort('blockedbyclient').catch(() => {});
    };

    if (hostMatches(host, opt.blocklist)) return hit('自定义');
    if (opt.blockTrackers !== false && hostMatches(host, TRACKER_HOSTS)) return hit('统计');

    // 加密字体靠页面自己下发的字体文件渲染，拦了就没法还原题干
    const cryptoMode = (this.config.data.ocs && this.config.data.ocs.cryptoText && this.config.data.ocs.cryptoText.mode) || 'font';
    if (type === 'font' && opt.blockFonts) {
      if (cryptoMode !== 'off') {
        if (!this._warned.has('font')) {
          this._warned.add('font');
          this.logger.warn('[省资源] 加密文字识别开着，已自动放行字体请求（否则题干会一直是乱码）');
        }
      } else {
        return hit('字体');
      }
    }

    if (type === 'image' && opt.blockImages) return hit('图片');
    if (type === 'media' && opt.blockMedia) return hit('媒体');

    if (opt.blockThirdParty && THIRD_PARTY_TYPES.has(type)) {
      const pageRoot = this._pageRoot(req);
      if (pageRoot && rootDomain(host) !== pageRoot) return hit('第三方');
    }

    return route.continue().catch(() => {});
  }

  /** 页面主域缓存 5 秒，避免每个请求都去解析一次 URL */
  _pageRoot(req) {
    try {
      const page = req.frame().page();
      const now = Date.now();
      if (!page.__ocsRootAt || now - page.__ocsRootAt > 5000) {
        page.__ocsRoot = rootDomain(hostOf(page.url()));
        page.__ocsRootAt = now;
      }
      return page.__ocsRoot;
    } catch (e) {
      return '';
    }
  }
}

module.exports = { ResourceSaver, TRACKER_HOSTS, rootDomain, hostMatches };
