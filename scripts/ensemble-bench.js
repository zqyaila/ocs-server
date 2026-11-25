#!/usr/bin/env node
/**
 * 多轮复核评测脚本（ensemble-bench）
 *
 * 作用：拿一份带标准答案的题库，分别用「单轮」和「多轮复核」跑一遍，
 * 直接报出两种模式的正确率、耗时、请求数，以及每道题的改判明细。
 * 用来回答两个问题：
 *   1. 多轮到底能不能提分？提多少？
 *   2. 哪些题被「改好」了，哪些被「改坏」了 —— 后者是调提示词的依据。
 *
 * 用法：
 *   node scripts/ensemble-bench.js --sample > my-questions.jsonl   # 生成格式示例
 *   node scripts/ensemble-bench.js --file my-questions.jsonl --rounds 3 --verify
 *   node scripts/ensemble-bench.js --file q.jsonl --compare=strict # 单轮 vs 严格模式
 *
 * 题库格式（JSONL，一行一题；也可传 .json 数组）：
 *   {"type":"single","title":"...","options":"A. 甲\nB. 乙","answer":"B"}
 *   {"type":"multiple","title":"...","options":"A. 甲\nB. 乙\nC. 丙","answer":"AC"}
 *   {"type":"judgement","title":"...","options":"A. 正确\nB. 错误","answer":"A"}
 *   {"type":"completion","title":"...","answer":"光合作用#叶绿体"}
 *
 * 答案字段写字母或选项原文都行，脚本会统一换算成「提交值」再比对。
 * 接口配置默认读 data/config.json 里的 ai 段，也可以用环境变量覆盖：
 *   AI_BASE_URL / AI_API_KEY / AI_MODEL
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.OCS_DATA_DIR || path.join(ROOT, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

/* ---------------- 与 userscript 保持一致的多轮策略 ---------------- */

const PRESETS = {
  fast: { rounds: 2, verify: true, falsify: false, budgetSeconds: 30 },
  balanced: { rounds: 3, verify: true, falsify: false, budgetSeconds: 60 },
  strict: { rounds: 5, verify: true, falsify: true, budgetSeconds: 110 }
};

const LENSES = [
  { name: '直答', temperature: null, hint: '' },
  {
    name: '排除法',
    temperature: 0.45,
    hint: '先在心里逐个排除明显错误的选项，再从剩下的里选出唯一正确的；多选题只保留有把握的。'
  },
  {
    name: '教材口径',
    temperature: 0.7,
    hint: '以该课程通用教材与权威定义的表述为准，特别注意题干里的「最」「主要」「不正确」「除了」等限定词。'
  },
  {
    name: '反向假设',
    temperature: 0.85,
    hint: '逐一假设每个选项为真，找出与其他选项或学科常识相矛盾的那一个，剩下的就是答案。'
  },
  {
    name: '拆条件',
    temperature: 0.3,
    hint: '先把题干拆成若干可判定的小条件，再逐条核对每个选项是否同时满足全部条件。'
  }
];

const SYSTEM_APPEND = [
  '【多轮复核模式】',
  '- 先在心里完成完整推理，只输出最终结论，不要展示过程；',
  '- 留意题干中的否定词与限定词（不正确 / 除了 / 最 / 主要 / 至少）；',
  '- 若两个选项表述等价，选与题干问法最贴切的那个；',
  '- 在 JSON 里额外给出 "confidence"（0 到 1 的小数），表示你对该答案的把握。'
].join('\n');

const TYPE_NAME = {
  single: '单选题',
  multiple: '多选题',
  judgement: '判断题',
  completion: '填空题',
  'fill-blank': '填空题',
  unknown: '未知题型（请根据题目内容判断）'
};

