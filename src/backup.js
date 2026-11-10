/**
 * 备份与迁移：把 data 目录打成 zip，也能把别人打好的 zip 还原回来。
 *
 * 为什么不用 archiver / adm-zip：
 * 安装包里只带 node.exe 和 playwright-core，多一个第三方依赖就多一份体积和不更新的风险。
 * zip 的 store / deflate 两种方式用 zlib 就能写完，代码不到 200 行，够用。
 *
 * 为什么排除缓存：
 * Chromium 的 Cache / Code Cache / GPUCache 动辄几百 MB，里面全是可再生的东西。
 * 带上去只会让备份从 20MB 变成 500MB，传输和导入都慢。登录态在 Cookies、
 * Local Storage、IndexedDB 里，这些一个都不能少。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/** profile 里可以整目录丢掉的东西（小写比较，命中任意一段就跳过） */
const SKIP_DIRS = new Set([
  'cache',
  'code cache',
  'gpucache',
  'shadercache',
  'grshadercache',
  'graphitedawncache',
  'dawncache',
  'dawngraphitecache',
  'dawnwebgpucache',
  'component_crx_cache',
  'extensions_crx_cache',
  'crashpad',
  'segmentation_platform',
  'browsermetrics',
  'safe browsing',
  'service worker',
  'optimization_guide_model_store',
  'commerce_subscription_db',
  'budget_database',
  'blob_storage',
  // data/logs 是运行日志，跟账号无关，没必要塞进备份
  'logs'
]);

/** 跨进程锁和运行期产物，复制过去只会让 Chromium 以为 profile 被占用 */
const SKIP_FILES = new Set([
  'singletonlock',
  'singletoncookie',
  'singletonsocket',
  '.port',
  'lockfile',
  'gm-store.probe.json' // 测接口用的临时存储，不是用户数据
]);

const MAX_IMPORT_BYTES = 512 * 1024 * 1024; // 512MB：再大就让用户直接拷目录

/* ------------------------------ CRC32 ------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/* ------------------------------ 写 zip ------------------------------ */

function dosDateTime(date) {
  const y = Math.max(1980, date.getFullYear());
  return {
    time: ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((date.getSeconds() / 2) & 31),
    date: (((y - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31)
  };
}

class ZipWriter {
  constructor() {
    this.chunks = [];
    this.entries = [];
    this.offset = 0;
  }

  /** 不压缩直接存：图片、woff、已经压过的二进制再 deflate 只是白烧 CPU */
  add(name, data, mtime) {
    const nameBuf = Buffer.from(name, 'utf8');
    const dt = dosDateTime(mtime || new Date());
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // 文件名是 UTF-8
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(dt.time, 10);
    local.writeUInt16LE(dt.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    this.chunks.push(local, nameBuf, data);
    this.entries.push({ nameBuf, crc, size: data.length, offset: this.offset, dt });
    this.offset += local.length + nameBuf.length + data.length;
  }

  end() {
    const cdStart = this.offset;
    for (const e of this.entries) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(20, 4);
      h.writeUInt16LE(20, 6);
      h.writeUInt16LE(0x0800, 8);
      h.writeUInt16LE(0, 10);
      h.writeUInt16LE(e.dt.time, 12);
      h.writeUInt16LE(e.dt.date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.size, 20);
      h.writeUInt32LE(e.size, 24);
      h.writeUInt16LE(e.nameBuf.length, 28);
      h.writeUInt32LE(e.offset, 42);
      this.chunks.push(h, e.nameBuf);
      this.offset += 46 + e.nameBuf.length;
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(this.offset - cdStart, 12);
    eocd.writeUInt32LE(cdStart, 16);
    return Buffer.concat(this.chunks.concat([eocd]));
  }
}

/* ------------------------------ 读 zip ------------------------------ */

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function readZip(buf) {
  if (buf.length < 22) throw new Error('不是有效的 zip：文件太小');
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 zip：找不到目录尾部标记');

  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset >= buf.length) throw new Error('zip 目录偏移越界，文件可能不完整');

  const files = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');

    const lnlen = buf.readUInt16LE(lho + 26);
    const lelen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lnlen + lelen;
    const raw = buf.slice(start, start + csize);

    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`不支持的压缩方式（${method}）：${name}`);

    files.push({ name, data });
    p += 46 + nlen + elen + clen;
  }
  return files;
}

/* ------------------------------ 导出 ------------------------------ */

function shouldSkip(relParts, isDir) {
  const lower = relParts.map((s) => s.toLowerCase());
  if (isDir) return lower.some((s) => SKIP_DIRS.has(s));
  return SKIP_FILES.has(lower[lower.length - 1]);
}

function walk(rootDir, relBase, out) {
  const abs = path.join(rootDir, relBase);
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const ent of entries) {
    const rel = relBase ? relBase + '/' + ent.name : ent.name;
    const parts = rel.split('/');
    const isDir = ent.isDirectory();
    // data 根目录下的启动日志（Windows 托盘版把 node 输出重定向到 ocs.log，能滚到 8MB）。
    // 只排除最外层：profile 里 leveldb 的 000003.log 是登录态的一部分，不能动
    if (!relBase && !isDir && /\.log$/i.test(ent.name)) continue;
    if (shouldSkip(parts, isDir)) continue;
    if (isDir) {
      walk(rootDir, rel, out);
      continue;
    }
    if (!ent.isFile()) continue; // 符号链接（SingletonSocket 之类）直接丢掉
    const full = path.join(rootDir, rel);
    try {
      const st = fs.statSync(full);
      // 超过 64MB 的单个文件不进备份（通常是异常缓存），避免打爆内存
      if (st.size > 64 * 1024 * 1024) continue;
      out.push({ rel, data: fs.readFileSync(full), mtime: st.mtime });
    } catch (e) {}
  }
}

