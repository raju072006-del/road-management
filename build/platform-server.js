/* ═══════════════════════════════════════════════════════════════
   PLATFORM — server frame के अंदर चलता है
   Google Apps Script services के browser-polyfills + दो data-modes:
     • LOCAL mode — localStorage (file:// से खोलने पर, offline)
     • CLOUD mode — Netlify Function → Supabase (hosted site पर,
       जब /api/db configured मिले) — सभी users का साझा central डेटा
   ═══════════════════════════════════════════════════════════════ */

var Logger = { log: function () { try { console.log.apply(console, arguments); } catch (e) {} } };

var MimeType = { GOOGLE_SHEETS: 'application/vnd.google-apps.spreadsheet', PDF: 'application/pdf' };

var Session = { getScriptTimeZone: function () { return 'Asia/Kolkata'; } };

var ScriptApp = { getService: function () { return { getUrl: function () { return ''; } }; } };

var LockService = {
  getScriptLock: function () {
    return { waitLock: function(){}, tryLock: function(){ return true; }, releaseLock: function(){}, hasLock: function(){ return true; } };
  }
};

var HtmlService = {
  XFrameOptionsMode: { ALLOWALL: 'ALLOWALL', DEFAULT: 'DEFAULT' },
  _wrap: function (content) {
    var o = {
      getContent: function () { return content; },
      setTitle: function () { return o; },
      setWidth: function () { return o; },
      setHeight: function () { return o; },
      setXFrameOptionsMode: function () { return o; }
    };
    return o;
  },
  createHtmlOutputFromFile: function (name) {
    if (name === 'Payment') return HtmlService._wrap(window.__PAYMENT_HTML__ || '');
    return HtmlService._wrap('');
  },
  createHtmlOutput: function (html) { return HtmlService._wrap(html || ''); }
};

var UrlFetchApp = {
  fetch: function () { throw new Error('इस mode में सीधी network call उपलब्ध नहीं है'); }
};

var Utilities = {
  getUuid: function () {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  },
  formatDate: function (date, tz, fmt) {
    var d = (date instanceof Date) ? date : new Date(date);
    function p(n, l) { n = String(n); while (n.length < (l || 2)) n = '0' + n; return n; }
    return String(fmt)
      .replace(/yyyy/g, String(d.getFullYear()))
      .replace(/MM/g, p(d.getMonth() + 1))
      .replace(/dd/g, p(d.getDate()))
      .replace(/HH/g, p(d.getHours()))
      .replace(/mm/g, p(d.getMinutes()))
      .replace(/ss/g, p(d.getSeconds()));
  },
  base64Decode: function (s) {
    var bin = atob(String(s || ''));
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  },
  base64Encode: function (bytes) {
    if (typeof bytes === 'string') return btoa(unescape(encodeURIComponent(bytes)));
    var bin = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray ? bytes.subarray(i, i + CH) : bytes.slice(i, i + CH));
    }
    return btoa(bin);
  },
  newBlob: function (bytes, mime, name) {
    var _n = name || null;
    return {
      getBytes: function () { return bytes; },
      getContentType: function () { return mime || 'application/octet-stream'; },
      getName: function () { return _n; },
      setName: function (n) { _n = n; return this; }
    };
  },
  sleep: function () {}
};

var PropertiesService = (function () {
  var KEY = 'rms_props';
  function load() { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; } }
  function store(o) { localStorage.setItem(KEY, JSON.stringify(o)); }
  var api = {
    getProperty: function (k) { var o = load(); return (k in o) ? o[k] : null; },
    setProperty: function (k, v) { var o = load(); o[k] = String(v); store(o); return api; },
    deleteProperty: function (k) { var o = load(); delete o[k]; store(o); return api; },
    getProperties: function () { return load(); },
    deleteAllProperties: function () { store({}); return api; }
  };
  return { getScriptProperties: function () { return api; }, getUserProperties: function () { return api; } };
})();

var CacheService = (function () {
  var mem = {};
  var api = {
    get: function (k) {
      var e = mem[k];
      if (!e) return null;
      if (Date.now() > e.exp) { delete mem[k]; return null; }
      return e.v;
    },
    put: function (k, v, ttl) {
      ttl = ttl || 600;
      /* cloud mode में cache छोटा — ताकि दूसरे users के बदलाव जल्दी दिखें */
      if (SB_CLOUD && ttl > 60) ttl = 60;
      mem[k] = { v: String(v), exp: Date.now() + ttl * 1000 };
    },
    remove: function (k) { delete mem[k]; },
    removeAll: function (keys) { (keys || []).forEach(function (k) { delete mem[k]; }); }
  };
  return { getScriptCache: function () { return api; }, getUserCache: function () { return api; } };
})();

/* ── CLOUD detection — boot हमें __BASE__ देता है (http/https origin) ── */

