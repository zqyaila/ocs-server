/**
 * 每个用户一套 AI 接口。
 *
 * 场景：几个号同时挂课，各自的额度/服务商不一样 —— 张三用 DeepSeek，
 * 李四用公司内网的 OpenAI 兼容网关，王五不配 AI 只靠题库。
 * 如果共用一份全局配置，就只能同一时间跑一种，改来改去还容易串。
 *
 * 存法：config.json 里每个用户可选带一个 `ai` 段，`custom: true` 表示不跟全局。
 * 解析时以全局为底，用户自己填了的字段覆盖上去 —— 这样以后全局新增字段
 * （超时、重试这类）不会因为某个用户自定义过就永远拿不到。
 */

// 允许按用户覆盖的字段：和全局 ai 段保持同名，脚本读的也是这些键
const OVERRIDABLE = [
  'enabled',
  'provider',
  'baseUrl',
  'apiKey',
  'model',
  'temperature',
  'maxTokens',
  'supportImages',
  'timeoutSeconds',
  'requestType',
  'retry',
  'systemPrompt',
  'extraPrompt'
];

// 这几个字段填空等于「没填」，应该回落到全局；其余字段（含布尔 false）照原样覆盖
const BLANK_FALLBACK = new Set(['provider', 'baseUrl', 'apiKey', 'model']);

function isCustom(user) {
  return !!(user && user.ai && user.ai.custom);
}

/**
 * @param {object} globalAi  config.data.ai
 * @param {object} user      users 里的一个条目（可带 ai 段）
 * @returns {object}         该用户实际生效的 AI 配置
 */
function resolveAi(globalAi, user) {
  const base = globalAi && typeof globalAi === 'object' ? globalAi : {};
  const own = user && user.ai;
  if (!own || !own.custom) return base;

  const out = Object.assign({}, base);
  for (const key of OVERRIDABLE) {
    const v = own[key];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') {
      const s = v.trim();
      if (!s && BLANK_FALLBACK.has(key)) continue;
      out[key] = key === 'apiKey' ? v.trim() : s;
      continue;
    }
    out[key] = v;
  }
  return out;
}

/** 给前端 / 日志用的摘要，不含 Key */
function summarize(globalAi, user) {
  const eff = resolveAi(globalAi, user);
  return {
    custom: isCustom(user),
    enabled: !!eff.enabled,
    provider: eff.provider || '',
    model: eff.model || '',
    baseUrl: eff.baseUrl || '',
    hasKey: !!eff.apiKey,
    // 自定义时是自己填了 Key，还是回落到全局的 Key
    ownKey: !!(user && user.ai && user.ai.apiKey)
  };
}

/**
 * 把前端提交的内容整理成要落盘的 user.ai。
 * Key 留空时保留原来的 —— 前端只显示「已保存」，不把明文回传。
 */
function sanitize(patch, prev) {
  const p = patch && typeof patch === 'object' ? patch : {};
  const old = prev && typeof prev === 'object' ? prev : {};
  const out = { custom: p.custom !== false };

  if (p.enabled !== undefined) out.enabled = !!p.enabled;
  if (p.provider !== undefined) out.provider = String(p.provider || '').trim();
  if (p.baseUrl !== undefined) out.baseUrl = String(p.baseUrl || '').trim();
  if (p.model !== undefined) out.model = String(p.model || '').trim();
  if (p.temperature !== undefined) out.temperature = Number(p.temperature);
  if (p.maxTokens !== undefined) out.maxTokens = Math.max(128, Number(p.maxTokens) || 1024);
  if (p.supportImages !== undefined) out.supportImages = !!p.supportImages;

  const key = p.apiKey === undefined ? undefined : String(p.apiKey || '').trim();
  if (key) out.apiKey = key;
  else if (p.clearKey) out.apiKey = '';
  else if (old.apiKey) out.apiKey = old.apiKey;

  // 关掉自定义时保留字段，下次打开还在，不用重新填
  if (!out.custom && old.apiKey && !out.apiKey) out.apiKey = old.apiKey;
  return out;
}

module.exports = { resolveAi, summarize, sanitize, isCustom, OVERRIDABLE };