const BASE_SYSTEM_PROMPT = [
  '你是一名严谨的在线课程答题助手，需要根据题目和选项给出最可能的正确答案。',
  '只输出一行 JSON，不要输出解释、Markdown 代码块或任何多余文字。',
  '输出格式（必须严格遵守）：{"answer":"答案"}',
  '规则：',
  '1. 单选题：answer 为唯一正确选项的字母，例如 "B"；',
  '2. 多选题：answer 为所有正确选项的字母连写，例如 "ACD"；',
  '3. 判断题：answer 只能是 "正确" 或 "错误"；',
  '4. 填空题：按空的顺序给出答案，多个空之间用 "#" 分隔，例如 "光合作用#叶绿体"；',
  '5. 如果题目信息不足以判断，输出 {"answer":""}，不要随意猜测。'
].join('\n');

/* ---------------- 文本与答案处理 ---------------- */

function normText(value) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, '')
    .replace(/[，。、；;,.!?！？：:"'“”‘’（）()【】\[\]{}<>《》]/g, '')
    .toLowerCase();
}

function optionLines(env) {
  return String(env.options || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function stripPrefix(line) {
  const text = String(line || '').trim();
  return text.replace(/^[A-Ha-h]\s*[.、:：)．]\s*/, '').trim() || text;
}

/** 字母答案 → 选项原文 */
function lettersToOptions(letters, env) {
  const lines = optionLines(env);
  const picked = [];
  for (const ch of letters) {
    const idx = ch.toUpperCase().charCodeAt(0) - 65;
    if (lines[idx] === undefined) return [];
    picked.push(stripPrefix(lines[idx]));
  }
  return picked;
}

/**
 * 把模型答案转成「最终会填进页面的值」。
 * 与 userscript 的 formatAiAnswererAnswer 行为对齐，保证评测结果能代表线上效果。
 */
function formatAnswer(answer, env) {
  const raw = String(answer || '').trim();
  if (!raw) return '';
  const compact = raw.replace(/[\s,，、;；]/g, '').toUpperCase();
  const letters = /^[A-H]{1,8}$/.test(compact) ? compact.split('') : [];

  if (env.type === 'completion' || env.type === 'fill-blank') {
    const parts = String(raw)
      .split('#')
      .map((s) => s.trim())
      .filter(Boolean);
    return parts.join('#');
  }
  if (env.type === 'judgement') {
    if (letters.length) {
      const mapped = lettersToOptions(letters, env);
      if (mapped.length) return mapped[0];
    }
    if (/正确|对|√|true|yes|^t$/i.test(raw)) return '正确';
    if (/错误|错|×|false|no|^f$/i.test(raw)) return '错误';
    return stripPrefix(raw);
  }
  if (env.type === 'multiple') {
    if (letters.length) {
      const mapped = lettersToOptions(letters, env);
      if (mapped.length) return mapped.join('#');
    }
    return raw;
  }
  if (letters.length) {
    const mapped = lettersToOptions(letters, env);
    if (mapped.length) return mapped[0];
  }
  return stripPrefix(raw);
}

/** 比对键：单选看选项文本，多选看字母集合，填空看各空内容 */
function voteKey(text, env) {
  const value = String(text || '').trim();
  if (!value) return '';
  const parts = value.split('#').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return '';
  if (env.type === 'multiple') {
    return parts.map(normText).sort().join('|');
  }
  if (env.type === 'completion' || env.type === 'fill-blank') {
    return parts.map(normText).join('|');
  }
  const head = normText(parts[0]);
  if (env.type === 'judgement') {
    if (/^(正确|对|是|√|true|yes|t|a|1)$/.test(head)) return 'T';
    if (/^(错误|错|不对|否|×|false|no|f|b|0)$/.test(head)) return 'F';
  }
  return head;
}

/** 标准答案 → 比对键（字母先换算成选项原文） */
function truthKey(env) {
  const raw = String(env.answer || '').trim();
  if (!raw) return '';
  if (env.type === 'completion' || env.type === 'fill-blank') {
    return voteKey(raw, env);
  }
  return voteKey(formatAnswer(raw, env), env);
}

function parseSample(content) {
  const cleaned = String(content || '').trim().replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/, '').trim();
  const out = { answer: '', confidence: 0.6, reason: '' };
  const jsonText = (cleaned.match(/\{[\s\S]*\}/) || [])[0];
  if (jsonText) {
    try {
      const obj = JSON.parse(jsonText);
      const value =
        obj.answer !== undefined ? obj.answer :
        obj.answers !== undefined ? obj.answers :
        obj.result !== undefined ? obj.result :
        obj.option !== undefined ? obj.option :
        obj['答案'];
      if (Array.isArray(value)) {
        out.answer = value.map((v) => String(v).trim()).filter(Boolean).join('#');
      } else if (value !== undefined && value !== null) {
        out.answer = String(value).trim();
      }
      out.reason = String(obj.reason || obj.analysis || obj.explanation || '');
      let conf = Number(obj.confidence !== undefined ? obj.confidence : obj['置信度']);
      if (Number.isFinite(conf)) {
        if (conf > 1 && conf <= 100) conf /= 100;
        out.confidence = Math.min(1, Math.max(0, conf));
      }
      return out;
    } catch (e) {
      /* 落到纯文本兜底 */
    }
  }
  out.answer = cleaned.replace(/^(最终答案|正确答案|答案|answer)\s*[:：]\s*/i, '').trim();
  return out;
}

/* ---------------- 接口调用 ---------------- */

function loadAiConfig(cli) {
  let ai = {};
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    ai = (cfg && cfg.ai) || {};
  } catch (e) {
    /* 没有配置文件就走环境变量 */
  }
  const baseUrl = cli.baseUrl || process.env.AI_BASE_URL || ai.baseUrl || '';
  const apiKey = cli.apiKey || process.env.AI_API_KEY || ai.apiKey || '';
  const model = cli.model || process.env.AI_MODEL || ai.model || '';
  const temperature = cli.temperature !== undefined ? Number(cli.temperature) : Number(ai.temperature ?? 0.2);
  const maxTokens = Number(ai.maxTokens || 1024);
  const timeoutSeconds = Number(ai.timeoutSeconds || 60);
  if (!baseUrl || !model) {
    throw new Error(
      '没有可用的 AI 配置：先在控制台保存一份 AI 配置（写入 data/config.json），' +
        '或用 --base-url / --api-key / --model 传参'
    );
  }
  return { baseUrl, apiKey, model, temperature, maxTokens, timeoutSeconds };
}