var SB_CLOUD = false;
var SB_TOKEN = '';
(function () {
  try {
    if (window.__BASE__) {
      var x = new XMLHttpRequest();
      x.open('GET', window.__BASE__ + '/api/db', false);
      x.send(null);
      if (x.status === 200) {
        var r = JSON.parse(x.responseText);
        SB_CLOUD = (r && r.cloud === true);
      }
      try { SB_TOKEN = localStorage.getItem('rms_cloud_token') || ''; } catch (e) {}
    }
  } catch (e) {}
})();

function sbCall_(op, args) {
  var x = new XMLHttpRequest();
  x.open('POST', window.__BASE__ + '/api/db', false);
  x.setRequestHeader('Content-Type', 'application/json');
  x.send(JSON.stringify({ op: op, token: SB_TOKEN, args: args || {} }));
  var r = null;
  try { r = JSON.parse(x.responseText); } catch (e) {}
  if (!r || r.ok !== true) {
    throw new Error((r && r.error) || ('Server त्रुटि (' + x.status + ')'));
  }
  return r.result;
}

/* ── साझा helpers — दोनों modes ─────────────────────────────── */

/* synchronous SHA-256 (hex) — local login में password-hash तुलना के लिए
   (crypto.subtle async है, जबकि validateLogin sync है — इसलिए pure-JS) */
function sha256Hex_(msg) {
  function rrot(v, n) { return (v >>> n) | (v << (32 - n)); }
  var K = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  /* UTF-8 encode */
  var bytes = [];
  msg = String(msg);
  for (var i = 0; i < msg.length; i++) {
    var cp = msg.codePointAt(i);
    if (cp > 0xffff) i++;
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  var bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (var j = 7; j >= 0; j--) bytes.push((j >= 4 ? 0 : (bitLen / Math.pow(2, j * 8))) & 0xff);
  var w = new Array(64);
  for (var off = 0; off < bytes.length; off += 64) {
    for (var t = 0; t < 16; t++) {
      w[t] = (bytes[off+t*4] << 24) | (bytes[off+t*4+1] << 16) | (bytes[off+t*4+2] << 8) | bytes[off+t*4+3];
    }
    for (t = 16; t < 64; t++) {
      var s0 = rrot(w[t-15], 7) ^ rrot(w[t-15], 18) ^ (w[t-15] >>> 3);
      var s1 = rrot(w[t-2], 17) ^ rrot(w[t-2], 19) ^ (w[t-2] >>> 10);
      w[t] = (w[t-16] + s0 + w[t-7] + s1) | 0;
    }
    var a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
    for (t = 0; t < 64; t++) {
      var S1 = rrot(e,6) ^ rrot(e,11) ^ rrot(e,25);
      var ch = (e & f) ^ (~e & g);
      var t1 = (h + S1 + ch + K[t] + w[t]) | 0;
      var S0 = rrot(a,2) ^ rrot(a,13) ^ rrot(a,22);
      var mj = (a & b) ^ (a & c) ^ (b & c);
      var t2 = (S0 + mj) | 0;
      h=g; g=f; f=e; e=(d+t1)|0; d=c; c=b; b=a; a=(t1+t2)|0;
    }
    H[0]=(H[0]+a)|0; H[1]=(H[1]+b)|0; H[2]=(H[2]+c)|0; H[3]=(H[3]+d)|0;
    H[4]=(H[4]+e)|0; H[5]=(H[5]+f)|0; H[6]=(H[6]+g)|0; H[7]=(H[7]+h)|0;
  }
  var hex = '';
  for (i = 0; i < 8; i++) hex += ('00000000' + ((H[i] >>> 0).toString(16))).slice(-8);
  return hex;
}

function sbVal_(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    var dd = ('0' + v.getDate()).slice(-2), mm = ('0' + (v.getMonth() + 1)).slice(-2);
    return dd + '/' + mm + '/' + v.getFullYear();
  }
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  return String(v);
}

/* rows[][] में (row,col) से 2D block लिखना (values पहले से sanitized) */
function cellsWrite_(rows, row, col, vals) {
  for (var r = 0; r < vals.length; r++) {
    var idx = row - 1 + r;
    while (rows.length <= idx) rows.push([]);
    var line = rows[idx];
    for (var c = 0; c < vals[r].length; c++) {
      while (line.length < col - 1 + c) line.push('');
      line[col - 1 + c] = vals[r][c];
    }
  }
}
function cellsClear_(rows, row, col, nrows, ncols) {
  for (var r = 0; r < nrows; r++) {
    var line = rows[row - 1 + r];
    if (!line) continue;
    for (var c = 0; c < ncols; c++) {
      if (line.length > col - 1 + c) line[col - 1 + c] = '';
    }
  }
}

/* ── LocalDB — localStorage persistence (LOCAL mode) ──────────── */

