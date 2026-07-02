/**
 * ═══════════════════════════════════════════════════════════════
 *  SupabaseDB.gs — Supabase Data Layer (SpreadsheetApp/DriveApp का विकल्प)
 * ═══════════════════════════════════════════════════════════════
 *
 *  सारा डेटा Supabase (PostgreSQL + JSONB) में रहता है:
 *    • SBApp   → SpreadsheetApp जैसा ही API, पर rows Supabase में
 *    • SBDrive → DriveApp जैसा API, पर फ़ाइलें Supabase Storage में
 *
 *  SETUP (Script Properties — Project Settings → Script Properties):
 *    SUPABASE_URL         = https://xxxx.supabase.co
 *    SUPABASE_SERVICE_KEY = (service_role secret key)
 *
 *  पहले supabase_schema.sql चलाएँ और 'rms-files' नाम का PUBLIC
 *  Storage bucket बनाएँ। विस्तृत निर्देश: SETUP_SUPABASE.md
 * ═══════════════════════════════════════════════════════════════
 */

var SB_BUCKET  = 'rms-files';
var SB_MAIN_ID = 'main';   // मुख्य वर्कबुक (Dashboard के सभी sheets)

// ── Config ──────────────────────────────────────────────────────
function sbConf_() {
  var p = PropertiesService.getScriptProperties();
  var url = (p.getProperty('SUPABASE_URL') || '').replace(/\/+$/, '');
  var key = p.getProperty('SUPABASE_SERVICE_KEY') || '';
  if (!url || !key) {
    throw new Error('Supabase सेट नहीं है — Apps Script के Project Settings → Script Properties में SUPABASE_URL और SUPABASE_SERVICE_KEY जोड़ें (देखें SETUP_SUPABASE.md)');
  }
  return { url: url, key: key };
}

// एक बार सेट करने के लिए helper — Apps Script editor से चलाएँ:
function setupSupabaseCredentials() {
  var p = PropertiesService.getScriptProperties();
  // ▼▼ अपनी values भरकर एक बार Run करें ▼▼
  // p.setProperty('SUPABASE_URL', 'https://xxxx.supabase.co');
  // p.setProperty('SUPABASE_SERVICE_KEY', 'eyJ....');
  Logger.log('SUPABASE_URL = ' + p.getProperty('SUPABASE_URL'));
}

// ── HTTP core ───────────────────────────────────────────────────
function sbRpc_(fn, params) {
  var c = sbConf_();
  var res = UrlFetchApp.fetch(c.url + '/rest/v1/rpc/' + fn, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'apikey': c.key, 'Authorization': 'Bearer ' + c.key },
    payload: JSON.stringify(params || {}),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  var body = res.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error('Supabase RPC ' + fn + ' विफल (' + code + '): ' + body);
  }
  if (!body || body === '' ) return null;
  try { return JSON.parse(body); } catch (e) { return body; }
}

function sbStoragePath_(segments) {
  return segments.map(function(s){ return encodeURIComponent(s); }).join('/');
}

function sbUpload_(pathSegs, bytes, mime) {
  var c = sbConf_();
  var res = UrlFetchApp.fetch(c.url + '/storage/v1/object/' + SB_BUCKET + '/' + sbStoragePath_(pathSegs), {
    method: 'post',
    headers: { 'apikey': c.key, 'Authorization': 'Bearer ' + c.key, 'x-upsert': 'true' },
    payload: Utilities.newBlob(bytes, mime || 'application/octet-stream'),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('Storage upload विफल: ' + res.getContentText());
  }
}

function sbStorageDelete_(path) {
  var c = sbConf_();
  UrlFetchApp.fetch(c.url + '/storage/v1/object/' + SB_BUCKET + '/' +
      path.split('/').map(encodeURIComponent).join('/'), {
    method: 'delete',
    headers: { 'apikey': c.key, 'Authorization': 'Bearer ' + c.key },
    muteHttpExceptions: true
  });
}

function sbStorageCopy_(srcPath, dstPath) {
  var c = sbConf_();
  var res = UrlFetchApp.fetch(c.url + '/storage/v1/object/copy', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'apikey': c.key, 'Authorization': 'Bearer ' + c.key },
    payload: JSON.stringify({ bucketId: SB_BUCKET, sourceKey: srcPath, destinationKey: dstPath }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('Storage copy विफल: ' + res.getContentText());
  }
}

function sbPublicUrl_(path) {
  var c = sbConf_();
  return c.url + '/storage/v1/object/public/' + SB_BUCKET + '/' +
    path.split('/').map(encodeURIComponent).join('/');
}

// ── per-execution memory cache (एक HTTP call प्रति वर्कबुक) ─────
var SB_MEM_ = { data: {}, ssList: null };

function sbLoadSS_(ssId) {
  if (!SB_MEM_.data[ssId]) {
    SB_MEM_.data[ssId] = sbRpc_('ss_get_all', { p_ss: ssId }) || {};
  }
  return SB_MEM_.data[ssId];
}

function sbListSS_(force) {
  if (force || !SB_MEM_.ssList) {
    SB_MEM_.ssList = sbRpc_('ss_list_spreadsheets', {}) || [];
  }
  return SB_MEM_.ssList;
}

// value sanitize — JSON में Date नहीं जा सकता
function sbVal_(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    var dd = ('0' + v.getDate()).slice(-2), mm = ('0' + (v.getMonth() + 1)).slice(-2);
    return dd + '/' + mm + '/' + v.getFullYear();
  }
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  return String(v);
}