function endpointOf(baseUrl) {
  const raw = String(baseUrl || '').trim().replace(/\/+$/, '');
  return /\/chat\/completions$/i.test(raw) ? raw : raw + '/chat/completions';
}

async function chat(ai, messages, opts = {}) {
  const url = endpointOf(ai.baseUrl);
  const headers = { 'Content-Type': 'application/json' };
  if (ai.apiKey) headers.Authorization = 'Bearer ' + ai.apiKey;
  const body = { model: ai.model, messages, stream: false };
  if (opts.temperature !== undefined && opts.temperature !== null) body.temperature = opts.temperature;
  body.max_tokens = opts.maxTokens || ai.maxTokens;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), (opts.timeoutSeconds || ai.timeoutSeconds) * 1000);
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new Error('HTTP ' + res.status + '：' + text.slice(0, 200));
    }
    const data = JSON.parse(text);
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new Error('返回内容为空');
    return String(content);
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 两种答题模式 ---------------- */

function buildQuestionText(env) {
  const lines = ['【题型】' + (TYPE_NAME[env.type] || TYPE_NAME.unknown), '【题目】' + String(env.title || '')];
  if (env.options) lines.push('【选项】\n' + String(env.options));
  if (env.type === 'completion') {
    const blanks = optionLines(env).length;
    if (blanks > 1) lines.push('【说明】本题共有 ' + blanks + ' 个空，请按顺序给出 ' + blanks + ' 个答案。');
  }
  return lines.join('\n');
}