var LocalDB = (function () {
  var DB_KEY = 'rms_db', FILE_KEY = 'rms_files';
  var db = null, files = null, warned = false;
  function loadDb() {
    if (db) return db;
    try { db = JSON.parse(localStorage.getItem(DB_KEY) || 'null'); } catch (e) { db = null; }
    if (!db || !db.ss) db = { ss: { main: { name: 'Road Management System', updated: new Date().toISOString(), sheets: {} } } };
    return db;
  }
  function loadFiles() {
    if (files) return files;
    try { files = JSON.parse(localStorage.getItem(FILE_KEY) || 'null') || {}; } catch (e) { files = {}; }
    return files;
  }
  function persist(key, obj) {
    try { localStorage.setItem(key, JSON.stringify(obj)); }
    catch (e) {
      if (!warned) {
        warned = true;
        try { window.parent.alert('⚠️ Browser storage भर गया है — नया डेटा save नहीं हो पा रहा।\nपुरानी फ़ाइलें/फोटो हटाएँ या डेटा export करें।'); } catch (x) {}
      }
      throw new Error('Storage quota पूर्ण — डेटा save नहीं हुआ');
    }
  }
  return {
    db: loadDb,
    files: loadFiles,
    save: function () { persist(DB_KEY, loadDb()); },
    saveFiles: function () { persist(FILE_KEY, loadFiles()); },
    touch: function (ssId) {
      var s = loadDb().ss[ssId];
      if (s) s.updated = new Date().toISOString();
    }
  };
})();

/* ── SBRange — दोनों modes का साझा Range (writes sheet को सौंपता है) ── */

function SBRange_(sheet, row, col, nrows, ncols) {
  this.sh = sheet; this.row = row; this.col = col;
  this.nrows = nrows || 1; this.ncols = ncols || 1;
}
SBRange_.prototype.getValues = function () {
  var rows = this.sh._rows(), out = [];
  for (var r = 0; r < this.nrows; r++) {
    var src = rows[this.row - 1 + r] || [], line = [];
    for (var c = 0; c < this.ncols; c++) {
      var v = src[this.col - 1 + c];
      line.push(v === undefined || v === null ? '' : v);
    }
    out.push(line);
  }
  return out;
};
SBRange_.prototype.getValue = function () { return this.getValues()[0][0]; };
SBRange_.prototype.getDisplayValues = function () {
  return this.getValues().map(function (r) { return r.map(function (v) { return String(v); }); });
};
SBRange_.prototype.setValues = function (vals) {
  this.sh._setCells(this.row, this.col, vals.map(function (r) { return r.map(sbVal_); }));
  return this;
};
SBRange_.prototype.setValue = function (v) { return this.setValues([[v]]); };
SBRange_.prototype.clearContent = function () {
  this.sh._clearRange(this.row, this.col, this.nrows, this.ncols);
  return this;
};
['setBackground','setFontColor','setFontWeight','setFontSize','setNumberFormat',
 'setHorizontalAlignment','setVerticalAlignment','setWrap','setBorder',
 'setDataValidation','setFontStyle','setFontFamily','merge','setNote'
].forEach(function (m) { SBRange_.prototype[m] = function () { return this; }; });

/* ── SBSheet / SBSpreadsheet — LOCAL mode ─────────────────────── */

function SBSheet_(ss, name) { this.ss = ss; this.name = name; }
SBSheet_.prototype._rows = function () {
  var s = LocalDB.db().ss[this.ss.id];
  if (!s.sheets[this.name]) s.sheets[this.name] = [];
  return s.sheets[this.name];
};
SBSheet_.prototype._setCells = function (row, col, vals) {
  cellsWrite_(this._rows(), row, col, vals);
  LocalDB.touch(this.ss.id); LocalDB.save();
};
SBSheet_.prototype._clearRange = function (row, col, nrows, ncols) {
  cellsClear_(this._rows(), row, col, nrows, ncols);
  LocalDB.touch(this.ss.id); LocalDB.save();
};
SBSheet_.prototype.getName = function () { return this.name; };
SBSheet_.prototype.setName = function (newName) {
  var s = LocalDB.db().ss[this.ss.id];
  s.sheets[newName] = s.sheets[this.name] || [];
  delete s.sheets[this.name];
  this.name = newName;
  LocalDB.save();
  return this;
};
SBSheet_.prototype.getLastRow = function () { return this._rows().length; };
SBSheet_.prototype.getLastColumn = function () {
  var rows = this._rows(), max = 0;
  for (var i = 0; i < rows.length; i++) if (rows[i].length > max) max = rows[i].length;
  return max;
};
SBSheet_.prototype.getMaxRows = function () { return Math.max(this.getLastRow(), 1000); };
SBSheet_.prototype.getMaxColumns = function () { return Math.max(this.getLastColumn(), 26); };
SBSheet_.prototype.getRange = function (row, col, nrows, ncols) {
  return new SBRange_(this, row, col, nrows || 1, ncols || 1);
};
SBSheet_.prototype.getDataRange = function () {
  return new SBRange_(this, 1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1));
};
SBSheet_.prototype.appendRow = function (arr) {
  this._rows().push(arr.map(sbVal_));
  LocalDB.touch(this.ss.id); LocalDB.save();
  return this;
};
SBSheet_.prototype.deleteRow = function (rowIdx) {
  var rows = this._rows();
  if (rowIdx >= 1 && rowIdx <= rows.length) rows.splice(rowIdx - 1, 1);
  LocalDB.touch(this.ss.id); LocalDB.save();
  return this;
};
SBSheet_.prototype.clearContents = function () {
  var s = LocalDB.db().ss[this.ss.id];
  s.sheets[this.name] = [];
  LocalDB.save();
  return this;
};
['setFrozenRows','setFrozenColumns','setRowHeight','setColumnWidth',
 'autoResizeColumns','autoResizeColumn','setTabColor','showSheet','hideSheet'
].forEach(function (m) { SBSheet_.prototype[m] = function () { return this; }; });

