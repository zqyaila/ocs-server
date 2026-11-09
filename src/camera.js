/**
 * 摄像头接管（人脸核验用）
 *
 * 背景：很多网课进课程/考试前会调 getUserMedia 打开摄像头做人脸核验。
 * 无头 Chromium 里没有摄像头，页面会拿到 NotFoundError，卡在核验页过不去。
 *
 * 做法：页面里的 getUserMedia 被 shim 接管，返回一条 canvas 合成的流；
 * 画面来自管理面板——用户在自己电脑上开摄像头（或传一张照片），
 * 帧通过 HTTP 推到这里，shim 再按帧率拉走画进 canvas。
 *
 * 一条会话（session）的生命周期：
 *   pending  页面已请求，等人在面板上操作
 *   live     面板正在供帧
 *   idle     视频源待命：页面本轮抓拍已结束，源还在，下一次请求自动续上
 *   ended    用户点了结束
 *   refused  用户点了拒绝
 */

const MAX_FRAME_CHARS = 480 * 1024; // dataURL 长度上限，防止一帧几十 MB 把内存撑爆
const SESSION_TTL = 5 * 60 * 1000; // 5 分钟没动静就丢弃，避免列表里堆僵尸

class CameraHub {
  constructor(options = {}) {
    this.logger = options.logger || (() => {});
    this.onChange = options.onChange || (() => {});
    this.sessions = new Map();
    this._pruneTimer = setInterval(() => this.prune(), 60 * 1000);
    this._pruneTimer.unref && this._pruneTimer.unref();
  }

  prune() {
    const now = Date.now();
    for (const [userId, s] of this.sessions) {
      if (now - s.updatedAt > SESSION_TTL) {
        this.sessions.delete(userId);
        this.logger('info', `[摄像头] ${s.name} 的核验会话超时，已清理`);
        this.onChange();
      }
    }
  }

  _session(userId, name) {
    let s = this.sessions.get(userId);
    if (!s) {
      s = {
        userId,
        name: name || userId,
        state: 'pending',
        mode: null,
        width: 640,
        height: 480,
        frame: null,
        frameAt: 0,
        frames: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        startedAt: 0
      };
      this.sessions.set(userId, s);
    }
    return s;
  }

  /** 页面调 getUserMedia：登记一条请求，返回会话参数 */
  request(userId, payload = {}, name) {
    const s = this._session(userId, name);
    // 视频源待命：上一轮抓拍结束后源还在，这次页面再要就直接续上，不用再喊人
    if (s.state === 'idle' && s.mode === 'video' && s.frame) {
      s.state = 'live';
      s.frames = 0;
      s.startedAt = Date.now();
      s.updatedAt = Date.now();
      this.logger('info', `[摄像头] ${s.name} 再次抓拍，视频源已自动续上`);
      this.onChange();
      return { ok: true, state: s.state, width: s.width, height: s.height, mode: s.mode };
    }
    // 同一场核验里页面会多次要流（先预览、再正式拍），10 秒内正在供帧就直接复用，
    // 不要反复弹面板；超过 10 秒说明上一轮早结束了（比如页面刷新），重新走一遍
    if (s.state === 'live' && s.frame && Date.now() - s.frameAt < 10000) {
      s.updatedAt = Date.now();
      return { ok: true, state: s.state, width: s.width, height: s.height, mode: s.mode };
    }
    const w = Number(payload.width) || 0;
    const h = Number(payload.height) || 0;
    if (w >= 160 && h >= 120) {
      s.width = Math.min(Math.max(w, 160), 1920);
      s.height = Math.min(Math.max(h, 120), 1080);
    }
    if (s.state !== 'pending') {
      s.state = 'pending';
      s.mode = null;
      s.frame = null;
      s.frameAt = 0;
      s.frames = 0;
    }
    s.updatedAt = Date.now();
    s.audio = !!payload.audio;
    this.logger('warn', `[摄像头] ${s.name} 的页面请求了摄像头，请打开控制台完成人脸核验`);
    this.onChange();
    return { ok: true, state: s.state, width: s.width, height: s.height, mode: s.mode };
  }