function messagesFor(env, hint, extraPrompt) {
  const system = [BASE_SYSTEM_PROMPT, extraPrompt, hint, SYSTEM_APPEND].filter(Boolean).join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: buildQuestionText(env) }
  ];
}

/** 单轮：线上原本的行为，作为基线 */
async function runSingle(ai, env) {
  const startedAt = Date.now();
  const content = await chat(ai, messagesFor(env, '', ''), { temperature: ai.temperature });
  const sample = parseSample(content);
  const formatted = formatAnswer(sample.answer, env);
  return { key: voteKey(formatted, env), label: formatted, ms: Date.now() - startedAt, requests: 1 };
}

/** 多轮：多视角采样 → 投票 → 分歧复核 → 可选证伪 */
async function runEnsemble(ai, env, opts) {
  const startedAt = Date.now();
  const lenses = LENSES.slice(0, Math.max(1, Math.min(opts.rounds, LENSES.length)));
  let requests = 0;

  const samples = [];
  for (const lens of lenses) {
    requests += 1;
    try {
      const temperature = lens.temperature === null ? ai.temperature : lens.temperature;
      const content = await chat(ai, messagesFor(env, lens.hint, ''), { temperature });
      const sample = parseSample(content);
      const formatted = formatAnswer(sample.answer, env);
      const key = voteKey(formatted, env);
      if (key) samples.push({ key, label: formatted, confidence: sample.confidence, lens: lens.name, reason: sample.reason });
    } catch (e) {
      /* 单轮失败不毁整题，和线上一致 */
    }
  }
  if (!samples.length) {
    return { key: '', label: '', ms: Date.now() - startedAt, requests, agree: 0 };
  }

  // 计票
  const map = new Map();
  for (const s of samples) {
    let slot = map.get(s.key);
    if (!slot) {
      slot = { key: s.key, label: s.label, count: 0, score: 0, reason: '' };
      map.set(s.key, slot);
    }
    slot.count += 1;
    slot.score += s.confidence;
    if (!slot.reason && s.reason) slot.reason = s.reason;
  }
  const list = [...map.values()].sort((a, b) => (b.count - a.count) || (b.score - a.score));
  let top = list[0];
  let agree = top.count / samples.length;

  // 全票一致就不复核，省一次请求
  const unanimous = samples.length > 1 && top.count === samples.length;
  if (opts.verify && !unanimous) {
    requests += 1;
    const candidates = list.slice(0, 3);
    const lines = [buildQuestionText(env), '', '下面是几位独立作答者给出的结果（顺序不代表任何倾向，出现次数也不代表正确）：'];
    candidates.forEach((c, i) => lines.push(i + 1 + '. ' + c.label));
    lines.push('', '请作为该科目的阅卷老师，独立重新审题：');
    lines.push('1. 逐个判断上面的结果是否正确，错在哪里；');
    lines.push('2. 不要因为某个结果「眼熟」或出现次数多就选它；');
    lines.push('3. 如果它们全都错，直接给出你认为正确的答案。');
    lines.push('只输出一行 JSON：{"final":"候选编号或答案原文","reason":"一句话结论","confidence":0.0}');
    try {
      const content = await chat(
        ai,
        [
          { role: 'system', content: [BASE_SYSTEM_PROMPT, SYSTEM_APPEND].join('\n\n') },
          { role: 'user', content: lines.join('\n') }
        ],
        { temperature: 0.1 }
      );
      const parsed = parseSample(content);
      const raw = String(parsed.answer || '').trim();
      const asIndex = /^\s*[\[\(（]?([1-9])[\]\)）]?\s*$/.exec(raw);
      if (asIndex && Number(asIndex[1]) <= candidates.length) {
        const picked = candidates[Number(asIndex[1]) - 1];
        if (picked.key !== top.key) top = picked;
        agree = picked.count / samples.length;
      } else {
        const wanted = voteKey(formatAnswer(raw, env), env);
        const hit = candidates.find((c) => c.key === wanted) || list.find((c) => c.key === wanted);
        if (hit) {
          if (hit.key !== top.key) top = hit;
          agree = hit.count / samples.length;
        } else if (wanted && parsed.confidence >= 0.6) {
          top = { key: wanted, label: formatAnswer(raw, env), count: 0, score: 0, reason: parsed.reason };
          agree = 0;
        }
      }
    } catch (e) {
      /* 复核失败就用多数票 */
    }
  }

  // 反方证伪
  if (opts.falsify && opts.rounds > 1) {
    requests += 1;
    const lines = [buildQuestionText(env), '', '【待验证的答案】' + top.label, ''];
    lines.push('请只做一件事：尽力找出这个答案是错的证据（反例、定义冲突、教材口径差异、题干限定词被忽略）。');
    lines.push('如果它本身是对的，不要为了挑错而编造问题，直接确认。');
    lines.push('只输出一行 JSON：找不到问题 {"verdict":"CONFIRM"}；确实错了 {"verdict":"WRONG","better":"更正确的答案","reason":"依据"}');
    try {
      const content = await chat(
        ai,
        [
          { role: 'system', content: [BASE_SYSTEM_PROMPT, SYSTEM_APPEND].join('\n\n') },
          { role: 'user', content: lines.join('\n') }
        ],
        { temperature: 0.2 }
      );
      const jsonText = (content.match(/\{[\s\S]*\}/) || [])[0];
      const obj = jsonText ? JSON.parse(jsonText) : {};
      const better = String(obj.better || '').trim();
      if (String(obj.verdict || '').toUpperCase() === 'WRONG' && better) {
        const wanted = voteKey(formatAnswer(better, env), env);
        const second = list[1];
        const votes = second && second.key === wanted ? second.count : 0;
        if (wanted && wanted !== top.key && (votes > 0 || agree < 0.6)) {
          top = { key: wanted, label: formatAnswer(better, env), count: votes, score: 0, reason: obj.reason || '' };
        }
      }
    } catch (e) {
      /* 证伪失败不影响结论 */
    }
  }

  return { key: top.key, label: top.label, ms: Date.now() - startedAt, requests, agree };
}