// ═════════════════════════════════════════════════════════════
//  SBRange — GAS Range जैसा
// ═════════════════════════════════════════════════════════════
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
  return this.getValues().map(function(r){ return r.map(function(v){ return String(v); }); });
};
SBRange_.prototype.setValues = function (vals) {
  var clean = vals.map(function(r){ return r.map(sbVal_); });
  sbRpc_('ss_set_cells', {
    p_ss: this.sh.ss.id, p_sheet: this.sh.name,
    p_row: this.row, p_col: this.col, p_values: clean
  });
  // local cache sync
  var rows = this.sh._rows();
  for (var r = 0; r < clean.length; r++) {
    var idx = this.row - 1 + r;
    while (rows.length <= idx) rows.push([]);
    var line = rows[idx];
    for (var c = 0; c < clean[r].length; c++) {
      while (line.length < this.col - 1 + c) line.push('');
      line[this.col - 1 + c] = clean[r][c];
    }
  }
  return this;
};
SBRange_.prototype.setValue = function (v) { return this.setValues([[v]]); };
SBRange_.prototype.clearContent = function () {
  sbRpc_('ss_clear_range', {
    p_ss: this.sh.ss.id, p_sheet: this.sh.name,
    p_row: this.row, p_col: this.col, p_nrows: this.nrows, p_ncols: this.ncols
  });
  var rows = this.sh._rows();
  for (var r = 0; r < this.nrows; r++) {
    var line = rows[this.row - 1 + r];
    if (!line) continue;
    for (var c = 0; c < this.ncols; c++) {
      if (line.length > this.col - 1 + c) line[this.col - 1 + c] = '';
    }
  }
  return this;
};
// styling — Supabase में लागू नहीं; chainable no-op
['setBackground','setFontColor','setFontWeight','setFontSize','setNumberFormat',
 'setHorizontalAlignment','setVerticalAlignment','setWrap','setBorder',
 'setDataValidation','setFontStyle','setFontFamily','merge','setNote'
].forEach(function (m) { SBRange_.prototype[m] = function(){ return this; }; });

// ═════════════════════════════════════════════════════════════
//  SBSheet — GAS Sheet जैसा
// ═════════════════════════════════════════════════════════════
function SBSheet_(ss, name) { this.ss = ss; this.name = name; }
SBSheet_.prototype._rows = function () {
  var data = sbLoadSS_(this.ss.id);
  if (!data[this.name]) data[this.name] = [];
  return data[this.name];
};
SBSheet_.prototype.getName = function () { return this.name; };
SBSheet_.prototype.setName = function (newName) {
  sbRpc_('ss_rename_sheet', { p_ss: this.ss.id, p_old: this.name, p_new: newName });
  var data = sbLoadSS_(this.ss.id);
  data[newName] = data[this.name] || [];
  delete data[this.name];
  this.name = newName;
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
  var clean = arr.map(sbVal_);
  sbRpc_('ss_append_row', { p_ss: this.ss.id, p_sheet: this.name, p_cells: clean });
  this._rows().push(clean);
  return this;
};
SBSheet_.prototype.deleteRow = function (rowIdx) {
  sbRpc_('ss_delete_row', { p_ss: this.ss.id, p_sheet: this.name, p_row: rowIdx });
  var rows = this._rows();
  if (rowIdx >= 1 && rowIdx <= rows.length) rows.splice(rowIdx - 1, 1);
  return this;
};
SBSheet_.prototype.clearContents = function () {
  var lr = this.getLastRow(), lc = this.getLastColumn();
  if (lr > 0 && lc > 0) this.getRange(1, 1, lr, lc).clearContent();
  return this;
};
// layout/styling no-ops
['setFrozenRows','setFrozenColumns','setRowHeight','setColumnWidth',
 'autoResizeColumns','autoResizeColumn','setTabColor','showSheet','hideSheet'
].forEach(function (m) { SBSheet_.prototype[m] = function(){ return this; }; });

