/* ═══════════════════════════════════════════════════════════════
   LOCAL BOOT — मुख्य पेज पर चलता है
   1. छिपा हुआ "server frame" बनाता है जिसमें Code.gs चलता है
   2. google.script.run को उस frame पर forward करता है
   3. local:// फ़ाइल-links को blob URLs में बदलता है
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ── server frame ── */
  var frame = document.createElement('iframe');
  frame.id = '__server_frame__';
  frame.style.cssText = 'display:none;width:0;height:0;border:0;position:absolute;left:-9999px;';
  document.body.appendChild(frame);
  var SW = frame.contentWindow;
  SW.__PAYMENT_HTML__ = window.__PAYMENT_HTML__;
  var doc = frame.contentDocument;
  var SCRIPT_OPEN = '<' + 'script>';
  var SCRIPT_CLOSE = '<' + '/script>';
  doc.open();
  doc.write(
    '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>' +
    SCRIPT_OPEN + window.__SRC_PLATFORM__ + SCRIPT_CLOSE +
    SCRIPT_OPEN + window.__SRC_CODEGS__ + SCRIPT_CLOSE +
    SCRIPT_OPEN + 'try{__initLocal();}catch(e){console.error(e);}' + SCRIPT_CLOSE +
    '</body></html>'
  );
  doc.close();
  /* बड़ी strings अब free कर दें */
  try { delete window.__SRC_PLATFORM__; delete window.__SRC_CODEGS__; } catch (e) {}

  /* ── server-call dispatcher ── */
  window.__SERVER__ = {
    call: function (fn, args) {
      if (/_$/.test(fn)) throw new Error('निजी function: ' + fn);
      var f = SW[fn];
      if (typeof f !== 'function') throw new Error('Server function नहीं मिला: ' + fn);
      var r = f.apply(SW, args || []);
      if (r === undefined || r === null) return r;
      return JSON.parse(JSON.stringify(r));   /* GAS जैसा JSON-serialization */
    }
  };

  /* ── google.script.run shim ── */
  function makeRunner(s, f, u) {
    return new Proxy({}, {
      get: function (_, name) {
        if (name === 'withSuccessHandler') return function (fn) { return makeRunner(fn, f, u); };
        if (name === 'withFailureHandler') return function (fn) { return makeRunner(s, fn, u); };
        if (name === 'withUserObject')     return function (o)  { return makeRunner(s, f, o); };
        if (typeof name !== 'string') return undefined;
        return function () {
          var args = [].slice.call(arguments);
          setTimeout(function () {
            try {
              var r = window.__SERVER__.call(name, args);
              if (s) s(r, u);
            } catch (e) {
              if (f) f(e, u); else console.error('[server]', name, e);
            }
          }, 0);
        };
      }
    });
  }
  window.google = window.google || {};
  window.google.script = {
    run: makeRunner(null, null, null),
    host: { close: function () {}, editor: {} }
  };

  /* ── local:// links → blob URLs ── */
  var blobCache = {};
  function fileBlobUrl(id) {
    if (blobCache[id]) return blobCache[id];
    var rec = SW.localFileRecord && SW.localFileRecord(id);
    if (!rec) return '';
    var bin = atob(rec.data || '');
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    var url = URL.createObjectURL(new Blob([arr], { type: rec.mime || 'application/octet-stream' }));
    blobCache[id] = url;
    return url;
  }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
  function folderBlobUrl(path) {
    var list = (SW.localFolderList && SW.localFolderList(path)) || [];
    var rows = list.map(function (f) {
      return '<a class="fi" href="#" data-id="' + f.id + '"><span class="ic">📄</span><span class="nm">' +
        esc(f.name) + '</span><span class="dt">' + String(f.created || '').slice(0, 10) + '</span></a>';
    }).join('');
    var html = '<!DOCTYPE html><html lang="hi"><head><meta charset="UTF-8"><title>फ़ाइलें</title>' +
      '<style>body{margin:0;background:#f2f4fa;font-family:Inter,"Noto Sans Devanagari",sans-serif;color:#222b45;padding:32px 16px}' +
      '.wrap{max-width:680px;margin:0 auto}h1{font-size:17px;margin:0 0 14px}' +
      '.card{background:#fff;border:1px solid #e3e8f0;border-radius:14px;overflow:hidden;box-shadow:0 8px 24px -12px rgba(19,26,46,.12)}' +
      '.fi{display:flex;align-items:center;gap:12px;padding:13px 18px;text-decoration:none;color:#222b45;border-bottom:1px solid #eef1f7}' +
      '.fi:last-child{border-bottom:none}.fi:hover{background:#f5f7fd}' +
      '.ic{font-size:18px}.nm{flex:1;font-size:13.5px;font-weight:500}.dt{font-size:11.5px;color:#8a94ad}' +
      '.empty{padding:40px;text-align:center;color:#8a94ad;font-size:13px}</style></head>' +
      '<body><div class="wrap"><h1>📁 ' + esc(decodeURIComponent(path).split('/').pop() || 'फ़ाइलें') + '</h1>' +
      '<div class="card">' + (rows || '<div class="empty">इस फ़ोल्डर में कोई फ़ाइल नहीं है</div>') + '</div></div>' +
      SCRIPT_OPEN +
      'document.addEventListener("click",function(e){var a=e.target.closest("a[data-id]");if(!a)return;e.preventDefault();' +
      'window.opener&&window.opener.__openLocalFile&&window.opener.__openLocalFile(a.getAttribute("data-id"));});' +
      SCRIPT_CLOSE + '</body></html>';
    return URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  }
  function resolveLocal(u) {
    u = String(u || '');
    var m = u.match(/^local:\/\/f\/([^\/]+)\//);
    if (m) return fileBlobUrl(m[1]);
    m = u.match(/^local:\/\/folder\/(.*)$/);
    if (m) return folderBlobUrl(m[1]);
    return u;
  }
  window.__openLocalFile = function (id) {
    var u = fileBlobUrl(id);
    if (u) window.open(u, '_blank');
  };

  /* window.open patch — local:// को resolve करे */
  var _open = window.open;
  window.open = function (u) {
    var args = [].slice.call(arguments);
    if (/^local:\/\//.test(String(u || ''))) args[0] = resolveLocal(u);
    return _open.apply(window, args);
  };

  /* anchors में local:// hrefs */
  document.addEventListener('click', function (e) {
    var t = e.target;
    var a = t && t.closest ? t.closest('a[href^="local://"]') : null;
    if (a) { e.preventDefault(); window.open(a.getAttribute('href'), '_blank'); }
  }, true);

  /* page load के बाद fileDownloadUrl को wrap करें */
  document.addEventListener('DOMContentLoaded', function () {
    var _fdu = window.fileDownloadUrl;
    window.fileDownloadUrl = function (lnk) {
      lnk = String(lnk || '');
      var m = lnk.match(/^local:\/\/f\/([^\/]+)\//);
      if (m) return fileBlobUrl(m[1]);
      return _fdu ? _fdu(lnk) : '';
    };
  });
})();