/* ---------------- 题库读取与报告 ---------------- */

const SAMPLE_LINES = [
  { type: 'single', title: 'HTTP 协议默认使用的端口号是？', options: 'A. 21\nB. 25\nC. 80\nD. 443', answer: 'C' },
  { type: 'multiple', title: '下列属于面向对象三大特性的有？', options: 'A. 封装\nB. 继承\nC. 多态\nD. 编译', answer: 'ABC' },
  { type: 'judgement', title: 'TCP 是面向连接的可靠传输协议。', options: 'A. 正确\nB. 错误', answer: 'A' },
  { type: 'completion', title: '植物进行光合作用的主要场所是____，吸收光能的色素位于____中。', options: '', answer: '叶绿体#类囊体薄膜' }
];

function loadQuestions(file) {
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (!raw) throw new Error('题库文件为空');
  if (raw.startsWith('[')) {
    return JSON.parse(raw).map((q, i) => normalizeQuestion(q, i));
  }
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trim().startsWith('//'))
    .map((line, i) => {
      try {
        return normalizeQuestion(JSON.parse(line), i);
      } catch (e) {
        throw new Error('第 ' + (i + 1) + ' 行不是合法 JSON：' + line.slice(0, 80));
      }
    });
}

function normalizeQuestion(q, index) {
  const type = String(q.type || 'single').toLowerCase();
  const env = {
    type: type === 'fill-blank' ? 'completion' : type,
    title: String(q.title || q.question || '').trim(),
    options: String(q.options || ''),
    answer: String(q.answer !== undefined ? q.answer : q.correct || '').trim()
  };
  if (!env.title) throw new Error('第 ' + (index + 1) + ' 题缺少 title');
  if (!env.answer) throw new Error('第 ' + (index + 1) + ' 题缺少 answer（标准答案）');
  return env;
}