// ═════════════════════════════════════════════════════════════
//  SBSpreadsheet — GAS Spreadsheet जैसा
// ═════════════════════════════════════════════════════════════
function SBSpreadsheet_(id, name) { this.id = id; this._name = name || id; }
SBSpreadsheet_.prototype.getId = function () { return this.id; };
SBSpreadsheet_.prototype.getName = function () {
  var list = sbListSS_();
  for (var i = 0; i < list.length; i++) if (list[i].id === this.id) return list[i].name;
  return this._name;
};
SBSpreadsheet_.prototype.getUrl = function () { return ''; };
SBSpreadsheet_.prototype.getSheetByName = function (name) {
  var data = sbLoadSS_(this.id);
  return data.hasOwnProperty(name) ? new SBSheet_(this, name) : null;
};
SBSpreadsheet_.prototype.insertSheet = function (name) {
  name = name || ('Sheet' + (Object.keys(sbLoadSS_(this.id)).length + 1));
  sbRpc_('ss_ensure_sheet', { p_ss: this.id, p_sheet: name });
  var data = sbLoadSS_(this.id);
  if (!data[name]) data[name] = [];
  return new SBSheet_(this, name);
};
SBSpreadsheet_.prototype.getSheets = function () {
  var data = sbLoadSS_(this.id), self = this;
  return Object.keys(data).map(function (n) { return new SBSheet_(self, n); });
};
SBSpreadsheet_.prototype.deleteSheet = function (sheet) {
  sbRpc_('ss_delete_sheet', { p_ss: this.id, p_sheet: sheet.getName() });
  delete sbLoadSS_(this.id)[sheet.getName()];
  return this;
};
SBSpreadsheet_.prototype.rename = function (name) {
  sbRpc_('ss_rename_spreadsheet', { p_id: this.id, p_name: name });
  this._name = name; SB_MEM_.ssList = null;
  return this;
};

// ═════════════════════════════════════════════════════════════
//  SBApp — SpreadsheetApp का विकल्प
// ═════════════════════════════════════════════════════════════
var SBApp = {
  getActiveSpreadsheet: function () {
    return new SBSpreadsheet_(SB_MAIN_ID, 'Road Management System');
  },
  openById: function (id) {
    return new SBSpreadsheet_(String(id));
  },
  create: function (name) {
    var id = Utilities.getUuid();
    sbRpc_('ss_create_spreadsheet', { p_id: id, p_name: name });
    sbRpc_('ss_ensure_sheet', { p_ss: id, p_sheet: 'Sheet1' });
    SB_MEM_.ssList = null;
    SB_MEM_.data[id] = { 'Sheet1': [] };
    return new SBSpreadsheet_(id, name);
  },
  flush: function () { /* Supabase writes तुरंत होते हैं */ },
  getUi: function () {
    var chain = { addItem: function(){ return chain; }, addSeparator: function(){ return chain; }, addToUi: function(){} };
    return {
      alert: function (a, b, c) { Logger.log('[UI] ' + [a, b].filter(String).join(' — ')); return 'OK'; },
      createMenu: function () { return chain; },
      showModalDialog: function () {},
      showSidebar: function () {},
      ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL', YES_NO: 'YES_NO' },
      Button: { OK: 'OK', CANCEL: 'CANCEL', YES: 'YES', NO: 'NO' }
    };
  },
  newDataValidation: function () {
    var b = {
      requireValueInList: function(){ return b; },
      setAllowInvalid:    function(){ return b; },
      build:              function(){ return {}; }
    };
    return b;
  }
};

// ═════════════════════════════════════════════════════════════
//  SBDrive — DriveApp का विकल्प (फ़ाइलें Supabase Storage में)
// ═════════════════════════════════════════════════════════════

