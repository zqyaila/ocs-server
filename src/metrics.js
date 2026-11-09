/**
 * 资源占用采集。
 *
 * Node 自己的内存好拿（process.memoryUsage），但真正吃内存的是每个用户那个
 * Chromium：主进程 + zygote + 网络/存储服务 + 每标签一个 renderer + GPU。
 * Playwright 对 launchPersistentContext 不暴露进程句柄，所以这里按
 * 「命令行里带 --user-data-dir=<该用户的 profile 目录>」来认领进程，再从
 * /proc 读 RSS 与 CPU 时间片。Linux 下零依赖，其它平台降级为只报 Node。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const PAGE_SIZE = 4096;
const CLOCK_TICKS = 100; // Linux USER_HZ，x86/arm 上都是 100

function safeRead(file, enc) {
  try {
    return fs.readFileSync(file, enc || 'utf8');
  } catch (e) {
    return '';
  }
}

/** 解析 /proc/<pid>/stat：comm 里可能有空格和括号，所以从右往左取 */
function parseStat(raw) {
  const close = raw.lastIndexOf(')');
  if (close < 0) return null;
  const rest = raw.slice(close + 2).split(' ');
  // rest[0] 是 state（field 3），utime 是 field 14 → rest[11]，stime → rest[12]
  const utime = Number(rest[11]) || 0;
  const stime = Number(rest[12]) || 0;
  return { ticks: utime + stime };
}

function listProcesses() {
  if (process.platform !== 'linux') return [];
  let names = [];
  try {
    names = fs.readdirSync('/proc');
  } catch (e) {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (name.charCodeAt(0) < 48 || name.charCodeAt(0) > 57) continue;
    const pid = Number(name);
    const cmd = safeRead(`/proc/${pid}/cmdline`).replace(/\0/g, ' ').trim();
    // 只看浏览器进程，避免把 shell / 编辑器（命令行里也带 profile 路径）算进来
    if (!cmd || !/(chrome|chromium)/i.test(cmd.slice(0, 200))) continue;
    const args = cmd;
    let rss = 0;
    const statm = safeRead(`/proc/${pid}/statm`).split(' ');
    if (statm.length > 1) rss = (Number(statm[1]) || 0) * PAGE_SIZE;
    const st = parseStat(safeRead(`/proc/${pid}/stat`));
    out.push({ pid, cmd: args, rss, ticks: st ? st.ticks : 0 });
  }
  return out;
}

function mb(bytes) {
  return Math.round((bytes || 0) / 1048576);
}

class Metrics {
  constructor({ dataDir } = {}) {
    this.dataDir = dataDir || '';
    this.profiles = new Map(); // userId -> profile 目录
    this.prev = { at: 0, nodeCpu: null, procs: new Map() };
    this.latest = this.empty();
    this.history = [];
    this.disk = { dataMB: 0, users: {}, at: 0, running: false };
    this.saver = { blocked: 0, byType: {} };
    // 事件循环延迟：自己数定时器的迟到量。monitorEventLoopDelay 的均值
    // 等于设定的 resolution（20ms 就是 20.0），看着像一直卡，没有参考价值。
    this._lagAt = 0;
    this._lag = [];
    this._lagTimer = null;
    this.timer = null;
  }

  empty() {
    return {
      at: 0,
      uptimeSec: 0,
      node: { rssMB: 0, heapUsedMB: 0, heapTotalMB: 0, cpuPct: 0, loopLagMs: 0 },
      system: { totalMB: 0, freeMB: 0, usedPct: 0, load1: 0, cores: 1 },
      chrome: { rssMB: 0, procs: 0, cpuPct: 0, users: {} },
      disk: { dataMB: 0, users: {} },
      saver: { blocked: 0, byType: {} },
      history: []
    };
  }

  /** 登记某个用户的 profile 目录，之后按它认领 Chromium 进程 */
  setProfiles(map) {
    const next = map instanceof Map ? map : new Map(Object.entries(map || {}));
    const same =
      next.size === this.profiles.size &&
      [...next].every(([uid, dir]) => this.profiles.get(uid) === dir);
    this.profiles = next;
    // 用户增删后磁盘占用要重新统计，不然新用户一直显示「—」
    if (!same) this.disk.at = 0;
  }

  start(intervalMs = 3000) {
    if (this.timer) return;
    this.sample();
    this.timer = setInterval(() => this.sample(), intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();

    // 500ms 心跳，记录每次实际醒来比预期晚了多少（同步阻塞会让它变大）
    this._lagAt = Date.now();
    this._lagTimer = setInterval(() => {
      const now = Date.now();
      const late = Math.max(0, now - this._lagAt - 500);
      this._lagAt = now;
      this._lag.push(late);
      if (this._lag.length > 12) this._lag.shift();
    }, 500);
    if (typeof this._lagTimer.unref === 'function') this._lagTimer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this._lagTimer) clearInterval(this._lagTimer);
    this.timer = null;
    this._lagTimer = null;
  }

  /** 最近 6 秒里最严重的一次阻塞（ms） */
  lagMs() {
    if (!this._lag.length) return 0;
    return Math.round(Math.max(...this._lag) * 10) / 10;
  }