function pct(n, d) {
  if (!d) return '—';
  return ((n / d) * 100).toFixed(1) + '%';
}

function pad(text, width) {
  const s = String(text);
  // 中文按两格算，表格才对得齐
  const w = s.replace(/[\u4e00-\u9fa5]/g, '..').length;
  return s + ' '.repeat(Math.max(0, width - w));
}

async function main() {
  const args = process.argv.slice(2);
  const cli = {};
  let file = '';
  let limit = 0;
  let rounds = PRESETS.balanced.rounds;
  let verify = true;
  let falsify = false;
  let verbose = false;

  for (const arg of args) {
    const [k, v] = arg.split('=');
    if (k === '--sample') {
      for (const q of SAMPLE_LINES) console.log(JSON.stringify(q));
      return;
    }
    if (k === '--file') file = v || args[args.indexOf(arg) + 1];
    else if (k === '--limit') limit = Number(v) || 0;
    else if (k === '--rounds') rounds = Math.max(1, Math.min(5, Number(v) || 3));
    else if (k === '--preset') {
      const p = PRESETS[v];
      if (!p) throw new Error('未知档位：' + v + '（可选 fast / balanced / strict）');
      rounds = p.rounds;
      verify = p.verify;
      falsify = p.falsify;
    } else if (k === '--no-verify') verify = false;
    else if (k === '--falsify') falsify = true;
    else if (k === '--verbose' || k === '-v') verbose = true;
    else if (k === '--base-url') cli.baseUrl = v;
    else if (k === '--api-key') cli.apiKey = v;
    else if (k === '--model') cli.model = v;
    else if (k === '--temperature') cli.temperature = v;
  }

  if (!file) {
    console.log('用法：node scripts/ensemble-bench.js --file 题库.jsonl [--preset=balanced] [--limit=50] [-v]');
    console.log('      node scripts/ensemble-bench.js --sample > 题库.jsonl   # 生成格式示例');
    process.exit(1);
  }

  const ai = loadAiConfig(cli);
  let questions = loadQuestions(file);
  if (limit > 0) questions = questions.slice(0, limit);

  console.log('');
  console.log('模型：' + ai.model + '　接口：' + endpointOf(ai.baseUrl));
  console.log('题库：' + file + '（' + questions.length + ' 题）');
  console.log('多轮：' + rounds + ' 轮' + (verify ? ' + 复核' : '') + (falsify ? ' + 证伪' : ''));
  console.log('');

  const rows = [];
  let okSingle = 0;
  let okMulti = 0;
  let msSingle = 0;
  let msMulti = 0;
  let reqMulti = 0;
  const fixed = [];
  const broken = [];

  for (let i = 0; i < questions.length; i++) {
    const env = questions[i];
    const want = truthKey(env);
    process.stdout.write('\r  跑第 ' + (i + 1) + '/' + questions.length + ' 题…');
    let single;
    try {
      single = await runSingle(ai, env);
    } catch (e) {
      single = { key: '', label: '', ms: 0, requests: 1, error: e.message };
    }
    let multi;
    try {
      multi = await runEnsemble(ai, env, { rounds, verify, falsify });
    } catch (e) {
      multi = { key: '', label: '', ms: 0, requests: 0, agree: 0, error: e.message };
    }

    const sOk = !!want && single.key === want;
    const mOk = !!want && multi.key === want;
    if (sOk) okSingle += 1;
    if (mOk) okMulti += 1;
    msSingle += single.ms || 0;
    msMulti += multi.ms || 0;
    reqMulti += multi.requests || 0;

    rows.push({ index: i + 1, env, want, single, multi, sOk, mOk });
    if (!sOk && mOk) fixed.push(rows[rows.length - 1]);
    if (sOk && !mOk) broken.push(rows[rows.length - 1]);
  }
  process.stdout.write('\r' + ' '.repeat(30) + '\r');

  // 按题型汇总
  const byType = new Map();
  for (const row of rows) {
    const t = row.env.type;
    if (!byType.has(t)) byType.set(t, { n: 0, s: 0, m: 0 });
    const slot = byType.get(t);
    slot.n += 1;
    if (row.sOk) slot.s += 1;
    if (row.mOk) slot.m += 1;
  }

  console.log(pad('题型', 10) + pad('题数', 6) + pad('单轮', 14) + pad('多轮', 14) + '变化');
  console.log('-'.repeat(58));
  for (const [type, slot] of byType) {
    const delta = ((slot.m - slot.s) / slot.n) * 100;
    const sign = delta > 0 ? '+' : '';
    console.log(
      pad(TYPE_NAME[type] || type, 10) +
        pad(slot.n, 6) +
        pad(slot.s + '/' + slot.n + ' (' + pct(slot.s, slot.n) + ')', 14) +
        pad(slot.m + '/' + slot.n + ' (' + pct(slot.m, slot.n) + ')', 14) +
        (delta === 0 ? '持平' : sign + delta.toFixed(1) + ' 个百分点')
    );
  }
  console.log('-'.repeat(58));
  const totalDelta = ((okMulti - okSingle) / rows.length) * 100;
  console.log(
    pad('合计', 10) +
      pad(rows.length, 6) +
      pad(okSingle + '/' + rows.length + ' (' + pct(okSingle, rows.length) + ')', 14) +
      pad(okMulti + '/' + rows.length + ' (' + pct(okMulti, rows.length) + ')', 14) +
      (totalDelta === 0 ? '持平' : (totalDelta > 0 ? '+' : '') + totalDelta.toFixed(1) + ' 个百分点')
  );

  console.log('');
  console.log('平均耗时：单轮 ' + (msSingle / rows.length / 1000).toFixed(1) + 's / 题，多轮 ' + (msMulti / rows.length / 1000).toFixed(1) + 's / 题');
  console.log('平均请求：单轮 1 次 / 题，多轮 ' + (reqMulti / rows.length).toFixed(1) + ' 次 / 题（约 ' + (reqMulti / rows.length).toFixed(1) + ' 倍 token）');
  console.log('改判：救回 ' + fixed.length + ' 题，改坏 ' + broken.length + ' 题，净收益 ' + (fixed.length - broken.length) + ' 题');

  if (verbose && (fixed.length || broken.length)) {
    console.log('');
    if (fixed.length) {
      console.log('【被救回的题】');
      for (const row of fixed) {
        console.log('  #' + row.index + ' ' + row.env.title.slice(0, 40));
        console.log('     单轮：' + (row.single.label || '(空)') + '　→　多轮：' + row.multi.label + '　正确：' + row.env.answer);
      }
    }
    if (broken.length) {
      console.log('【被改坏的题】');
      for (const row of broken) {
        console.log('  #' + row.index + ' ' + row.env.title.slice(0, 40));
        console.log('     单轮：' + (row.single.label || '(空)') + '　→　多轮：' + row.multi.label + '　正确：' + row.env.answer);
      }
    }
  }

  console.log('');
  // 结论提示
  if (totalDelta >= 5) {
    console.log('结论：多轮带来的提升明显，建议在考试场景开启这一档。');
  } else if (totalDelta > 0) {
    console.log('结论：有小幅提升。如果嫌慢可以降到「快速」档，或者只对不确定的题开复核。');
  } else if (totalDelta === 0) {
    console.log('结论：这批题上多轮没有提升。多半是错在知识盲区 —— 同一个模型多问几遍也是同一个错误，换更强的模型更有效。');
  } else {
    console.log('结论：多轮反而更差，多半是复核在「过度改判」。先关掉「反方证伪」，或把轮数降到 2~3 再试。');
  }
  console.log('');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('');
    console.error('出错：' + err.message);
    process.exit(1);
  });
}

module.exports = { formatAnswer, voteKey, truthKey, parseSample, runSingle, runEnsemble, loadQuestions };
