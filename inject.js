(function () {
  'use strict';

  // ---- 0. 确保运行在页面主世界（MV3 content script 默认是隔离世界）----
  // 万一浏览器忽略了 manifest 的 "world": "MAIN"，这里用 script 标签再注入一次。
  // popup 的「立即注入」会先置 __szdxForceMain，避免 MAIN world 里误判为隔离世界。
  var cur = document.currentScript;
  var fromPageScript = !!(cur && cur.src && cur.src.indexOf('szdx-main=1') !== -1);
  var forcedMain = !!window.__szdxForceMain;
  var inIsolatedWorld = !fromPageScript && !forcedMain &&
    typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
  if (inIsolatedWorld) {
    try {
      var s = document.createElement('script');
      s.src = chrome.runtime.getURL('inject.js') + '?szdx-main=1';
      (document.head || document.documentElement || document).appendChild(s);
    } catch (e) {}
    return;
  }

  if (window.__szdxGuard && window.__szdxGuard.version === '1.3.0') return;

  // ---- 1. 总开关：popup 写入同源 localStorage，这里同步读取 ----
  try {
    if (localStorage.getItem('__szdx_guard_off') === '1') return;
  } catch (e) {}

  var G = {
    installed: true,
    version: '1.3.0',
    blocked: 0,
    resumed: 0,
    skipped: 0,
    confirmed: 0,
    acknowledged: 0,
    started: 0,
    autoDialog: true,
    at: Date.now(),
    path: location.pathname
  };
  window.__szdxGuard = G;

  var isVideoPage = function () {
    return /\/videodetails\//i.test(location.pathname);
  };

  // ---- 2. 治本：把平台配置 rdLostPauseTime 置 0 ----
  // /system/getSetting -> data.video(JSON 字符串) -> settingStore -> r.value
  // 播放页回调判断 r.value == 1 才调用 video.pause()
  var nativeParse = JSON.parse;
  JSON.parse = function () {
    var out = nativeParse.apply(this, arguments);
    try {
      if (out && typeof out === 'object' && 'rdLostPauseTime' in out) {
        out.rdLostPauseTime = 0;
        G.blocked++;
      }
    } catch (e) {}
    return out;
  };

  // ---- 3. 兜底：播放页不再注册失焦监听器 ----
  // 判断放在「注册时刻」，SPA 内从首页跳进播放页同样命中；考试页不受影响
  var nativeAdd = EventTarget.prototype.addEventListener;
  var BLOCKED = { visibilitychange: 1, blur: 1 };
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (isVideoPage() && BLOCKED[type] && (this === window || this === document)) {
      G.blocked++;
      return;
    }
    return nativeAdd.call(this, type, listener, options);
  };
  var addNative = function (target, type, fn, opts) {
    return nativeAdd.call(target, type, fn, opts);
  };

  // ---- 4. 兜底：播放页伪装为始终可见 ----
  // 保存原生 getter，看门狗用它判断「是否真的失焦」
  var nativeHiddenGet = null;
  var nativeStateGet = null;
  var nativeHasFocus = null;
  try {
    var hd = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
    var sd = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    nativeHiddenGet = hd && hd.get ? hd.get : null;
    nativeStateGet = sd && sd.get ? sd.get : null;
    nativeHasFocus = document.hasFocus.bind(document);

    if (nativeHiddenGet) {
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: function () {
          return isVideoPage() ? false : nativeHiddenGet.call(document);
        }
      });
    }
    if (nativeStateGet) {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: function () {
          return isVideoPage() ? 'visible' : nativeStateGet.call(document);
        }
      });
    }
    document.hasFocus = function () {
      return isVideoPage() ? true : nativeHasFocus();
    };
    try {
      Object.defineProperty(document, 'webkitHidden', {
        configurable: true,
        get: function () { return false; }
      });
    } catch (e) {}
  } catch (e) {}

  var reallyHidden = function () {
    try { return nativeHiddenGet ? !!nativeHiddenGet.call(document) : false; }
    catch (e) { return false; }
  };
  var reallyFocused = function () {
    try { return nativeHasFocus ? nativeHasFocus() : true; }
    catch (e) { return true; }
  };

  // ---- 5. 终极兜底：任何来源的失焦暂停都自动续播 ----
  // pause 事件不冒泡，用 document 的捕获阶段监听。
  // 只在「页面真的失焦」时恢复，前台手动暂停和定时提醒弹窗都不干预。
  addNative(document, 'pause', function (e) {
    if (!isVideoPage()) return;
    if (!reallyHidden() && reallyFocused()) return;
    var v = e.target;
    if (!v || v.tagName !== 'VIDEO' || v.ended || !v.isConnected) return;
    G.resumed++;
    Promise.resolve().then(function () {
      try {
        var p = v.play();
        if (p && p.catch) p.catch(function () {});
      } catch (err) {}
    });
  }, true);

  // ---- 6. 播完弹窗自动处理（实测链路，共 3 步）----
  // onended
  //   -> [1] 课程评价 dialog「跳过」
  //   -> [2] MessageBox「该视频已播放完毕！」「确定」
  //   -> 平台自身 videoMsgChange(type:2) 标记 100% 并加载下一节
  //   -> [3] 新一节 MessageBox「您需要完整观看一遍视频…」「我知道了」
  //   -> 视频自动开始播放
  // 严格按「弹窗正文特征 + 按钮文字」双重限定，避免误点其它提示框。
  var autoDialog = true;
  try { autoDialog = localStorage.getItem('__szdx_auto_dialog') !== '0'; } catch (e) {}
  G.autoDialog = autoDialog;

  var RULES = [
    { key: 'skip',        marker: /课程评价|请为本课程打分/,                    btn: '跳过',     count: 'skipped' },
    { key: 'confirm',     marker: /该视频已播放完毕|视频已播放完毕/,             btn: '确定',     count: 'confirmed' },
    { key: 'acknowledge', marker: /完整观看一遍视频|获得本课学时|视频可以拖动播放/, btn: '我知道了', count: 'acknowledged' }
  ];
  var lastAt = { skip: 0, confirm: 0, acknowledge: 0 };
  var badge = null;

  function paintBadge() {
    if (!badge) return;
    badge.textContent = '失焦保护 · 拦截 ' + G.blocked + ' · 续播 ' + G.resumed +
      ' · 跳过 ' + G.skipped + ' · 完成 ' + G.confirmed +
      ' · 知晓 ' + G.acknowledged + '   ×';
    try {
      badge.setAttribute('data-szdx', JSON.stringify({
        installed: true, version: G.version, blocked: G.blocked, resumed: G.resumed,
        skipped: G.skipped, confirmed: G.confirmed, acknowledged: G.acknowledged,
        started: G.started, autoDialog: autoDialog
      }));
    } catch (e) {}
  }

  function findBtn(root, label) {
    var list = root.querySelectorAll('button, .el-button, [role="button"]');
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
      var t = (b.textContent || '').replace(/\s+/g, '');
      if (t === label) return b;
    }
    return null;
  }

  // 取当前可见的弹窗容器，按面积升序（最内层优先），避免点到页面里无关的按钮
  function visibleBoxes() {
    var nodes = [];
    var sels = ['.el-message-box', '.el-dialog', '[role="alertdialog"]', '[role="dialog"]', '.el-overlay'];
    for (var s = 0; s < sels.length; s++) {
      var found = document.querySelectorAll(sels[s]);
      for (var i = 0; i < found.length; i++) {
        var n = found[i];
        var r = n.getBoundingClientRect();
        if (r.width < 40 || r.height < 20) continue;
        try {
          var cs = getComputedStyle(n);
          if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
        } catch (e) {}
        if (nodes.indexOf(n) === -1) nodes.push(n);
      }
    }
    nodes.sort(function (a, b) {
      var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return ra.width * ra.height - rb.width * rb.height;
    });
    return nodes;
  }

  // 点完第 3 个弹窗后，平台一般会自动起播；这里只做一次保守兜底
  function ensurePlaying() {
    setTimeout(function () {
      try {
        var v = document.querySelector('video');
        if (!v || v.ended || !v.paused || v.readyState < 2 || v.currentTime > 3) return;
        if (visibleBoxes().length) return;
        var p = v.play();
        if (p && p.then) p.then(function () { G.started++; paintBadge(); }, function () {});
      } catch (e) {}
    }, 900);
  }

  var handleDialogs = function () {
    if (!isVideoPage() || !autoDialog || !document.body) return;
    var boxes = visibleBoxes();
    if (!boxes.length) return;
    var now = Date.now();

    for (var i = 0; i < RULES.length; i++) {
      var rule = RULES[i];
      if (now - lastAt[rule.key] < 900) continue;
      for (var j = 0; j < boxes.length; j++) {
        var text = (boxes[j].textContent || '').replace(/\s+/g, '');
        if (!rule.marker.test(text)) continue;
        var btn = findBtn(boxes[j], rule.btn);
        if (!btn) continue;
        lastAt[rule.key] = now;
        G[rule.count]++;
        paintBadge();
        btn.click();
        if (rule.key === 'acknowledge') ensurePlaying();
        return;
      }
    }
  };
  G.handleDialogs = handleDialogs;

  // ---- 7. 状态角标常驻 + DOM 计数（popup 兜底读取）+ 双重驱动 ----
  // MutationObserver 立刻响应 DOM 变化；低频轮询兜底 v-show / 后台被节流的情况。
  try {
    var startObserver = function () {
      if (!document.body) { setTimeout(startObserver, 200); return; }
      var obs = new MutationObserver(function () { handleDialogs(); });
      obs.observe(document.body, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ['class', 'style']
      });
      handleDialogs();
    };
    startObserver();
    setInterval(handleDialogs, 1200);

    if (window.top === window) {
      var mount = function () {
        if (!document.body) { setTimeout(mount, 200); return; }
        var old = document.getElementById('__szdx_guard_badge');
        if (old && old.parentNode) old.parentNode.removeChild(old);
        badge = document.createElement('div');
        badge.id = '__szdx_guard_badge';
        badge.title = '点击隐藏（不影响功能）';
        badge.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483647;' +
          'padding:7px 11px;border-radius:8px;background:#0F6E56;color:#fff;' +
          'font:12px/1.5 -apple-system,Segoe UI,sans-serif;opacity:.92;cursor:pointer';
        document.body.appendChild(badge);
        paintBadge();
        setInterval(paintBadge, 1000);
        addNative(badge, 'click', function () {
          if (badge && badge.parentNode) badge.parentNode.removeChild(badge);
          badge = null;
        }, false);
      };
      mount();
    }
  } catch (e) {}

  console.log('[东财DUFE数字党校] 失焦保护 + 播完弹窗自动处理已注入主世界', G);
})();
