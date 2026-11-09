#!/usr/bin/env node
/**
 * 环境自检：确认这台机器能不能跑「服务端挂课」
 * 最关键的是视频解码能力 —— 网课视频多为 H.264，缺少解码器会导致进度条不动
 */
const os = require('os');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { resolveExecutable } = require('../src/browser');

const ok = (s) => console.log('  \x1b[32m✓\x1b[0m ' + s);
const bad = (s) => console.log('  \x1b[31m✗\x1b[0m ' + s);
const warn = (s) => console.log('  \x1b[33m!\x1b[0m ' + s);

// 内置 1 秒 H.264 样片（160x120），用于真实解码验证
const SAMPLE_MP4_B64 =
  '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';

const CODECS = [
  { label: 'H.264 / AVC (mp4)', contentType: 'video/mp4; codecs="avc1.42E01E"', critical: true },
  { label: 'H.265 / HEVC (mp4)', contentType: 'video/mp4; codecs="hvc1.1.6.L93.B0"', critical: false },
  { label: 'VP9 (webm)', contentType: 'video/webm; codecs="vp9"', critical: false },
  { label: 'AV1 (mp4)', contentType: 'video/mp4; codecs="av01.0.05M.08"', critical: false },
  { label: 'AAC 音频 (mp4)', contentType: 'audio/mp4; codecs="mp4a.40.2"', critical: true }
];

(async () => {
  console.log('\n=========== OCS 服务端环境自检 ===========\n');

  console.log('【系统】');
  ok(`Node ${process.version} / ${process.platform} ${process.arch}`);
  const totalMem = Math.round(os.totalmem() / 1024 / 1024);
  const freeMem = Math.round(os.freemem() / 1024 / 1024);
  console.log(`     内存 ${totalMem} MB（可用 ${freeMem} MB），CPU ${os.cpus().length} 核`);
  if (totalMem < 900) warn('内存偏小：Chromium 单实例约需 400-700MB，建议 2GB 以上');
  else ok('内存满足要求');

  console.log('\n【浏览器】');
  const exe = resolveExecutable(process.env.CHROME_PATH);
  if (!exe) {
    bad('未找到 Chromium/Chrome');
    console.log('     安装方法：sudo apt install chromium  （或设置 CHROME_PATH 环境变量）');
    process.exit(1);
  }
  ok('可执行文件：' + exe);

  let browser;
  try {
    browser = await chromium.launch({
      executablePath: exe,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required']
    });
  } catch (e) {
    bad('浏览器启动失败：' + e.message);
    console.log('     常见原因：缺少系统依赖库。Debian/Ubuntu 可执行：');
    console.log('     sudo apt install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \\');
    console.log('       libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \\');
    console.log('       libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 fonts-noto-cjk');
    process.exit(1);
  }

  const page = await browser.newPage();
  const ua = await page.evaluate(() => navigator.userAgent);
  ok('浏览器启动成功');
  console.log('     UA: ' + ua);
  if (/HeadlessChrome/i.test(ua)) warn('UA 含 HeadlessChrome，部分平台可能识别为自动化环境');

  console.log('\n【视频解码能力】（决定视频课能不能真正播放）');
  const results = await page.evaluate(async (list) => {
    const out = [];
    for (const item of list) {
      let supported = null;
      try {
        const r = await navigator.mediaCapabilities.decodingInfo({
          type: 'file',
          video:
            item.contentType.startsWith('audio')
              ? undefined
              : { contentType: item.contentType, width: 1280, height: 720, bitrate: 2000000, framerate: 30 },
          audio: item.contentType.startsWith('audio') ? { contentType: item.contentType, channels: 2, bitrate: 128000, samplerate: 44100 } : undefined
        });
        supported = r.supported;
      } catch (e) {
        const v = document.createElement(item.contentType.startsWith('audio') ? 'audio' : 'video');
        supported = v.canPlayType(item.contentType) !== '';
      }
      out.push({ label: item.label, supported, critical: item.critical });
    }
    return out;
  }, CODECS);

  let h264ok = false;
  for (const r of results) {
    if (r.supported) ok(`${r.label}：支持`);
    else if (r.critical) bad(`${r.label}：不支持`);
    else warn(`${r.label}：不支持（一般不影响）`);
    if (r.label.includes('H.264')) h264ok = r.supported;
  }

  // 真实播放测试：内置 H.264 样片，能播才算真的能解码（比 API 探测可靠）
  const playTest = await page.evaluate(async (b64) => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.src = 'data:video/mp4;base64,' + b64;
    v.style.position = 'fixed';
    v.style.left = '-9999px';
    document.body.appendChild(v);
    try {
      await v.play();
    } catch (e) {
      v.remove();
      return { ok: false, error: e.message };
    }
    await new Promise((r) => setTimeout(r, 1600));
    const res = {
      ok: v.currentTime > 0.2 && v.videoWidth > 0,
      t: Number(v.currentTime.toFixed(2)),
      w: v.videoWidth,
      h: v.videoHeight,
      err: v.error ? v.error.code : null
    };
    v.remove();
    return res;
  }, SAMPLE_MP4_B64);

  if (playTest.ok) ok(`真实播放测试通过：已解码 ${playTest.w}x${playTest.h}，进度 ${playTest.t}s`);
  else bad(`真实播放测试失败：${playTest.error || '解码失败 code=' + playTest.err}`);
  h264ok = playTest.ok;

  await browser.close();

  console.log('\n【结论】');
  if (h264ok) {
    ok('H.264 可用，视频课可以正常播放，方案可行。');
  } else {
    bad('缺少 H.264 解码器，网课视频无法播放（进度条不会动）。');
    console.log(`
     先确认浏览器版本 —— Debian 12/13 的 chromium 一般已自带 H.264，
     只有老版本（Debian 10/11）或某些自行编译的构建才会缺：
       chromium --version
       sudo apt update && sudo apt install --only-upgrade chromium

     处理办法（按推荐顺序）：
     1) x86_64 机器：装 Google Chrome 官方 deb，自带 H.264/AAC，最稳：
        wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
        sudo apt install ./google-chrome-stable_current_amd64.deb
        export CHROME_PATH=/usr/bin/google-chrome
        （注意：Chrome 没有 arm64 官方包，树莓派用不了）

     2) 树莓派：改用 Raspberry Pi OS 的 chromium（自带 H.264 硬件解码），
        不要用原生 Debian arm64 源里的构建。

     3) 如果课程本身是纯答题/文档，不含视频，可忽略此项。`);
    process.exitCode = 2;
  }

  console.log('\n自检完成。下一步：npm start，然后浏览器访问 http://<本机IP>:8899\n');
})();