  /** 汇总所有浏览器实例的拦截计数，由 server 每轮塞进来 */
  setSaverStats(stats) {
    this.saver = stats || { blocked: 0, byType: {} };
  }

  sample() {
    const now = Date.now();
    const uptimeSec = Math.round(process.uptime());
    const mem = process.memoryUsage();
    const elapsed = now - (this.prev.at || now);
    const cpu = process.cpuUsage(this.prev.nodeCpu || undefined);

    let nodeCpuPct = 0;
    if (this.prev.nodeCpu && elapsed > 0) {
      // cpuUsage 给的是微秒：/1000 变毫秒，再除以间隔就是占比，×100 才是百分数
      nodeCpuPct = Math.round(((cpu.user + cpu.system) / 1000 / elapsed) * 100 * 10) / 10;
    }

    // 进程扫描
    const procs = listProcesses();
    const perUser = {};
    let chromeRss = 0;
    let chromeCpu = 0;
    let chromeProcs = 0;
    for (const p of procs) {
      let owner = null;
      for (const [uid, dir] of this.profiles) {
        if (dir && p.cmd.includes(dir)) {
          owner = uid;
          break;
        }
      }
      if (!owner) continue;
      chromeProcs += 1;
      chromeRss += p.rss;
      const prevTicks = this.prev.procs.get(p.pid);
      const prevAt = this.prev.at;
      let cpuPct = 0;
      if (prevTicks !== undefined && prevAt && elapsed > 0) {
        // ticks 是 1/100 秒，换算成「占一个核的百分比」
        cpuPct = ((p.ticks - prevTicks) / CLOCK_TICKS / elapsed) * 1000 * 100;
      }
      chromeCpu += cpuPct;
      const slot = perUser[owner] || (perUser[owner] = { rssMB: 0, procs: 0, cpuPct: 0 });
      slot.rssMB += p.rss;
      slot.procs += 1;
      slot.cpuPct += cpuPct;
    }
    for (const k of Object.keys(perUser)) {
      perUser[k].rssMB = mb(perUser[k].rssMB);
      perUser[k].cpuPct = Math.round(perUser[k].cpuPct * 10) / 10;
    }

    const total = os.totalmem();
    const free = os.freemem();

    this.latest = {
      at: now,
      uptimeSec,
      node: {
        rssMB: mb(mem.rss),
        heapUsedMB: mb(mem.heapUsed),
        heapTotalMB: mb(mem.heapTotal),
        cpuPct: Math.max(0, nodeCpuPct),
        loopLagMs: this.lagMs()
      },
      system: {
        totalMB: mb(total),
        freeMB: mb(free),
        usedPct: total ? Math.round(((total - free) / total) * 100) : 0,
        load1: Math.round((os.loadavg()[0] || 0) * 100) / 100,
        cores: os.cpus().length || 1
      },
      chrome: {
        rssMB: mb(chromeRss),
        procs: chromeProcs,
        cpuPct: Math.round(chromeCpu * 10) / 10,
        users: perUser
      },
      disk: { dataMB: this.disk.dataMB, users: this.disk.users },
      saver: this.saver,
      history: []
    };

    this.history.push({ t: now, n: this.latest.node.rssMB, c: this.latest.chrome.rssMB });
    if (this.history.length > 90) this.history.shift();
    this.latest.history = this.history.slice(-60);

    this.prev = {
      at: now,
      nodeCpu: process.cpuUsage(),
      procs: new Map(procs.map((p) => [p.pid, p.ticks]))
    };

    if (now - this.disk.at > 30000 && !this.disk.running) this.refreshDisk();
    return this.latest;
  }

  /**
   * 磁盘占用用 du（一次 30 秒），profile 目录动辄上万个小文件，
   * 用 fs 递归统计会明显拖慢主线程。
   */
  refreshDisk() {
    if (!this.dataDir || process.platform !== 'linux') return;
    const dirs = [[this.dataDir, '__all__']];
    for (const [uid, dir] of this.profiles) dirs.push([dir, uid]);
    this.disk.running = true;
    const run = ([dir, key]) =>
      new Promise((resolve) => {
        execFile('du', ['-sk', dir], { timeout: 15000 }, (err, stdout) => {
          const kb = err ? 0 : Number(String(stdout).split(/\s+/)[0]) || 0;
          resolve([key, mb(kb * 1024)]);
        });
      });
    Promise.all(dirs.map(run))
      .then((pairs) => {
        const users = {};
        let all = 0;
        for (const [key, size] of pairs) {
          if (key === '__all__') all = size;
          else users[key] = size;
        }
        this.disk = { dataMB: all, users, at: Date.now(), running: false };
        this.latest.disk = { dataMB: all, users };
      })
      .catch(() => {
        this.disk.running = false;
      });
  }

  snapshot() {
    if (!this.latest.at) this.sample();
    // 拦截计数是随时在涨的，别等下一次采样
    this.latest.saver = this.saver;
    return this.latest;
  }
}

module.exports = { Metrics, listProcesses, mb };
