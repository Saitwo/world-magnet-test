// world-magnet フェーズ0 — 保存/復元レイヤ
//
// 役割はこれだけ:
//   - 状態（どこを解錠したか・何を貼ったか）を localStorage に入れる/出す
//   - 画像（実物マグネットの写真）を IndexedDB に入れる/出す（localStorage は 5MB 上限に当たる）
//   - 画像を保存する前に縮小・圧縮する（ローカル保存は長辺 1,024px）
//   - 鑑賞操作（拡大して1枚を見る）の回数を localStorage に記録する
//
// ここに UI もボードの見た目も入れない。
//
// 事故らないための約束:
//   - この API は **例外を投げない**。失敗は false / null / 空配列で返す。
//   - プライベートブラウジングやストレージ拒否でも落ちない。落ちる代わりに
//     メモリ上のフォールバックに切り替わり、その旨を available() が返す。
//   - 非同期 API の Promise は reject しない（必ず resolve する）。
//
// 保存キーはすべて "wm_" 接頭辞。
(function (global) {
  "use strict";

  // ---- 定数 ----------------------------------------------------------------
  var PREFIX = "wm_";
  var SAVE_VER = 1;                    // 状態スキーマのバージョン
  var STATE_KEY = PREFIX + "state_v1"; // 状態本体
  var LAUNCH_KEY = PREFIX + "launches_v1"; // 起動タイムスタンプ（通過条件②の実測用）
  var LAUNCH_MAX = 500;
  var LOOK_KEY = PREFIX + "looks_v1";  // 鑑賞操作の記録（通過条件②を起動回数より鋭く測る）
  var LOOK_MAX = 1000;

  var DB_NAME = PREFIX + "images";
  var DB_VER = 1;
  var STORE_IMAGES = "images";

  // 画像の既定 = ローカル保存の解像度。
  // 512px は「配信時」の規則（第三者著作物を他人に見せる際の権利上の措置）であって、
  // 自分の端末で自分の写真を見るだけのローカル保存には適用しない。
  // 詳細ビューは約400 CSS px を3倍密度で描くため 1,200 device px が要り、512px では引き伸ばしになる。
  // 2026-09-11 の決定。サーバー配信を入れるフェーズ1が、SERVE_MAX_EDGE を適用し直すゲート。
  var IMAGE_DEFAULTS = { maxEdge: 1024, quality: 0.8, type: "image/jpeg" };
  var SERVE_MAX_EDGE = 512;            // 他人に配信するときの上限。フェーズ0では未使用。

  // ---- 環境判定 ------------------------------------------------------------
  var memState = null;      // localStorage が使えないときの逃げ場
  var memLaunches = null;
  var memLooks = null;
  var memImages = null;     // IndexedDB が使えないときの逃げ場（リロードで消える）
  var lsOK = null;
  var idbOK = null;

  function hasLocalStorage() {
    if (lsOK !== null) return lsOK;
    try {
      var k = PREFIX + "probe";
      global.localStorage.setItem(k, "1");
      global.localStorage.removeItem(k);
      lsOK = true;
    } catch (e) {
      lsOK = false;
    }
    return lsOK;
  }

  function hasIndexedDB() {
    try { return !!global.indexedDB; } catch (e) { return false; }
  }

  // ---- localStorage --------------------------------------------------------
  function rawGet(key) {
    if (!hasLocalStorage()) return null;
    try { return global.localStorage.getItem(key); } catch (e) { return null; }
  }

  function rawSet(key, value) {
    if (!hasLocalStorage()) return false;
    try { global.localStorage.setItem(key, value); return true; } catch (e) { return false; }
  }

  function rawDel(key) {
    if (!hasLocalStorage()) return false;
    try { global.localStorage.removeItem(key); return true; } catch (e) { return false; }
  }

  // ---- 状態 ----------------------------------------------------------------
  // 保存されるのは { ver, savedAt, data } の形。呼び出し側は data だけ意識すればいい。
  function saveState(obj) {
    var payload;
    try {
      payload = JSON.stringify({ ver: SAVE_VER, savedAt: Date.now(), data: obj });
    } catch (e) {
      return false; // 循環参照など。呼び出し側を落とさない
    }
    memState = payload; // localStorage が死んでいてもセッション中は保つ
    return rawSet(STATE_KEY, payload);
  }

  // 将来スキーマを変えたらここに 1→2 の変換を足す。
  // 未知の（＝未来の）バージョンは読まずに null を返す。壊すより読まない方が安全。
  function migrate(saved) {
    if (!saved || typeof saved !== "object") return null;
    var ver = saved.ver;
    if (ver === SAVE_VER) return saved.data;
    if (typeof ver !== "number" || ver > SAVE_VER) return null;
    // 例: if (ver === 1) { saved.data = up1to2(saved.data); ver = 2; }
    return null;
  }

  function loadState() {
    var s = rawGet(STATE_KEY);
    if (s == null) s = memState;
    if (s == null) return null;
    try {
      return migrate(JSON.parse(s));
    } catch (e) {
      return null;
    }
  }

  function stateMeta() {
    var s = rawGet(STATE_KEY) || memState;
    if (s == null) return null;
    try {
      var o = JSON.parse(s);
      return { ver: o.ver, savedAt: o.savedAt, bytes: s.length };
    } catch (e) {
      return null;
    }
  }

  function clearState() {
    memState = null;
    return rawDel(STATE_KEY);
  }

  // ---- 起動タイムスタンプ ---------------------------------------------------
  // 通過条件②（何も増えない7日間で何回開いたか）を自己申告でなく実測するための配列。
  function getLaunches() {
    var s = rawGet(LAUNCH_KEY);
    if (s == null) s = memLaunches;
    if (s == null) return [];
    try {
      var a = JSON.parse(s);
      return Array.isArray(a) ? a : [];
    } catch (e) {
      return [];
    }
  }

  function recordLaunch(at) {
    var a = getLaunches();
    a.push(typeof at === "number" ? at : Date.now());
    if (a.length > LAUNCH_MAX) a = a.slice(a.length - LAUNCH_MAX);
    var payload;
    try { payload = JSON.stringify(a); } catch (e) { return a; }
    memLaunches = payload;
    rawSet(LAUNCH_KEY, payload);
    return a;
  }

  function clearLaunches() {
    memLaunches = null;
    return rawDel(LAUNCH_KEY);
  }

  // ---- 鑑賞操作 -------------------------------------------------------------
  // 通過条件②は「何も増えない7日間で何回開いたか」を起動回数で測っているが、起動は
  // 「開いただけ」でも記録される。1枚に寄って見た回数のほうが鑑賞の定着の直接指標になる。
  // kind は寄り方の種類（"pref" = 県ボードに降りた / "zoom" = ピンチで拡大した など）。
  // 記録は [{ t: 時刻, k: kind }]。
  function getLooks() {
    var s = rawGet(LOOK_KEY);
    if (s == null) s = memLooks;
    if (s == null) return [];
    try {
      var a = JSON.parse(s);
      return Array.isArray(a) ? a : [];
    } catch (e) {
      return [];
    }
  }

  function recordLook(kind, at) {
    var a = getLooks();
    a.push({ t: typeof at === "number" ? at : Date.now(), k: String(kind || "?") });
    if (a.length > LOOK_MAX) a = a.slice(a.length - LOOK_MAX);
    var payload;
    try { payload = JSON.stringify(a); } catch (e) { return a; }
    memLooks = payload;
    rawSet(LOOK_KEY, payload);
    return a;
  }

  // 種類ごとの回数。{ pref: 12, zoom: 40 } のように返す。
  function lookCounts() {
    var out = {};
    getLooks().forEach(function (e) {
      var k = e && e.k ? e.k : "?";
      out[k] = (out[k] || 0) + 1;
    });
    return out;
  }

  function clearLooks() {
    memLooks = null;
    return rawDel(LOOK_KEY);
  }

  // ---- IndexedDB -----------------------------------------------------------
  var dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve) {
      if (!hasIndexedDB()) { idbOK = false; resolve(null); return; }
      var req;
      try {
        req = global.indexedDB.open(DB_NAME, DB_VER);
      } catch (e) {
        idbOK = false; resolve(null); return;
      }
      // Safari のプライベートモードなどで open が返ってこないことがあるので保険をかける
      var settled = false;
      var timer = global.setTimeout(function () {
        if (!settled) { settled = true; idbOK = false; resolve(null); }
      }, 5000);
      function done(db) {
        if (settled) return;
        settled = true;
        global.clearTimeout(timer);
        idbOK = !!db;
        resolve(db);
      }
      req.onupgradeneeded = function () {
        try {
          var db = req.result;
          if (!db.objectStoreNames.contains(STORE_IMAGES)) db.createObjectStore(STORE_IMAGES);
        } catch (e) { /* 握りつぶす */ }
      };
      req.onsuccess = function () { done(req.result); };
      req.onerror = function () { done(null); };
      req.onblocked = function () { done(null); };
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return openDB().then(function (db) {
      if (!db) return null; // IndexedDB なし → 呼び出し側でメモリに逃げる
      return new Promise(function (resolve) {
        var store;
        try {
          store = db.transaction(STORE_IMAGES, mode).objectStore(STORE_IMAGES);
        } catch (e) {
          resolve(null); return;
        }
        var req;
        try { req = fn(store); } catch (e) { resolve(null); return; }
        if (!req) { resolve(null); return; }
        req.onsuccess = function () { resolve(req.result === undefined ? null : req.result); };
        req.onerror = function () { resolve(null); };
      });
    }).catch(function () { return null; });
  }

  function memImageMap() {
    if (!memImages) memImages = {};
    return memImages;
  }

  // ---- 画像の縮小・圧縮 -----------------------------------------------------
  // File / Blob / HTMLImageElement / Canvas を受けて、長辺 maxEdge・JPEG quality の Blob を返す。
  // 失敗したら null（元の巨大画像をそのまま入れて容量を食い潰すより、入れない方が安全）。
  function decode(src) {
    // createImageBitmap があれば EXIF の向きごと解決してくれる
    if (global.createImageBitmap && (src instanceof global.Blob)) {
      return global.createImageBitmap(src, { imageOrientation: "from-image" })
        .catch(function () { return global.createImageBitmap(src); })
        .catch(function () { return decodeViaImg(src); });
    }
    if (src instanceof global.Blob) return decodeViaImg(src);
    return Promise.resolve(src); // すでに <img> や <canvas>
  }

  function decodeViaImg(blob) {
    return new Promise(function (resolve) {
      var url;
      try { url = global.URL.createObjectURL(blob); } catch (e) { resolve(null); return; }
      var img = new global.Image();
      img.onload = function () { global.URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { global.URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }

  function sizeOf(bmp) {
    var w = bmp.width || bmp.naturalWidth || 0;
    var h = bmp.height || bmp.naturalHeight || 0;
    return { w: w, h: h };
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise(function (resolve) {
      try {
        if (canvas.convertToBlob) { // OffscreenCanvas
          canvas.convertToBlob({ type: type, quality: quality }).then(resolve, function () { resolve(null); });
          return;
        }
        canvas.toBlob(function (b) { resolve(b || null); }, type, quality);
      } catch (e) {
        resolve(null);
      }
    });
  }

  function prepareImage(src, opts) {
    var o = opts || {};
    var maxEdge = o.maxEdge > 0 ? o.maxEdge : IMAGE_DEFAULTS.maxEdge;
    var quality = typeof o.quality === "number" ? o.quality : IMAGE_DEFAULTS.quality;
    // 手動マスクで切り抜いた画像は透明が要る。その場合だけ "image/webp" を渡す想定。
    var type = o.type || IMAGE_DEFAULTS.type;

    return Promise.resolve().then(function () {
      return decode(src);
    }).then(function (bmp) {
      if (!bmp) return null;
      var s = sizeOf(bmp);
      if (!s.w || !s.h) return null;
      var scale = Math.min(1, maxEdge / Math.max(s.w, s.h));
      var w = Math.max(1, Math.round(s.w * scale));
      var h = Math.max(1, Math.round(s.h * scale));

      var canvas;
      try {
        canvas = global.document ? global.document.createElement("canvas")
                                 : new global.OffscreenCanvas(w, h);
      } catch (e) { return null; }
      canvas.width = w; canvas.height = h;
      var ctx;
      try { ctx = canvas.getContext("2d"); } catch (e) { return null; }
      if (!ctx) return null;
      try {
        ctx.imageSmoothingQuality = "high";
        // JPEG には透明がないので、下に白を敷いてから描く（黒く潰れるのを防ぐ）
        if (type === "image/jpeg") { ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, w, h); }
        ctx.drawImage(bmp, 0, 0, w, h);
      } catch (e) { return null; }
      if (bmp.close) { try { bmp.close(); } catch (e) { /* noop */ } }

      return canvasToBlob(canvas, type, quality).then(function (blob) {
        if (!blob) return null;
        blob.wmWidth = w;    // 後段でメタに使う（Blob に生えるだけの補助情報）
        blob.wmHeight = h;
        return blob;
      });
    }).catch(function () { return null; });
  }

  // ---- 画像 I/O ------------------------------------------------------------
  // 保存されるレコード: { blob, type, size, w, h, savedAt, meta }
  function putImage(id, blob, meta) {
    id = String(id);
    if (!blob) return Promise.resolve(false);
    var rec = {
      blob: blob,
      type: blob.type || "",
      size: blob.size || 0,
      w: blob.wmWidth || (meta && meta.w) || null,
      h: blob.wmHeight || (meta && meta.h) || null,
      savedAt: Date.now(),
      meta: meta || null
    };
    return tx("readwrite", function (s) { return s.put(rec, id); }).then(function (r) {
      if (r !== null) return true;
      // IndexedDB が使えない → セッション中だけメモリに置く
      memImageMap()[id] = rec;
      return hasIndexedDB() ? false : true;
    });
  }

  // 元画像を縮小してから保存する近道。UI 側はだいたいこれを呼べばいい。
  function putImageFromFile(id, file, opts) {
    return prepareImage(file, opts).then(function (blob) {
      if (!blob) return false;
      return putImage(id, blob, opts && opts.meta);
    });
  }

  function getRecord(id) {
    id = String(id);
    return tx("readonly", function (s) { return s.get(id); }).then(function (r) {
      if (r) return r;
      var m = memImages && memImages[id];
      return m || null;
    });
  }

  function getImage(id) {
    return getRecord(id).then(function (r) { return r ? r.blob : null; });
  }

  // 表示用の object URL。呼び出し側が使い終わったら revokeObjectURL すること。
  function getImageURL(id) {
    return getImage(id).then(function (b) {
      if (!b) return null;
      try { return global.URL.createObjectURL(b); } catch (e) { return null; }
    });
  }

  function deleteImage(id) {
    id = String(id);
    if (memImages) delete memImages[id];
    return tx("readwrite", function (s) { return s.delete(id); }).then(function () { return true; })
      .catch(function () { return false; });
  }

  function listImages() {
    return openDB().then(function (db) {
      if (!db) {
        return Object.keys(memImages || {}).map(function (k) {
          var r = memImages[k];
          return { id: k, type: r.type, size: r.size, w: r.w, h: r.h, savedAt: r.savedAt };
        });
      }
      return new Promise(function (resolve) {
        var out = [];
        var store;
        try { store = db.transaction(STORE_IMAGES, "readonly").objectStore(STORE_IMAGES); }
        catch (e) { resolve([]); return; }
        var req;
        try { req = store.openCursor(); } catch (e) { resolve([]); return; }
        req.onsuccess = function () {
          var c = req.result;
          if (!c) { resolve(out); return; }
          var v = c.value || {};
          out.push({ id: String(c.key), type: v.type, size: v.size, w: v.w, h: v.h, savedAt: v.savedAt });
          c.continue();
        };
        req.onerror = function () { resolve(out); };
      });
    }).catch(function () { return []; });
  }

  function clearImages() {
    memImages = null;
    return tx("readwrite", function (s) { return s.clear(); }).then(function () { return true; })
      .catch(function () { return false; });
  }

  // ---- その他 --------------------------------------------------------------
  function available() {
    return openDB().then(function (db) {
      return { localStorage: hasLocalStorage(), indexedDB: !!db };
    }).catch(function () {
      return { localStorage: hasLocalStorage(), indexedDB: false };
    });
  }

  function estimate() {
    try {
      if (global.navigator && global.navigator.storage && global.navigator.storage.estimate) {
        return global.navigator.storage.estimate().catch(function () { return null; });
      }
    } catch (e) { /* noop */ }
    return Promise.resolve(null);
  }

  // wm_ 接頭辞のものだけ消す。他アプリのキーには触らない。
  function clearAll() {
    clearState();
    clearLaunches();
    clearLooks();   // localStorage は接頭辞で消えるが、メモリ上の逃げ場は明示的に落とす
    if (hasLocalStorage()) {
      try {
        var keys = [];
        for (var i = 0; i < global.localStorage.length; i++) {
          var k = global.localStorage.key(i);
          if (k && k.indexOf(PREFIX) === 0) keys.push(k);
        }
        keys.forEach(function (k) { rawDel(k); });
      } catch (e) { /* noop */ }
    }
    return clearImages();
  }

  global.WMStore = {
    SAVE_VER: SAVE_VER,
    PREFIX: PREFIX,
    STATE_KEY: STATE_KEY,
    LAUNCH_KEY: LAUNCH_KEY,
    LOOK_KEY: LOOK_KEY,
    IMAGE_DEFAULTS: IMAGE_DEFAULTS,
    SERVE_MAX_EDGE: SERVE_MAX_EDGE,

    available: available,
    estimate: estimate,

    saveState: saveState,
    loadState: loadState,
    stateMeta: stateMeta,
    clearState: clearState,

    recordLaunch: recordLaunch,
    getLaunches: getLaunches,
    clearLaunches: clearLaunches,

    recordLook: recordLook,
    getLooks: getLooks,
    lookCounts: lookCounts,
    clearLooks: clearLooks,

    prepareImage: prepareImage,
    putImage: putImage,
    putImageFromFile: putImageFromFile,
    getImage: getImage,
    getImageURL: getImageURL,
    getImageRecord: getRecord,
    deleteImage: deleteImage,
    listImages: listImages,
    clearImages: clearImages,

    clearAll: clearAll
  };
})(typeof window !== "undefined" ? window : this);