// Storage-file wrapper — id = uuid (files table)
function SBFile_(rec) { this.rec = rec; }
SBFile_.prototype.getId   = function () { return this.rec.id; };
SBFile_.prototype.getName = function () { return this.rec.name; };
SBFile_.prototype.getUrl  = function () { return sbPublicUrl_(this.rec.path); };
SBFile_.prototype.setName = function (name) {
  sbRpc_('ss_rename_file', { p_id: this.rec.id, p_name: name });
  this.rec.name = name; return this;
};
SBFile_.prototype.setTrashed = function (flag) {
  if (flag) {
    var path = sbRpc_('ss_delete_file', { p_id: this.rec.id });
    if (path) sbStorageDelete_(path);
  }
  return this;
};
SBFile_.prototype.setSharing = function () { return this; };
SBFile_.prototype.moveTo = function (folder) {
  if (folder && folder.path !== undefined) this.rec.folder = folder.path;
  return this;
};
SBFile_.prototype.makeCopy = function (name, folder) {
  var id = Utilities.getUuid();
  var dstPath = 'f/' + id + '/' + String(name).replace(/[\/\\]/g, '_');
  sbStorageCopy_(this.rec.path, dstPath);
  sbRpc_('ss_register_file', {
    p_id: id, p_path: dstPath, p_name: name,
    p_folder: folder ? folder.path : this.rec.folder,
    p_mime: this.rec.mime || '', p_size: this.rec.size || 0
  });
  return new SBFile_({ id: id, path: dstPath, name: name, folder: folder ? folder.path : '', mime: this.rec.mime });
};
SBFile_.prototype.getLastUpdated = function () { return new Date(this.rec.created_at || Date.now()); };

// Payment "स्प्रेडशीट-फ़ाइल" wrapper (Drive-file जैसा व्यवहार)
function SBSSFile_(entry) { this.e = entry; }
SBSSFile_.prototype.getId   = function () { return this.e.id; };
SBSSFile_.prototype.getName = function () { return this.e.name; };
SBSSFile_.prototype.getUrl  = function () { return ''; };
SBSSFile_.prototype.setName = function (name) {
  sbRpc_('ss_rename_spreadsheet', { p_id: this.e.id, p_name: name });
  this.e.name = name; SB_MEM_.ssList = null; return this;
};
SBSSFile_.prototype.setTrashed = function (flag) {
  if (flag) { sbRpc_('ss_delete_spreadsheet', { p_id: this.e.id }); SB_MEM_.ssList = null; delete SB_MEM_.data[this.e.id]; }
  return this;
};
SBSSFile_.prototype.setSharing = function () { return this; };
SBSSFile_.prototype.moveTo = function () { return this; };
SBSSFile_.prototype.getLastUpdated = function () {
  return this.e.updated ? new Date(this.e.updated.replace(' ', 'T')) : new Date();
};