function SBSpreadsheet_(id) { this.id = id; }
SBSpreadsheet_.prototype.getId = function () { return this.id; };
SBSpreadsheet_.prototype.getName = function () {
  var s = LocalDB.db().ss[this.id];
  return s ? s.name : this.id;
};
SBSpreadsheet_.prototype.getUrl = function () { return ''; };
SBSpreadsheet_.prototype._ensure = function () {
  var db = LocalDB.db();
  if (!db.ss[this.id]) {
    db.ss[this.id] = { name: this.id, updated: new Date().toISOString(), sheets: {} };
    LocalDB.save();
  }
  return db.ss[this.id];
};
SBSpreadsheet_.prototype.getSheetByName = function (name) {
  var s = this._ensure();
  return s.sheets.hasOwnProperty(name) ? new SBSheet_(this, name) : null;
};
SBSpreadsheet_.prototype.insertSheet = function (name) {
  var s = this._ensure();
  name = name || ('Sheet' + (Object.keys(s.sheets).length + 1));
  if (!s.sheets[name]) { s.sheets[name] = []; LocalDB.save(); }
  return new SBSheet_(this, name);
};
SBSpreadsheet_.prototype.getSheets = function () {
  var s = this._ensure(), self = this;
  return Object.keys(s.sheets).map(function (n) { return new SBSheet_(self, n); });
};
SBSpreadsheet_.prototype.deleteSheet = function (sheet) {
  var s = this._ensure();
  delete s.sheets[sheet.getName()];
  LocalDB.save();
  return this;
};

/* ── साझा UI stubs ── */
var SBUi_ = {
  getUi: function () {
    var chain = { addItem: function () { return chain; }, addSeparator: function () { return chain; }, addToUi: function () {} };
    return {
      alert: function (a, b) { Logger.log('[UI] ' + [a, b].filter(function (x) { return typeof x === 'string'; }).join(' — ')); return 'OK'; },
      createMenu: function () { return chain; },
      showModalDialog: function () {},
      showSidebar: function () {},
      ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL', YES_NO: 'YES_NO' },
      Button: { OK: 'OK', CANCEL: 'CANCEL', YES: 'YES', NO: 'NO' }
    };
  },
  newDataValidation: function () {
    var b = { requireValueInList: function () { return b; }, setAllowInvalid: function () { return b; }, build: function () { return {}; } };
    return b;
  }
};

var SBApp = {
  getActiveSpreadsheet: function () { return new SBSpreadsheet_('main'); },
  openById: function (id) {
    if (!LocalDB.db().ss[String(id)]) throw new Error('Spreadsheet नहीं मिली: ' + id);
    return new SBSpreadsheet_(String(id));
  },
  create: function (name) {
    var id = Utilities.getUuid();
    LocalDB.db().ss[id] = { name: name, updated: new Date().toISOString(), sheets: { 'Sheet1': [] } };
    LocalDB.save();
    return new SBSpreadsheet_(id);
  },
  flush: function () {},
  getUi: SBUi_.getUi,
  newDataValidation: SBUi_.newDataValidation
};

/* ── SBDrive — LOCAL mode (फ़ाइलें localStorage में, base64) ───── */

function SBFile_(id) { this.id = id; }
SBFile_.prototype._rec = function () { return LocalDB.files()[this.id]; };
SBFile_.prototype.getId = function () { return this.id; };
SBFile_.prototype.getName = function () { var r = this._rec(); return r ? r.name : ''; };
SBFile_.prototype.getUrl = function () {
  var r = this._rec();
  return 'local://f/' + this.id + '/' + encodeURIComponent(r ? r.name : 'file');
};
SBFile_.prototype.setName = function (name) {
  var r = this._rec(); if (r) { r.name = name; LocalDB.saveFiles(); } return this;
};
SBFile_.prototype.setTrashed = function (flag) {
  if (flag) { delete LocalDB.files()[this.id]; LocalDB.saveFiles(); }
  return this;
};
SBFile_.prototype.setSharing = function () { return this; };
SBFile_.prototype.moveTo = function (folder) {
  var r = this._rec(); if (r && folder && folder.path !== undefined) { r.folder = folder.path; LocalDB.saveFiles(); }
  return this;
};
SBFile_.prototype.makeCopy = function (name, folder) {
  var r = this._rec();
  var id = Utilities.getUuid();
  LocalDB.files()[id] = {
    name: name || (r ? r.name : 'copy'),
    mime: r ? r.mime : '',
    data: r ? r.data : '',
    folder: folder ? folder.path : (r ? r.folder : ''),
    created: new Date().toISOString()
  };
  LocalDB.saveFiles();
  return new SBFile_(id);
};
SBFile_.prototype.getLastUpdated = function () {
  var r = this._rec(); return new Date(r ? r.created : Date.now());
};
SBFile_.prototype.getBlob = function () {
  var r = this._rec();
  return Utilities.newBlob(Utilities.base64Decode(r ? r.data : ''), r ? r.mime : '', r ? r.name : '');
};

