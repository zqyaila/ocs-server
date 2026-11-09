/**
 * GM API 兼容层（注入浏览器主世界）
 * 目标：让油猴脚本在 Playwright 中无需任何改动即可运行
 */

function buildGmShim(storeJson, options) {
  const opts = Object.assign({ scriptVersion: '5.3.1', debug: false }, options || {});
  return `(function(){
  "use strict";
  var __store = ${storeJson || '{}'};
  var __listeners = Object.create(null);
  var __seq = 0;
  var __tabId = "tab_" + Math.random().toString(36).slice(2, 10);
  var __tabData = Object.create(null);

  // 关键：定义 unsafeWindow，脚本才会启用 GMStoreProvider（持久化存储）
  try {
    Object.defineProperty(window, "unsafeWindow", { value: window, writable: true, configurable: true });
  } catch (e) {
    window.unsafeWindow = window;
  }

  // 有的脚本会把原生 fetch 存起来再 originalFetch.apply(this, ...) 调用，
  // 一旦 this 不是 window 就抛 "Failed to execute 'fetch' on 'Window': Illegal invocation"。
  // 这里预先 bind 好，谁调用都不会再丢 this（脚本自己的包装函数仍然可以覆盖它）。
  try {
    if (typeof window.fetch === "function" && !window.fetch.__ocsBound) {
      var __nativeFetch = window.fetch.bind(window);
      try {
        Object.defineProperty(__nativeFetch, "__ocsBound", { value: true });
      } catch (e) {}
      Object.defineProperty(window, "fetch", {
        value: __nativeFetch,
        writable: true,
        configurable: true
      });
    }
  } catch (e) {}

  function clone(v) {
    if (v === undefined) return undefined;
    try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; }
  }
  function bridge(op, payload) {
    if (typeof window.gmBridge !== "function") return Promise.resolve(null);
    return window.gmBridge(op, payload);
  }

  window.GM_getValue = function (key, defaultValue) {
    return Object.prototype.hasOwnProperty.call(__store, key) ? clone(__store[key]) : defaultValue;
  };
  window.GM_setValue = function (key, value) {
    var oldValue = __store[key];
    __store[key] = clone(value);
    bridge("set", { key: key, value: __store[key] });
    __fire(key, oldValue, __store[key], false);
    return true;
  };
  window.GM_deleteValue = function (key) {
    var oldValue = __store[key];
    delete __store[key];
    bridge("delete", { key: key });
    __fire(key, oldValue, undefined, false);
  };
  window.GM_listValues = function () {
    return Object.keys(__store);
  };

  function __fire(key, oldValue, newValue, remote) {
    var list = __listeners[key];
    if (!list) return;
    list.slice().forEach(function (item) {
      try { item.callback(key, oldValue, newValue, remote); } catch (e) { console.error("[GM] listener error", e); }
    });
  }
  // 供 node 侧跨 frame 广播调用
  window.__OCS_GM_APPLY__ = function (key, oldValue, newValue) {
    __store[key] = newValue;
    __fire(key, oldValue, newValue, true);
  };

  window.GM_addValueChangeListener = function (key, callback) {
    var id = "l" + (++__seq);
    (__listeners[key] = __listeners[key] || []).push({ id: id, callback: callback });
    return id;
  };
  window.GM_removeValueChangeListener = function (listenerId) {
    Object.keys(__listeners).forEach(function (key) {
      __listeners[key] = __listeners[key].filter(function (i) { return i.id !== listenerId; });
    });
  };

  window.GM_getTab = function (callback) {
    if (typeof callback === "function") callback(clone(__tabData));
  };
  window.GM_saveTab = function (obj) {
    __tabData = clone(obj) || {};
    bridge("saveTab", { tabId: __tabId, data: __tabData });
  };

  window.GM_notification = function (details) {
    var d = typeof details === "string" ? { text: details } : details || {};
    bridge("notify", { title: d.title || "", text: d.text || "" });
  };

  window.GM_getResourceText = function () { return ""; };
  window.GM_getResourceURL = function () { return ""; };

  window.GM_info = {
    script: {
      name: "OCS 网课助手",
      namespace: "ocs-server",
      version: "${opts.scriptVersion}",
      description: "server side runtime",
      matches: ["*://*/*"],
      grant: []
    },
    scriptHandler: "OCS-Server",
    version: "1.0.0"
  };
  window.GM = window.GM || {};
  window.GM_info.scriptMetaStr = "";

  window.GM_xmlhttpRequest = function (details) {
    var d = details || {};
    var aborted = false;
    var id = "req_" + (++__seq);
    bridge("http", {
      id: id,
      url: d.url,
      method: (d.method || "GET").toUpperCase(),
      headers: d.headers || {},
      data: d.data === undefined ? null : d.data,
      timeout: d.timeout || 30000,
      anonymous: !!d.anonymous
    }).then(function (res) {
      if (aborted) return;
      if (!res) { d.onerror && d.onerror({ error: "bridge unavailable" }); return; }
      if (res.error) {
        d.onerror && d.onerror({ error: res.error, status: 0, statusText: res.error });
        return;
      }
      var response = res.responseText;
      if (d.responseType === "json") {
        try { response = JSON.parse(res.responseText); } catch (e) { response = null; }
      }
      d.onload && d.onload({
        status: res.status,
        statusText: res.statusText,
        responseText: res.responseText,
        response: response,
        responseHeaders: res.responseHeaders || "",
        finalUrl: res.finalUrl || d.url
      });
    }).catch(function (err) {
      if (aborted) return;
      d.onerror && d.onerror({ error: String(err && err.message || err) });
    });
    return { abort: function () { aborted = true; bridge("abort", { id: id }); } };
  };

  /* ============================================================
   * 摄像头接管（人脸核验）
   *
   * 无头浏览器没有摄像头，网课一进课程/考试就卡在「请开启摄像头」。
   * 这里把 getUserMedia 换成 canvas 合成的流，画面由控制台那边提供：
   * 用户在控制台里开自己电脑的摄像头（或传一张照片），帧推给 node，
   * 这里每 180ms 拉一次画进 canvas，页面拿到的就是一条正常的视频流。
   * ============================================================ */
  (function () {
    if (!navigator.mediaDevices) return;

    var cam = {
      on: false,
      stream: null,
      canvas: null,
      c2d: null,
      img: null,
      mode: "",
      width: 640,
      height: 480,
      lastAt: 0,
      pollTimer: null,
      drawTimer: null,
      waiting: null,
      tearing: false,
      refused: false
    };

    function camLog(text) {
      try { console.log("[摄像头] " + text); } catch (e) {}
    }

    function pickSize(v, fallback) {
      if (typeof v === "number" && v > 0) return v;
      if (v && typeof v === "object") {
        var n = v.ideal || v.exact || v.max || v.min;
        if (typeof n === "number" && n > 0) return n;
      }
      return fallback;
    }

    function drawPlaceholder(text) {
      var c = cam.c2d;
      if (!c) return;
      var w = cam.canvas.width;
      var h = cam.canvas.height;
      var g = c.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, "#232936");
      g.addColorStop(1, "#12151c");
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
      c.strokeStyle = "rgba(255,255,255,0.18)";
      c.lineWidth = 3;
      c.beginPath();
      c.arc(w / 2, h / 2 - 28, 52, 0, Math.PI * 2);
      c.stroke();
      c.beginPath();
      c.arc(w / 2, h / 2 - 44, 18, 0, Math.PI * 2);
      c.stroke();
      c.beginPath();
      c.arc(w / 2, h / 2 + 8, 32, Math.PI * 0.18, Math.PI * 0.82);
      c.stroke();
      c.fillStyle = "#9aa3b2";
      c.font = "16px sans-serif";
      c.textAlign = "center";
      c.fillText(text, w / 2, h / 2 + 80);
    }

    // 每 60ms 重绘一次：照片模式加一点呼吸感，页面端的活体检测才不像一张死图
    function paint() {
      var c = cam.c2d;
      if (!c) return;
      var w = cam.canvas.width;
      var h = cam.canvas.height;
      var im = cam.img;
      if (!im || !im.complete || !im.naturalWidth) return;
      var t = Date.now() / 1000;
      var k = cam.mode === "photo" ? 1 + Math.sin(t * 1.1) * 0.012 : 1;
      var dy = cam.mode === "photo" ? Math.sin(t * 1.7) * 1.5 : 0;
      var dw = w * k;
      var dh = h * k;
      c.drawImage(im, (w - dw) / 2, (h - dh) / 2 + dy, dw, dh);
    }

    function setFrame(url) {
      if (!cam.img) {
        cam.img = new Image();
        cam.img.onload = paint;
      }
      if (cam.img.src === url) return;
      cam.img.src = url;
    }

    function ensureStream() {
      if (cam.stream) return cam.stream;
      cam.tearing = false;
      var cv = document.createElement("canvas");
      cv.width = cam.width;
      cv.height = cam.height;
      cam.canvas = cv;
      cam.c2d = cv.getContext("2d");
      drawPlaceholder("等待管理者确认…");
      cam.stream = cv.captureStream(15);

      var track = cam.stream.getVideoTracks()[0];
      try {
        Object.defineProperty(track, "label", { value: "HD Webcam (OCS)", configurable: true });
        var origSettings = track.getSettings ? track.getSettings.bind(track) : function () { return {}; };
        track.getSettings = function () {
          return Object.assign({}, origSettings(), {
            width: cam.width,
            height: cam.height,
            frameRate: 15,
            deviceId: "ocs-default",
            facingMode: "user"
          });
        };
        track.getCapabilities = function () {
          return {
            width: { min: 160, max: 1920 },
            height: { min: 120, max: 1080 },
            frameRate: { min: 1, max: 30 },
            facingMode: ["user"]
          };
        };
        track.applyConstraints = function () { return Promise.resolve(); };
        var rawStop = track.stop.bind(track);
        track.stop = function () {
          try { rawStop(); } catch (e) {}
          teardown();
        };
      } catch (e) {}

      cam.drawTimer = setInterval(paint, 60);
      return cam.stream;
    }

    function teardown() {
      if (cam.tearing) return;
      cam.tearing = true;
      cam.on = false;
      if (cam.pollTimer) clearTimeout(cam.pollTimer);
      if (cam.drawTimer) clearInterval(cam.drawTimer);
      cam.pollTimer = null;
      cam.drawTimer = null;
      var s = cam.stream;
      cam.stream = null;
      cam.canvas = null;
      cam.c2d = null;
      cam.img = null;
      cam.lastAt = 0;
      // 轨道一定要真的停掉：canvas 的 captureStream 不会自己结束，
      // 不停的话页面那边会一直显示「摄像头开着」，人脸核验组件也不收尾
      if (s) {
        s.getTracks().forEach(function (t) {
          try { t.stop(); } catch (e) {}
        });
      }
      bridge("camera", { action: "release" }).catch(function () {});
    }

    function pollLoop() {
      if (!cam.on) return;
      bridge("camera", { action: "poll" })
        .then(function (r) {
          if (!cam.on || !r) return;
          if (r.state === "refused") {
            camLog("管理者拒绝了摄像头请求");
            cam.refused = true;
            var w = cam.waiting;
            cam.waiting = null;
            teardown();
            if (w) w("refused");
            return;
          }
          if (r.state === "ended") {
            camLog("管理员已结束人脸核验");
            // 必须真的收尾：留着 canvas 和轨道，下次页面再要摄像头会立刻拿到旧画面
            teardown();
            return;
          }
          if (r.mode) cam.mode = r.mode;
          if (r.url && r.at && r.at !== cam.lastAt) {
            cam.lastAt = r.at;
            setFrame(r.url);
            if (cam.waiting) {
              var done = cam.waiting;
              cam.waiting = null;
              done(true);
            }
          }
        })
        .catch(function () {})
        .then(function () {
          if (cam.on) cam.pollTimer = setTimeout(pollLoop, 180);
        });
    }

    function waitFirstFrame(ms) {
      // 帧可能在 pollLoop 第一次返回时就到了，先看一眼，别白等两分钟
      if (cam.lastAt) return Promise.resolve(true);
      return new Promise(function (resolve) {
        cam.waiting = resolve;
        setTimeout(function () {
          if (cam.waiting === resolve) {
            cam.waiting = null;
            resolve(false);
          }
        }, ms);
      });
    }

    function silentAudioTrack() {
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        var ac = new AC();
        var osc = ac.createOscillator();
        var gain = ac.createGain();
        gain.gain.value = 0.0001;
        var dest = ac.createMediaStreamDestination();
        osc.connect(gain);
        gain.connect(dest);
        osc.start();
        return dest.stream.getAudioTracks()[0] || null;
      } catch (e) {
        return null;
      }
    }

    function acquire(constraints) {
      var c = constraints || {};
      var video = c.video;
      if (video === false || video === undefined || video === null) {
        return Promise.reject(new DOMException("Requested device not found", "NotFoundError"));
      }
      var wantW = 640;
      var wantH = 480;
      if (typeof video === "object") {
        wantW = pickSize(video.width, 640);
        wantH = pickSize(video.height, 480);
      }

      var req = bridge("camera", {
        action: "request",
        width: wantW,
        height: wantH,
        audio: !!c.audio
      });

      return req.then(function (r) {
        if (!r || !r.ok) {
          throw new DOMException("Permission denied", "NotAllowedError");
        }
        cam.width = r.width || wantW;
        cam.height = r.height || wantH;
        cam.on = true;
        cam.refused = false;
        camLog("页面请求摄像头，已转交控制台（" + cam.width + "×" + cam.height + "）");
        var stream = ensureStream();
        if (c.audio) {
          var at = silentAudioTrack();
          if (at) stream.addTrack(at);
        }
        pollLoop();
        // 等第一帧再交出去：页面拿到流通常会立刻截图，太早给会拍到占位图
        return waitFirstFrame(120000).then(function (got) {
          if (got === "refused") {
            throw new DOMException("Permission denied", "NotAllowedError");
          }
          if (!got) camLog("等了 2 分钟没有画面，先给占位画面，避免页面卡死");
          return stream;
        });
      });
    }

    var md = navigator.mediaDevices;
    var origGUM = md.getUserMedia ? md.getUserMedia.bind(md) : null;

    md.getUserMedia = function (constraints) {
      try {
        return acquire(constraints);
      } catch (e) {
        return Promise.reject(e);
      }
    };

    // 老站点还在用这两个
    navigator.getUserMedia = function (constraints, ok, fail) {
      md.getUserMedia(constraints).then(ok, fail);
    };
    navigator.webkitGetUserMedia = navigator.getUserMedia;

    var origEnum = md.enumerateDevices ? md.enumerateDevices.bind(md) : null;
    md.enumerateDevices = function () {
      var p = origEnum ? origEnum().catch(function () { return []; }) : Promise.resolve([]);
      return p.then(function (list) {
        var hasVideo = list.some(function (d) { return d.kind === "videoinput"; });
        if (!hasVideo) {
          list = list.concat([
            { deviceId: "ocs-default", groupId: "ocs", kind: "videoinput", label: "HD Webcam (OCS)" }
          ]);
        }
        return list;
      });
    };

    if (navigator.permissions && navigator.permissions.query) {
      var origQuery = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = function (desc) {
        if (desc && (desc.name === "camera" || desc.name === "microphone")) {
          return Promise.resolve({ state: "granted", onchange: null });
        }
        return origQuery(desc);
      };
    }

    // 人脸核验常在跨域 iframe 里，iframe 没有 allow="camera" 的话连我们的覆盖都进不去
    function fixIframe(el) {
      if (!el || el.tagName !== "IFRAME") return;
      var a = el.getAttribute("allow") || "";
      if (a.indexOf("camera") >= 0) return;
      el.setAttribute("allow", (a ? a + "; " : "") + "camera; microphone; fullscreen");
    }
    try {
      Array.prototype.forEach.call(document.querySelectorAll("iframe"), fixIframe);
      var mo = new MutationObserver(function (list) {
        for (var i = 0; i < list.length; i++) {
          var added = list[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var n = added[j];
            if (n && n.tagName === "IFRAME") fixIframe(n);
            else if (n && n.querySelectorAll) {
              Array.prototype.forEach.call(n.querySelectorAll("iframe"), fixIframe);
            }
          }
        }
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(function () { mo.disconnect(); }, 60000);
    } catch (e) {}
  })();
})();`;
}

module.exports = { buildGmShim };
