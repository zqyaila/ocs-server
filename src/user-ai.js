/**
 * 每个用户一套 AI 接口。
 *
 * 场景：几个号同时挂课，各自的额度/服务商不一样 —— 张三用 DeepSeek，
 * 李四用公司内网的 OpenAI 兼容网关，王五跑本机的 Ollama。
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
  'extraPrompt',
  'ensemble'
];

// 这几个字段填空等于「没填」，应该回落到全局；其余字段（含布尔 false）照原样覆盖
const BLANK_FALLBACK = new Set(['provider', 'baseUrl', 'apiKey', 'model']);

function isCustom(user) {
  return !!(user && user.ai && user.ai.custom);
}

/**
 * @param {object} globalAi  config.data.ai（管理员配的全局接口）
 * @param {object} user      users 里的一个条目（可带 ai 段）
 * @param {object} account   系统账号（可带 ai 段，作为用户级之上的默认）
 * @returns {object}         实际生效的 AI 配置
 */
function overlay(base, own) {
  const out = Object.assign({}, base);
  for (const key of OVERRIDABLE) {
    const v = own[key];
    if (v === undefined || v === null) continue;
    // 多轮复核是一小组参数，按字段合并：用户只改了轮数，不该把「复核」丢掉
    if (key === 'ensemble' && typeof v === 'object' && !Array.isArray(v)) {
      out[key] = Object.assign({}, out[key] || {}, v);
      continue;
    }
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

// 普通账号能用全局配置里的「参数类」字段，但接口地址、模型、Key 必须自己填，
// 否则会白嫖管理员的额度、也能从 hasKey 看出人家配没配
const SAFE_KEYS = ['temperature', 'maxTokens', 'timeoutSeconds', 'requestType', 'retry', 'systemPrompt', 'extraPrompt', 'ensemble'];

function safeBase(globalAi) {
  const g = globalAi && typeof globalAi === 'object' ? globalAi : {};
  const out = { enabled: false, provider: '', baseUrl: '', apiKey: '', model: '', supportImages: true };
  for (const k of SAFE_KEYS) {
    if (g[k] !== undefined) out[k] = g[k];
  }
  return out;
}

function resolveAi(globalAi, user, account) {
  let base = globalAi && typeof globalAi === 'object' ? globalAi : {};

  // 传了 account 就按账号类型先定基线：普通账号拿不到管理员的接口和 Key
  if (account) {
    if (account.role !== 'admin') base = safeBase(base);
    const a = account.ai;
    if (a && a.custom) base = overlay(base, a);
  }

  const own = user && user.ai;
  if (!own || !own.custom) return base;
  // isolated = 这个号明确「不继承上层 Key」，账户没配就是没有，不许回落到管理员那份
  if (own.isolated) base = safeBase(base);
  return overlay(base, own);
}

/** 给前端 / 日志用的摘要，不含 Key */
function summarize(globalAi, user, account) {
  const eff = resolveAi(globalAi, user, account);
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

/** 多轮复核参数：前端传什么都要夹回合法区间，避免 5 轮变 50 轮把额度刷爆 */
function sanitizeEnsemble(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const num = (v, d, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return d;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  const out = {};
  if (input.enabled !== undefined) out.enabled = !!input.enabled;
  if (input.preset !== undefined) {
    out.preset = ['fast', 'balanced', 'strict', 'custom'].includes(input.preset) ? input.preset : 'custom';
  }
  if (input.rounds !== undefined) out.rounds = num(input.rounds, 3, 1, 5);
  if (input.verify !== undefined) out.verify = !!input.verify;
  if (input.falsify !== undefined) out.falsify = !!input.falsify;
  if (input.budgetSeconds !== undefined) out.budgetSeconds = num(input.budgetSeconds, 60, 15, 300);
  if (input.imageRounds !== undefined) out.imageRounds = num(input.imageRounds, 1, 1, 3);
  if (input.lowConfidence !== undefined) out.lowConfidence = input.lowConfidence === 'hold' ? 'hold' : 'best';
  return Object.keys(out).length ? out : null;
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

  const ens = sanitizeEnsemble(p.ensemble);
  if (ens) out.ensemble = ens;

  const key = p.apiKey === undefined ? undefined : String(p.apiKey || '').trim();
  if (key) out.apiKey = key;
  else if (p.clearKey) out.apiKey = '';
  else if (old.apiKey) out.apiKey = old.apiKey;

  // 关掉自定义时保留字段，下次打开还在，不用重新填
  if (!out.custom && old.apiKey && !out.apiKey) out.apiKey = old.apiKey;
  return out;
}

module.exports = { resolveAi, summarize, sanitize, isCustom, OVERRIDABLE };