function SBSSFile_(id) { this.id = id; }
SBSSFile_.prototype.getId = function () { return this.id; };
SBSSFile_.prototype.getName = function () {
  var s = LocalDB.db().ss[this.id]; return s ? s.name : this.id;
};
SBSSFile_.prototype.getUrl = function () { return ''; };
SBSSFile_.prototype.setName = function (name) {
  var s = LocalDB.db().ss[this.id]; if (s) { s.name = name; LocalDB.save(); } return this;
};
SBSSFile_.prototype.setTrashed = function (flag) {
  if (flag) { delete LocalDB.db().ss[this.id]; LocalDB.save(); }
  return this;
};
SBSSFile_.prototype.setSharing = function () { return this; };
SBSSFile_.prototype.moveTo = function () { return this; };
SBSSFile_.prototype.getLastUpdated = function () {
  var s = LocalDB.db().ss[this.id]; return new Date(s ? s.updated : Date.now());
};

function SBFolder_(path) { this.path = String(path || ''); }
SBFolder_.prototype.getId = function () { return this.path || 'root'; };
SBFolder_.prototype.getName = function () {
  var parts = this.path.split('/'); return parts[parts.length - 1] || 'Root';
};
SBFolder_.prototype.getUrl = function () { return 'local://folder/' + encodeURIComponent(this.path); };
SBFolder_.prototype.createFolder = function (name) {
  return new SBFolder_(this.path ? this.path + '/' + name : String(name));
};
SBFolder_.prototype.getFoldersByName = function (name) {
  var f = this.createFolder(name), done = false;
  return { hasNext: function () { return !done; }, next: function () { done = true; return f; } };
};
SBFolder_.prototype.createFile = function (blob) {
  var id = Utilities.getUuid();
  LocalDB.files()[id] = {
    name: blob.getName() || 'file',
    mime: blob.getContentType() || 'application/octet-stream',
    data: Utilities.base64Encode(blob.getBytes()),
    folder: this.path,
    created: new Date().toISOString()
  };
  LocalDB.saveFiles();
  return new SBFile_(id);
};
SBFolder_.prototype.getFilesByType = function () {
  var db = LocalDB.db();
  var list = Object.keys(db.ss).filter(function (id) { return id !== 'main'; })
    .sort(function (a, b) { return String(db.ss[b].updated).localeCompare(String(db.ss[a].updated)); });
  var i = 0;
  return { hasNext: function () { return i < list.length; }, next: function () { return new SBSSFile_(list[i++]); } };
};
SBFolder_.prototype.getFilesByName = function (name) {
  var files = LocalDB.files(), self = this;
  var ids = Object.keys(files).filter(function (id) { return files[id].folder === self.path && files[id].name === name; });
  var i = 0;
  return { hasNext: function () { return i < ids.length; }, next: function () { return new SBFile_(ids[i++]); } };
};
SBFolder_.prototype.getFiles = function () {
  var files = LocalDB.files(), self = this;
  var ids = Object.keys(files).filter(function (id) { return files[id].folder === self.path; });
  var i = 0;
  return { hasNext: function () { return i < ids.length; }, next: function () { return new SBFile_(ids[i++]); } };
};
SBFolder_.prototype.setTrashed = function () { return this; };
SBFolder_.prototype.setSharing = function () { return this; };

var SBDrive = {
  Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK', ANYONE: 'ANYONE', PRIVATE: 'PRIVATE' },
  Permission: { VIEW: 'VIEW', EDIT: 'EDIT' },
  getRootFolder: function () { return new SBFolder_(''); },
  getFolderById: function (id) { return new SBFolder_(id === 'root' ? '' : String(id || '')); },
  createFolder: function (name) { return new SBFolder_(String(name)); },
  getFileById: function (id) {
    id = String(id || '').trim();
    if (LocalDB.db().ss[id]) return new SBSSFile_(id);
    if (LocalDB.files()[id]) return new SBFile_(id);
    throw new Error('फ़ाइल नहीं मिली: ' + id);
  }
};

/* ── boot के लिए helpers (LOCAL versions) ─────────────────────── */

function localFileRecord(id) {
  var r = LocalDB.files()[String(id)];
  return r ? { id: String(id), name: r.name, mime: r.mime, data: r.data, created: r.created } : null;
}

