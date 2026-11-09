const fs = require('fs');
const path = require('path');

/**
 * 日志：控制台立即输出，文件写入做缓冲。
 * 答题时会连着刷几十行，每行一次 appendFileSync 就是几十次同步写盘，
 * 全都卡在事件循环上（截图、点击都要排队）。攒 300ms 一次异步写。
 */
function createLogger(dataDir) {
  const logDir = path.join(dataDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const file = path.join(logDir, 'server.log');
  const MAX_BYTES = 5 * 1024 * 1024;

  let buffer = [];
  let timer = null;
  let writing = false;

  function flush() {
    if (!buffer.length || writing) return;
    const chunk = buffer.join('');
    buffer = [];
    writing = true;
    try {
      // 简易轮转：超过 5MB 截断
      if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) fs.writeFileSync(file, '');
    } catch (e) {}
    fs.appendFile(file, chunk, () => {
      writing = false;
      if (buffer.length) flush();
    });
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, 300);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function write(level, args) {
    const line = `[${new Date().toISOString()}] [${level}] ${args
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')}`;
    const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    out(line);
    buffer.push(line + '\n');
    if (buffer.length >= 200) flush();
    else schedule();
  }

  /**
   * 读回文件里最后 n 条日志。
   * 重启后控制台不再是一片空白，能直接看到上次关服务前发生了什么。
   * 只读文件尾部 256KB，5MB 的老日志也不会拖慢启动。
   */
  function readHistory(n) {
    const want = Math.max(0, Math.min(Number(n) || 0, 1000));
    if (!want) return [];
    let text = '';
    try {
      const st = fs.statSync(file);
      const start = Math.max(0, st.size - 256 * 1024);
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      text = buf.toString('utf8');
      // 从文件中间开始读时第一行可能被截断，丢掉
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    } catch (e) {
      return [];
    }
    const out = [];
    for (const raw of text.split('\n')) {
      const m = raw.match(/^\[([^\]]+)\]\s+\[(info|warn|error)\]\s+([\s\S]*)$/);
      if (!m) continue;
      const t = Date.parse(m[1]);
      out.push({ time: Number.isFinite(t) ? t : Date.now(), level: m[2], message: m[3] });
    }
    return out.slice(-want);
  }

  return {
    info: (...a) => write('info', a),
    warn: (...a) => write('warn', a),
    error: (...a) => write('error', a),
    flush,
    readHistory
  };
}

module.exports = { createLogger };
