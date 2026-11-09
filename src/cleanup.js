/**
 * 资源清理：把「明明没事干却占着几百 MB」的东西放掉。
 *
 * 分三层，越往下越狠：
 * 1) 页面层：关掉多余标签、清 HTTP/代码缓存、让 renderer 做一次 GC
 * 2) 浏览器层：把闲置用户的整个 Chromium 关掉（登录态在磁盘上，下次照常）
 * 3) 磁盘层：删 profile 里的缓存目录（不碰 cookie / Local Storage）
 */
const fs = require('fs');
const path = require('path');

const CACHE_DIRS = [
  'Default/Cache',
  'Default/Code Cache',
  'Default/GPUCache',
  'Default/DawnCache',
  'Default/ShaderCache',
  'Default/Service Worker/ScriptCache',
  'GrShaderCache',
  'ShaderCache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache'
];

function forceGc() {
  if (typeof global.gc === 'function') {
    global.gc();
    return true;
  }
  // 没带 --expose-gc 启动时，用 v8 的开关临时开一个 gc 出来
  try {
    const v8 = require('v8');
    const vm = require('vm');
    v8.setFlagsFromString('--expose_gc');
    const gc = vm.runInNewContext('gc');
    if (typeof gc === 'function') {
      gc();
      return true;
    }
  } catch (e) {}
  return false;
}

function dirSize(dir) {
  let total = 0;
  let stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const ent of entries) {
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else {
        try {
          total += fs.statSync(p).size;
        } catch (e) {}
      }
    }
  }
  return total;
}

/** 删掉 profile 里的缓存目录，返回释放的字节数；浏览器在跑时不要调用 */
function clearProfileCaches(profileDir) {
  if (!profileDir || !fs.existsSync(profileDir)) return 0;
  let freed = 0;
  for (const rel of CACHE_DIRS) {
    const dir = path.join(profileDir, rel);
    if (!fs.existsSync(dir)) continue;
    freed += dirSize(dir);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {}
  }
  return freed;
}

/**
 * 页面层清理。CDP 的 clearBrowserCache 是整 context 生效的，
 * 清一次就够，不用每个标签都来一遍。
 */
async function clearPageCaches(page) {
  if (!page || page.isClosed()) return false;
  let session = null;
  try {
    session = await page.context().newCDPSession(page);
    await session.send('Network.enable').catch(() => {});
    await session.send('Network.clearBrowserCache').catch(() => {});
    await session.send('HeapProfiler.collectGarbage').catch(() => {});
    return true;
  } catch (e) {
    return false;
  } finally {
    if (session) session.detach().catch(() => {});
  }
}

module.exports = { forceGc, clearProfileCaches, clearPageCaches, dirSize, CACHE_DIRS };
