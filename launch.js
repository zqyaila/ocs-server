#!/usr/bin/env node
/**
 * Windows 安装版启动器。
 *
 * 双击桌面图标 → 选一个能用的端口 → 起服务 → 等它就绪 → 用默认浏览器打开控制台。
 *
 * 做了三件命令行启动没有的事：
 * 1. 端口被别的程序占了就往上找，而不是直接 EADDRINUSE 崩掉；
 * 2. 发现 8899 上已经跑着本程序（比如上次没关干净），就直接开浏览器，不再起第二个；
 * 3. 起来之后自动开浏览器，用户不用自己敲地址。
 */
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const DEFAULT_PORT = 8899;

function readConfiguredPort() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const p = Number(c && c.server && c.server.port);
    if (Number.isInteger(p) && p > 0 && p < 65536) return p;
  } catch (e) {}
  const env = Number(process.env.OCS_PORT);
  return Number.isInteger(env) && env > 0 ? env : DEFAULT_PORT;
}

/**
 * 第一次运行：先落一份最小配置，把监听地址限定在本机。
 * 好处是 Windows 不会弹「防火墙已阻止」——桌面版基本只在本机开控制台。
 * 想让手机 / 另一台电脑看画面，把 server.host 改成 0.0.0.0 再重启即可。
 */
function seedConfigIfNeeded() {
  if (fs.existsSync(CONFIG_PATH)) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ server: { host: '127.0.0.1', port: DEFAULT_PORT } }, null, 2));
  } catch (e) {}
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '0.0.0.0');
  });
}

/** 端口被占用时，看看是不是自己人（已经跑着的 OCS 控制台） */
function probeOcs(port) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 1500 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        body += d;
        if (body.length > 8192) {
          req.destroy();
          finish(false);
        }
      });
      res.on('end', () => {
        try {
          finish(JSON.parse(body).name === 'ocs-server');
        } catch (e) {
          finish(false);
        }
      });
      res.on('error', () => finish(false));
    });
    req.on('timeout', () => {
      req.destroy();
      finish(false);
    });
    req.on('error', () => finish(false));
  });
}

function openBrowser(url) {
  // start 的第一个参数会被当成窗口标题，必须留一个空串
  const child = spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

function waitReady(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1000 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => {
        if (Date.now() > deadline) resolve(false);
        else setTimeout(tick, 250);
      });
    };
    tick();
  });
}

(async () => {
  seedConfigIfNeeded();
  const preferred = readConfiguredPort();

  // 已经有一份在跑：直接打开，不重复启动
  if (!(await isPortFree(preferred)) && (await probeOcs(preferred))) {
    console.log('[启动] ' + preferred + ' 端口上已经有一个控制台在跑，直接打开。');
    openBrowser('http://127.0.0.1:' + preferred + '/');
    setTimeout(() => process.exit(0), 800);
    return;
  }

  let port = preferred;
  for (let i = 0; i < 30 && !(await isPortFree(port)); i++) port++;
  if (port !== preferred) {
    console.log('[启动] ' + preferred + ' 被占用，改用 ' + port);
  }

  process.env.OCS_PORT = String(port);

  // 托盘启动器靠这个文件知道该开哪个端口（8899 可能已被占用而顺延）
  try {
    fs.writeFileSync(path.join(DATA_DIR, '.port'), String(port));
  } catch (e) {}

  const url = 'http://127.0.0.1:' + port + '/';

  // 让用户知道现在该干什么（窗口版写进 ocs.log，托盘版没人看控制台）
  console.log('');
  console.log('  OCS 网课助手');
  console.log('  ------------------------------');
  console.log('  地址：' + url);
  console.log('  数据：' + DATA_DIR);
  console.log('  停止：右键任务栏右下角的托盘图标 → 退出');
  console.log('');

  require('./src/server.js');

  const ok = await waitReady(port, 45000);
  if (ok) {
    console.log('[启动] 服务已就绪，正在打开浏览器…');
    openBrowser(url);
  } else {
    console.log('[启动] 服务 45 秒内没起来，请看上面的日志。');
  }
})();