function localFolderList(path) {
  var files = LocalDB.files();
  return Object.keys(files)
    .filter(function (id) { return files[id].folder === path; })
    .map(function (id) { return { id: id, name: files[id].name, created: files[id].created }; })
    .sort(function (a, b) { return String(b.created).localeCompare(String(a.created)); });
}

/* ═══════════════════════════════════════════════════════════════
   CLOUD mode — Netlify Function → Supabase (साझा central डेटा)
   ═══════════════════════════════════════════════════════════════ */

/* workbook cache — TTL के बाद ताज़ा fetch (दूसरे users के बदलाव दिखें) */
var RS_ = { data: {}, at: {}, list: null, listAt: 0, TTL: 45000 };
function rsLoad_(ssId) {
  var now = Date.now();
  if (RS_.data[ssId] && (now - RS_.at[ssId]) < RS_.TTL) return RS_.data[ssId];
  RS_.data[ssId] = sbCall_('loadAll', { ss: ssId }) || {};
  RS_.at[ssId] = now;
  return RS_.data[ssId];
}
function rsList_(force) {
  var now = Date.now();
  if (!force && RS_.list && (now - RS_.listAt) < RS_.TTL) return RS_.list;
  RS_.list = sbCall_('listSS', {}) || [];
  RS_.listAt = now;
  return RS_.list;
}
function rsHas_(ssId) {
  var list = rsList_();
  for (var i = 0; i < list.length; i++) if (list[i].id === ssId) return list[i];
  return null;
}

/* RSheet — remote sheet (SBSheet से inherit; सिर्फ़ storage-hooks अलग) */
function RSheet_(ss, name) { this.ss = ss; this.name = name; }
RSheet_.prototype = Object.create(SBSheet_.prototype);
RSheet_.prototype.constructor = RSheet_;
RSheet_.prototype._rows = function () {
  var d = rsLoad_(this.ss.id);
  if (!d[this.name]) d[this.name] = [];
  return d[this.name];
};
RSheet_.prototype._setCells = function (row, col, vals) {
  sbCall_('setCells', { ss: this.ss.id, sheet: this.name, row: row, col: col, values: vals });
  cellsWrite_(this._rows(), row, col, vals);
};
RSheet_.prototype._clearRange = function (row, col, nrows, ncols) {
  sbCall_('clearRange', { ss: this.ss.id, sheet: this.name, row: row, col: col, nrows: nrows, ncols: ncols });
  cellsClear_(this._rows(), row, col, nrows, ncols);
};
RSheet_.prototype.setName = function (newName) {
  sbCall_('renameSheet', { ss: this.ss.id, old: this.name, neu: newName });
  var d = rsLoad_(this.ss.id);
  d[newName] = d[this.name] || [];
  delete d[this.name];
  this.name = newName;
  return this;
};
RSheet_.prototype.appendRow = function (arr) {
  var clean = arr.map(sbVal_);
  sbCall_('appendRow', { ss: this.ss.id, sheet: this.name, cells: clean });
  this._rows().push(clean);
  return this;
};
RSheet_.prototype.deleteRow = function (rowIdx) {
  sbCall_('deleteRow', { ss: this.ss.id, sheet: this.name, row: rowIdx });
  var rows = this._rows();
  if (rowIdx >= 1 && rowIdx <= rows.length) rows.splice(rowIdx - 1, 1);
  return this;
};
RSheet_.prototype.clearContents = function () {
  sbCall_('deleteSheet', { ss: this.ss.id, sheet: this.name });
  sbCall_('ensureSheet', { ss: this.ss.id, sheet: this.name });
  rsLoad_(this.ss.id)[this.name] = [];
  return this;
};

/* RSpreadsheet — remote workbook */
function RSpreadsheet_(id) { this.id = id; }
RSpreadsheet_.prototype.getId = function () { return this.id; };
RSpreadsheet_.prototype.getUrl = function () { return ''; };
RSpreadsheet_.prototype.getName = function () {
  var e = rsHas_(this.id);
  return e ? e.name : this.id;
};
RSpreadsheet_.prototype.getSheetByName = function (name) {
  var d = rsLoad_(this.id);
  return d.hasOwnProperty(name) ? new RSheet_(this, name) : null;
};
RSpreadsheet_.prototype.insertSheet = function (name) {
  var d = rsLoad_(this.id);
  name = name || ('Sheet' + (Object.keys(d).length + 1));
  if (!d.hasOwnProperty(name)) {
    sbCall_('ensureSheet', { ss: this.id, sheet: name });
    d[name] = [];
  }
  return new RSheet_(this, name);
};
RSpreadsheet_.prototype.getSheets = function () {
  var d = rsLoad_(this.id), self = this;
  return Object.keys(d).map(function (n) { return new RSheet_(self, n); });
};
RSpreadsheet_.prototype.deleteSheet = function (sheet) {
  sbCall_('deleteSheet', { ss: this.id, sheet: sheet.getName() });
  delete rsLoad_(this.id)[sheet.getName()];
  return this;
};

