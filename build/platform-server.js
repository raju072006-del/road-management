/* ═══════════════════════════════════════════════════════════════
   LOCAL PLATFORM — server frame के अंदर चलता है
   Google Apps Script services के browser-polyfills +
   localStorage-backed database (SBApp/SBDrive)
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
  fetch: function () { throw new Error('Local mode में bाहरी network call उपलब्ध नहीं है'); }
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
    put: function (k, v, ttl) { mem[k] = { v: String(v), exp: Date.now() + (ttl || 600) * 1000 }; },
    remove: function (k) { delete mem[k]; },
    removeAll: function (keys) { (keys || []).forEach(function (k) { delete mem[k]; }); }
  };
  return { getScriptCache: function () { return api; }, getUserCache: function () { return api; } };
})();

/* ── LocalDB — localStorage persistence ───────────────────────── */

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

function sbVal_(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    var dd = ('0' + v.getDate()).slice(-2), mm = ('0' + (v.getMonth() + 1)).slice(-2);
    return dd + '/' + mm + '/' + v.getFullYear();
  }
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  return String(v);
}

/* ── SBRange / SBSheet / SBSpreadsheet ────────────────────────── */

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
  var rows = this.sh._rows();
  for (var r = 0; r < vals.length; r++) {
    var idx = this.row - 1 + r;
    while (rows.length <= idx) rows.push([]);
    var line = rows[idx];
    for (var c = 0; c < vals[r].length; c++) {
      while (line.length < this.col - 1 + c) line.push('');
      line[this.col - 1 + c] = sbVal_(vals[r][c]);
    }
  }
  LocalDB.touch(this.sh.ss.id); LocalDB.save();
  return this;
};
SBRange_.prototype.setValue = function (v) { return this.setValues([[v]]); };
SBRange_.prototype.clearContent = function () {
  var rows = this.sh._rows();
  for (var r = 0; r < this.nrows; r++) {
    var line = rows[this.row - 1 + r];
    if (!line) continue;
    for (var c = 0; c < this.ncols; c++) {
      if (line.length > this.col - 1 + c) line[this.col - 1 + c] = '';
    }
  }
  LocalDB.touch(this.sh.ss.id); LocalDB.save();
  return this;
};
['setBackground','setFontColor','setFontWeight','setFontSize','setNumberFormat',
 'setHorizontalAlignment','setVerticalAlignment','setWrap','setBorder',
 'setDataValidation','setFontStyle','setFontFamily','merge','setNote'
].forEach(function (m) { SBRange_.prototype[m] = function () { return this; }; });

function SBSheet_(ss, name) { this.ss = ss; this.name = name; }
SBSheet_.prototype._rows = function () {
  var s = LocalDB.db().ss[this.ss.id];
  if (!s.sheets[this.name]) s.sheets[this.name] = [];
  return s.sheets[this.name];
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

/* ── SBDrive — फ़ाइलें localStorage में (base64) ───────────────── */

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

/* ── parent (boot) के लिए helpers ─────────────────────────────── */

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

/* पहली बार — sample sheets seed करें */
function __initLocal() {
  try {
    var main = LocalDB.db().ss.main;
    if (main && Object.keys(main.sheets).length === 0 && typeof setupSheets === 'function') {
      setupSheets();
      Logger.log('[Local] पहली बार setup — sample data बन गया');
    }
  } catch (e) { console.error('initLocal:', e); }
}
