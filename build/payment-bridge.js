/* LOCAL BRIDGE — Payment iframe से parent के server frame को call */
(function () {
  'use strict';
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
              var r = window.parent.__SERVER__.call(name, args);
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
  /* local:// links भी parent की तरह खुलें */
  var _open = window.open;
  window.open = function (u) {
    var args = [].slice.call(arguments);
    if (/^local:\/\//.test(String(u || '')) && window.parent && window.parent.open !== window.open) {
      return window.parent.open.apply(window.parent, args);
    }
    return _open.apply(window, args);
  };
})();