var RSBApp = {
  getActiveSpreadsheet: function () { return new RSpreadsheet_('main'); },
  openById: function (id) {
    id = String(id);
    if (!rsHas_(id)) throw new Error('Spreadsheet नहीं मिली: ' + id);
    return new RSpreadsheet_(id);
  },
  create: function (name) {
    var id = Utilities.getUuid();
    sbCall_('createSS', { id: id, name: name });
    sbCall_('ensureSheet', { ss: id, sheet: 'Sheet1' });
    RS_.data[id] = { 'Sheet1': [] };
    RS_.at[id] = Date.now();
    RS_.list = null;
    return new RSpreadsheet_(id);
  },
  flush: function () {},
  getUi: SBUi_.getUi,
  newDataValidation: SBUi_.newDataValidation
};

/* RFile / RSSFile / RFolder — remote फ़ाइलें (Supabase Storage) */
function RFile_(rec) { this.rec = rec || {}; }
RFile_.prototype.getId = function () { return this.rec.id; };
RFile_.prototype.getName = function () { return this.rec.name || ''; };
RFile_.prototype.getUrl = function () { return this.rec.url || ''; };
RFile_.prototype.setName = function (name) {
  sbCall_('renameFile', { id: this.rec.id, name: name });
  this.rec.name = name;
  return this;
};
RFile_.prototype.setTrashed = function (flag) {
  if (flag) sbCall_('deleteFile', { id: this.rec.id });
  return this;
};
RFile_.prototype.setSharing = function () { return this; };
RFile_.prototype.moveTo = function () { return this; };
RFile_.prototype.makeCopy = function (name, folder) {
  var r = sbCall_('copyFile', { id: this.rec.id, name: name, folder: folder ? folder.path : undefined });
  return new RFile_(r);
};
RFile_.prototype.getLastUpdated = function () { return new Date(this.rec.created || Date.now()); };
RFile_.prototype.getBlob = function () { throw new Error('cloud mode में getBlob उपलब्ध नहीं'); };

function RSSFile_(entry) { this.e = entry; }
RSSFile_.prototype.getId = function () { return this.e.id; };
RSSFile_.prototype.getName = function () { return this.e.name; };
RSSFile_.prototype.getUrl = function () { return ''; };
RSSFile_.prototype.setName = function (name) {
  sbCall_('renameSS', { id: this.e.id, name: name });
  this.e.name = name;
  RS_.list = null;
  return this;
};
RSSFile_.prototype.setTrashed = function (flag) {
  if (flag) {
    sbCall_('deleteSS', { id: this.e.id });
    delete RS_.data[this.e.id];
    RS_.list = null;
  }
  return this;
};
RSSFile_.prototype.setSharing = function () { return this; };
RSSFile_.prototype.moveTo = function () { return this; };
RSSFile_.prototype.getLastUpdated = function () {
  return this.e.updated ? new Date(String(this.e.updated).replace(' ', 'T')) : new Date();
};

function RFolder_(path) { this.path = String(path || ''); }
RFolder_.prototype = Object.create(SBFolder_.prototype);
RFolder_.prototype.constructor = RFolder_;
RFolder_.prototype.createFolder = function (name) {
  return new RFolder_(this.path ? this.path + '/' + name : String(name));
};
RFolder_.prototype.getFoldersByName = function (name) {
  var f = this.createFolder(name), done = false;
  return { hasNext: function () { return !done; }, next: function () { done = true; return f; } };
};
RFolder_.prototype.createFile = function (blob) {
  var r = sbCall_('upload', {
    name: blob.getName() || 'file',
    mime: blob.getContentType() || 'application/octet-stream',
    base64: Utilities.base64Encode(blob.getBytes()),
    folder: this.path
  });
  return new RFile_(r);
};
RFolder_.prototype.getFilesByType = function () {
  var list = rsList_(true).filter(function (s) { return s.id !== 'main'; });
  var i = 0;
  return { hasNext: function () { return i < list.length; }, next: function () { return new RSSFile_(list[i++]); } };
};
RFolder_.prototype.getFilesByName = function (name) {
  var rows = (sbCall_('listFolder', { folder: this.path }) || []).filter(function (f) { return f.name === name; });
  var i = 0;
  return { hasNext: function () { return i < rows.length; }, next: function () { return new RFile_(rows[i++]); } };
};
RFolder_.prototype.getFiles = function () {
  var rows = sbCall_('listFolder', { folder: this.path }) || [];
  var i = 0;
  return { hasNext: function () { return i < rows.length; }, next: function () { return new RFile_(rows[i++]); } };
};

var RSBDrive = {
  Access: SBDrive.Access,
  Permission: SBDrive.Permission,
  getRootFolder: function () { return new RFolder_(''); },
  getFolderById: function (id) { return new RFolder_(id === 'root' ? '' : String(id || '')); },
  createFolder: function (name) { return new RFolder_(String(name)); },
  getFileById: function (id) {
    id = String(id || '').trim();
    var e = rsHas_(id);
    if (e) return new RSSFile_(e);
    var r = sbCall_('fileRecord', { id: id });
    if (r && r.id) return new RFile_(r);
    throw new Error('फ़ाइल नहीं मिली: ' + id);
  }
};