  /** shim 轮询：拿状态和最新一帧 */
  poll(userId) {
    const s = this.sessions.get(userId);
    if (!s) return { state: 'none' };
    s.updatedAt = Date.now();
    return {
      state: s.state,
      mode: s.mode,
      width: s.width,
      height: s.height,
      url: s.frame || '',
      at: s.frameAt
    };
  }

  /** 面板推帧（实时摄像头或照片） */
  pushFrame(userId, image) {
    const s = this.sessions.get(userId);
    if (!s) return { ok: false, error: '没有进行中的核验请求' };
    const url = String(image || '');
    if (!url.startsWith('data:image/')) return { ok: false, error: '图片格式不对' };
    if (url.length > MAX_FRAME_CHARS) return { ok: false, error: '图片太大，请缩小到 640×480 左右' };
    s.frame = url;
    s.frameAt = Date.now();
    s.frames += 1;
    s.updatedAt = s.frameAt;
    // idle（视频待命）时继续收帧，但不要改状态：页面没在抓拍，
    // 列表里不该一直显示「供帧中」
    if (s.state !== 'live' && s.state !== 'idle') {
      s.state = 'live';
      s.startedAt = s.frameAt;
      this.onChange();
    }
    return { ok: true, frames: s.frames };
  }

  start(userId, mode) {
    const s = this._session(userId);
    s.state = 'pending';
    s.mode = mode || 'live';
    s.updatedAt = Date.now();
    this.onChange();
    return { ok: true };
  }

  /**
   * 页面自己关掉了流（track.stop / 组件收尾）。
   * 视频模式不结束会话，改成 idle 待命：网课中途还会再抓拍，
   * 视频源继续播放，下一次请求直接续上，不用人再上传一次。
   */
  release(userId) {
    const s = this.sessions.get(userId);
    if (!s) return { ok: true };
    if (s.mode === 'video' && (s.state === 'live' || s.state === 'idle')) {
      if (s.state !== 'idle') {
        s.state = 'idle';
        s.updatedAt = Date.now();
        this.logger('info', `[摄像头] ${s.name} 本轮抓拍结束，视频源继续待命`);
        this.onChange();
      }
      return { ok: true, state: 'idle' };
    }
    return this.stop(userId);
  }

  stop(userId) {
    const s = this.sessions.get(userId);
    if (!s) return { ok: true };
    // 页面释放流时会再报一次，已经结束过就别重复写日志
    if (s.state === 'ended') return { ok: true };
    s.state = 'ended';
    s.frame = null;
    s.updatedAt = Date.now();
    this.logger('info', `[摄像头] ${s.name} 的核验已结束（共 ${s.frames} 帧）`);
    this.onChange();
    return { ok: true };
  }

  refuse(userId) {
    const s = this.sessions.get(userId);
    if (!s) return { ok: true };
    s.state = 'refused';
    s.frame = null;
    s.updatedAt = Date.now();
    this.logger('warn', `[摄像头] 已拒绝 ${s.name} 的摄像头请求`);
    this.onChange();
    return { ok: true };
  }

  /** 面板列表：不带完整帧，附一个很小的缩略图省流量 */
  list() {
    const out = [];
    for (const s of this.sessions.values()) {
      out.push({
        userId: s.userId,
        name: s.name,
        state: s.state,
        mode: s.mode,
        width: s.width,
        height: s.height,
        frames: s.frames,
        audio: !!s.audio,
        updatedAt: s.updatedAt,
        hasFrame: !!s.frame
      });
    }
    return out;
  }

  /** 面板预览用：返回完整帧 */
  frameOf(userId) {
    const s = this.sessions.get(userId);
    return s && s.frame ? s.frame : '';
  }

  dispose() {
    clearInterval(this._pruneTimer);
    this.sessions.clear();
  }
}

module.exports = { CameraHub };