/**
 * 打包 data 目录。
 * @param {string} dataDir   data 目录绝对路径
 * @param {object} config    Config 实例（为了把 users 数量写进清单）
 */
function exportBackup(dataDir, config) {
  const files = [];
  walk(dataDir, '', files);

  const manifest = {
    kind: 'ocs-backup',
    version: 1,
    createdAt: new Date().toISOString(),
    platform: process.platform,
    appVersion: (() => {
      try {
        return require('../package.json').version;
      } catch (e) {
        return '';
      }
    })(),
    users: (config && config.users ? config.users.length : 0) || 0
  };

  const zip = new ZipWriter();
  zip.add('ocs-backup.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  for (const f of files) zip.add(f.rel, f.data, f.mtime);
  return { buffer: zip.end(), manifest, count: files.length };
}

/* ------------------------------ 导入 ------------------------------ */

/**
 * 把 zip 里的内容落盘到 dataDir。
 *
 * 只替换 config.json 和 users/，不动 logs/ 等其它东西：
 * 整个 data 目录改名会让正在写日志的流句柄失效，而且没必要。
 * 旧数据不会删，改名成 data.bak-<时间>/ 留着，出问题能回退。
 *
 * @returns {{files:number, backup:string, manifest:object|null}}
 */
function importBackup(zipBuffer, dataDir, options) {
  const opts = options || {};
  if (!Buffer.isBuffer(zipBuffer) || zipBuffer.length === 0) throw new Error('上传内容为空');
  if (zipBuffer.length > MAX_IMPORT_BYTES) {
    throw new Error('备份文件超过 512MB，请直接拷贝 data 目录');
  }

  const files = readZip(zipBuffer);
  if (!files.length) throw new Error('备份里没有文件');

  // 先全部校验一遍再动磁盘，避免解压到一半失败留下半套数据
  const safe = [];
  let hasConfig = false;
  for (const f of files) {
    const name = f.name.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!name || name === 'ocs-backup.json') continue;
    const segs = name.split('/');
    if (segs.some((seg) => seg === '..' || seg === '')) {
      throw new Error('备份里有非法路径：' + f.name);
    }
    if (name === 'config.json') hasConfig = true;
    // 只认这三类，别的东西（日志、临时文件）一律不落盘
    if (name !== 'config.json' && name !== 'users' && !name.startsWith('users/')) continue;
    safe.push({ name, data: f.data });
  }
  if (!hasConfig) throw new Error('这不像 OCS 的备份：里面没有 config.json');
  // 只有 config.json 也是合法的：账号还没登录过时 users/ 是空的，不该因此拒绝导入

  fs.mkdirSync(dataDir, { recursive: true });

  // 1. 旧数据挪到 data.bak-<时间>（只挪 config.json 和 users）
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-');
  const backupDir = dataDir + '.bak-' + stamp;
  try {
    fs.rmSync(backupDir, { recursive: true, force: true });
    fs.mkdirSync(backupDir, { recursive: true });
    const oldConfig = path.join(dataDir, 'config.json');
    if (fs.existsSync(oldConfig)) fs.copyFileSync(oldConfig, path.join(backupDir, 'config.json'));
    const oldUsers = path.join(dataDir, 'users');
    if (fs.existsSync(oldUsers)) fs.renameSync(oldUsers, path.join(backupDir, 'users'));
  } catch (e) {
    // 拷不走也照常继续：真正危险的是半途而废，不是少一份回滚副本
  }

  // 2. 落盘（users 目录已经被挪走，这里重新建）
  const root = path.resolve(dataDir) + path.sep;
  let written = 0;
  for (const f of safe) {
    const full = path.join(dataDir, f.name);
    if (!path.resolve(full).startsWith(root)) continue;
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, f.data);
    written++;
  }

  if (opts.prune !== false) pruneBackups(dataDir, 2);

  return { files: written, backup: backupDir, manifest: readManifest(files) };
}

function readManifest(files) {
  const m = files.find((f) => f.name === 'ocs-backup.json');
  if (!m) return null;
  try {
    return JSON.parse(m.data.toString('utf8'));
  } catch (e) {
    return null;
  }
}

/** 只保留最近 n 份 data.bak-*，最新的那份（刚生成的）永远留着 */
function pruneBackups(dataDir, n, keepDir) {
  try {
    const parent = path.dirname(dataDir);
    const base = path.basename(dataDir) + '.bak-';
    const list = fs
      .readdirSync(parent)
      .filter((d) => d.startsWith(base))
      .map((d) => ({ d, t: fs.statSync(path.join(parent, d)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const item of list.slice(n)) {
      const full = path.join(parent, item.d);
      if (keepDir && path.resolve(full) === path.resolve(keepDir)) continue;
      fs.rmSync(full, { recursive: true, force: true });
    }
  } catch (e) {}
}

module.exports = { exportBackup, importBackup, readZip, ZipWriter, MAX_IMPORT_BYTES };