function rsFileRecord_(id) {
  try { return sbCall_('fileRecord', { id: String(id) }); } catch (e) { return null; }
}
function rsFolderList_(path) {
  try { return sbCall_('listFolder', { folder: String(path || '') }) || []; } catch (e) { return []; }
}

/* ── cloud patch — Code.gs load होने के बाद boot इसे चलाता है ── */

function __cloudPatch() {
  if (!SB_CLOUD) return;

  SBApp = RSBApp;
  SBDrive = RSBDrive;
  localFileRecord = rsFileRecord_;
  localFolderList = rsFolderList_;

  /* login/session अब server-side (Netlify Function) — passwords code में नहीं */
  validateLogin = function (username, password) {
    var x = new XMLHttpRequest();
    x.open('POST', window.__BASE__ + '/api/db', false);
    x.setRequestHeader('Content-Type', 'application/json');
    try { x.send(JSON.stringify({ op: 'login', args: { user: username, pass: password } })); }
    catch (e) { return { success: false, message: 'Server से संपर्क नहीं हो पाया' }; }
    var r = null;
    try { r = JSON.parse(x.responseText); } catch (e) {}
    if (!r || r.ok !== true) return { success: false, message: (r && r.error) || 'Server त्रुटि' };
    if (r.result && r.result.success) {
      SB_TOKEN = r.result.token;
      __CU = String(username || '').toLowerCase().trim();   // ownership scoping
      __ROLE = String(r.result.role || '');                 // admin-guard
      try { localStorage.setItem('rms_cloud_token', SB_TOKEN); } catch (e) {}
      try { __initLocal(); } catch (e) {}
    }
    return r.result;
  };

  validateSession = function (token) {
    if (!token) return { valid: false };
    var x = new XMLHttpRequest();
    x.open('POST', window.__BASE__ + '/api/db', false);
    x.setRequestHeader('Content-Type', 'application/json');
    try { x.send(JSON.stringify({ op: 'session', args: { token: token } })); }
    catch (e) { return { valid: false }; }
    var r = null;
    try { r = JSON.parse(x.responseText); } catch (e) {}
    if (!r || r.ok !== true) return { valid: false };
    if (r.result && r.result.valid) {
      SB_TOKEN = token;
      __CU = String(r.result.u || '').toLowerCase().trim();   // ownership scoping (session बहाल)
      __ROLE = String(r.result.role || '');                   // admin-guard (session बहाल)
      try { localStorage.setItem('rms_cloud_token', token); } catch (e) {}
      try { __initLocal(); } catch (e) {}
    }
    return r.result;
  };

  /* Admin: user-प्रबंधन — server-side (Supabase app_users टेबल) */
  adminListUsers = function () {
    try { return sbCall_('userList') || []; } catch (e) { return []; }
  };
  adminCreateUser = function (a) {
    try { sbCall_('userCreate', a || {}); return { success: true }; }
    catch (e) { return { success: false, msg: String(e.message || e) }; }
  };
  adminUpdateUser = function (a) {
    try { sbCall_('userUpdate', a || {}); return { success: true }; }
    catch (e) { return { success: false, msg: String(e.message || e) }; }
  };
  // Phase 3 sharing — share-picker के लिए users की सूची (Supabase से)
  listShareTargets = function () {
    try { return sbCall_('userTargets') || []; } catch (e) { return []; }
  };
  adminSetPassword = function (a) {
    try { sbCall_('userSetPassword', a || {}); return { success: true }; }
    catch (e) { return { success: false, msg: String(e.message || e) }; }
  };
  adminSetActive = function (a) {
    try { sbCall_('userSetActive', a || {}); return { success: true }; }
    catch (e) { return { success: false, msg: String(e.message || e) }; }
  };
  adminDeleteUser = function (a) {
    try { sbCall_('userDelete', a || {}); return { success: true }; }
    catch (e) { return { success: false, msg: String(e.message || e) }; }
  };

  Logger.log('[Cloud] Supabase mode ON');
}

/* पहली बार — sample sheets seed करें (दोनों modes) */
function __initLocal() {
  try {
    if (SB_CLOUD) {
      /* seed के writes के लिए token चाहिए — login/session के बाद ही चलता है */
      if (!SB_TOKEN) return;
      var d = sbCall_('loadAll', { ss: 'main' }) || {};
      if (Object.keys(d).length === 0 && typeof setupSheets === 'function') {
        setupSheets();
        delete RS_.data.main;
        Logger.log('[Cloud] पहली बार setup — sample data बन गया');
      }
      return;
    }
    var main = LocalDB.db().ss.main;
    if (main && Object.keys(main.sheets).length === 0 && typeof setupSheets === 'function') {
      setupSheets();
      Logger.log('[Local] पहली बार setup — sample data बन गया');
    }
  } catch (e) { console.error('init:', e); }
}
