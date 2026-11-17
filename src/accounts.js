/**
 * 系统账号：注册、登录、邀请码、会话。
 *
 * 和 config.users 不是一个东西：
 *   - accounts.json 里的 account 是「用这个程序的人」，有用户名密码；
 *   - config.users 里的是「挂机的超星账号」，属于某个 account。
 *
 * 密码用 scrypt 加盐存哈希，会话是随机 32 字节的 cookie，落盘到 sessions.json，
 * 服务重启后已登录的人不用重新登。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const USERNAME_RE = /^[A-Za-z0-9_\u4e00-\u9fa5]{3,24}$/;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉 0/O/1/I

function randomId(prefix) {
  return prefix + crypto.randomBytes(8).toString('hex');
}

function randomCode(len) {
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return out;
}

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), s, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 64 * 1024 * 1024
  });
  return { salt: s, hash: hash.toString('hex') };
}

function verifyPassword(password, salt, hash) {
  try {
    const got = crypto.scryptSync(String(password), salt, SCRYPT.keylen, {
      N: SCRYPT.N,
      r: SCRYPT.r,
      p: SCRYPT.p,
      maxmem: 64 * 1024 * 1024
    });
    const want = Buffer.from(String(hash), 'hex');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch (e) {
    return false;
  }
}

class Accounts {
  constructor({ dataDir, logger, sessionDays = 30, defaultMaxTasks = 3, inviteDays = 7 }) {
    this.dir = dataDir;
    this.logger = logger || { info() {}, warn() {} };
    this.file = path.join(dataDir, 'accounts.json');
    this.sessionFile = path.join(dataDir, 'sessions.json');
    this.adminPasswordFile = path.join(dataDir, 'admin-password.txt');
    this.sessionDays = sessionDays;
    this.defaultMaxTasks = defaultMaxTasks;
    this.inviteDays = inviteDays;
    this.data = this.load();
    this.sessions = this.loadSessions();
    this.loginFails = new Map();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
        invites: Array.isArray(raw.invites) ? raw.invites : []
      };
    } catch (e) {
      return { accounts: [], invites: [] };
    }
  }

  loadSessions() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
      return raw && typeof raw === 'object' ? raw : {};
    } catch (e) {
      return {};
    }
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  saveSessions() {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.sessionFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.sessions, null, 2));
    fs.renameSync(tmp, this.sessionFile);
  }

  /** 首次启动建管理员；密码优先取环境变量，否则随机生成写进 data/admin-password.txt */
  ensureAdmin(username = 'admin', password = process.env.OCS_ADMIN_PASSWORD || '') {
    if (this.data.accounts.some((a) => a.role === 'admin')) return null;
    const pwd = String(password || '').trim() || randomCode(12);
    const acc = this.create({ username, password: pwd, role: 'admin', maxTasks: 0 });
    try {
      fs.writeFileSync(
        this.adminPasswordFile,
        `账号：${acc.username}\n密码：${pwd}\n\n首次登录后请在「账号设置」里改掉这个密码，改完可以删除本文件。\n`,
        { mode: 0o600 }
      );
      fs.chmodSync(this.adminPasswordFile, 0o600);
    } catch (e) {}
    this.logger.warn(`[账号] 已创建管理员 ${acc.username}，初始密码见 data/admin-password.txt`);
    return { account: acc, password: pwd };
  }

  list() {
    return this.data.accounts.slice();
  }

  byId(id) {
    return this.data.accounts.find((a) => a.id === id) || null;
  }

  findByUsername(username) {
    const key = String(username || '').trim().toLowerCase();
    return this.data.accounts.find((a) => a.usernameLower === key) || null;
  }

  publicView(a, taskCount) {
    if (!a) return null;
    return {
      id: a.id,
      username: a.username,
      role: a.role,
      disabled: !!a.disabled,
      createdAt: a.createdAt,
      lastLoginAt: a.lastLoginAt || null,
      maxTasks: Number(a.maxTasks) || 0,
      taskCount: typeof taskCount === 'number' ? taskCount : undefined,
      hasAi: !!(a.ai && a.ai.custom && a.ai.enabled),
      aiModel: (a.ai && a.ai.model) || ''
    };
  }

  create({ username, password, role = 'user', maxTasks }) {
    const name = String(username || '').trim();
    if (!USERNAME_RE.test(name)) {
      throw new Error('用户名要 3-24 位，只能用中英文、数字、下划线');
    }
    if (this.findByUsername(name)) throw new Error('这个用户名已经有人用了');
    const pwd = String(password || '');
    if (pwd.length < 6) throw new Error('密码至少 6 位');
    const { salt, hash } = hashPassword(pwd);
    const acc = {
      id: randomId('a'),
      username: name,
      usernameLower: name.toLowerCase(),
      salt,
      hash,
      role,
      disabled: false,
      createdAt: Date.now(),
      lastLoginAt: null,
      maxTasks: maxTasks === undefined ? this.defaultMaxTasks : Number(maxTasks) || 0,
      ai: { custom: false }
    };
    this.data.accounts.push(acc);
    this.save();
    return acc;
  }

  verify(username, password) {
    const acc = this.findByUsername(username);
    if (!acc) return null;
    if (acc.disabled) return { disabled: true };
    if (!verifyPassword(password, acc.salt, acc.hash)) return null;
    return acc;
  }

  setPassword(id, password) {
    const acc = this.byId(id);
    if (!acc) throw new Error('账号不存在');
    const pwd = String(password || '');
    if (pwd.length < 6) throw new Error('密码至少 6 位');
    const { salt, hash } = hashPassword(pwd);
    acc.salt = salt;
    acc.hash = hash;
    acc.passwordChangedAt = Date.now();
    this.save();
    this.destroyAccountSessions(id);
    return acc;
  }

  update(id, patch) {
    const acc = this.byId(id);
    if (!acc) throw new Error('账号不存在');
    if (patch.disabled !== undefined) acc.disabled = !!patch.disabled;
    if (patch.maxTasks !== undefined) acc.maxTasks = Math.max(0, Number(patch.maxTasks) || 0);
    if (patch.ai !== undefined) acc.ai = patch.ai;
    this.save();
    if (acc.disabled) this.destroyAccountSessions(id);
    return acc;
  }

  /* ---------------- 邀请码 ---------------- */

  createInvite({ createdBy, maxUses = 1, days, note = '' } = {}) {
    const d = days === undefined ? this.inviteDays : Number(days) || 0;
    const inv = {
      code: randomCode(8),
      createdBy: createdBy || '',
      createdAt: Date.now(),
      maxUses: Math.max(1, Number(maxUses) || 1),
      used: 0,
      expiresAt: d > 0 ? Date.now() + d * 86400000 : 0,
      disabled: false,
      note: String(note || '').slice(0, 60),
      usedBy: []
    };
    this.data.invites.push(inv);
    this.save();
    return inv;
  }

  listInvites() {
    return this.data.invites.slice().sort((a, b) => b.createdAt - a.createdAt);
  }

  revokeInvite(code) {
    const inv = this.data.invites.find((i) => i.code === code);
    if (!inv) throw new Error('邀请码不存在');
    inv.disabled = true;
    this.save();
    return inv;
  }

  checkInvite(code) {
    const inv = this.data.invites.find((i) => i.code === String(code || '').trim().toUpperCase());
    if (!inv) return { ok: false, error: '邀请码无效' };
    if (inv.disabled) return { ok: false, error: '这个邀请码已被停用' };
    if (inv.expiresAt && Date.now() > inv.expiresAt) return { ok: false, error: '这个邀请码已过期' };
    if (inv.used >= inv.maxUses) return { ok: false, error: '这个邀请码已经用完了' };
    return { ok: true, invite: inv };
  }

  consumeInvite(code, accountId) {
    const r = this.checkInvite(code);
    if (!r.ok) return r;
    r.invite.used += 1;
    r.invite.usedBy.push({ accountId, at: Date.now() });
    this.save();
    return r;
  }

  /* ---------------- 会话 ---------------- */

  createSession(accountId, meta = {}) {
    const sid = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.sessions[sid] = {
      accountId,
      createdAt: now,
      expiresAt: now + this.sessionDays * 86400000,
      ip: meta.ip || '',
      ua: String(meta.ua || '').slice(0, 160)
    };
    // 顺手清掉过期会话，避免文件越滚越大
    for (const [k, v] of Object.entries(this.sessions)) {
      if (!v || !v.expiresAt || v.expiresAt < now) delete this.sessions[k];
    }
    this.saveSessions();
    return sid;
  }

  getSession(sid) {
    if (!sid) return null;
    const s = this.sessions[sid];
    if (!s) return null;
    if (!s.expiresAt || s.expiresAt < Date.now()) {
      delete this.sessions[sid];
      this.saveSessions();
      return null;
    }
    const acc = this.byId(s.accountId);
    if (!acc || acc.disabled) return null;
    return acc;
  }

  destroySession(sid) {
    if (!sid || !this.sessions[sid]) return;
    delete this.sessions[sid];
    this.saveSessions();
  }

  destroyAccountSessions(accountId) {
    let changed = false;
    for (const [k, v] of Object.entries(this.sessions)) {
      if (v && v.accountId === accountId) {
        delete this.sessions[k];
        changed = true;
      }
    }
    if (changed) this.saveSessions();
  }

  /* ---------------- 登录限流 ---------------- */

  tooManyFails(key) {
    const rec = this.loginFails.get(key);
    if (!rec) return false;
    if (rec.until && Date.now() < rec.until) return true;
    if (rec.until && Date.now() >= rec.until) this.loginFails.delete(key);
    return false;
  }

  noteFail(key) {
    const now = Date.now();
    const rec = this.loginFails.get(key) || { count: 0, until: 0, first: now };
    if (now - rec.first > 10 * 60000) {
      rec.count = 0;
      rec.first = now;
    }
    rec.count += 1;
    if (rec.count >= 5) rec.until = now + 5 * 60000;
    this.loginFails.set(key, rec);
  }

  clearFails(key) {
    this.loginFails.delete(key);
  }
}

module.exports = { Accounts, USERNAME_RE, randomCode };