// आभासी folder — path सिर्फ़ files.folder metadata के लिए
function SBFolder_(path) { this.path = String(path || ''); }
SBFolder_.prototype.getId   = function () { return this.path || 'root'; };
SBFolder_.prototype.getName = function () {
  var parts = this.path.split('/'); return parts[parts.length - 1] || 'Root';
};
SBFolder_.prototype.getUrl  = function () {
  // वेब-ऐप का अपना folder-viewer page (doGet में page=files handler)
  try { return ScriptApp.getService().getUrl() + '?page=files&folder=' + encodeURIComponent(this.path); }
  catch (e) { return ''; }
};
SBFolder_.prototype.createFolder = function (name) {
  return new SBFolder_(this.path ? this.path + '/' + name : String(name));
};
SBFolder_.prototype.getFoldersByName = function (name) {
  // आभासी folders हमेशा "मौजूद" — getOrCreateFolder_ pattern के लिए
  var f = this.createFolder(name), done = false;
  return { hasNext: function(){ return !done; }, next: function(){ done = true; return f; } };
};
SBFolder_.prototype.createFile = function (blob) {
  var id    = Utilities.getUuid();
  var name  = blob.getName() || 'file';
  var mime  = blob.getContentType() || 'application/octet-stream';
  var bytes = blob.getBytes();
  var safe  = String(name).replace(/[\/\\#?%]/g, '_');
  var path  = 'f/' + id + '/' + safe;
  sbUpload_([ 'f', id, safe ], bytes, mime);
  sbRpc_('ss_register_file', { p_id: id, p_path: path, p_name: name, p_folder: this.path, p_mime: mime, p_size: bytes.length });
  return new SBFile_({ id: id, path: path, name: name, folder: this.path, mime: mime, size: bytes.length });
};
SBFolder_.prototype.getFilesByType = function () {
  // Payment module: folder की स्प्रेडशीट-सूची = spreadsheets table ('main' छोड़कर)
  var list = sbListSS_(true).filter(function (s) { return s.id !== SB_MAIN_ID; });
  var i = 0;
  return { hasNext: function(){ return i < list.length; }, next: function(){ return new SBSSFile_(list[i++]); } };
};
SBFolder_.prototype.getFilesByName = function (name) {
  var rows = sbFilesInFolder_(this.path).filter(function (f) { return f.name === name; });
  var i = 0;
  return { hasNext: function(){ return i < rows.length; }, next: function(){ return new SBFile_(rows[i++]); } };
};
SBFolder_.prototype.getFiles = function () {
  var rows = sbFilesInFolder_(this.path), i = 0;
  return { hasNext: function(){ return i < rows.length; }, next: function(){ return new SBFile_(rows[i++]); } };
};
SBFolder_.prototype.setTrashed = function () { return this; };
SBFolder_.prototype.setSharing = function () { return this; };

function sbFilesInFolder_(folder) {
  var c = sbConf_();
  var res = UrlFetchApp.fetch(c.url + '/rest/v1/files?folder=eq.' + encodeURIComponent(folder) + '&order=created_at.desc', {
    headers: { 'apikey': c.key, 'Authorization': 'Bearer ' + c.key },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) return [];
  try { return JSON.parse(res.getContentText()) || []; } catch (e) { return []; }
}

var SBDrive = {
  Access:     { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK', ANYONE: 'ANYONE', PRIVATE: 'PRIVATE' },
  Permission: { VIEW: 'VIEW', EDIT: 'EDIT' },
  getRootFolder: function () { return new SBFolder_(''); },
  getFolderById: function (id) {
    if (id === 'root') return new SBFolder_('');
    return new SBFolder_(String(id || ''));
  },
  createFolder: function (name) { return new SBFolder_(String(name)); },
  getFileById: function (id) {
    id = String(id || '').trim();
    // पहले spreadsheets में देखें (payment परियोजनाएँ)
    var list = sbListSS_();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return new SBSSFile_(list[i]);
    }
    // फिर files table (uuid)
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      var rec = sbRpc_('ss_file_by_id', { p_id: id });
      if (rec && rec.id) return new SBFile_(rec);
    }
    throw new Error('फ़ाइल नहीं मिली: ' + id);
  }
};

// ── वेब-ऐप folder-viewer (doGet से बुलाया जाता है) ──────────────
function sbFolderViewerHtml_(folderPath) {
  var files = sbFilesInFolder_(folderPath);
  var rows = files.map(function (f) {
    return '<a class="fi" href="' + sbPublicUrl_(f.path) + '" target="_blank" rel="noopener">' +
      '<span class="ic">📄</span><span class="nm">' + String(f.name).replace(/</g, '&lt;') + '</span>' +
      '<span class="dt">' + String(f.created_at || '').slice(0, 10) + '</span></a>';
  }).join('');
  var esc = String(folderPath).replace(/</g, '&lt;');
  return '<!DOCTYPE html><html lang="hi"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>फ़ाइलें — ' + esc + '</title>' +
    '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+Devanagari:wght@400;500;600;700&display=swap" rel="stylesheet">' +
    '<style>body{margin:0;background:#f2f4fa;font-family:Inter,"Noto Sans Devanagari",sans-serif;color:#222b45;padding:32px 16px}' +
    '.wrap{max-width:680px;margin:0 auto}' +
    'h1{font-size:17px;font-weight:700;margin:0 0 4px}' +
    '.sub{font-size:12.5px;color:#6b7a99;margin-bottom:20px;word-break:break-all}' +
    '.card{background:#fff;border:1px solid #e3e8f0;border-radius:14px;box-shadow:0 1px 2px rgba(19,26,46,.05),0 8px 24px -12px rgba(19,26,46,.12);overflow:hidden}' +
    '.fi{display:flex;align-items:center;gap:12px;padding:13px 18px;text-decoration:none;color:#222b45;border-bottom:1px solid #eef1f7;transition:background .15s cubic-bezier(.4,0,.2,1)}' +
    '.fi:last-child{border-bottom:none}.fi:hover{background:#f5f7fd}' +
    '.ic{font-size:18px}.nm{flex:1;font-size:13.5px;font-weight:500}.dt{font-size:11.5px;color:#8a94ad;font-family:"Roboto Mono",monospace}' +
    '.empty{padding:40px;text-align:center;color:#8a94ad;font-size:13px}</style></head>' +
    '<body><div class="wrap"><h1>📁 ' + (esc.split('/').pop() || 'फ़ाइलें') + '</h1>' +
    '<div class="sub">' + esc + '</div><div class="card">' +
    (rows || '<div class="empty">इस फ़ोल्डर में कोई फ़ाइल नहीं है</div>') +
    '</div></div></body></html>';
}
