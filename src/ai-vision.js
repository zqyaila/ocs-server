/**
 * 加密字体识别：把「字形网格图」交给支持视觉的大模型读出来。
 *
 * 背景：超星用自定义 @font-face 把码位打乱，DOM 里的文字是乱码。
 * 脚本默认用本地「字体特征比对」（crackFont + font_ref_cx.bin）还原，
 * 这条路准且不花钱，但依赖 CDN 上的特征表；表拉不到、或遇到表里没有的
 * 生僻字形时就没辙了。
 *
 * 这里提供第二种方式：脚本把要还原的字符用**同一个加密字体**画到 canvas
 * 上（每个字带编号），连同编号一起发过来，交给视觉模型逐格读，
 * 模型返回 {"1":"知","2":"识"} 之后脚本再回填 DOM。
 * 优点是不依赖特征表、不依赖 CDN；缺点是慢一点、要消耗 token。
 */

const DEFAULT_PROMPT = [
  '图片是一张字形表：每个格子一个汉字，格子正下方是这一格的编号。',
  '请逐格识别，按编号返回 JSON，例如 {"1":"知","2":"识","3":"是"}。',
  '要求：',
  '1. 只输出 JSON 本身，不要解释、不要代码块、不要多余文字；',
  '2. 编号必须连续完整，从 1 开始，一个都不能少；',
  '3. 值只放一个字。看不清或不是汉字时填 "?"；',
  '4. 不要按常识猜词语，逐格独立识别。'
].join('\n');

function resolveEndpoint(baseUrl) {
  const raw = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  if (/\/chat\/completions$/i.test(raw)) return raw;
  return raw + '/chat/completions';
}

/** 从模型回复里抠出第一段完整 JSON（容忍 ```json 包裹与前后废话） */
function extractJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch (e) {
          return null;
        }
      }
    }
  }
  return null;
}

/** 模型偶尔会把答案包一层 { "map": {...} } / { "answers": {...} } */
function normalizeMap(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const holder =
    obj.map && typeof obj.map === 'object' ? obj.map :
    obj.answers && typeof obj.answers === 'object' ? obj.answers :
    obj.result && typeof obj.result === 'object' ? obj.result :
    obj;
  const out = {};
  for (const [k, v] of Object.entries(holder)) {
    const idx = String(k).replace(/[^0-9]/g, '');
    if (!idx) continue;
    let ch = typeof v === 'string' ? v.trim() : '';
    // 去掉 "A" 之类前缀和引号；只接受 1~2 个字符（有的字是扩展区、占两个 UTF-16 单元）
    ch = ch.replace(/^[A-Za-z]\s*[.、)）:：]\s*/, '').replace(/^["'`「『]+|["'`」』]+$/g, '').trim();
    if (!ch) continue;
    const chars = [...ch];
    if (chars.length === 0 || chars.length > 2) continue;
    out[Number(idx)] = chars[0];
  }
  return out;
}

/**
 * @param {object} opts
 * @param {object} opts.ai       config.data.ai（baseUrl / apiKey / model / timeoutSeconds）
 * @param {object} opts.bridge   GmBridge 实例（借它发请求，复用超时与日志）
 * @param {string} opts.image    data:image/png;base64,... 字形网格图
 * @param {number} opts.count    图里有几格
 * @returns {Promise<{ok:boolean, map?:object, error?:string, raw?:string}>}
 */
async function recognizeGlyphs({ ai, bridge, image, count }) {
  const cfg = ai || {};
  const url = resolveEndpoint(cfg.baseUrl);
  if (!url) return { ok: false, error: '未配置 AI 接口地址' };
  if (!cfg.model) return { ok: false, error: '未配置模型名称' };
  if (!cfg.apiKey && !/127\.0\.0\.1|localhost|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\./.test(cfg.baseUrl || '')) {
    return { ok: false, error: '未配置 API Key' };
  }
  if (!image || !/^data:image\//.test(String(image))) return { ok: false, error: '图片数据无效' };

  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = 'Bearer ' + cfg.apiKey;
  const body = {
    model: cfg.model,
    temperature: 0,
    max_tokens: Math.max(256, Number(count) * 12),
    messages: [
      {
        role: 'system',
        content: '你是严谨的字形识别器，只按编号逐格读出图片里的字，不猜测、不补全句子。'
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: DEFAULT_PROMPT + `\n\n本图共 ${count} 格。` },
          { type: 'image_url', image_url: { url: image } }
        ]
      }
    ]
  };

  const timeout = Math.max(10, Number(cfg.timeoutSeconds) || 60) * 1000;
  const r = await bridge.http({
    url,
    method: 'POST',
    headers,
    data: JSON.stringify(body),
    timeout
  });

  if (!r || r.error) return { ok: false, error: (r && r.error) || '请求失败' };
  if (r.status >= 400) {
    let detail = String(r.responseText || '').slice(0, 200);
    try {
      const j = JSON.parse(r.responseText);
      detail = (j.error && (j.error.message || j.error)) || detail;
    } catch (e) {}
    return { ok: false, error: `HTTP ${r.status}：${detail}` };
  }

  let content = '';
  try {
    const j = JSON.parse(r.responseText);
    const choice = j.choices && j.choices[0];
    content = (choice && choice.message && choice.message.content) || j.output_text || '';
    if (Array.isArray(content)) content = content.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('');
  } catch (e) {
    return { ok: false, error: '接口返回不是 JSON' };
  }

  const parsed = extractJson(content);
  if (!parsed) return { ok: false, error: '模型没有返回可解析的结果', raw: String(content).slice(0, 200) };
  const map = normalizeMap(parsed);
  const got = Object.keys(map).length;
  if (!got) return { ok: false, error: '模型返回结果为空', raw: String(content).slice(0, 200) };
  return { ok: true, map, count: got, raw: String(content).slice(0, 300) };
}

module.exports = { recognizeGlyphs, extractJson, normalizeMap, resolveEndpoint, DEFAULT_PROMPT };
