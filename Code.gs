// DEPLOY: 2026-06-17T23:12
/**
 * ═══════════════════════════════════════════════════════════
 *  सड़क परियोजना प्रबंधन प्रणाली — Backend Logic (Code.gs)
 * ═══════════════════════════════════════════════════════════
 *
 *  यह फ़ाइल build के समय "Road Management.html" में embed होती है
 *  और browser के छिपे हुए server-frame में चलती है।
 *  Data-layer (SBApp/SBDrive) build\platform-server.js देता है:
 *    • LOCAL mode — localStorage (PC पर file से खोलने पर)
 *    • CLOUD mode — Netlify Function (/api/db) → Supabase
 *
 *  बदलाव के बाद: test.bat (local जाँच) → push.bat (online)
 *  Cloud setup: CLOUD-SETUP.md देखें।
 * ═══════════════════════════════════════════════════════════
 */

// ── Web App Entry Point ─────────────────────────────────────
function doGet(e) {
  const page = (e && e.parameter && e.parameter.page) || '';
  if (page === 'files') {
    // Supabase Storage folder-viewer (दस्तावेज़/फोटो folders के लिए)
    return HtmlService.createHtmlOutput(sbFolderViewerHtml_((e.parameter.folder || '')))
      .setTitle('फ़ाइलें')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
  if (page === 'payment') {
    return HtmlService.createHtmlOutputFromFile('Payment')
      .setTitle('परियोजना भुगतान प्रबंधन')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
  var buildTs = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'dd-MM-yyyy HH:mm:ss');
  var html = HtmlService.createHtmlOutputFromFile('Dashboard').getContent();
  html = html.replace('</head>',
    '<script>window._BUILD_TS="' + buildTs + '";<\/script>' +
    '<meta http-equiv="Cache-Control" content="no-cache,no-store,must-revalidate">' +
    '<meta http-equiv="Pragma" content="no-cache">' +
    '<meta http-equiv="Expires" content="0"></head>');
  return HtmlService.createHtmlOutput(html)
    .setTitle('सड़क परियोजना प्रबंधन प्रणाली')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function getWebAppUrl() {
  return ScriptApp.getService().getUrl();
}

function getPaymentPageHtml() {
  var html = HtmlService.createHtmlOutputFromFile('Payment').getContent();
  // GAS-injected build timestamp forces cache revalidation
  var buildTs = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'dd-MM-yyyy HH:mm');
  html = html.replace('</head>', '<script>window._PAY_BUILD="' + buildTs + '";<\/script></head>');
  try {
    var ss = SBApp.getActiveSpreadsheet();
    var rows = sheetToObjects_(ss, '3_Projects');
    var projects = (rows || []).filter(function(r){ return r.Project_ID; }).map(function(r){
      return {
        id:     r.Project_ID,
        name:   r.Project_Name || r['Project_Name\n(कार्य का नाम)'] || '',
        status: r.Status || ''
      };
    });
    var tag = '<script>window._DASH_PROJECTS=' + JSON.stringify(projects) + ';<\/script>';
    html = html.replace('</head>', tag + '</head>');
  } catch(e) {}
  return html;
}

// ── Authentication ───────────────────────────────────────────
// सुरक्षा: passwords code में plaintext नहीं — केवल SHA-256 hash।
// (यह सिर्फ़ LOCAL/file mode के लिए है; online CLOUD mode में login
//  Netlify server से होता है और passwords APP_USERS env में रहते हैं।)
// Super Admin — पहला/मुख्य admin: हटाया या निष्क्रिय नहीं किया जा सकता (सिर्फ़ नाम/password बदल सकता है)
const SUPER_ADMIN_ = 'Admin';   // डिफ़ॉल्ट id 'Admin' / password 'Admin@123' (case-sensitive)

// ── Ownership scoping (Phase 2) ──────────────────────────────
// वर्तमान लॉग-इन user (server-frame global) — login/session पर सेट होता है।
// हर user को सिर्फ़ अपना डेटा दिखे; owner-रहित (पुराना) डेटा Super Admin का माना जाता है।
var __CU = '';
var __ROLE = '';
function _owner_() { return __CU || SUPER_ADMIN_; }
function _isAdmin_() { return __ROLE === 'admin'; }
// साझा Master/reference डेटा सिर्फ़ Admin बदल सकता है; user केवल उपयोग करता है
function _adminOnlyGuard_() { return _isAdmin_() ? null : { success: false, msg: 'यह साझा Master/सूची डेटा केवल Admin बदल सकता है।' }; }
function _ownsRow_(row) { return String((row && row.Owner) || SUPER_ADMIN_) === _owner_(); }
// किसी नई पंक्ति (सबसे अंतिम) पर Owner कॉलम भर दो (कॉलम न हो तो बना दो)
function _stampOwnerLastRow_(sheet) {
  if (!sheet) return;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  var hdr = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
  var c = hdr.indexOf('Owner');
  if (c < 0) { c = hdr.length; sheet.getRange(1, c + 1).setValue('Owner'); }
  sheet.getRange(lastRow, c + 1).setValue(_owner_());
}
// Phase 3: वर्तमान user के साथ share किए गए resources (14_Shares शीट से)
function _sharedIds_(ss) {
  var me = _owner_(), roads = {}, projs = {};
  try {
    sheetToObjects_(ss, '14_Shares').forEach(function (s) {
      if (String(s.Shared_With || '').trim() !== me) return;
      if (s.Res_Type === 'road') roads[s.Res_ID] = 1;
      else if (s.Res_Type === 'project') projs[s.Res_ID] = 1;
    });
  } catch (e) {}
  return { roads: roads, projs: projs };
}
// किसी road/project को current user देख सकता है? — owner हो या share किया गया हो
function _canSeeRoad_(r, shared) { return _ownsRow_(r) || !!(shared && shared.roads[r.Road_ID]); }
function _canSeeProj_(p, shared) { return _ownsRow_(p) || !!(shared && shared.projs[p.Project_ID]); }

// share की स्थिति (remark दिखाने हेतु): mineTo[type:id]=[किन users को दिया], toMe[type:id]=मालिक
function _shareMaps_(ss) {
  var me = _owner_(), out = { mineTo: {}, toMe: {} };
  try {
    sheetToObjects_(ss, '14_Shares').forEach(function (s) {
      var key = s.Res_Type + ':' + s.Res_ID;
      if (String(s.Owner || '').trim() === me) (out.mineTo[key] = out.mineTo[key] || []).push(String(s.Shared_With));
      if (String(s.Shared_With || '').trim() === me) out.toMe[key] = String(s.Owner);
    });
  } catch (e) {}
  return out;
}
// row पर share-remark टैग: 'in:<मालिक>' (मुझसे साझा) | 'out:<users>' (मैंने साझा किया) | ''
function _shareTag_(type, id, maps) {
  var key = type + ':' + id;
  if (maps.toMe[key]) return 'in:' + maps.toMe[key];
  if (maps.mineTo[key] && maps.mineTo[key].length) return 'out:' + maps.mineTo[key].join(', ');
  return '';
}

// वर्तमान user को दिखने वाले Road_ID / Project_ID के सेट (owned + shared; children filter हेतु)
function _ownedSets_(ss) {
  var shared = _sharedIds_(ss);
  var roads = {}, projs = {};
  sheetToObjects_(ss, '1_Roads_Master').forEach(function (r) { if (_canSeeRoad_(r, shared) && r.Road_ID) roads[r.Road_ID] = 1; });
  sheetToObjects_(ss, '3_Projects').forEach(function (p) { if (_canSeeProj_(p, shared) && p.Project_ID) projs[p.Project_ID] = 1; });
  return { roads: roads, projs: projs };
}

// ── Phase 3: Sharing (road/project को दूसरे user के साथ view+edit) ──
function _ensureSharesSheet_(ss) {
  var sh = ss.getSheetByName('14_Shares');
  if (!sh) { sh = ss.insertSheet('14_Shares'); sh.appendRow(['Share_ID', 'Owner', 'Shared_With', 'Res_Type', 'Res_ID']); SBApp.flush(); }
  return sh;
}
function _currentUserOwnsResource_(ss, resType, resId) {
  var sheetName = resType === 'road' ? '1_Roads_Master' : '3_Projects';
  var idCol     = resType === 'road' ? 'Road_ID' : 'Project_ID';
  var row = sheetToObjects_(ss, sheetName).find(function (x) { return String(x[idCol]) === resId; });
  return !!(row && _ownsRow_(row));
}
// किन users के साथ share किया जा सकता है (self को छोड़कर सक्रिय users) — किसी भी logged-in user के लिए
function listShareTargets() {
  _seedLocalUsersIfNeeded_();
  var me = _owner_(), dyn = _localUsers_(), out = [];
  Object.keys(dyn).forEach(function (k) { if (k !== me && dyn[k].active !== false) out.push({ username: k, name: dyn[k].name || k }); });
  return out;
}
function shareResource(resType, resId, sharedWith) {
  resType = String(resType || '').trim(); resId = String(resId || '').trim(); sharedWith = String(sharedWith || '').trim();
  if (resType !== 'road' && resType !== 'project') return { success: false, msg: 'अमान्य resource' };
  if (!resId || !sharedWith) return { success: false, msg: 'अधूरी जानकारी' };
  if (sharedWith === _owner_()) return { success: false, msg: 'स्वयं को share नहीं कर सकते' };
  var ss = SBApp.getActiveSpreadsheet();
  if (!_isAdmin_() && !_currentUserOwnsResource_(ss, resType, resId)) return { success: false, msg: 'यह resource आपका नहीं है' };
  var sh = _ensureSharesSheet_(ss);
  var rows = sheetToObjects_(ss, '14_Shares');
  if (rows.some(function (r) { return r.Res_Type === resType && r.Res_ID === resId && String(r.Shared_With).trim() === sharedWith; })) return { success: true };
  sh.appendRow(['SHR' + Date.now().toString(36) + Math.floor(Math.random() * 1000), _owner_(), sharedWith, resType, resId]);
  SBApp.flush();
  CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
  return { success: true };
}
function unshareResource(resType, resId, sharedWith) {
  resType = String(resType || '').trim(); resId = String(resId || '').trim(); sharedWith = String(sharedWith || '').trim();
  var ss = SBApp.getActiveSpreadsheet();
  if (!_isAdmin_() && !_currentUserOwnsResource_(ss, resType, resId)) return { success: false, msg: 'यह resource आपका नहीं है' };
  var sh = ss.getSheetByName('14_Shares'); if (!sh) return { success: true };
  var vals = sh.getDataRange().getValues();
  var H = vals[0].map(function (h) { return String(h).trim(); });
  var tC = H.indexOf('Res_Type'), iC = H.indexOf('Res_ID'), wC = H.indexOf('Shared_With');
  for (var r = vals.length - 1; r >= 1; r--) {
    if (String(vals[r][tC]) === resType && String(vals[r][iC]) === resId && String(vals[r][wC]).trim() === sharedWith) sh.deleteRow(r + 1);
  }
  SBApp.flush();
  CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
  return { success: true };
}
function listSharesFor(resType, resId) {
  resType = String(resType || '').trim(); resId = String(resId || '').trim();
  var ss = SBApp.getActiveSpreadsheet();
  return sheetToObjects_(ss, '14_Shares')
    .filter(function (r) { return r.Res_Type === resType && r.Res_ID === resId; })
    .map(function (r) { return String(r.Shared_With); });
}
const USERS_ = {
  'Admin': { hash: 'e86f78a8a3caf0b60d8e74e5942aa6d86dc150cd3c03338aef25b7d2d7e3acc7', role: 'admin', name: 'Administrator' },   // Admin / Admin@123 (Super Admin)
  'user1': { hash: '1e9a6b9afd56cf274a1b46367cad2ff478fb6f0e29e5766195848b1482d2e2be', role: 'user',  name: 'User 1' },
  'user2': { hash: 'cd92953692442115e21ca8c5daefaffe2b3d8737769700667cb8ca864ae1e7c4', role: 'user',  name: 'User 2' },
  'user':  { hash: '3e7c19576488862816f13b512cacf3e4ba97dd97243ea0bd6a2ad1642d86ba72', role: 'user',  name: 'User' }   // User / User@123 — local mode
};

// LOCAL mode में Admin द्वारा बनाए dynamic users — PropertiesService में
// (CLOUD mode में ये सब __cloudPatch से Netlify/Supabase पर चले जाते हैं)
function _localUsers_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('app_users') || '{}') || {}; }
  catch (e) { return {}; }
}
function _saveLocalUsers_(m) {
  PropertiesService.getScriptProperties().setProperty('app_users', JSON.stringify(m || {}));
}
// पहली बार: built-in USERS_ को manageable store में एक बार copy करो — फिर सब edit/delete हो सकें।
// एक बार seed होने पर USERS_ auth में उपयोग नहीं होता (हटाया user वापस न आए)।
function _seedLocalUsersIfNeeded_() {
  var props = PropertiesService.getScriptProperties();
  var dyn = _localUsers_();
  var changed = false;
  // Super Admin हमेशा मौजूद रहे — flag की परवाह किए बिना (पुराने seed में छूट गया हो तो भी)
  if (!dyn[SUPER_ADMIN_] && USERS_[SUPER_ADMIN_]) {
    dyn[SUPER_ADMIN_] = { hash: USERS_[SUPER_ADMIN_].hash, role: 'admin', name: USERS_[SUPER_ADMIN_].name, active: true };
    changed = true;
  }
  // पहली बार — बाक़ी built-in users भी एक बार copy करो
  if (!props.getProperty('app_users_seeded')) {
    Object.keys(USERS_).forEach(function (k) {
      if (!dyn[k]) { dyn[k] = { hash: USERS_[k].hash, role: USERS_[k].role, name: USERS_[k].name, active: true }; changed = true; }
    });
    props.setProperty('app_users_seeded', '1');
  }
  if (changed) _saveLocalUsers_(dyn);
}
// कम-से-कम एक सक्रिय Admin ज़रूरी — क्या यह key वही आख़िरी admin है?
function _isLastActiveAdmin_(dyn, key) {
  var admins = Object.keys(dyn).filter(function (k) { return dyn[k].role === 'admin' && dyn[k].active !== false; });
  return admins.length <= 1 && admins.indexOf(key) >= 0;
}

function validateLogin(username, password) {
  var key = (username || '').trim();   // case-sensitive
  _seedLocalUsersIfNeeded_();
  var dyn = _localUsers_();
  var u = dyn[key];
  if (!u && Object.keys(dyn).length === 0) u = USERS_[key];   // आपात: store खाली हो तो built-in से
  if (u && u.active === false) return { success: false, message: 'यह खाता निष्क्रिय है — Admin से संपर्क करें।' };
  var ok = false;
  try { ok = !!u && typeof sha256Hex_ === 'function' && sha256Hex_(String(password || '')) === u.hash; } catch (e) { ok = false; }
  if (!ok) {
    return { success: false, message: 'गलत यूजर ID या पासवर्ड।' };
  }
  var token = Utilities.getUuid();
  PropertiesService.getScriptProperties().setProperty(
    'sess_' + token,
    JSON.stringify({ username: key, role: u.role, name: u.name, expires: Date.now() + 28800000 })
  );
  __CU = key; __ROLE = u.role;   // ownership scoping + admin-guard
  return { success: true, token: token, role: u.role, name: u.name };
}

// ── Admin: user-प्रबंधन (LOCAL implementations; CLOUD में __cloudPatch override) ──
function adminListUsers() {
  _seedLocalUsersIfNeeded_();
  var out = [], dyn = _localUsers_();
  Object.keys(dyn).forEach(function (k) { out.push({ username: k, role: dyn[k].role, name: dyn[k].name, active: dyn[k].active !== false }); });
  return out;
}
function adminCreateUser(a) {
  a = a || {};
  _seedLocalUsersIfNeeded_();
  var uname = (a.user || '').trim();
  if (!/^[A-Za-z0-9._-]{2,40}$/.test(uname)) return { success: false, msg: 'username में केवल A-Z a-z 0-9 . _ - चलेंगे (2–40 अक्षर)' };
  if (String(a.pass || '').length < 4) return { success: false, msg: 'password कम-से-कम 4 अक्षर का हो' };
  var dyn = _localUsers_();
  if (dyn[uname]) return { success: false, msg: 'यह username पहले से मौजूद है' };
  dyn[uname] = { hash: sha256Hex_(String(a.pass)), role: a.role === 'admin' ? 'admin' : 'user', name: a.name || uname, active: true };
  _saveLocalUsers_(dyn);
  return { success: true };
}
function adminUpdateUser(a) {
  a = a || {};
  _seedLocalUsersIfNeeded_();
  var uname = (a.user || '').trim();
  var dyn = _localUsers_();
  if (!dyn[uname]) return { success: false, msg: 'user नहीं मिला' };
  var role = a.role === 'admin' ? 'admin' : 'user';
  if (uname === SUPER_ADMIN_) role = 'admin';   // Super Admin हमेशा Admin रहेगा
  if (dyn[uname].role === 'admin' && role !== 'admin' && _isLastActiveAdmin_(dyn, uname)) return { success: false, msg: 'कम-से-कम एक सक्रिय Admin ज़रूरी है' };
  if (a.name !== undefined) dyn[uname].name = a.name || uname;
  dyn[uname].role = role;
  _saveLocalUsers_(dyn);
  return { success: true };
}
function adminSetPassword(a) {
  a = a || {};
  _seedLocalUsersIfNeeded_();
  var uname = (a.user || '').trim();
  if (String(a.pass || '').length < 4) return { success: false, msg: 'password कम-से-कम 4 अक्षर का हो' };
  var dyn = _localUsers_();
  if (!dyn[uname]) return { success: false, msg: 'user नहीं मिला' };
  dyn[uname].hash = sha256Hex_(String(a.pass));
  _saveLocalUsers_(dyn);
  return { success: true };
}
function adminSetActive(a) {
  a = a || {};
  _seedLocalUsersIfNeeded_();
  var uname = (a.user || '').trim();
  var dyn = _localUsers_();
  if (!dyn[uname]) return { success: false, msg: 'user नहीं मिला' };
  if (!a.active && uname === SUPER_ADMIN_) return { success: false, msg: 'Super Admin को निष्क्रिय नहीं किया जा सकता' };
  if (!a.active && dyn[uname].role === 'admin' && _isLastActiveAdmin_(dyn, uname)) return { success: false, msg: 'कम-से-कम एक सक्रिय Admin ज़रूरी है' };
  dyn[uname].active = !!a.active;
  _saveLocalUsers_(dyn);
  return { success: true };
}
function adminDeleteUser(a) {
  a = a || {};
  _seedLocalUsersIfNeeded_();
  var uname = (a.user || '').trim();
  var dyn = _localUsers_();
  if (!dyn[uname]) return { success: false, msg: 'user नहीं मिला' };
  if (uname === SUPER_ADMIN_) return { success: false, msg: 'Super Admin को हटाया नहीं जा सकता' };
  if (dyn[uname].role === 'admin' && _isLastActiveAdmin_(dyn, uname)) return { success: false, msg: 'कम-से-कम एक सक्रिय Admin ज़रूरी है — पहले दूसरा Admin बनाएँ' };
  delete dyn[uname];
  _saveLocalUsers_(dyn);
  return { success: true };
}

function validateSession(token) {
  if (!token) return { valid: false };
  var raw = PropertiesService.getScriptProperties().getProperty('sess_' + token);
  if (!raw) return { valid: false };
  try {
    var s = JSON.parse(raw);
    if (Date.now() > s.expires) {
      PropertiesService.getScriptProperties().deleteProperty('sess_' + token);
      return { valid: false };
    }
    __CU = s.username || ''; __ROLE = s.role || '';   // ownership scoping + admin-guard (session बहाल)
    return { valid: true, role: s.role, name: s.name };
  } catch(e) { return { valid: false }; }
}

function doLogout_(token) {
  if (token) PropertiesService.getScriptProperties().deleteProperty('sess_' + token);
  return true;
}

// ── Cache config ────────────────────────────────────────────
const CACHE_KEY_P = 'rms_primary';    // roads, projects, letters
const CACHE_KEY_S = 'rms_secondary';  // sections, projRoads, docs, finance, plan + OFC
const CACHE_TTL   = 900;              // 15 minutes

// ── Internal: Sheet → Array of Objects (optimized) ─────────
function sheetToObjects_(ss, sheetName) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];

  const values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = values[0];
  const result = [];

  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    let hasData = false;
    for (let c = 0; c < row.length; c++) {
      if (row[c] !== '' && row[c] !== null && row[c] !== undefined) { hasData = true; break; }
    }
    if (!hasData) continue;
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      const h = String(headers[c]).trim();
      if (h) {
        const v = row[c];
        if (v === null || v === undefined || v === '') {
          obj[h] = '';
        } else if (v instanceof Date) {
          const dd = String(v.getDate()).padStart(2,'0');
          const mm = String(v.getMonth()+1).padStart(2,'0');
          obj[h] = dd+'/'+mm+'/'+v.getFullYear();
        } else {
          obj[h] = String(v).trim();
        }
      }
    }
    result.push(obj);
  }
  return result;
}

// ── Primary Data: Dashboard के लिए (Roads, Projects, Letters) ─
function getPrimaryData() {
  return _scopePrimary_(_rawPrimary_());
}
function _rawPrimary_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(CACHE_KEY_P);
  if (cached) {
    try { return JSON.parse(cached); } catch(e) {}
  }
  const ss = SBApp.getActiveSpreadsheet();
  const data = {
    roads:    sheetToObjects_(ss, '1_Roads_Master'),
    projects: sheetToObjects_(ss, '3_Projects'),
    letters:  sheetToObjects_(ss, '5_Letters')
  };
  try { cache.put(CACHE_KEY_P, JSON.stringify(data), CACHE_TTL); } catch(e) {}
  return data;
}
// वर्तमान user के अनुसार छाँटो (cache raw रहता है; हर call अपने user के लिए filter)
function _scopePrimary_(raw) {
  var me = _owner_();
  var ss = SBApp.getActiveSpreadsheet();
  var shared = _sharedIds_(ss);
  var roads    = (raw.roads    || []).filter(function (r) { return _canSeeRoad_(r, shared); });
  var projects = (raw.projects || []).filter(function (p) { return _canSeeProj_(p, shared); });
  var maps = _shareMaps_(ss);
  roads.forEach(function (r) { r._share = _shareTag_('road', r.Road_ID, maps); });
  projects.forEach(function (p) { p._share = _shareTag_('project', p.Project_ID, maps); });
  var pids = {}; projects.forEach(function (p) { if (p.Project_ID) pids[p.Project_ID] = 1; });
  var letters  = (raw.letters  || []).filter(function (l) {
    return l.Project_ID ? !!pids[l.Project_ID] : (me === SUPER_ADMIN_);
  });
  return { roads: roads, projects: projects, letters: letters };
}

// ── Default Work Types ───────────────────────────────────────
const DEFAULT_WORK_TYPES = [
  'पैच मरम्मत',
  'विशेष मरामत',
  'नवीनीकरण',
  'चौड़ीकरण एवं सुदृढीकरण',
  'पुल/पुलिया/सेतु मरम्मत',
  'नव निर्माण',
  'अन्य'
];

// ══════════════════════════════════════════════════════════════
//  11_Conversations — Letter Group / Thread
// ══════════════════════════════════════════════════════════════

function ensureConvSheet_(ss) {
  let sheet = ss.getSheetByName('11_Conversations');
  if (!sheet) {
    sheet = ss.insertSheet('11_Conversations');
    sheet.getRange(1,1,1,7).setValues([['Conv_ID','Project_ID','Conv_Name','Created_Date','Note','Conv_Status','Conv_Type']])
      .setBackground('#1a3a5c').setFontColor('#fff').setFontWeight('bold');
    sheet.setFrozenRows(1);
    SBApp.flush();
  } else {
    const hdr = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0].map(h=>String(h).trim());
    ['Conv_Status','Conv_Type'].forEach(function(col) {
      if (!hdr.includes(col)) {
        sheet.getRange(1, sheet.getLastColumn()+1).setValue(col)
          .setBackground('#1a3a5c').setFontColor('#fff').setFontWeight('bold');
        hdr.push(col);
      }
    });
    SBApp.flush();
  }
  return sheet;
}

function ensureLetterConvCol_(ss) {
  const sheet = ss.getSheetByName('5_Letters');
  if (!sheet) return;
  let hdr = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0].map(h=>String(h).trim());
  ['Conv_ID','Reply_To','Remark','Department','Division','Post_Name'].forEach(col => {
    if (!hdr.includes(col)) {
      const c = sheet.getLastColumn() + 1;
      sheet.getRange(1,c).setValue(col)
        .setBackground('#1a3a5c').setFontColor('#fff').setFontWeight('bold');
      hdr.push(col);
    }
  });
  SBApp.flush();
}

function createConversation(data) {
  const ss     = SBApp.getActiveSpreadsheet();
  const sheet  = ensureConvSheet_(ss);
  const rows   = sheetToObjects_(ss, '11_Conversations');
  const max    = rows.reduce((m,r)=>Math.max(m,parseInt((r.Conv_ID||'').replace(/\D/g,''))||0),0);
  const convId = 'CONV' + String(max+1).padStart(3,'0');
  const now    = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy');
  sheet.appendRow([convId, data.projectId||'', data.convName||'', now, data.note||'', '', data.convType||'']);
  SBApp.flush();
  CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
  return {success:true, convId:convId, createdDate:now};
}

function addLetterToConv(data) {
  const ss = SBApp.getActiveSpreadsheet();
  ensureLetterConvCol_(ss);

  let viewUrl = '';
  if (data.base64 && data.fileName) {
    try {
      const prj     = sheetToObjects_(ss,'3_Projects').find(p=>p.Project_ID===data.projectId)||{};
      const pLabel  = (data.projectId||'')+(prj.Project_Name?' — '+prj.Project_Name:'');
      const pFolder = getOrCreateFolder_(getRMSFolder_(), pLabel);
      const cvFolder= getOrCreateFolder_(pFolder, '3_Conversations');
      const tFolder = getOrCreateFolder_(cvFolder, (data.convId||'CONV')+'_'+(data.convName||''));
      const bytes   = Utilities.base64Decode(data.base64);
      const blob    = Utilities.newBlob(bytes, data.mimeType||'application/octet-stream', data.fileName);
      const file    = tFolder.createFile(blob);
      file.setSharing(SBDrive.Access.ANYONE_WITH_LINK, SBDrive.Permission.VIEW);
      viewUrl = file.getUrl();
    } catch(e) {}
  }

  const lSheet = ss.getSheetByName('5_Letters');
  if (!lSheet) return {success:false, msg:'5_Letters Sheet नहीं मिली'};
  const hdr   = lSheet.getRange(1,1,1,lSheet.getLastColumn()).getValues()[0].map(h=>String(h).trim());
  const ltrId = 'LTR'+String(lSheet.getLastRow()).padStart(3,'0');
  const map   = {
    Letter_ID:       ltrId,
    Project_ID:      data.projectId   ||'',
    Letter_No:       data.letterNo    ||'',
    Letter_Date:     data.letterDate  ||'',
    Direction:       data.direction   ||'Outgoing',
    Subject:         data.subject     ||'',
    Reply_Expected:  data.replyExpected||'No',
    Reply_Received:  'Pending',
    Reply_Date:      '',
    Drive_Link:      viewUrl,
    Conv_ID:         data.convId      ||'',
    Reply_To:        data.replyToId   ||'',
    Department:      data.department  ||'',
    Division:        data.division    ||'',
    Post_Name:       data.postName    ||''
  };
  lSheet.appendRow(hdr.map(h=>map[h]!==undefined?map[h]:''));
  SBApp.flush();
  CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
  return {success:true, ltrId:ltrId, viewUrl:viewUrl};
}

function updateConvNote(convId, note) {
  const ss    = SBApp.getActiveSpreadsheet();
  const sheet = ensureConvSheet_(ss);
  const vals  = sheet.getDataRange().getValues();
  const hdr   = vals[0].map(h=>String(h).trim());
  const cidC  = hdr.indexOf('Conv_ID');
  const ntC   = hdr.indexOf('Note');
  if (ntC < 0) return {success:false, msg:'Note column नहीं मिला'};
  for (let r=1; r<vals.length; r++) {
    if (String(vals[r][cidC]).trim()===convId) {
      sheet.getRange(r+1, ntC+1).setValue(note||'');
      SBApp.flush();
      CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
      return {success:true};
    }
  }
  return {success:false, msg:'Conversation नहीं मिला'};
}

function updateConversation(data) {
  const ss    = SBApp.getActiveSpreadsheet();
  const sheet = ensureConvSheet_(ss);
  const vals  = sheet.getDataRange().getValues();
  const hdr   = vals[0].map(h=>String(h).trim());
  const cidC  = hdr.indexOf('Conv_ID');
  for (let r=1; r<vals.length; r++) {
    if (String(vals[r][cidC]).trim()===data.convId) {
      const map = {
        Conv_Name: data.convName||'',
        Conv_Type: data.convType||'',
        Note:      data.note!==undefined ? data.note : String(vals[r][hdr.indexOf('Note')]||'')
      };
      for (const [col,val] of Object.entries(map)) {
        const ci = hdr.indexOf(col);
        if (ci>=0) sheet.getRange(r+1,ci+1).setValue(val);
      }
      SBApp.flush();
      CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
      return {success:true};
    }
  }
  return {success:false, msg:'Conversation नहीं मिला'};
}

function deleteConversation(convId) {
  const ss    = SBApp.getActiveSpreadsheet();
  const sheet = ensureConvSheet_(ss);
  const vals  = sheet.getDataRange().getValues();
  const cidC  = vals[0].map(h=>String(h).trim()).indexOf('Conv_ID');
  for (let r=1; r<vals.length; r++) {
    if (String(vals[r][cidC]).trim()===convId) {
      sheet.deleteRow(r+1);
      SBApp.flush();
      CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
      return {success:true};
    }
  }
  return {success:false, msg:'नहीं मिला'};
}

function deleteConversationWithLetters(convId) {
  const ss = SBApp.getActiveSpreadsheet();
  // Delete from 5_Letters where Conv_ID matches
  const lSheet = ss.getSheetByName('5_Letters');
  if (lSheet && lSheet.getLastRow() > 1) {
    const lVals = lSheet.getDataRange().getValues();
    const cidC  = lVals[0].map(h=>String(h).trim()).indexOf('Conv_ID');
    if (cidC >= 0) {
      for (let r = lVals.length-1; r >= 1; r--) {
        if (String(lVals[r][cidC]).trim() === convId) lSheet.deleteRow(r+1);
      }
    }
  }
  // Delete conversation
  const cSheet = ensureConvSheet_(ss);
  const cVals  = cSheet.getDataRange().getValues();
  const ccidC  = cVals[0].map(h=>String(h).trim()).indexOf('Conv_ID');
  for (let r=1; r<cVals.length; r++) {
    if (String(cVals[r][ccidC]).trim()===convId) { cSheet.deleteRow(r+1); break; }
  }
  SBApp.flush();
  CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
  return {success:true};
}

function updateLetterRemark(letterId, remark) {
  const ss    = SBApp.getActiveSpreadsheet();
  ensureLetterConvCol_(ss);
  const sheet = ss.getSheetByName('5_Letters');
  if (!sheet) return {success:false};
  const vals  = sheet.getDataRange().getValues();
  const hdr   = vals[0].map(h=>String(h).trim());
  const lidC  = hdr.indexOf('Letter_ID');
  const rmkC  = hdr.indexOf('Remark');
  if (rmkC < 0) return {success:false, msg:'Remark column नहीं मिला'};
  for (let r=1; r<vals.length; r++) {
    if (String(vals[r][lidC]).trim()===letterId) {
      sheet.getRange(r+1, rmkC+1).setValue(remark||'');
      SBApp.flush();
      CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
      return {success:true};
    }
  }
  return {success:false, msg:'Letter नहीं मिला'};
}

function reopenConversation(convId) {
  const ss    = SBApp.getActiveSpreadsheet();
  const sheet = ensureConvSheet_(ss);
  const vals  = sheet.getDataRange().getValues();
  const hdr   = vals[0].map(h=>String(h).trim());
  const cidC  = hdr.indexOf('Conv_ID');
  const stC   = hdr.indexOf('Conv_Status');
  if (stC < 0) return {success:false, msg:'Conv_Status column नहीं मिला'};
  for (let r=1; r<vals.length; r++) {
    if (String(vals[r][cidC]).trim()===convId) {
      sheet.getRange(r+1, stC+1).setValue('');
      SBApp.flush();
      CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
      return {success:true};
    }
  }
  return {success:false, msg:'नहीं मिला'};
}

function updateLetter(data) {
  const ss    = SBApp.getActiveSpreadsheet();
  ensureLetterConvCol_(ss);
  const sheet = ss.getSheetByName('5_Letters');
  if (!sheet) return {success:false, msg:'5_Letters Sheet नहीं मिली'};
  const vals  = sheet.getDataRange().getValues();
  const hdr   = vals[0].map(h=>String(h).trim());
  const lidC  = hdr.indexOf('Letter_ID');
  for (let r=1; r<vals.length; r++) {
    if (String(vals[r][lidC]).trim()===data.letterId) {
      const colMap = {Subject:data.subject||'', Letter_No:data.letterNo||'',
        Letter_Date:data.letterDate||'', Direction:data.direction||'',
        Reply_Expected:data.replyExpected||'No', Remark:data.remark||'',
        Department:data.department||'', Division:data.division||'', Post_Name:data.postName||''};
      for (const [col,val] of Object.entries(colMap)) {
        const ci = hdr.indexOf(col);
        if (ci>=0) sheet.getRange(r+1,ci+1).setValue(val);
      }
      let viewUrl = '';
      if (data.base64 && data.fileName) {
        try {
          const prj    = sheetToObjects_(ss,'3_Projects').find(p=>p.Project_ID===data.projectId)||{};
          const pLabel = (data.projectId||'')+(prj.Project_Name?' — '+prj.Project_Name:'');
          const cvFolder = getOrCreateFolder_(getOrCreateFolder_(getRMSFolder_(), pLabel), '3_Conversations');
          const tFolder  = getOrCreateFolder_(cvFolder,(data.convId||'CONV')+'_'+(data.convName||''));
          const blob = Utilities.newBlob(Utilities.base64Decode(data.base64),data.mimeType||'application/octet-stream',data.fileName);
          const file = tFolder.createFile(blob);
          file.setSharing(SBDrive.Access.ANYONE_WITH_LINK, SBDrive.Permission.VIEW);
          viewUrl = file.getUrl();
          const dlkC = hdr.indexOf('Drive_Link');
          if (dlkC>=0) sheet.getRange(r+1,dlkC+1).setValue(viewUrl);
        } catch(e) {}
      }
      SBApp.flush();
      CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
      return {success:true, viewUrl:viewUrl};
    }
  }
  return {success:false, msg:'Letter नहीं मिला'};
}

// ══════════════════════════════════════════════════════════════
//  8_Bills — Bill / Payment CRUD
// ══════════════════════════════════════════════════════════════

function ensureBillsSheet_() {
  const ss = SBApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName('8_Bills');
  if (!sh) {
    sh = ss.insertSheet('8_Bills');
    sh.appendRow(['Bill_ID','Project_ID','Payment_Cat','Bill_Number',
                  'Contractor_Name','MB_Number','MB_Reference','Measurement_Date',
                  'Bill_Reference','Bill_Date','Payment_Date',
                  'Bill_Amount','Total_With_GST','Check_Payment',
                  'Withheld','Withheld_Amount','Record_MB','Record_Date','Status',
                  'Remark','File_Name','Drive_Link','Created_Date']);
    sh.setFrozenRows(1);
    sh.setRowHeight(1, 28);
  } else {
    // Add any missing new columns to existing sheet
    const hdr = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0].map(h=>String(h).trim());
    ['Withheld','Withheld_Amount','Record_MB','Record_Date','Status'].forEach(col => {
      if (!hdr.includes(col)) sh.getRange(1, sh.getLastColumn()+1).setValue(col);
    });
  }
  return sh;
}

function addBill(data) {
  try {
    const sh  = ensureBillsSheet_();
    const ss  = SBApp.getActiveSpreadsheet();
    const billId = 'BILL-' + Date.now();
    const now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy');
    let viewUrl = '', fileName = '';

    if (data.base64 && data.fileName) {
      const prj      = sheetToObjects_(ss, '3_Projects').find(p => p.Project_ID === data.projectId) || {};
      const pLabel   = (data.projectId||'') + (prj.Project_Name ? ' — ' + prj.Project_Name : '');
      const pFolder  = getOrCreateFolder_(getRMSFolder_(), pLabel);
      const billFolder = getOrCreateFolder_(pFolder, '8_Bills');
      const blob     = Utilities.newBlob(Utilities.base64Decode(data.base64), data.mimeType || 'application/octet-stream', data.fileName);
      const file     = billFolder.createFile(blob);
      file.setSharing(SBDrive.Access.ANYONE_WITH_LINK, SBDrive.Permission.VIEW);
      viewUrl  = file.getUrl();
      fileName = data.fileName;
    }

    // Header-based row build so new/old sheet layouts both work
    const hdr2 = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0].map(h=>String(h).trim());
    const row  = new Array(hdr2.length).fill('');
    const put  = (col, val) => { const c = hdr2.indexOf(col); if (c>=0) row[c]=val; };
    put('Bill_ID',          billId);
    put('Project_ID',       data.projectId||'');
    put('Payment_Cat',      data.paymentCat||'');
    put('Bill_Number',      data.billNumber||'');
    put('Contractor_Name',  data.contractorName||'');
    put('MB_Number',        data.mbNumber||'');
    put('MB_Reference',     data.mbReference||'');
    put('Measurement_Date', data.measurementDate||'');
    put('Bill_Reference',   data.billReference||'');
    put('Bill_Date',        data.billDate||'');
    put('Payment_Date',     data.paymentDate||'');
    put('Bill_Amount',      data.billAmount||'');
    put('Total_With_GST',   data.totalWithGst||'');
    put('Check_Payment',    data.checkPayment||'');
    put('Withheld',         data.withheld||'');
    put('Withheld_Amount',  data.withheldAmount||'');
    put('Record_MB',        data.recordMb||'');
    put('Record_Date',      data.recordDate||'');
    put('Status',           data.status||'Unknown');
    put('Remark',           data.remark||'');
    put('File_Name',        fileName);
    put('Drive_Link',       viewUrl);
    put('Created_Date',     now);
    sh.appendRow(row);
    SBApp.flush();
    const cache_ = CacheService.getScriptCache();
    try { cache_.remove(CACHE_KEY_P); } catch(e2) {}
    try { cache_.remove(CACHE_KEY_S); } catch(e2) {}
    return {success:true, billId:billId, viewUrl:viewUrl, fileName:fileName, createdDate:now};
  } catch(e) {
    return {success:false, msg:e.message};
  }
}

function updateBill(data) {
  try {
    const sh   = ensureBillsSheet_();
    const ss   = SBApp.getActiveSpreadsheet();
    const vals = sh.getDataRange().getValues();
    const hdr  = vals[0].map(h => String(h).trim());
    const idC  = hdr.indexOf('Bill_ID');
    for (let r = 1; r < vals.length; r++) {
      if (String(vals[r][idC]).trim() !== data.billId) continue;
      const set = (col, val) => { const c = hdr.indexOf(col); if (c >= 0) sh.getRange(r+1, c+1).setValue(val); };
      set('Payment_Cat',     data.paymentCat||'');
      set('Bill_Number',     data.billNumber||'');
      set('Contractor_Name', data.contractorName||'');
      set('MB_Number',       data.mbNumber||'');
      set('MB_Reference',    data.mbReference||'');
      set('Measurement_Date',data.measurementDate||'');
      set('Bill_Reference',  data.billReference||'');
      set('Bill_Date',       data.billDate||'');
      set('Payment_Date',    data.paymentDate||'');
      set('Bill_Amount',     data.billAmount||'');
      set('Total_With_GST',  data.totalWithGst||'');
      set('Check_Payment',   data.checkPayment||'');
      set('Withheld',        data.withheld||'');
      set('Withheld_Amount', data.withheldAmount||'');
      set('Record_MB',       data.recordMb||'');
      set('Record_Date',     data.recordDate||'');
      set('Status',          data.status||'Unknown');
      set('Remark',          data.remark||'');

      let viewUrl  = String(vals[r][hdr.indexOf('Drive_Link')]||'');
      let fileName = String(vals[r][hdr.indexOf('File_Name')]||'');
      if (data.base64 && data.fileName) {
        const prj    = sheetToObjects_(ss, '3_Projects').find(p => p.Project_ID === data.projectId) || {};
        const pLabel = (data.projectId||'') + (prj.Project_Name ? ' — ' + prj.Project_Name : '');
        const billFolder = getOrCreateFolder_(getOrCreateFolder_(getRMSFolder_(), pLabel), '8_Bills');
        const blob   = Utilities.newBlob(Utilities.base64Decode(data.base64), data.mimeType||'application/octet-stream', data.fileName);
        const file   = billFolder.createFile(blob);
        file.setSharing(SBDrive.Access.ANYONE_WITH_LINK, SBDrive.Permission.VIEW);
        viewUrl  = file.getUrl();
        fileName = data.fileName;
        set('Drive_Link', viewUrl);
        set('File_Name',  fileName);
      }
      SBApp.flush();
      CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
      return {success:true, viewUrl:viewUrl, fileName:fileName};
    }
    return {success:false, msg:'Bill नहीं मिला'};
  } catch(e) {
    return {success:false, msg:e.message};
  }
}

function updateBillStatus(billId, status) {
  try {
    const sh   = ensureBillsSheet_();
    const vals = sh.getDataRange().getValues();
    const hdr  = vals[0].map(h => String(h).trim());
    const idC  = hdr.indexOf('Bill_ID');
    const stC  = hdr.indexOf('Status');
    for (let r = 1; r < vals.length; r++) {
      if (String(vals[r][idC]).trim() !== billId) continue;
      if (stC >= 0) sh.getRange(r+1, stC+1).setValue(status);
      SBApp.flush();
      CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
      return {success: true};
    }
    return {success: false, msg: 'Bill नहीं मिला'};
  } catch(e) {
    return {success: false, msg: e.message};
  }
}

function attachBillFile(data) {
  try {
    const sh   = ensureBillsSheet_();
    const ss   = SBApp.getActiveSpreadsheet();
    const vals = sh.getDataRange().getValues();
    const hdr  = vals[0].map(h => String(h).trim());
    const idC  = hdr.indexOf('Bill_ID');
    for (let r = 1; r < vals.length; r++) {
      if (String(vals[r][idC]).trim() !== data.billId) continue;
      const pLabel  = (data.projectId||'') + (data.projectName ? ' — ' + data.projectName : '');
      const bFolder = getOrCreateFolder_(getOrCreateFolder_(getRMSFolder_(), pLabel), '8_Bills');
      const blob   = Utilities.newBlob(Utilities.base64Decode(data.base64), data.mimeType||'application/octet-stream', data.fileName);
      const file   = bFolder.createFile(blob);
      file.setSharing(SBDrive.Access.ANYONE_WITH_LINK, SBDrive.Permission.VIEW);
      const viewUrl = file.getUrl();
      const set = (col, val) => { const c = hdr.indexOf(col); if (c>=0) sh.getRange(r+1,c+1).setValue(val); };
      set('Drive_Link', viewUrl);
      set('File_Name',  data.fileName);
      SBApp.flush();
      CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
      return {success: true, viewUrl: viewUrl, fileName: data.fileName};
    }
    return {success: false, msg: 'Bill नहीं मिला'};
  } catch(e) {
    return {success: false, msg: e.message};
  }
}

function deleteBill(billId) {
  try {
    const sh   = ensureBillsSheet_();
    const vals = sh.getDataRange().getValues();
    const hdr  = vals[0].map(h => String(h).trim());
    const idC  = hdr.indexOf('Bill_ID');
    for (let r = 1; r < vals.length; r++) {
      if (String(vals[r][idC]).trim() === billId) {
        sh.deleteRow(r + 1);
        SBApp.flush();
        CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
        return {success:true};
      }
    }
    return {success:false, msg:'Bill नहीं मिला'};
  } catch(e) {
    return {success:false, msg:e.message};
  }
}

// ══ FINANCE LEDGER CRUD ══

function _ensureFinSheet_(ss) {
  ss = ss || SBApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('6_Finance_Ledger');
  if (!sh) {
    sh = ss.insertSheet('6_Finance_Ledger');
    sh.appendRow(['Txn_ID','Project_ID','Date','Type','Amount','Running_Balance','Remark']);
  }
  return sh;
}

function addAllotment(data) {
  try {
    const ss  = SBApp.getActiveSpreadsheet();
    const sh  = _ensureFinSheet_(ss);
    const txnId = 'TXN_' + new Date().getTime();
    const amtRs = Number(data.amount)||0;
    // Format date as DD/MM/YYYY if input is YYYY-MM-DD
    let dateStr = data.date||'';
    const dm = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dm) dateStr = dm[3]+'/'+dm[2]+'/'+dm[1];
    sh.appendRow([txnId, data.pid||'', dateStr, 'Allotment', amtRs, 0, data.remark||'']);
    SBApp.flush();
    const cache_ = CacheService.getScriptCache();
    try { cache_.remove(CACHE_KEY_P); } catch(e2) {}
    try { cache_.remove(CACHE_KEY_S); } catch(e2) {}
    return {success:true, txnId:txnId};
  } catch(e) {
    return {success:false, error:e.message};
  }
}

function addExpense(data) {
  try {
    const ss  = SBApp.getActiveSpreadsheet();
    const sh  = _ensureFinSheet_(ss);
    const txnId = 'TXN_' + new Date().getTime();
    const amtRs = Number(data.amount)||0;
    let dateStr = data.date||'';
    const dm = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dm) dateStr = dm[3]+'/'+dm[2]+'/'+dm[1];
    sh.appendRow([txnId, data.pid||'', dateStr, 'Expense', amtRs, 0, data.remark||'']);
    SBApp.flush();
    const cache_ = CacheService.getScriptCache();
    try { cache_.remove(CACHE_KEY_P); } catch(e2) {}
    try { cache_.remove(CACHE_KEY_S); } catch(e2) {}
    return {success:true, txnId:txnId};
  } catch(e) {
    return {success:false, error:e.message};
  }
}

function updateAllotment(data) {
  try {
    const ss  = SBApp.getActiveSpreadsheet();
    const sh  = _ensureFinSheet_(ss);
    const vals = sh.getDataRange().getValues();
    const hdr  = vals[0].map(h => String(h).trim());
    const idC  = hdr.indexOf('Txn_ID');
    const dtC  = hdr.indexOf('Date');
    const amC  = hdr.indexOf('Amount');
    const rmC  = hdr.indexOf('Remark');
    let dateStr = data.date||'';
    const dm = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dm) dateStr = dm[3]+'/'+dm[2]+'/'+dm[1];
    for (let r = 1; r < vals.length; r++) {
      if (String(vals[r][idC]).trim() === (data.txnId||'')) {
        if (dtC>=0) sh.getRange(r+1, dtC+1).setValue(dateStr);
        if (amC>=0) sh.getRange(r+1, amC+1).setValue(Number(data.amount)||0);
        if (rmC>=0) sh.getRange(r+1, rmC+1).setValue(data.remark||'');
        SBApp.flush();
        const cache_ = CacheService.getScriptCache();
        try { cache_.remove(CACHE_KEY_P); } catch(e2) {}
        try { cache_.remove(CACHE_KEY_S); } catch(e2) {}
        return {success:true};
      }
    }
    return {success:false, error:'Record नहीं मिला'};
  } catch(e) {
    return {success:false, error:e.message};
  }
}

function deleteAllotment(data) {
  try {
    const ss  = SBApp.getActiveSpreadsheet();
    const sh  = _ensureFinSheet_(ss);
    const vals = sh.getDataRange().getValues();
    const hdr  = vals[0].map(h => String(h).trim());
    const idC  = hdr.indexOf('Txn_ID');
    const tyC  = hdr.indexOf('Type');
    for (let r = 1; r < vals.length; r++) {
      if (String(vals[r][idC]).trim() === (data.txnId||'')) {
        const ty = String(vals[r][tyC]||'');
        if (ty !== 'Allotment' && ty !== 'Fund Received' && ty !== 'Expense') {
          return {success:false, error:'केवल Allotment/Expense entries हटाई जा सकती हैं'};
        }
        sh.deleteRow(r + 1);
        SBApp.flush();
        const cache_ = CacheService.getScriptCache();
        try { cache_.remove(CACHE_KEY_P); } catch(e2) {}
        try { cache_.remove(CACHE_KEY_S); } catch(e2) {}
        return {success:true};
      }
    }
    return {success:false, error:'Record नहीं मिला'};
  } catch(e) {
    return {success:false, error:e.message};
  }
}

// ══ END FINANCE LEDGER CRUD ══

function closeConversation(convId) {
  const ss    = SBApp.getActiveSpreadsheet();
  const sheet = ensureConvSheet_(ss);
  const vals  = sheet.getDataRange().getValues();
  const hdr   = vals[0].map(h=>String(h).trim());
  const cidC  = hdr.indexOf('Conv_ID');
  const stC   = hdr.indexOf('Conv_Status');
  if (stC < 0) return {success:false, msg:'Conv_Status column नहीं मिला'};
  for (let r=1; r<vals.length; r++) {
    if (String(vals[r][cidC]).trim()===convId) {
      sheet.getRange(r+1, stC+1).setValue('Closed');
      SBApp.flush();
      CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
      return {success:true};
    }
  }
  return {success:false, msg:'नहीं मिला'};
}

function deleteLetter(letterId) {
  try {
    const ss    = SBApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('5_Letters');
    if (!sheet) return {success:false, msg:'5_Letters नहीं मिली'};
    const vals = sheet.getDataRange().getValues();
    const hdr  = vals[0].map(h=>String(h).trim());
    const lidC = hdr.indexOf('Letter_ID');
    if (lidC<0) return {success:false, msg:'Letter_ID column नहीं मिला'};
    for (let r=1; r<vals.length; r++) {
      if (String(vals[r][lidC]).trim()===letterId) {
        sheet.deleteRow(r+1);
        SBApp.flush();
        CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
        return {success:true};
      }
    }
    return {success:false, msg:'Letter नहीं मिला: '+letterId};
  } catch(e) { return {success:false, msg:e.message}; }
}

function markLetterReplied(letterId) {
  const ss    = SBApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('5_Letters');
  if (!sheet) return {success:false};
  const vals  = sheet.getDataRange().getValues();
  const hdr   = vals[0].map(h=>String(h).trim());
  const lidC  = hdr.indexOf('Letter_ID');
  const rrC   = hdr.indexOf('Reply_Received');
  for (let r=1; r<vals.length; r++) {
    if (String(vals[r][lidC]).trim()===letterId) {
      if (rrC>=0) sheet.getRange(r+1,rrC+1).setValue('Yes');
      SBApp.flush();
      CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
      return {success:true};
    }
  }
  return {success:false};
}

function updateLetterReplyExpected(letterId, replyExpected) {
  const ss    = SBApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('5_Letters');
  if (!sheet) return {success:false};
  const vals  = sheet.getDataRange().getValues();
  const hdr   = vals[0].map(h=>String(h).trim());
  const lidC  = hdr.indexOf('Letter_ID');
  const reC   = hdr.indexOf('Reply_Expected');
  for (let r=1; r<vals.length; r++) {
    if (String(vals[r][lidC]).trim()===letterId) {
      if (reC>=0) sheet.getRange(r+1,reC+1).setValue(replyExpected||'No');
      SBApp.flush();
      CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
      return {success:true};
    }
  }
  return {success:false};
}

// ── Doc Categories ───────────────────────────────────────────
const DEFAULT_DOC_CATS = [
  ['1','Estimate'],['2','Bond/Extra Item'],['3','Utility Payment'],
  ['4','Charge Memo'],['5','Drawing/Measurement'],['6','Test Report/SLC/TAC'],
  ['7','Site Photographs'],['8','Bill Copy']
];

function ensureDocCatSheet_(ss) {
  let sheet = ss.getSheetByName('10_Doc_Categories');
  if (!sheet) {
    sheet = ss.insertSheet('10_Doc_Categories');
    sheet.getRange(1,1,1,2).setValues([['Cat_No','Cat_Name']])
      .setBackground('#1a3a5c').setFontColor('#fff').setFontWeight('bold');
    sheet.setFrozenRows(1);
    DEFAULT_DOC_CATS.forEach(([no,nm]) => sheet.appendRow([no, nm]));
    SBApp.flush();
  }
  return sheet;
}

function getDocCategoriesList_() {
  const ss = SBApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('10_Doc_Categories');
  if (!sheet) return DEFAULT_DOC_CATS.map(([n,nm]) => ({Cat_No:n, Cat_Name:nm}));
  const vals = sheet.getDataRange().getValues();
  const cats = vals.slice(1)
    .map(r => ({Cat_No:String(r[0]||'').trim(), Cat_Name:String(r[1]||'').trim()}))
    .filter(c => c.Cat_No && c.Cat_Name);
  return cats.length ? cats : DEFAULT_DOC_CATS.map(([n,nm]) => ({Cat_No:n, Cat_Name:nm}));
}

function saveDocCategory(catNo, catName) {
  var _g = _adminOnlyGuard_(); if (_g) return _g;
  catNo = String(catNo||'').trim(); catName = String(catName||'').trim();
  if (!catNo || !catName) return {success:false, msg:'नाम खाली नहीं हो सकता'};
  const ss = SBApp.getActiveSpreadsheet();
  const sheet = ensureDocCatSheet_(ss);
  const vals = sheet.getDataRange().getValues();
  for (let r = 1; r < vals.length; r++) {
    if (String(vals[r][0]).trim() === catNo) {
      sheet.getRange(r+1, 2).setValue(catName);
      SBApp.flush();
      CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
      return {success:true};
    }
  }
  return {success:false, msg:'Category नहीं मिली: '+catNo};
}

function addDocCategory(catName) {
  var _g = _adminOnlyGuard_(); if (_g) return _g;
  catName = String(catName||'').trim();
  if (!catName) return {success:false, msg:'नाम खाली नहीं हो सकता'};
  const ss = SBApp.getActiveSpreadsheet();
  const sheet = ensureDocCatSheet_(ss);
  const vals = sheet.getDataRange().getValues();
  if (vals.slice(1).some(r => String(r[1]).trim().toLowerCase() === catName.toLowerCase()))
    return {success:false, msg:'"'+catName+'" पहले से मौजूद है'};
  const maxNo = vals.slice(1).reduce((m,r) => Math.max(m, parseInt(r[0])||0), 0);
  const newNo = String(maxNo + 1);
  sheet.appendRow([newNo, catName]);
  SBApp.flush();
  CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
  return {success:true, catNo:newNo};
}

function deleteDocCategory(catNo) {
  var _g = _adminOnlyGuard_(); if (_g) return _g;
  catNo = String(catNo||'').trim();
  const ss = SBApp.getActiveSpreadsheet();
  const sheet = ensureDocCatSheet_(ss);
  const vals = sheet.getDataRange().getValues();
  for (let r = 1; r < vals.length; r++) {
    if (String(vals[r][0]).trim() === catNo) {
      sheet.deleteRow(r+1);
      SBApp.flush();
      CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
      return {success:true};
    }
  }
  return {success:false, msg:'नहीं मिली'};
}

// ── Internal: Work Types sheet से list ──────────────────────
function getWorkTypesList_() {
  const ss = SBApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('8_Work_Types');
  if (!sheet) return DEFAULT_WORK_TYPES.slice();
  let types = sheet.getDataRange().getValues().slice(1).map(r => String(r[0]).trim()).filter(Boolean);
  if (!types.length) return DEFAULT_WORK_TYPES.slice();
  // पुरानी Sheet में अगर नए default प्रकार (जैसे नव निर्माण/अन्य) मौजूद नहीं हैं तो उन्हें जोड़ दें
  const lower = types.map(t => t.toLowerCase());
  const missing = DEFAULT_WORK_TYPES.filter(t => lower.indexOf(t.toLowerCase()) < 0);
  if (missing.length) {
    missing.forEach(t => sheet.appendRow([t]));
    types = types.concat(missing);
  }
  return types;
}

// ── Work Types: Rename (केवल कस्टम — डिफ़ॉल्ट नहीं) ──────────
function renameWorkType(oldName, newName) {
  var _g = _adminOnlyGuard_(); if (_g) return _g;
  oldName = String(oldName||'').trim(); newName = String(newName||'').trim();
  if (!newName) return { success: false, msg: 'नाम खाली नहीं हो सकता' };
  if (DEFAULT_WORK_TYPES.indexOf(oldName) >= 0) return { success: false, msg: 'डिफ़ॉल्ट कार्य प्रकार बदला नहीं जा सकता' };
  const ss = SBApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('8_Work_Types');
  if (!sheet) return { success: false, msg: '8_Work_Types Sheet नहीं मिली' };
  const vals = sheet.getDataRange().getValues();
  for (let r = 1; r < vals.length; r++) {
    if (String(vals[r][0]).trim() === oldName) {
      sheet.getRange(r+1, 1).setValue(newName);
      CacheService.getScriptCache().remove(CACHE_KEY_S);
      return { success: true };
    }
  }
  return { success: false, msg: 'नहीं मिला' };
}

// ── Work Types: Delete (केवल कस्टम — डिफ़ॉल्ट नहीं) ──────────
function deleteWorkType(name) {
  var _g = _adminOnlyGuard_(); if (_g) return _g;
  name = String(name||'').trim();
  if (DEFAULT_WORK_TYPES.indexOf(name) >= 0) return { success: false, msg: 'डिफ़ॉल्ट कार्य प्रकार हटाया नहीं जा सकता' };
  const ss = SBApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('8_Work_Types');
  if (!sheet) return { success: false, msg: '8_Work_Types Sheet नहीं मिली' };
  const vals = sheet.getDataRange().getValues();
  for (let r = 1; r < vals.length; r++) {
    if (String(vals[r][0]).trim() === name) {
      sheet.deleteRow(r+1);
      CacheService.getScriptCache().remove(CACHE_KEY_S);
      return { success: true };
    }
  }
  return { success: false, msg: 'नहीं मिला' };
}

// ── Secondary Data: बाकी सब ─────────────────────────────────
function getSecondaryData() {
  return _scopeSecondary_(_rawSecondary_());
}
function _rawSecondary_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(CACHE_KEY_S);
  if (cached) {
    try { return JSON.parse(cached); } catch(e) {}
  }
  const ss = SBApp.getActiveSpreadsheet();
  ofcSetup_(ss);
  const data = {
    sections:  sheetToObjects_(ss, '2_Road_Sections'),
    projRoads: sheetToObjects_(ss, '3B_Project_Roads'),
    docs:      sheetToObjects_(ss, '4_Documents'),
    finance:   sheetToObjects_(ss, '6_Finance_Ledger'),
    plan:      sheetToObjects_(ss, '7_Annual_Plan'),
    workTypes: getWorkTypesList_(),
    roadTypes: getRoadTypesList_(),
    docCats:   getDocCategoriesList_(),
    convs:     sheetToObjects_(ss, '11_Conversations'),
    bills:     sheetToObjects_(ss, '8_Bills'),
    masters:   (ensureMasterSheet_(ss), sheetToObjects_(ss, '9_Masters')),
    mbItems:   (_ensureMBSheets_(ss), sheetToObjects_(ss, '12_MB_Items')),
    mbEntries: sheetToObjects_(ss, '13_MB_Entries'),
    ofc: {
      departments: ofcRead_(ss, 'OFC_Depts'),
      officers:    ofcRead_(ss, 'OFC_Officers'),
      roadLinks:   ofcRead_(ss, 'OFC_RoadLinks'),
      letters:     ofcRead_(ss, 'OFC_Letters')
    }
  };
  try { cache.put(CACHE_KEY_S, JSON.stringify(data), CACHE_TTL); } catch(e) {}
  return data;
}
// children को parent (road/project) के owner अनुसार छाँटो; reference/config व OFC साझा रहते हैं
function _scopeSecondary_(raw) {
  var ss = SBApp.getActiveSpreadsheet();
  var own = _ownedSets_(ss);
  var byRoad = function (x) { return x.Road_ID ? !!own.roads[x.Road_ID] : false; };
  var byProj = function (x) { return x.Project_ID ? !!own.projs[x.Project_ID] : false; };
  return {
    sections:  (raw.sections  || []).filter(byRoad),
    projRoads: (raw.projRoads || []).filter(byProj),
    docs:      (raw.docs      || []).filter(byProj),
    finance:   (raw.finance   || []).filter(byProj),
    plan:      (raw.plan      || []).filter(byRoad),
    convs:     (raw.convs     || []).filter(byProj),
    bills:     (raw.bills     || []).filter(byProj),
    mbItems:   (raw.mbItems   || []).filter(byProj),
    mbEntries: (raw.mbEntries || []).filter(byProj),
    // साझा reference/config — सभी users के लिए एक ही
    workTypes: raw.workTypes, roadTypes: raw.roadTypes, docCats: raw.docCats,
    masters:   raw.masters, ofc: raw.ofc
  };
}

// ══════════════════════════════════════════════════════════════
//  1_Roads_Master — CRUD + Bulk Import
// ══════════════════════════════════════════════════════════════

// Avg_Width_M / Last_Work_Month / Last_Work_Year / Last_Work_Date / Maintenance_Years —
// मैनुअल fallback columns (जब Chainage Detail न हो) + अनुरक्षण अवधि (project sync से भी अपडेट होती है)
function ensureRoadMasterExtraCols_(ss) {
  const sheet = ss.getSheetByName('1_Roads_Master');
  if (!sheet) return;
  const hdr = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
  ['Avg_Width_M', 'Last_Work_Month', 'Last_Work_Year', 'Last_Work_Date', 'Maintenance_Years'].forEach(function(name) {
    if (hdr.indexOf(name) >= 0) return;
    const col = sheet.getLastColumn() + 1;
    sheet.getRange(1, col).setValue(name).setBackground('#1a3a5c').setFontColor('#fff').setFontWeight('bold');
    hdr.push(name);
  });
  SBApp.flush();
}

// Status column ensure करें (पुरानी sheets में नहीं होगा)
function ensureStatusColumn_(ss) {
  const sheet = ss.getSheetByName('1_Roads_Master');
  if (!sheet) return -1;
  const hdr = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const idx = hdr.indexOf('Status');
  if (idx >= 0) return idx + 1;
  const col = sheet.getLastColumn() + 1;
  sheet.getRange(1, col).setValue('Status')
    .setBackground('#1a3a5c').setFontColor('#fff').setFontWeight('bold');
  SBApp.flush();
  return col;
}

// ── नई सड़क Add ──────────────────────────────────────────────
// Road ID — केवल अंक, अधिकतम 8 डिजिट
function _validRoadId_(id) { return /^\d{1,8}$/.test(String(id || '').trim()); }
// सबसे छोटा खाली numeric क्रमांक — Road ID न दिए जाने पर auto-generate (केवल अंक)
function genRoadId_(ss) {
  const used = {};
  sheetToObjects_(ss, '1_Roads_Master').forEach(function (r) {
    const n = parseInt(String(r.Road_ID || '').replace(/\D/g, '')) || 0;
    if (n > 0) used[n] = true;
  });
  let n = 1; while (used[n]) n++;
  return String(n);
}

function addRoad(data) {
  const ss = SBApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('1_Roads_Master');
  if (!sheet) return { success: false, msg: '1_Roads_Master Sheet नहीं मिली' };
  const rows = sheetToObjects_(ss, '1_Roads_Master');
  let rid = String(data.roadId || '').trim();
  let autoId = false;
  if (!rid) { rid = genRoadId_(ss); autoId = true; }   // ID न दी हो तो अपने-आप बनाओ
  else if (!_validRoadId_(rid)) return { success: false, msg: 'Road ID केवल अंक (अधिकतम 8 डिजिट) हो सकता है' };
  // Duplicate check
  if (rows.find(r => r.Road_ID === rid)) return { success: false, msg: 'Road ID "' + rid + '" पहले से मौजूद है' };
  ensureStatusColumn_(ss);
  ensureRoadMasterExtraCols_(ss);
  sheet.appendRow([rid, data.roadName||'', data.roadType||'', data.srishtiCode||'', data.vidhansabha||'', data.lengthKm||'', 'Active', data.remark||'']);
  const hdrNew = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0].map(h=>String(h).trim());
  const lastRow = sheet.getLastRow();
  const lw = roadLastWorkMY_(data.lastWorkDate);
  [['Avg_Width_M', data.avgWidthM||''],['Last_Work_Month', lw.month],['Last_Work_Year', lw.year],
   ['Last_Work_Date', data.lastWorkDate||''],['Maintenance_Years', data.maintenanceYears||2]]
    .forEach(([k,v]) => { const c=hdrNew.indexOf(k); if (c>=0 && v!=='') sheet.getRange(lastRow,c+1).setValue(v); });
  _stampOwnerLastRow_(sheet);   // यह सड़क वर्तमान user की
  SBApp.flush();
  CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
  return { success: true, roadId: rid, autoId: autoId };
}

// किसी सड़क का Road_ID बदलो (सभी जुड़ी शीट में reference भी अपडेट)
const ROAD_ID_SHEETS = ['1_Roads_Master', '2_Road_Sections', '3B_Project_Roads', '4_Documents', '5_Letters', '7_Annual_Plan', 'OFC_RoadLinks', 'OFC_Letters'];
function renumberRoad(oldId, newId) {
  oldId = String(oldId || '').trim();
  newId = String(newId || '').trim();
  if (!oldId || !newId) return { success: false, msg: 'पुराना व नया दोनों Road ID ज़रूरी हैं' };
  if (oldId === newId) return { success: true };
  if (!_validRoadId_(newId)) return { success: false, msg: 'Road ID केवल अंक (अधिकतम 8 डिजिट) हो सकता है' };
  const ss = SBApp.getActiveSpreadsheet();
  const roads = sheetToObjects_(ss, '1_Roads_Master');
  if (!roads.some(r => String(r.Road_ID).trim() === oldId)) return { success: false, msg: oldId + ' नहीं मिली' };
  if (roads.some(r => String(r.Road_ID).trim() === newId)) return { success: false, msg: newId + ' पहले से मौजूद है' };
  // हर शीट में Road_ID कॉलम पर oldId → newId
  ROAD_ID_SHEETS.forEach(function (sName) {
    const s = ss.getSheetByName(sName);
    if (!s || s.getLastRow() < 2) return;
    const vals = s.getDataRange().getValues();
    const c = vals[0].map(h => String(h).trim()).indexOf('Road_ID');
    if (c < 0) return;
    for (let r = 1; r < vals.length; r++) {
      if (String(vals[r][c]).trim() === oldId) s.getRange(r + 1, c + 1).setValue(newId);
    }
  });
  // 14_Shares — road share का Res_ID भी बदलो
  const shr = ss.getSheetByName('14_Shares');
  if (shr && shr.getLastRow() >= 2) {
    const sv = shr.getDataRange().getValues();
    const H = sv[0].map(h => String(h).trim());
    const tC = H.indexOf('Res_Type'), iC = H.indexOf('Res_ID');
    if (tC >= 0 && iC >= 0) for (let r = 1; r < sv.length; r++) {
      if (String(sv[r][tC]) === 'road' && String(sv[r][iC]).trim() === oldId) shr.getRange(r + 1, iC + 1).setValue(newId);
    }
  }
  SBApp.flush();
  CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
  return { success: true, oldId: oldId, newId: newId };
}

// "आखिरी कार्य की तारीख" (input type=date, YYYY-MM-DD) से Month/Year निकालें — पुराने Month/Year
// आधारित कोड (बल्क इम्पोर्ट, DLP बैज आदि) से backward-compatible बने रहने के लिए
function roadLastWorkMY_(dateStr) {
  if (!dateStr) return { month: '', year: '' };
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return { month: '', year: '' };
  return { month: String(d.getMonth()+1).padStart(2,'0'), year: String(d.getFullYear()) };
}

// ── सड़क Update ───────────────────────────────────────────────
function updateRoad(data) {
  const ss = SBApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('1_Roads_Master');
  if (!sheet) return { success: false, msg: '1_Roads_Master Sheet नहीं मिली' };
  ensureRoadMasterExtraCols_(ss);
  const vals = sheet.getDataRange().getValues();
  const hdr  = vals[0].map(h => String(h).trim());
  const ridC = hdr.indexOf('Road_ID');
  const colOf = k => hdr.indexOf(k);
  for (let r = 1; r < vals.length; r++) {
    if (String(vals[r][ridC]).trim() !== data.roadId) continue;
    const lw = roadLastWorkMY_(data.lastWorkDate);
    [['Road_Name', data.roadName||''],['Road_Type', data.roadType||''],
     ['Srishti_Code', data.srishtiCode||''],['Vidhansabha', data.vidhansabha||''],
     ['Total_Length_KM', data.lengthKm||''],['Remark', data.remark||''],
     ['Avg_Width_M', data.avgWidthM||''],['Last_Work_Month', lw.month],['Last_Work_Year', lw.year],
     ['Last_Work_Date', data.lastWorkDate||''],['Maintenance_Years', data.maintenanceYears||2]
    ].forEach(([k,v]) => { const c=colOf(k); if(c>=0) sheet.getRange(r+1,c+1).setValue(v); });
    SBApp.flush();
    CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
    return { success: true };
  }
  return { success: false, msg: 'Road ID नहीं मिला: ' + data.roadId };
}

// ── सड़क Delete ───────────────────────────────────────────────
function deleteRoad(roadId) {
  const ss = SBApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('1_Roads_Master');
  if (!sheet) return { success: false, msg: '1_Roads_Master Sheet नहीं मिली' };
  const vals = sheet.getDataRange().getValues();
  const ridC = vals[0].map(h => String(h).trim()).indexOf('Road_ID');
  for (let r = 1; r < vals.length; r++) {
    if (String(vals[r][ridC]).trim() !== roadId) continue;
    sheet.deleteRow(r + 1);
    SBApp.flush();
    CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
    return { success: true };
  }
  return { success: false, msg: 'Road ID नहीं मिला' };
}

// ── सड़क Dump (अब charge में नहीं) ───────────────────────────
function dumpRoad(roadId, reason) {
  const ss = SBApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('1_Roads_Master');
  if (!sheet) return { success: false, msg: '1_Roads_Master Sheet नहीं मिली' };
  ensureStatusColumn_(ss);
  const vals = sheet.getDataRange().getValues();
  const hdr  = vals[0].map(h => String(h).trim());
  const ridC = hdr.indexOf('Road_ID'), stC = hdr.indexOf('Status'), remC = hdr.indexOf('Remark');
  for (let r = 1; r < vals.length; r++) {
    if (String(vals[r][ridC]).trim() !== roadId) continue;
    if (stC  >= 0) sheet.getRange(r+1, stC+1).setValue('Dumped');
    if (remC >= 0 && reason) {
      const dt  = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy');
      const cur = String(vals[r][remC]||'').trim();
      sheet.getRange(r+1, remC+1).setValue((cur?cur+' ':'')+'[Dump: '+reason+' — '+dt+']');
    }
    SBApp.flush();
    CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
    return { success: true };
  }
  return { success: false, msg: 'Road ID नहीं मिला' };
}

// ── Dump से Restore ──────────────────────────────────────────
function restoreRoad(roadId) {
  const ss = SBApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('1_Roads_Master');
  if (!sheet) return { success: false, msg: 'Sheet नहीं मिली' };
  ensureStatusColumn_(ss);
  const vals = sheet.getDataRange().getValues();
  const hdr  = vals[0].map(h => String(h).trim());
  const ridC = hdr.indexOf('Road_ID'), stC = hdr.indexOf('Status');
  for (let r = 1; r < vals.length; r++) {
    if (String(vals[r][ridC]).trim() !== roadId) continue;
    if (stC >= 0) sheet.getRange(r+1, stC+1).setValue('Active');
    SBApp.flush();
    CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
    return { success: true };
  }
  return { success: false, msg: 'Road ID नहीं मिला' };
}

// ── Bulk Import ───────────────────────────────────────────────
function bulkAddRoads(rows) {
  const ss = SBApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('1_Roads_Master');
  if (!sheet) return { success: false, msg: '1_Roads_Master Sheet नहीं मिली' };
  ensureStatusColumn_(ss);
  const existing = sheetToObjects_(ss, '1_Roads_Master').map(r => r.Road_ID);
  let added = 0, skipped = [], errors = [];
  rows.forEach(row => {
    const rid = String(row.roadId || '').trim();
    if (!rid || !row.roadName) { errors.push(rid || '(blank)'); return; }
    if (existing.includes(rid)) { skipped.push(rid); return; }
    sheet.appendRow([rid, row.roadName||'', row.roadType||'', row.srishtiCode||'', row.vidhansabha||'', row.lengthKm||'', 'Active', row.remark||'']);
    _stampOwnerLastRow_(sheet);   // हर आयातित सड़क वर्तमान user की
    existing.push(rid);
    added++;
  });
  SBApp.flush();
  CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
  return { success: true, added: added, skipped: skipped, errors: errors };
}

// ══════════════════════════════════════════════════════════════
//  2_Road_Sections — CRUD + Bulk Import
// ══════════════════════════════════════════════════════════════

function ensureStructureChainageCol_(ss) {
  const sheet = ss.getSheetByName('2_Road_Sections');
  if (!sheet) return;
  const hdr = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0].map(h=>String(h).trim());
  if (hdr.includes('Structure_Chainage')) return;
  const sdIdx = hdr.indexOf('Structure_Detail');
  const col = sdIdx >= 0 ? sdIdx + 1 : sheet.getLastColumn() + 1;
  sheet.insertColumnBefore(col);
  sheet.getRange(1, col).setValue('Structure_Chainage')
    .setBackground('#1a3a5c').setFontColor('#fff').setFontWeight('bold');
  SBApp.flush();
}

// Vidhansabha / Loksabha — चैनेज-वार (अलग-अलग किमी0 के लिए अलग) कॉलम
function ensureSectionVsLsCols_(ss) {
  const sheet = ss.getSheetByName('2_Road_Sections');
  if (!sheet) return;
  const hdr = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0].map(h=>String(h).trim());
  ['Vidhansabha', 'Loksabha'].forEach(function(name) {
    if (hdr.indexOf(name) >= 0) return;
    const col = sheet.getLastColumn() + 1;
    sheet.getRange(1, col).setValue(name).setBackground('#1a3a5c').setFontColor('#fff').setFontWeight('bold');
    hdr.push(name);
  });
  SBApp.flush();
}

function ensureSectionColumns_(ss) {
  const sheet = ss.getSheetByName('2_Road_Sections');
  if (!sheet) return;
  const hdr = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0].map(h=>String(h).trim());
  if (!hdr.includes('Last_Work_Date')) {
    const c = sheet.getLastColumn() + 1;
    sheet.getRange(1,c).setValue('Last_Work_Date').setBackground('#1a3a5c').setFontColor('#fff').setFontWeight('bold');
  }
  SBApp.flush();
}

function genSectionId_(ss) {
  const rows = sheetToObjects_(ss, '2_Road_Sections');
  const max = rows.reduce((m,r) => {
    const n = parseInt((r.Section_ID||'').replace(/\D/g,'')) || 0;
    return n > m ? n : m;
  }, 0);
  return 'SEC' + String(max + 1).padStart(3, '0');
}

function addSection(data) {
  const ss = SBApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('2_Road_Sections');
  if (!sheet) return { success: false, msg: '2_Road_Sections Sheet नहीं मिली' };
  ensureStructureChainageCol_(ss);
  ensureSectionVsLsCols_(ss);
  const sid = genSectionId_(ss);
  const hdr = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0].map(h=>String(h).trim());
  const map = {
    Section_ID: sid, Road_ID: data.roadId||'',
    Chainage_From: data.chainageFrom||'', Chainage_To: data.chainageTo||'',
    KM_Number: data.kmNumber||'', Length_KM: data.lengthKm||'',
    Width_M: data.widthM||'', Top_Surface: data.topSurface||'',
    Last_Work_Month: data.lastWorkMonth||'', Last_Work_Year: data.lastWorkYear||'',
    Bituminous_MM: data.bituminousMm||'', Granular_MM: data.granularMm||'',
    Structure_Chainage: data.structureChainage||'',
    Structure_Detail: data.structureDetail||'', Remark: data.remark||'',
    Vidhansabha: data.vidhansabha||'', Loksabha: data.loksabha||''
  };
  sheet.appendRow(hdr.map(h => map[h] !== undefined ? map[h] : ''));
  SBApp.flush();
  CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
  return { success: true, sectionId: sid };
}

function updateSection(data) {
  const ss = SBApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('2_Road_Sections');
  if (!sheet) return { success: false, msg: '2_Road_Sections Sheet नहीं मिली' };
  ensureStructureChainageCol_(ss);
  ensureSectionVsLsCols_(ss);
  const vals = sheet.getDataRange().getValues();
  const hdr  = vals[0].map(h=>String(h).trim());
  const sidC = hdr.indexOf('Section_ID');
  const fieldMap = {
    Chainage_From: data.chainageFrom||'', Chainage_To: data.chainageTo||'',
    KM_Number: data.kmNumber||'', Length_KM: data.lengthKm||'',
    Width_M: data.widthM||'', Top_Surface: data.topSurface||'',
    Last_Work_Month: data.lastWorkMonth||'', Last_Work_Year: data.lastWorkYear||'',
    Bituminous_MM: data.bituminousMm||'', Granular_MM: data.granularMm||'',
    Structure_Chainage: data.structureChainage||'',
    Structure_Detail: data.structureDetail||'', Remark: data.remark||'',
    Vidhansabha: data.vidhansabha||'', Loksabha: data.loksabha||''
  };
  for (let r = 1; r < vals.length; r++) {
    if (String(vals[r][sidC]).trim() !== data.sectionId) continue;
    Object.entries(fieldMap).forEach(([k,v]) => {
      const c = hdr.indexOf(k); if (c >= 0) sheet.getRange(r+1, c+1).setValue(v);
    });
    SBApp.flush();
    CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
    return { success: true };
  }
  return { success: false, msg: 'Section ID नहीं मिला: ' + data.sectionId };
}

function deleteSection(sectionId) {
  const ss = SBApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('2_Road_Sections');
  if (!sheet) return { success: false, msg: '2_Road_Sections Sheet नहीं मिली' };
  const vals = sheet.getDataRange().getValues();
  const sidC = vals[0].map(h=>String(h).trim()).indexOf('Section_ID');
  for (let r = 1; r < vals.length; r++) {
    if (String(vals[r][sidC]).trim() !== sectionId) continue;
    sheet.deleteRow(r + 1);
    SBApp.flush();
    CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
    return { success: true };
  }
  return { success: false, msg: 'Section ID नहीं मिला' };
}

function bulkAddSections(rows) {
  const ss = SBApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('2_Road_Sections');
  if (!sheet) return { success: false, msg: '2_Road_Sections Sheet नहीं मिली' };
  ensureStructureChainageCol_(ss);
  const hdr = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0].map(h=>String(h).trim());
  let added = 0, errors = [];
  rows.forEach(row => {
    if (!row.chainageFrom && !row.chainageTo) { errors.push('खाली row'); return; }
    const sid = genSectionId_(ss);
    const map = {
      Section_ID: sid, Road_ID: row.roadId||'',
      Chainage_From: row.chainageFrom||'', Chainage_To: row.chainageTo||'',
      KM_Number: row.kmNumber||'', Length_KM: row.lengthKm||'',
      Width_M: row.widthM||'', Top_Surface: row.topSurface||'',
      Last_Work_Month: row.lastWorkMonth||'', Last_Work_Year: row.lastWorkYear||'',
      Bituminous_MM: row.bituminousMm||'', Granular_MM: row.granularMm||'',
      Structure_Chainage: row.structureChainage||'',
      Structure_Detail: row.structureDetail||'', Remark: row.remark||''
    };
    sheet.appendRow(hdr.map(h => map[h] !== undefined ? map[h] : ''));
    added++;
  });
  SBApp.flush();
  CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
  return { success: true, added: added, errors: errors };
}

// ── Batch Save: edited + new sections एक call में ────────────
function saveSectionsBatch(payload) {
  const errors = [];
  const addedIds = [];
  (payload.updates || []).forEach(function(data) {
    const r = updateSection(data);
    if (!r.success) errors.push(r.msg);
  });
  (payload.newRows || []).forEach(function(data) {
    const r = addSection(data);
    if (r.success) addedIds.push(r.sectionId);
    else errors.push(r.msg);
  });
  CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
  return { success: errors.length === 0, addedIds: addedIds, errors: errors };
}

// ══════════════════════════════════════════════════════════════
//  9_Road_Types — CRUD
// ══════════════════════════════════════════════════════════════

const DEFAULT_ROAD_TYPES = ['शाहरी मार्ग', 'ग्रामीण मार्ग', 'राज्य मार्ग', 'राष्ट्रीय मार्ग'];

function getRoadTypesList_() {
  const ss = SBApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('9_Road_Types');
  if (!sheet) return DEFAULT_ROAD_TYPES.slice();
  const vals = sheet.getDataRange().getValues();
  const types = vals.slice(1).map(r => String(r[0]).trim()).filter(Boolean);
  return types.length ? types : DEFAULT_ROAD_TYPES.slice();
}

function ensureRoadTypesSheet_(ss) {
  let sheet = ss.getSheetByName('9_Road_Types');
  if (!sheet) {
    sheet = ss.insertSheet('9_Road_Types');
    sheet.getRange(1,1).setValue('Road_Type').setBackground('#1a3a5c').setFontColor('#fff').setFontWeight('bold');
    sheet.setFrozenRows(1);
    DEFAULT_ROAD_TYPES.forEach(t => sheet.appendRow([t]));
    SBApp.flush();
  }
  return sheet;
}

function addRoadType(typeName) {
  var _g = _adminOnlyGuard_(); if (_g) return _g;
  typeName = String(typeName).trim();
  if (!typeName) return { success: false, msg: 'नाम खाली नहीं हो सकता' };
  const ss = SBApp.getActiveSpreadsheet();
  const sheet = ensureRoadTypesSheet_(ss);
  const existing = sheet.getDataRange().getValues().slice(1).map(r => String(r[0]).trim().toLowerCase());
  if (existing.includes(typeName.toLowerCase())) return { success: false, msg: '"' + typeName + '" पहले से मौजूद है' };
  sheet.appendRow([typeName]);
  SBApp.flush();
  CacheService.getScriptCache().remove(CACHE_KEY_S);
  return { success: true };
}

function updateRoadType(oldName, newName) {
  var _g = _adminOnlyGuard_(); if (_g) return _g;
  oldName = String(oldName).trim(); newName = String(newName).trim();
  if (!newName) return { success: false, msg: 'नाम खाली नहीं हो सकता' };
  const ss = SBApp.getActiveSpreadsheet();
  const sheet = ensureRoadTypesSheet_(ss);
  const vals = sheet.getDataRange().getValues();
  for (let r = 1; r < vals.length; r++) {
    if (String(vals[r][0]).trim() === oldName) {
      sheet.getRange(r+1, 1).setValue(newName);
      SBApp.flush();
      CacheService.getScriptCache().remove(CACHE_KEY_S);
      return { success: true };
    }
  }
  return { success: false, msg: '"' + oldName + '" नहीं मिला' };
}

function deleteRoadType(typeName) {
  var _g = _adminOnlyGuard_(); if (_g) return _g;
  typeName = String(typeName).trim();
  const ss = SBApp.getActiveSpreadsheet();
  const sheet = ensureRoadTypesSheet_(ss);
  const vals = sheet.getDataRange().getValues();
  for (let r = 1; r < vals.length; r++) {
    if (String(vals[r][0]).trim() === typeName) {
      sheet.deleteRow(r+1);
      SBApp.flush();
      CacheService.getScriptCache().remove(CACHE_KEY_S);
      return { success: true };
    }
  }
  return { success: false, msg: '"' + typeName + '" नहीं मिला' };
}

// ── नया Work Type जोड़ें ─────────────────────────────────────
function addWorkType(typeName) {
  var _g = _adminOnlyGuard_(); if (_g) return _g;
  typeName = String(typeName).trim();
  if (!typeName) return { success: false, msg: 'नाम खाली नहीं हो सकता' };

  const ss = SBApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('8_Work_Types');

  if (!sheet) {
    sheet = ss.insertSheet('8_Work_Types');
    const h = sheet.getRange(1, 1, 1, 1);
    h.setValue('Work_Type').setBackground('#1a3a5c').setFontColor('#fff').setFontWeight('bold');
    sheet.setFrozenRows(1);
    DEFAULT_WORK_TYPES.forEach(t => sheet.appendRow([t]));
  }

  const existing = sheet.getDataRange().getValues().slice(1)
    .map(r => String(r[0]).trim().toLowerCase());
  if (existing.includes(typeName.toLowerCase())) {
    return { success: false, msg: '"' + typeName + '" पहले से मौजूद है' };
  }

  sheet.appendRow([typeName]);
  CacheService.getScriptCache().remove(CACHE_KEY_S);
  return { success: true };
}

// ══════════════════════════════════════════════════════════════
//  3_Projects — CRUD
// ══════════════════════════════════════════════════════════════

function ensureProjColumns_(ss) {
  const sheet = ss.getSheetByName('3_Projects');
  if (!sheet) return;
  const hdr = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0].map(h=>String(h).trim());
  const newCols = ['Sanctioned_Length','Contractor_Name','Contract_Cost','Contract_GST_Pct','Contract_Cost_GST','Work_Type','Required_Docs','Contractor_Phone','Contract_No','Actual_End_Date','Maintenance_Years'];
  newCols.forEach(col => {
    if (!hdr.includes(col)) {
      const c = sheet.getLastColumn() + 1;
      sheet.getRange(1,c).setValue(col).setBackground('#1a3a5c').setFontColor('#fff').setFontWeight('bold');
    }
  });
  SBApp.flush();
}

function genProjectId_(ss) {
  // सबसे छोटा खाली क्रमांक दोबारा उपयोग करो (हटाई गई परियोजना का नंबर फिर भर जाए) —
  // ताकि PRJ001, PRJ002… में गैप न रहे। सिर्फ़ मौजूदा 3_Projects की IDs देखो;
  // addProject किसी बचे orphan डेटा को इस ID के लिए पहले ही साफ़ कर देता है।
  const used = {};
  sheetToObjects_(ss, '3_Projects').forEach(function(r) {
    const n = parseInt(String(r.Project_ID||'').replace(/\D/g,'')) || 0;
    if (n > 0) used[n] = true;
  });
  let n = 1;
  while (used[n]) n++;
  return 'PRJ' + String(n).padStart(3, '0');
}

function addProject(data) {
  const ss = SBApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('3_Projects');
  if (!sheet) return { success: false, msg: '3_Projects Sheet नहीं मिली' };
  ensureProjColumns_(ss);
  const pid = genProjectId_(ss);
  // सुरक्षा: यदि पुराने (त्रुटिपूर्ण) delete से इसी नए ID वाली orphan पंक्तियाँ कहीं बची हों तो हटा दो,
  // ताकि दोबारा उपयोग किया गया ID पुराने डेटा से न जुड़ जाए।
  purgeProjectRows_(ss, pid);
  const hdr = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0].map(h=>String(h).trim());
  const map = {
    Project_ID: pid,
    Project_Name: data.projectName||'',
    Project_Type: data.projectType||'',
    Work_Type: data.workType||'',
    Sanction_Date: data.sanctionDate||'',
    Total_Sanctioned_Amt: data.sanctionedAmt||'',
    Sanctioned_Length: data.sanctionedLength||'',
    Overall_Start_Date: data.startDate||'',
    Overall_End_Date: data.endDate||'',
    Contractor_Name: data.contractorName||'',
    Contractor_Phone: data.contractorPhone||'',
    Contract_No: data.contractNo||'',
    Contract_Cost: data.contractCost||'',
    Contract_GST_Pct: data.contractGstPct||'',
    Contract_Cost_GST: data.contractCostGst||'',
    Status: data.status||'Pending',
    Maintenance_Years: data.maintenanceYears||2,
    Remark: data.remark||''
  };
  sheet.appendRow(hdr.map(h => map[h] !== undefined ? map[h] : ''));
  _stampOwnerLastRow_(sheet);   // यह परियोजना वर्तमान user की
  SBApp.flush();
  CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
  return { success: true, projectId: pid };
}

// किसी Project_ID से जुड़ी सभी शीट (मुख्य को छोड़कर) की पंक्तियाँ हटाओ
const PROJECT_LINKED_SHEETS = ['3B_Project_Roads', '4_Documents', '8_Bills', '11_Conversations', '5_Letters', '6_Finance_Ledger'];
function purgeProjectRows_(ss, projectId) {
  projectId = String(projectId||'').trim();
  if (!projectId) return;
  PROJECT_LINKED_SHEETS.forEach(function(sName) {
    const s = ss.getSheetByName(sName);
    if (!s || s.getLastRow() < 2) return;
    const sv   = s.getDataRange().getValues();
    const pidI = sv[0].map(h => String(h).trim()).indexOf('Project_ID');
    if (pidI < 0) return;
    for (let r = sv.length - 1; r >= 1; r--) {
      if (String(sv[r][pidI]).trim() === projectId) s.deleteRow(r + 1);
    }
  });
}

// किसी परियोजना का Project_ID बदलो (सभी जुड़ी शीट में reference भी अपडेट) —
// गैप भरने/साफ़ क्रमांक (जैसे PRJ004 → PRJ001) के लिए
function renumberProject(oldId, newId) {
  oldId = String(oldId||'').trim();
  newId = String(newId||'').trim().toUpperCase();
  if (!oldId || !newId)  return { success: false, msg: 'पुराना व नया दोनों ID ज़रूरी हैं' };
  if (oldId === newId)   return { success: true };
  if (!/^PRJ\d{3,}$/.test(newId)) return { success: false, msg: 'नया ID रूप PRJxxx होना चाहिए (जैसे PRJ001)' };
  const ss = SBApp.getActiveSpreadsheet();
  const projSheet = ss.getSheetByName('3_Projects');
  if (!projSheet) return { success: false, msg: '3_Projects Sheet नहीं मिली' };
  const projs = sheetToObjects_(ss, '3_Projects');
  if (!projs.some(p => String(p.Project_ID).trim() === oldId))  return { success: false, msg: oldId + ' नहीं मिली' };
  if (projs.some(p => String(p.Project_ID).trim() === newId))   return { success: false, msg: newId + ' पहले से किसी परियोजना का है' };
  // हर शीट में Project_ID कॉलम पर oldId → newId
  ['3_Projects'].concat(PROJECT_LINKED_SHEETS).forEach(function(sName) {
    const s = ss.getSheetByName(sName);
    if (!s || s.getLastRow() < 2) return;
    const vals = s.getDataRange().getValues();
    const pidI = vals[0].map(h => String(h).trim()).indexOf('Project_ID');
    if (pidI < 0) return;
    for (let r = 1; r < vals.length; r++) {
      if (String(vals[r][pidI]).trim() === oldId) s.getRange(r + 1, pidI + 1).setValue(newId);
    }
  });
  SBApp.flush();
  CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
  return { success: true, oldId: oldId, newId: newId };
}

function updateProject(data) {
  const ss = SBApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('3_Projects');
  if (!sheet) return { success: false, msg: '3_Projects Sheet नहीं मिली' };
  ensureProjColumns_(ss);
  const vals = sheet.getDataRange().getValues();
  const hdr  = vals[0].map(h=>String(h).trim());
  const pidC = hdr.indexOf('Project_ID');
  const fieldMap = {
    Project_Name: data.projectName||'',
    Project_Type: data.projectType||'',
    Work_Type: data.workType||'',
    Sanction_Date: data.sanctionDate||'',
    Total_Sanctioned_Amt: data.sanctionedAmt||'',
    Sanctioned_Length: data.sanctionedLength||'',
    Overall_Start_Date: data.startDate||'',
    Overall_End_Date: data.endDate||'',
    Contractor_Name: data.contractorName||'',
    Contractor_Phone: data.contractorPhone||'',
    Contract_No: data.contractNo||'',
    Contract_Cost: data.contractCost||'',
    Contract_GST_Pct: data.contractGstPct||'',
    Contract_Cost_GST: data.contractCostGst||'',
    Status: data.status||'',
    Maintenance_Years: data.maintenanceYears||2,
    Remark: data.remark||''
  };
  for (let r = 1; r < vals.length; r++) {
    if (String(vals[r][pidC]).trim() !== data.projectId) continue;
    Object.entries(fieldMap).forEach(([k,v]) => {
      const c = hdr.indexOf(k); if (c >= 0) sheet.getRange(r+1,c+1).setValue(v);
    });
    SBApp.flush();
    CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
    return { success: true };
  }
  return { success: false, msg: 'Project ID नहीं मिला: ' + data.projectId };
}

function deleteProject(projectId) {
  const ss = SBApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('3_Projects');
  if (!sheet) return { success: false, msg: '3_Projects Sheet नहीं मिली' };

  // Find project row + get name for Drive folder lookup
  const vals = sheet.getDataRange().getValues();
  const hdr  = vals[0].map(h => String(h).trim());
  const pidC  = hdr.indexOf('Project_ID');
  const nameC = hdr.indexOf('Project_Name');
  let projectRow = -1, projectName = '';
  for (let r = 1; r < vals.length; r++) {
    if (String(vals[r][pidC]).trim() === projectId) {
      projectRow  = r + 1;
      projectName = nameC >= 0 ? String(vals[r][nameC]).trim() : '';
      break;
    }
  }
  if (projectRow === -1) return { success: false, msg: 'Project ID नहीं मिला' };

  // 1. Google Drive folder → Trash
  try {
    const pLabel  = projectId + (projectName ? ' — ' + projectName : '');
    const rmsFldr = getOrCreateFolder_(SBDrive.getRootFolder(), 'Road Management System');
    const it = rmsFldr.getFoldersByName(pLabel);
    while (it.hasNext()) it.next().setTrashed(true);
  } catch(e) { /* Drive error non-fatal — continue sheet cleanup */ }

  // 2. Delete related rows from linked sheets (reverse order to keep indices stable)
  purgeProjectRows_(ss, projectId);

  // 3. Delete main project row
  sheet.deleteRow(projectRow);

  SBApp.flush();
  CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
  return { success: true };
}

function dumpProject(projectId, reason) {
  const ss = SBApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('3_Projects');
  if (!sheet) return { success: false, msg: '3_Projects Sheet नहीं मिली' };
  ensureProjColumns_(ss);
  const vals = sheet.getDataRange().getValues();
  const hdr  = vals[0].map(h=>String(h).trim());
  const pidC = hdr.indexOf('Project_ID'), stC = hdr.indexOf('Status'), remC = hdr.indexOf('Remark');
  for (let r = 1; r < vals.length; r++) {
    if (String(vals[r][pidC]).trim() !== projectId) continue;
    if (stC  >= 0) sheet.getRange(r+1, stC+1).setValue('Dumped');
    if (remC >= 0 && reason) {
      const dt  = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy');
      const cur = String(vals[r][remC]||'').trim();
      sheet.getRange(r+1, remC+1).setValue((cur?cur+' ':'')+'[Dump: '+reason+' — '+dt+']');
    }
    SBApp.flush();
    CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
    return { success: true };
  }
  return { success: false, msg: 'Project ID नहीं मिला' };
}

function restoreProject(projectId) {
  const ss = SBApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('3_Projects');
  if (!sheet) return { success: false, msg: '3_Projects Sheet नहीं मिली' };
  const vals = sheet.getDataRange().getValues();
  const hdr  = vals[0].map(h=>String(h).trim());
  const pidC = hdr.indexOf('Project_ID'), stC = hdr.indexOf('Status');
  for (let r = 1; r < vals.length; r++) {
    if (String(vals[r][pidC]).trim() !== projectId) continue;
    if (stC >= 0) sheet.getRange(r+1, stC+1).setValue('Pending');
    SBApp.flush();
    CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
    return { success: true };
  }
  return { success: false, msg: 'Project ID नहीं मिला' };
}

// ── Annual Plan Sheet helper ──────────────────────────────────
function _ensurePlanCols_(sheet) {
  if (!sheet || sheet.getLastRow() < 1) return;
  const hdr = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const needed = ['Plan_ID','Road_ID','Road_Name','Year','Work_Type','Proposed_Work',
                  'Section_KM','Estimated_Cost','Priority','Status',
                  'Photo_Link','Inspection_Note_Link','Forwarding_Letter_Link'];
  needed.forEach(function(col) {
    if (hdr.indexOf(col) < 0) {
      const nc = sheet.getLastColumn() + 1;
      sheet.getRange(1, nc).setValue(col);
      hdr.push(col);
    }
  });
}

function _getPlanHdr_(sheet) {
  if (sheet.getLastRow() < 1) return [];
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
}

function _findPlanRow_(sheet, planId) {
  if (sheet.getLastRow() < 2) return -1;
  const hdr = _getPlanHdr_(sheet);
  const idC = hdr.indexOf('Plan_ID');
  if (idC < 0) return -1;
  const vals = sheet.getDataRange().getValues();
  for (let r = 1; r < vals.length; r++) {
    if (String(vals[r][idC]||'').trim() === planId) return r + 1; // 1-indexed
  }
  return -1;
}

// वित्त वर्ष (जैसे "2025-26") 31 मार्च को समाप्त माना जाता है — उसके बाद वह "बीत गया"
function _isPlanYearExpired_(yearStr) {
  const m = String(yearStr||'').trim().match(/^(\d{4})-(\d{2})$/);
  if (!m) return false;
  const fyEndYear = parseInt(m[1], 10) + 1;
  const fyEnd = new Date(fyEndYear, 2, 31, 23, 59, 59);
  return new Date().getTime() > fyEnd.getTime();
}

function _planRowExpired_(sheet, hdr, row) {
  const yC = hdr.indexOf('Year');
  if (yC < 0) return false;
  return _isPlanYearExpired_(sheet.getRange(row, yC+1).getValue());
}

// ══════════════════════════════════════════════════════════════
//  MB (Measurement Book) Items & Entries
// ══════════════════════════════════════════════════════════════
function _ensureMBSheets_(ss) {
  let items = ss.getSheetByName('12_MB_Items');
  if (!items) {
    items = ss.insertSheet('12_MB_Items');
    items.appendRow(['Item_ID','Project_ID','S_No','Description','Unit','Total_Qty','Rate','Amount','Upload_Date','Source_File']);
    items.getRange(1,1,1,10).setBackground('#1a3a5c').setFontColor('#fff').setFontWeight('bold');
    items.setFrozenRows(1);
    items.setColumnWidth(4, 300);
  }
  let entries = ss.getSheetByName('13_MB_Entries');
  if (!entries) {
    entries = ss.insertSheet('13_MB_Entries');
    entries.appendRow(['Entry_ID','Item_ID','Project_ID','Entry_Date','Bill_No','MB_No','Qty_Paid','Remark']);
    entries.getRange(1,1,1,8).setBackground('#1a3a5c').setFontColor('#fff').setFontWeight('bold');
    entries.setFrozenRows(1);
  }
  return { items, entries };
}

function saveMBItems(data) {
  // data: { projectId, items:[{sNo,description,unit,totalQty,rate,amount}], sourceFile, clearExisting }
  const ss = SBApp.getActiveSpreadsheet();
  const { items: sheet, entries: esheet } = _ensureMBSheets_(ss);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (data.clearExisting) {
      const delRows = (sh, pidCol) => {
        if (sh.getLastRow() < 2) return;
        const vals = sh.getDataRange().getValues();
        const toDelete = [];
        for (let r = 1; r < vals.length; r++) {
          if (String(vals[r][pidCol]).trim() === data.projectId) toDelete.push(r+1);
        }
        for (let i = toDelete.length-1; i >= 0; i--) sh.deleteRow(toDelete[i]);
      };
      const ih = sheet.getLastRow()>0 ? sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0] : [];
      const eh = esheet.getLastRow()>0 ? esheet.getRange(1,1,1,esheet.getLastColumn()).getValues()[0] : [];
      delRows(sheet,  ih.map(h=>String(h).trim()).indexOf('Project_ID'));
      delRows(esheet, eh.map(h=>String(h).trim()).indexOf('Project_ID'));
    }
    const now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy');
    const rows = (data.items||[]).map(function(item, i) {
      const itemId = 'MBI-'+data.projectId+'-'+String(i+1).padStart(4,'0');
      return [itemId, data.projectId, item.sNo||String(i+1), item.description||'',
              item.unit||'', item.totalQty||'', item.rate||'', item.amount||'', now, data.sourceFile||''];
    });
    if (rows.length) sheet.getRange(sheet.getLastRow()+1,1,rows.length,10).setValues(rows);
    CacheService.getScriptCache().remove(CACHE_KEY_S);
    return { success: true, count: rows.length };
  } catch(e) { return { success: false, error: e.message }; }
  finally { lock.releaseLock(); }
}

function addMBEntry(data) {
  // data: { itemId, projectId, entryDate, billNo, mbNo, qtyPaid, remark }
  try {
    const ss = SBApp.getActiveSpreadsheet();
    const { entries: sheet } = _ensureMBSheets_(ss);
    const entryId = 'MBE-'+Utilities.getUuid().substring(0,8).toUpperCase();
    sheet.appendRow([entryId, data.itemId, data.projectId, data.entryDate||'',
                     data.billNo||'', data.mbNo||'', Number(data.qtyPaid)||0, data.remark||'']);
    CacheService.getScriptCache().remove(CACHE_KEY_S);
    return { success: true, entryId };
  } catch(e) { return { success: false, error: e.message }; }
}

function updateMBEntry(data) {
  try {
    const ss = SBApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('13_MB_Entries');
    if (!sheet || sheet.getLastRow()<2) return { success:false, error:'Sheet नहीं मिली' };
    const vals = sheet.getDataRange().getValues();
    const hdr  = vals[0].map(h=>String(h).trim());
    const idC  = hdr.indexOf('Entry_ID');
    for (let r=1; r<vals.length; r++) {
      if (String(vals[r][idC]).trim()===data.entryId) {
        const set=(col,val)=>{const i=hdr.indexOf(col);if(i>=0)sheet.getRange(r+1,i+1).setValue(val===undefined?'':val);};
        set('Entry_Date', data.entryDate||'');
        set('Bill_No',    data.billNo||'');
        set('MB_No',      data.mbNo||'');
        set('Qty_Paid',   Number(data.qtyPaid)||0);
        set('Remark',     data.remark||'');
        CacheService.getScriptCache().remove(CACHE_KEY_S);
        return { success: true };
      }
    }
    return { success:false, error:'Entry नहीं मिली: '+data.entryId };
  } catch(e) { return { success:false, error:e.message }; }
}

function deleteMBEntry(data) {
  try {
    const ss = SBApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('13_MB_Entries');
    if (!sheet || sheet.getLastRow()<2) return { success:false, error:'Sheet नहीं मिली' };
    const vals = sheet.getDataRange().getValues();
    const hdr  = vals[0].map(h=>String(h).trim());
    const idC  = hdr.indexOf('Entry_ID');
    for (let r=1; r<vals.length; r++) {
      if (String(vals[r][idC]).trim()===data.entryId) {
        sheet.deleteRow(r+1);
        CacheService.getScriptCache().remove(CACHE_KEY_S);
        return { success: true };
      }
    }
    return { success:false, error:'Entry नहीं मिली' };
  } catch(e) { return { success:false, error:e.message }; }
}

function deleteMBItemsForProject(data) {
  try {
    const ss = SBApp.getActiveSpreadsheet();
    const { items: sheet, entries: esheet } = _ensureMBSheets_(ss);
    const pid = data.projectId;
    const delRows = (sh) => {
      if (sh.getLastRow()<2) return;
      const vals = sh.getDataRange().getValues();
      const pidC = vals[0].map(h=>String(h).trim()).indexOf('Project_ID');
      if (pidC<0) return;
      const toDelete = [];
      for (let r=1;r<vals.length;r++) if(String(vals[r][pidC]).trim()===pid) toDelete.push(r+1);
      for (let i=toDelete.length-1;i>=0;i--) sh.deleteRow(toDelete[i]);
    };
    delRows(sheet); delRows(esheet);
    CacheService.getScriptCache().remove(CACHE_KEY_S);
    return { success: true };
  } catch(e) { return { success:false, error:e.message }; }
}

// ── Annual Plan में Row जोड़ें ────────────────────────────────
function addToAnnualPlan(data) {
  const ss = SBApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('7_Annual_Plan');
  if (!sheet) return { success: false, msg: '7_Annual_Plan Sheet नहीं मिली — setupSheets() चलाएं' };

  _ensurePlanCols_(sheet);
  const hdr = _getPlanHdr_(sheet);

  const lastRow = sheet.getLastRow();
  const planId = 'AP' + String(lastRow).padStart(3, '0');

  const row = new Array(hdr.length).fill('');
  const set = (col, val) => { const i = hdr.indexOf(col); if (i >= 0) row[i] = val; };
  set('Plan_ID',      planId);
  set('Road_ID',      data.roadId       || '');
  set('Road_Name',    data.roadName     || '');
  set('Year',         data.year         || '');
  set('Work_Type',    data.workType     || '');
  set('Proposed_Work',data.proposedWork || '');
  set('Section_KM',   data.sectionKm    || '');
  set('Estimated_Cost',data.estimatedCost || '');
  set('Priority',     data.priority     || '');
  set('Status',       data.status       || 'Proposed');

  sheet.appendRow(row);
  CacheService.getScriptCache().remove(CACHE_KEY_S);
  return { success: true, planId: planId };
}

// ── Annual Plan: single field update ─────────────────────────
function updatePlanField(data) {
  try {
    const ss = SBApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('7_Annual_Plan');
    if (!sheet) return { success: false, error: '7_Annual_Plan sheet नहीं मिली' };
    _ensurePlanCols_(sheet);
    const hdr = _getPlanHdr_(sheet);
    const row = _findPlanRow_(sheet, data.planId);
    if (row < 0) return { success: false, error: 'Plan_ID नहीं मिला: ' + data.planId };
    if (_planRowExpired_(sheet, hdr, row)) return { success: false, error: 'यह कार्ययोजना वर्ष बीत चुका है — अब बदलाव संभव नहीं' };
    const colIdx = hdr.indexOf(data.field);
    if (colIdx < 0) return { success: false, error: 'Column नहीं मिला: ' + data.field };
    sheet.getRange(row, colIdx + 1).setValue(data.value || '');
    CacheService.getScriptCache().remove(CACHE_KEY_S);
    return { success: true };
  } catch(e) { return { success: false, error: e.message }; }
}

// ── Annual Plan: update multiple fields from edit modal ───────
function updatePlanEntry(data) {
  try {
    const ss = SBApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('7_Annual_Plan');
    if (!sheet) return { success: false, error: '7_Annual_Plan sheet नहीं मिली' };
    _ensurePlanCols_(sheet);
    const hdr = _getPlanHdr_(sheet);
    const row = _findPlanRow_(sheet, data.planId);
    if (row < 0) return { success: false, error: 'Plan_ID नहीं मिला: ' + data.planId };
    if (_planRowExpired_(sheet, hdr, row)) return { success: false, error: 'यह कार्ययोजना वर्ष बीत चुका है — अब बदलाव संभव नहीं' };
    const set = (col, val) => { const i = hdr.indexOf(col); if (i >= 0) sheet.getRange(row, i+1).setValue(val||''); };
    set('Proposed_Work', data.proposedWork || '');
    set('Section_KM',    data.sectionKm    || '');
    set('Estimated_Cost',data.estimatedCost|| '');
    set('Priority',      data.priority     || '');
    set('Status',        data.status       || 'Proposed');
    CacheService.getScriptCache().remove(CACHE_KEY_S);
    return { success: true };
  } catch(e) { return { success: false, error: e.message }; }
}

// ── Annual Plan: delete entry ─────────────────────────────────
function deletePlanEntry(data) {
  try {
    const ss = SBApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('7_Annual_Plan');
    if (!sheet) return { success: false, error: '7_Annual_Plan sheet नहीं मिली' };
    const row = _findPlanRow_(sheet, data.planId);
    if (row < 0) return { success: false, error: 'Plan_ID नहीं मिला: ' + data.planId };
    if (_planRowExpired_(sheet, _getPlanHdr_(sheet), row)) return { success: false, error: 'यह कार्ययोजना वर्ष बीत चुका है — अब हटाया नहीं जा सकता' };
    sheet.deleteRow(row);
    CacheService.getScriptCache().remove(CACHE_KEY_S);
    return { success: true };
  } catch(e) { return { success: false, error: e.message }; }
}

// ── Annual Plan: upload file to Drive ────────────────────────
function uploadPlanFile(data) {
  try {
    const ss = SBApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('7_Annual_Plan');
    if (!sheet) return { success: false, error: '7_Annual_Plan sheet नहीं मिली' };
    _ensurePlanCols_(sheet);
    const hdr = _getPlanHdr_(sheet);
    const row = _findPlanRow_(sheet, data.planId);
    if (row < 0) return { success: false, error: 'Plan_ID नहीं मिला: ' + data.planId };
    if (_planRowExpired_(sheet, hdr, row)) return { success: false, error: 'यह कार्ययोजना वर्ष बीत चुका है — अब बदलाव संभव नहीं' };

    const typeMap = {
      photo:      { col: 'Photo_Link',             folder: 'फोटो',         prefix: 'Photo' },
      inspection: { col: 'Inspection_Note_Link',   folder: 'निरीक्षण नोट', prefix: 'InspNote' },
      forwarding: { col: 'Forwarding_Letter_Link', folder: 'अग्रेषण पत्र', prefix: 'FwdLetter' }
    };
    const tm = typeMap[data.uploadType];
    if (!tm) return { success: false, error: 'Invalid uploadType: ' + data.uploadType };

    // Save to Drive under RMS/AnnualPlan/<year>/<workType>/<सड़क - Plan_ID>/<फोटो|निरीक्षण नोट|अग्रेषण पत्र>/
    // — हर category का अलग folder, जिसमें कई फाइलें जमा होती रहती हैं (View उसी folder को खोलता है)
    const rmsFolder = getRMSFolder_();
    const apFolder   = getOrCreateFolder_(rmsFolder, 'AnnualPlan');
    const planTypeFolder_ = (yr, wt, rname, pid) => {
      const yrFolder   = getOrCreateFolder_(apFolder,  yr   || 'Unknown_Year');
      const wtFolder   = getOrCreateFolder_(yrFolder,  wt   || 'Unknown_Type');
      const workFolder = getOrCreateFolder_(wtFolder,  (rname || 'Road') + ' - ' + pid);
      const tf = getOrCreateFolder_(workFolder, tm.folder);
      tf.setSharing(SBDrive.Access.ANYONE_WITH_LINK, SBDrive.Permission.VIEW);
      return tf;
    };

    const typeFolder = planTypeFolder_(data.year, data.workType, data.roadName, data.planId);

    const bytes = Utilities.base64Decode(data.base64);
    const blob  = Utilities.newBlob(bytes, data.mimeType, tm.prefix + '_' + data.fileName);
    const file  = typeFolder.createFile(blob);
    file.setSharing(SBDrive.Access.ANYONE_WITH_LINK, SBDrive.Permission.VIEW);
    const folderLink = typeFolder.getUrl();

    const colIdx = hdr.indexOf(tm.col);
    if (colIdx >= 0) sheet.getRange(row, colIdx + 1).setValue(folderLink);

    // यह फाइल कार्ययोजना की अन्य चुनी हुई सड़कों/कार्यों से भी संबंधित है —
    // उसी फाइल की copy उनके अपने-अपने folder में भी डालें, ताकि उनके View में भी दिखे
    const extraLinks = {};
    const extraPlanIds = Array.isArray(data.extraPlanIds) ? data.extraPlanIds : [];
    extraPlanIds.forEach(pid => {
      pid = String(pid || '').trim();
      if (!pid || pid === data.planId) return;
      const r2 = _findPlanRow_(sheet, pid);
      if (r2 < 0) return;
      if (_planRowExpired_(sheet, hdr, r2)) return;
      const rowVals = sheet.getRange(r2, 1, 1, hdr.length).getValues()[0];
      const get = (col) => { const i = hdr.indexOf(col); return i >= 0 ? rowVals[i] : ''; };
      const tFolder2 = planTypeFolder_(get('Year'), get('Work_Type'), get('Road_Name'), pid);
      const copy = file.makeCopy(tm.prefix + '_' + data.fileName, tFolder2);
      copy.setSharing(SBDrive.Access.ANYONE_WITH_LINK, SBDrive.Permission.VIEW);
      const link2 = tFolder2.getUrl();
      if (colIdx >= 0) sheet.getRange(r2, colIdx + 1).setValue(link2);
      extraLinks[pid] = link2;
    });

    CacheService.getScriptCache().remove(CACHE_KEY_S);
    return { success: true, link: folderLink, extraLinks: extraLinks };
  } catch(e) { return { success: false, error: e.message }; }
}

// ── Work Type → Status Code mapping ─────────────────────────
const WORK_TYPE_CODES = {
  'पैच मरम्मत':              'Running-Patch',
  'विशेष मरामत':             'Running-SR',
  'नवीनीकरण':               'Running-Renewal',
  'चौड़ीकरण एवं सुदृढीकरण': 'Running-WS',
  'पुल/पुलिया/सेतु मरम्मत': 'Running-Setu'
};

// ── Project_Type auto-update helper ─────────────────────────
function updateProjType_(ss, projectId) {
  if (!projectId) return;
  const prSheet   = ss.getSheetByName('3B_Project_Roads');
  const projSheet = ss.getSheetByName('3_Projects');
  if (!prSheet || !projSheet) return;

  let count = 0;
  if (prSheet.getLastRow() > 1) {
    const prVals = prSheet.getDataRange().getValues();
    const prPidC = prVals[0].map(h => String(h).trim()).indexOf('Project_ID');
    if (prPidC >= 0) {
      for (let r = 1; r < prVals.length; r++) {
        if (String(prVals[r][prPidC]||'').trim() === projectId) count++;
      }
    }
  }
  const type = count === 0 ? '' : count === 1 ? 'Single' : 'Multiple';

  const pVals = projSheet.getDataRange().getValues();
  const pHdr  = pVals[0].map(h => String(h).trim());
  const pidC  = pHdr.indexOf('Project_ID');
  const ptC   = pHdr.indexOf('Project_Type');
  if (pidC < 0 || ptC < 0) return;
  for (let r = 1; r < pVals.length; r++) {
    if (String(pVals[r][pidC]||'').trim() !== projectId) continue;
    projSheet.getRange(r+1, ptC+1).setValue(type);
    SBApp.flush();
    break;
  }
}

// ── Road को मौजूदा Project में जोड़ें ────────────────────────
function addRoadToProject(data) {
  const ss = SBApp.getActiveSpreadsheet();
  const prSheet = ss.getSheetByName('3B_Project_Roads');
  if (!prSheet) return { success: false, msg: '3B_Project_Roads Sheet नहीं मिली' };

  // 1. 3B_Project_Roads में Running status के साथ जोड़ें
  const prId = 'PR' + String(prSheet.getLastRow()).padStart(3, '0');
  prSheet.appendRow([
    prId,
    data.projectId    || '',
    data.roadId       || '',
    data.kmCovered    || '',
    data.workDesc     || '',
    data.sanctionedAmt|| '',
    data.startDate    || '',
    data.endDate      || '',
    'Running'          // project में जाते ही Running
  ]);

  // 2. Annual Plan में इस सड़क की active entries को Dropped करें
  let workType = '';
  const planSheet = ss.getSheetByName('7_Annual_Plan');
  if (planSheet && planSheet.getLastRow() > 1) {
    const planVals = planSheet.getDataRange().getValues();
    const hdr      = planVals[0].map(h => String(h).trim());
    const ridCol   = hdr.indexOf('Road_ID');
    const stCol    = hdr.indexOf('Status');
    const wtCol    = hdr.indexOf('Work_Type');

    for (let r = 1; r < planVals.length; r++) {
      const rowRid = String(planVals[r][ridCol] || '').trim();
      const rowSt  = String(planVals[r][stCol]  || '').trim();
      if (rowRid === data.roadId && rowSt !== 'Dropped') {
        // Work type capture करें (पहली active entry से)
        if (!workType && wtCol >= 0) {
          workType = String(planVals[r][wtCol] || '').trim();
        }
        planSheet.getRange(r + 1, stCol + 1).setValue('Dropped');
      }
    }
  }

  SBApp.flush();
  updateProjType_(ss, data.projectId);
  CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
  return { success: true, prId: prId, workType: workType };
}

// ── Project Road Update ──────────────────────────────────────
function updateProjectRoad(data) {
  const ss = SBApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('3B_Project_Roads');
  if (!sheet) return { success: false, msg: '3B_Project_Roads Sheet नहीं मिली' };
  const vals = sheet.getDataRange().getValues();
  const hdr  = vals[0].map(h => String(h).trim());
  const pridC = hdr.indexOf('PR_ID');
  const fieldMap = {
    KM_Numbers_Covered:  data.kmCovered    || '',
    Work_Description:    data.workDesc     || '',
    Road_Sanctioned_Amt: data.sanctionedAmt|| '',
    Road_Start_Date:     data.startDate    || '',
    Road_End_Date:       data.endDate      || '',
    Road_Status:         data.status       || 'Running'
  };
  for (let r = 1; r < vals.length; r++) {
    if (String(vals[r][pridC]).trim() !== data.prId) continue;
    Object.entries(fieldMap).forEach(([k, v]) => {
      const c = hdr.indexOf(k); if (c >= 0) sheet.getRange(r+1, c+1).setValue(v);
    });
    SBApp.flush();
    CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
    return { success: true };
  }
  return { success: false, msg: 'PR_ID नहीं मिला: ' + data.prId };
}

// ── Project Doc Settings ─────────────────────────────────────
function saveProjectDocSettings(projectId, catNos) {
  const ss    = SBApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('3_Projects');
  if (!sheet) return { success: false, msg: '3_Projects Sheet नहीं मिली' };
  ensureProjColumns_(ss);
  const vals = sheet.getDataRange().getValues();
  const hdr  = vals[0].map(h => String(h).trim());
  const pidC = hdr.indexOf('Project_ID');
  const rdC  = hdr.indexOf('Required_Docs');
  if (rdC < 0) return { success: false, msg: 'Required_Docs column नहीं मिला' };
  for (let r = 1; r < vals.length; r++) {
    if (String(vals[r][pidC]).trim() !== projectId) continue;
    sheet.getRange(r+1, rdC+1).setValue(catNos||'');
    SBApp.flush();
    CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
    return { success: true };
  }
  return { success: false, msg: 'Project ID नहीं मिला' };
}

// ── Document Delete ──────────────────────────────────────────
function deleteDocument(docId) {
  const ss    = SBApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('4_Documents');
  if (!sheet) return { success: false, msg: 'Sheet नहीं मिली' };
  const vals  = sheet.getDataRange().getValues();
  const hdr   = vals[0].map(h => String(h).trim());
  const docC  = hdr.indexOf('Doc_ID');
  const lnkC  = hdr.indexOf('Drive_Link');
  for (let r = 1; r < vals.length; r++) {
    if (String(vals[r][docC]).trim() !== docId) continue;
    const lnk   = String(vals[r][lnkC]||'').trim();
    const match = lnk.match(/\/(?:d|f)\/([a-zA-Z0-9_-]+)\//);
    sheet.deleteRow(r + 1);
    SBApp.flush();
    // Drive file हटाएं यदि कोई अन्य row इसे reference नहीं करती
    if (match) {
      try {
        const fileId    = match[1];
        const remaining = sheet.getDataRange().getValues();
        const stillUsed = remaining.some(row => String(row[lnkC]||'').includes(fileId));
        if (!stillUsed) SBDrive.getFileById(fileId).setTrashed(true);
      } catch(e) {}
    }
    CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
    return { success: true };
  }
  return { success: false, msg: 'Doc ID नहीं मिला: ' + docId };
}

// ── Document Meta Update ─────────────────────────────────────
function updateDocumentMeta(docId, subType) {
  const ss    = SBApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('4_Documents');
  if (!sheet) return { success: false, msg: 'Sheet नहीं मिली' };
  const vals = sheet.getDataRange().getValues();
  const hdr  = vals[0].map(h => String(h).trim());
  const docC = hdr.indexOf('Doc_ID');
  const stC  = hdr.indexOf('Sub_Type');
  for (let r = 1; r < vals.length; r++) {
    if (String(vals[r][docC]).trim() !== docId) continue;
    if (stC >= 0) sheet.getRange(r+1, stC+1).setValue(subType||'');
    SBApp.flush();
    CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
    return { success: true };
  }
  return { success: false, msg: 'Doc ID नहीं मिला: ' + docId };
}

// ── Missing Dates Auto-Fix ───────────────────────────────────
function fixMissingProjRoadDates() {
  const ss = SBApp.getActiveSpreadsheet();
  const prSheet = ss.getSheetByName('3B_Project_Roads');
  if (!prSheet || prSheet.getLastRow() < 2) return { fixed: 0, updates: [] };

  const projMap = {};
  sheetToObjects_(ss, '3_Projects').forEach(p => { projMap[p.Project_ID] = p; });

  const vals   = prSheet.getDataRange().getValues();
  const hdr    = vals[0].map(h => String(h).trim());
  const pridC  = hdr.indexOf('PR_ID');
  const projC  = hdr.indexOf('Project_ID');
  const startC = hdr.indexOf('Road_Start_Date');
  const endC   = hdr.indexOf('Road_End_Date');
  if (startC < 0 && endC < 0) return { fixed: 0, updates: [] };

  let fixed = 0;
  const updates = [];

  for (let r = 1; r < vals.length; r++) {
    const row      = vals[r];
    const startVal = String(row[startC] || '').trim();
    const endVal   = String(row[endC]   || '').trim();
    if (startVal && endVal) continue;

    const pid = String(row[projC] || '').trim();
    const prj = projMap[pid];
    if (!prj) continue;

    const newStart = !startVal ? (prj.Overall_Start_Date || '') : startVal;
    const newEnd   = !endVal   ? (prj.Overall_End_Date   || '') : endVal;
    if (!newStart && !newEnd) continue;

    if (!startVal && newStart && startC >= 0) prSheet.getRange(r+1, startC+1).setValue(newStart);
    if (!endVal   && newEnd   && endC   >= 0) prSheet.getRange(r+1, endC+1).setValue(newEnd);

    updates.push({ prId: String(row[pridC]||'').trim(), startDate: newStart, endDate: newEnd });
    fixed++;
  }

  if (fixed > 0) {
    SBApp.flush();
    CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
  }
  return { fixed: fixed, updates: updates };
}

// ── Project Road Delete ──────────────────────────────────────
function deleteProjectRoad(prId) {
  const ss = SBApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('3B_Project_Roads');
  if (!sheet) return { success: false, msg: '3B_Project_Roads Sheet नहीं मिली' };
  const vals  = sheet.getDataRange().getValues();
  const hdr   = vals[0].map(h => String(h).trim());
  const pridC = hdr.indexOf('PR_ID');
  const projC = hdr.indexOf('Project_ID');
  for (let r = 1; r < vals.length; r++) {
    if (String(vals[r][pridC]).trim() !== prId) continue;
    const projectId = String(vals[r][projC]||'').trim();
    sheet.deleteRow(r + 1);
    SBApp.flush();
    updateProjType_(ss, projectId);
    CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
    return { success: true, projectId: projectId };
  }
  return { success: false, msg: 'PR_ID नहीं मिला' };
}

// ══════════════════════════════════════════════════════════════
//  Google Drive — File Upload
// ══════════════════════════════════════════════════════════════

function getOrCreateFolder_(parent, name) {
  var folders = parent.getFoldersByName(name);
  if (folders.hasNext()) return folders.next();
  return parent.createFolder(name);
}

function getRMSFolder_() {
  return getOrCreateFolder_(SBDrive.getRootFolder(), 'Road Management System');
}

function uploadFileToDrive(payload) {
  try {
    var rmsFolder  = getRMSFolder_();
    var projLabel, catLabel;
    if (payload.projectId) {
      projLabel = (payload.projectId||'') + (payload.projectName ? ' — ' + payload.projectName : '');
      catLabel  = (payload.catNo||'') + '_' + (payload.catName||'General');
    } else {
      // Road-only general doc: Roads/[roadIds]/[subType]/
      var roadsFolder = getOrCreateFolder_(rmsFolder, 'Roads');
      var roadLabel = (payload.roadIds||'General');
      projLabel = null; // use roadsFolder directly
      var roadFolder = getOrCreateFolder_(roadsFolder, roadLabel);
      catLabel = payload.subType || 'General';
      var catFolder0 = getOrCreateFolder_(roadFolder, catLabel);
      var bytes0 = Utilities.base64Decode(payload.base64);
      var blob0  = Utilities.newBlob(bytes0, payload.mimeType||'application/octet-stream', payload.fileName);
      var file0  = catFolder0.createFile(blob0);
      file0.setSharing(SBDrive.Access.ANYONE_WITH_LINK, SBDrive.Permission.VIEW);
      var fileId0  = file0.getId();
      var viewUrl0 = file0.getUrl();
      var ss0   = SBApp.getActiveSpreadsheet();
      var sheet0= ss0.getSheetByName('4_Documents');
      var docId0= 'DOC000';
      if (sheet0) {
        var now0 = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy');
        docId0 = 'DOC'+String(sheet0.getLastRow()).padStart(3,'0');
        sheet0.appendRow([docId0,'',payload.roadIds||'','',payload.catName||'साधारण दस्तावेज़',payload.subType||'',payload.fileName,now0,'Web Upload',viewUrl0]);
        SBApp.flush();
        CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
      }
      return {success:true,docId:docId0,fileId:fileId0,viewUrl:viewUrl0,fileName:payload.fileName,catNo:'',catName:payload.catName||'',subType:payload.subType||'',projectId:'',uploadDate:Utilities.formatDate(new Date(),Session.getScriptTimeZone(),'dd/MM/yyyy')};
    }
    var projFolder = getOrCreateFolder_(rmsFolder, projLabel);
    var catFolder  = getOrCreateFolder_(projFolder, catLabel);

    var bytes = Utilities.base64Decode(payload.base64);
    var blob  = Utilities.newBlob(bytes, payload.mimeType || 'application/octet-stream', payload.fileName);
    var file  = catFolder.createFile(blob);
    file.setSharing(SBDrive.Access.ANYONE_WITH_LINK, SBDrive.Permission.VIEW);

    var fileId  = file.getId();
    var viewUrl = file.getUrl();

    // 4_Documents में save
    var ss    = SBApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('4_Documents');
    var docId = 'DOC000';
    if (sheet) {
      var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy');
      // Primary project row
      docId = 'DOC' + String(sheet.getLastRow()).padStart(3, '0');
      sheet.appendRow([
        docId,
        payload.projectId  || '',
        payload.roadIds    || '',
        payload.catNo      || '',
        payload.catName    || '',
        payload.subType    || '',
        payload.fileName,
        now,
        'Web Upload',
        viewUrl
      ]);
      // Linked (additional) projects — अलग-अलग rows
      var linked = payload.linkedProjectIds || [];
      linked.forEach(function(lpid) {
        lpid = String(lpid).trim();
        if (!lpid || lpid === payload.projectId) return;
        var lid = 'DOC' + String(sheet.getLastRow()).padStart(3, '0');
        sheet.appendRow([lid, lpid, '', payload.catNo||'', payload.catName||'',
          payload.subType||'', payload.fileName, now, 'Web Upload', viewUrl]);
      });
      CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
    }

    return {
      success:    true,
      docId:      docId,
      fileId:     fileId,
      viewUrl:    viewUrl,
      fileName:   payload.fileName,
      catNo:      payload.catNo    || '',
      catName:    payload.catName  || '',
      subType:    payload.subType  || '',
      projectId:  payload.projectId|| '',
      uploadDate: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy')
    };
  } catch(e) {
    return { success: false, msg: e.message };
  }
}

// ── Cache Clear ──────────────────────────────────────────────
// HTML से call होने पर सिर्फ cache clear करता है (no alert)
// Spreadsheet menu से call होने पर alert दिखाता है
function invalidateCache(fromMenu) {
  CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
  if (fromMenu) {
    SBApp.getUi().alert('✅ Cache साफ हो गया। अगली बार Dashboard fresh data load करेगा।');
  }
}

// Menu से call होने के लिए wrapper
function invalidateCacheFromMenu() {
  invalidateCache(true);
}

// ══════════════════════════════════════════════════════════════
//  SETUP — एक बार Run करें: सभी Sheets + Sample Data बनेगा
// ══════════════════════════════════════════════════════════════
function setupSheets() {
  const ss = SBApp.getActiveSpreadsheet();
  const ui = SBApp.getUi();

  const SHEETS_CONFIG = [
    {
      name: '1_Roads_Master',
      headers: ['Road_ID','Road_Name','Road_Type','Srishti_Code','Vidhansabha','Total_Length_KM','Status','Remark'],
      samples: [
        ['RD001','मुख्य बाजार से रेलवे स्टेशन मार्ग','शाहरी मार्ग','SC2023001','विधानसभा-1','5.20','Active',''],
        ['RD002','ग्राम रामपुर सम्पर्क मार्ग','ग्रामीण मार्ग','SC2022004','विधानसभा-2','3.80','Active',''],
        ['RD003','जिला मुख्यालय राज्य मार्ग','राज्य मार्ग','SC2021007','विधानसभा-1','12.50','Active',''],
        ['RD004','बाईपास राष्ट्रीय मार्ग','राष्ट्रीय मार्ग','SC2020010','विधानसभा-3','28.00','Active','NH-28 पर']
      ]
    },
    {
      name: '2_Road_Sections',
      headers: ['Section_ID','Road_ID','Chainage_From','Chainage_To','KM_Number','Length_KM',
                'Width_M','Top_Surface','Last_Work_Month','Last_Work_Year',
                'Bituminous_MM','Granular_MM','Structure_Chainage','Structure_Detail','Remark'],
      samples: [
        ['SEC001','RD001','0+000','2+600','KM 0-2','2.60','7.0','BC','03','2023','40','250','1+200','Culvert x2',''],
        ['SEC002','RD001','2+600','5+200','KM 2-5','2.60','7.0','WBM','','Running','','','','','कार्य जारी'],
        ['SEC003','RD002','0+000','3+800','KM 0-3','3.80','5.5','Gravel','06','2022','','200','','',''],
        ['SEC004','RD003','0+000','6+000','KM 0-6','6.00','10.0','BC','09','2021','50','300','3+000','Bridge KM3',''],
        ['SEC005','RD003','6+000','12+500','KM 6-12','6.50','10.0','WBM','','2021','','250','','',''],
        ['SEC006','RD004','0+000','14+000','KM 0-14','14.00','12.0','BC','12','2020','60','350','8+000','Overbridge KM8',''],
        ['SEC007','RD004','14+000','28+000','KM 14-28','14.00','12.0','BC','12','2020','60','350','','','']
      ]
    },
    {
      name: '3_Projects',
      headers: ['Project_ID','Project_Name','Project_Type','Sanction_Date',
                'Total_Sanctioned_Amt','Overall_Start_Date','Overall_End_Date','Status','Remark'],
      samples: [
        ['PRJ001','मुख्य बाजार मार्ग BC Overlay कार्य','Single Road','15/04/2023','4500000','01/06/2023','31/03/2024','Running',''],
        ['PRJ002','ग्रामीण सम्पर्क मार्ग निर्माण 2022','Multi Road','10/01/2022','8200000','01/03/2022','28/02/2023','Completed',''],
        ['PRJ003','राज्य मार्ग पुनर्निर्माण DPR','Single Road','05/07/2021','15000000','','','Pending','DPR तैयारी में'],
        ['PRJ004','बाईपास NH सुदृढ़ीकरण','Single Road','20/03/2020','32000000','01/06/2020','31/12/2020','Completed','']
      ]
    },
    {
      name: '3B_Project_Roads',
      headers: ['PR_ID','Project_ID','Road_ID','KM_Numbers_Covered','Work_Description',
                'Road_Sanctioned_Amt','Road_Start_Date','Road_End_Date','Road_Status'],
      samples: [
        ['PR001','PRJ001','RD001','KM 2-5','BC Overlay 40mm','4500000','01/06/2023','31/03/2024','Running'],
        ['PR002','PRJ002','RD002','KM 0-3','Gravel to WBM Upgrade','3000000','01/03/2022','28/02/2023','Completed'],
        ['PR003','PRJ002','RD003','KM 0-5','Shoulder Repair','5200000','01/03/2022','28/02/2023','Completed'],
        ['PR004','PRJ004','RD004','KM 0-28','BC Overlay 60mm + Drain','32000000','01/06/2020','31/12/2020','Completed']
      ]
    },
    {
      name: '4_Documents',
      headers: ['Doc_ID','Project_ID','Road_IDs','Category_No','Category_Name',
                'Sub_Type','File_Name','Upload_Date','Uploaded_By','Drive_Link'],
      samples: [
        ['DOC001','PRJ001','RD001','1','Estimate','Abstract Estimate','Abstract_PRJ001.pdf','15/04/2023','Office',''],
        ['DOC002','PRJ001','RD001','5','Drawing/Measurement','MB-1','MB_PRJ001_1.pdf','01/06/2023','Field',''],
        ['DOC003','PRJ001','RD001','6','Test Report/SLC/TAC','SLC Report','SLC_PRJ001.pdf','15/01/2024','Office',''],
        ['DOC004','PRJ002','RD002,RD003','1','Estimate','Detailed Estimate','DPR_PRJ002.pdf','10/01/2022','Office',''],
        ['DOC005','PRJ002','RD002','7','Site Photographs','Before Work','Photos_PRJ002_Before.zip','01/03/2022','Field',''],
        ['DOC006','PRJ004','RD004','8','Bill Copy','Final Bill','Bill_PRJ004_Final.pdf','15/01/2021','Office','']
      ]
    },
    {
      name: '5_Letters',
      headers: ['Letter_ID','Project_ID','Letter_No','Letter_Date','Direction',
                'Subject','Reply_Expected','Reply_Received','Reply_Date','Drive_Link'],
      samples: [
        ['LTR001','PRJ001','PWD/2023/1245','10/05/2023','Outgoing','कार्यारंभ आदेश हेतु अनुमति','Yes','Yes','15/05/2023',''],
        ['LTR002','PRJ001','DM/2023/456','20/07/2023','Incoming','Quality रिपोर्ट प्रेषण करें','Yes','Pending','',''],
        ['LTR003','PRJ001','PWD/2023/2001','05/09/2023','Outgoing','Extension of Time हेतु','Yes','Pending','',''],
        ['LTR004','PRJ002','PWD/2022/789','05/02/2022','Outgoing','भूमि अधिग्रहण हेतु NOC','No','No','',''],
        ['LTR005','PRJ004','NHAI/2020/312','10/11/2020','Incoming','Final Inspection रिपोर्ट','Yes','Yes','20/11/2020','']
      ]
    },
    {
      name: '6_Finance_Ledger',
      headers: ['Txn_ID','Project_ID','Date','Type','Amount','Running_Balance','Remark'],
      samples: [
        ['TXN001','PRJ001','01/07/2023','Fund Received','2000000','2000000','1st Instalment'],
        ['TXN002','PRJ001','15/07/2023','Expenditure','850000','1150000','Contractor Bill-1'],
        ['TXN003','PRJ001','01/11/2023','Fund Received','1500000','2650000','2nd Instalment'],
        ['TXN004','PRJ001','20/11/2023','Expenditure','1200000','1450000','Contractor Bill-2'],
        ['TXN005','PRJ002','01/04/2022','Fund Received','8200000','8200000','Full Amount'],
        ['TXN006','PRJ002','30/06/2022','Expenditure','4100000','4100000','Contractor Final Bill'],
        ['TXN007','PRJ002','15/07/2022','Expenditure','4100000','0','Retention Released'],
        ['TXN008','PRJ004','01/06/2020','Fund Received','32000000','32000000','Full Sanctioned'],
        ['TXN009','PRJ004','31/12/2020','Expenditure','31500000','500000','Contractor Final'],
        ['TXN010','PRJ004','28/02/2021','Expenditure','500000','0','Defect Liability']
      ]
    },
    {
      name: '7_Annual_Plan',
      headers: ['Plan_ID','Road_ID','Road_Name','Year','Work_Type','Proposed_Work',
                'Section_KM','Estimated_Cost','Priority','Status','Photo_Links'],
      samples: [
        ['AP001','RD001','मुख्य बाजार मार्ग','2025-26','नवीनीकरण','BC Overlay 50mm','KM 0-5','6000000','High','Sanctioned',''],
        ['AP002','RD002','ग्रामीण सम्पर्क मार्ग','2025-26','चौड़ीकरण एवं सुदृढीकरण','Widening 5.5M to 7M','KM 0-3','3500000','Medium','Proposed',''],
        ['AP003','RD003','जिला मुख्यालय मार्ग','2024-25','पैच मरम्मत','Patch Repair','KM 5-12','1200000','Low','Dropped',''],
        ['AP004','RD004','बाईपास राष्ट्रीय मार्ग','2025-26','विशेष मरामत','Drain Repair','KM 0-14','2000000','Medium','Proposed',''],
        ['AP005','RD002','ग्रामीण सम्पर्क मार्ग','2024-25','पुल/पुलिया/सेतु मरम्मत','Culvert Construction','KM 2','800000','High','Sanctioned','']
      ]
    },
    {
      name: '8_Work_Types',
      headers: ['Work_Type'],
      samples: [
        ['पैच मरम्मत'],
        ['विशेष मरामत'],
        ['नवीनीकरण'],
        ['चौड़ीकरण एवं सुदृढीकरण'],
        ['पुल/पुलिया/सेतु मरम्मत']
      ]
    }
  ];

  let created = 0;
  const skipped = [];
  const errors  = [];

  for (let i = 0; i < SHEETS_CONFIG.length; i++) {
    const cfg = SHEETS_CONFIG[i];

    if (ss.getSheetByName(cfg.name)) {
      skipped.push(cfg.name);
      continue;
    }

    try {
      const sh = ss.insertSheet(cfg.name);

      // Header + data — एक ही batch में write करें
      const totalRows = 1 + (cfg.samples ? cfg.samples.length : 0);
      const allData   = [cfg.headers].concat(cfg.samples || []);
      sh.getRange(1, 1, totalRows, cfg.headers.length).setValues(allData);

      // Header styling — एक range पर सब एकसाथ
      sh.getRange(1, 1, 1, cfg.headers.length)
        .setBackground('#1a3a5c')
        .setFontColor('#ffffff')
        .setFontWeight('bold');

      sh.setFrozenRows(1);
      // autoResizeColumns() हटाया — बहुत slow था
      // default row height set करें ताकि Hindi text दिखे
      sh.setRowHeight(1, 28);

      // हर sheet के बाद flush — partial save, timeout नहीं आएगा
      SBApp.flush();
      created++;

    } catch(e) {
      errors.push(cfg.name + ': ' + e.message);
    }
  }

  // Sheet1 delete करें अगर खाली हो
  try {
    const s1 = ss.getSheetByName('Sheet1');
    if (s1 && s1.getLastRow() <= 1 && ss.getSheets().length > 1) {
      ss.deleteSheet(s1);
      SBApp.flush();
    }
  } catch(e) {}

  let msg = '✅ Setup पूर्ण!\n\n';
  msg += '✔ ' + created + ' Sheets बनाई गईं\n';
  if (skipped.length) msg += '⏭ ' + skipped.length + ' पहले से थीं (skip): ' + skipped.join(', ') + '\n';
  if (errors.length)  msg += '❌ Errors: ' + errors.join('; ') + '\n';
  msg += '\n📌 अब करें:\nDeploy → New Deployment → Web App → Deploy';

  ui.alert('सड़क परियोजना प्रबंधन', msg, ui.ButtonSet.OK);
}

// ══════════════════════════════════════════════════════════════
//  9_Officers + 9B_Road_Officers — विभागीय अधिकारी प्रबंधन
// ══════════════════════════════════════════════════════════════

const DEPT_LIST_  = ['जल विभाग','विद्युत विभाग','गैस विभाग','दूरसंचार विभाग','नगर निगम / पालिका','लोक निर्माण विभाग','अन्य विभाग'];
const DESIG_LIST_ = ['अवर अभियंता (JE)','सहायक अभियंता (AE)','अधिशासी अभियंता (EE)','अधीक्षण अभियंता (SE)','मुख्य अभियंता (CE)','अन्य पद'];

function ensureOfficerSheets_(ss) {
  let sh9 = ss.getSheetByName('9_Officers');
  if (!sh9) {
    sh9 = ss.insertSheet('9_Officers');
    sh9.getRange(1,1,1,7).setValues([['Officer_ID','Name','Department','Designation','Phone','Email','Notes']])
      .setBackground('#1a3a5c').setFontColor('#fff').setFontWeight('bold');
    sh9.setFrozenRows(1);
    SBApp.flush();
  }
  let sh9b = ss.getSheetByName('9B_Road_Officers');
  if (!sh9b) {
    sh9b = ss.insertSheet('9B_Road_Officers');
    sh9b.getRange(1,1,1,4).setValues([['RO_ID','Road_ID','Officer_ID','Work_Description']])
      .setBackground('#1a3a5c').setFontColor('#fff').setFontWeight('bold');
    sh9b.setFrozenRows(1);
    SBApp.flush();
  }
  return { sh9, sh9b };
}

function ensureLetterDeptCol_(ss) {
  const sheet = ss.getSheetByName('5_Letters');
  if (!sheet) return;
  const hdr = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0].map(h=>String(h).trim());
  ['Department','Road_ID','Officer_ID','Reply_Date'].forEach(function(col) {
    if (!hdr.includes(col)) {
      sheet.getRange(1, sheet.getLastColumn()+1).setValue(col)
        .setBackground('#1a3a5c').setFontColor('#fff').setFontWeight('bold');
      SBApp.flush();
    }
  });
}

function ensureOfficerFullCols_(ss) {
  const sh9 = ss.getSheetByName('9_Officers');
  if (!sh9) return;
  const hdr = sh9.getRange(1,1,1,sh9.getLastColumn()).getValues()[0].map(h=>String(h).trim());
  ['Zone','Division','Level','Office_Address','Senior_Officer_ID'].forEach(function(col) {
    if (!hdr.includes(col)) {
      sh9.getRange(1, sh9.getLastColumn()+1).setValue(col)
        .setBackground('#1a3a5c').setFontColor('#fff').setFontWeight('bold');
      SBApp.flush();
    }
  });
}

// 9_Masters — विभाग / पद master lists
function ensureMasterSheet_(ss) {
  let sh = ss.getSheetByName('9_Masters');
  if (!sh) {
    sh = ss.insertSheet('9_Masters');
    sh.getRange(1,1,1,3).setValues([['Master_ID','Type','Value']])
      .setBackground('#1a3a5c').setFontColor('#fff').setFontWeight('bold');
    sh.setFrozenRows(1);
    const defaults = [
      ['MST001','DEPT','जल विभाग'],['MST002','DEPT','विद्युत विभाग'],
      ['MST003','DEPT','गैस विभाग'],['MST004','DEPT','दूरसंचार विभाग'],
      ['MST005','DEPT','नगर निगम / पालिका'],['MST006','DEPT','लोक निर्माण विभाग'],
      ['MST007','DESIG','मुख्य अभियंता'],['MST008','DESIG','अधीक्षण अभियंता'],
      ['MST009','DESIG','अधिशासी अभियंता'],['MST010','DESIG','सहायक अभियंता'],
      ['MST011','DESIG','अवर अभियंता'],['MST012','DESIG','साइट सूपरवाइजर']
    ];
    sh.getRange(2,1,defaults.length,3).setValues(defaults);
    SBApp.flush();
  }
  return sh;
}

function addMaster(type, value) {
  var _g = _adminOnlyGuard_(); if (_g) return _g;
  try {
    const ss = SBApp.getActiveSpreadsheet();
    const sh = ensureMasterSheet_(ss);
    const rows = sheetToObjects_(ss, '9_Masters');
    if (rows.find(r => r.Type===type && String(r.Value).trim()===String(value).trim())) return {success:false, msg:'पहले से मौजूद है'};
    const max = rows.reduce((m,r)=>{const n=parseInt((r.Master_ID||'').replace(/\D/g,''))||0;return n>m?n:m;},0);
    const id = 'MST'+String(max+1).padStart(3,'0');
    sh.appendRow([id, type, value]);
    SBApp.flush();
    CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
    return {success:true, id:id};
  } catch(e) {return {success:false, msg:e.message};}
}

function deleteMaster(masterId) {
  var _g = _adminOnlyGuard_(); if (_g) return _g;
  try {
    const ss = SBApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName('9_Masters');
    if (!sh) return {success:false};
    const vals = sh.getDataRange().getValues();
    const idC = vals[0].map(h=>String(h).trim()).indexOf('Master_ID');
    for (let r=vals.length-1; r>=1; r--) {
      if (String(vals[r][idC]).trim()===masterId) {
        sh.deleteRow(r+1);
        SBApp.flush();
        CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
        return {success:true};
      }
    }
    return {success:false, msg:'नहीं मिला'};
  } catch(e) {return {success:false, msg:e.message};}
}

function addRoadLetter(data) {
  try {
    const ss = SBApp.getActiveSpreadsheet();
    ensureLetterDeptCol_(ss);
    ensureLetterConvCol_(ss);
    const sheet = ss.getSheetByName('5_Letters');
    if (!sheet) return {success:false, msg:'5_Letters नहीं मिली'};
    const hdr = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0].map(h=>String(h).trim());
    const ltrId = 'LTR'+String(sheet.getLastRow()).padStart(3,'0');
    let viewUrl = '';
    if (data.base64 && data.fileName) {
      try {
        const road = sheetToObjects_(ss, '3_Roads').find(r => r.Road_ID===data.roadId) || {};
        const rLabel = (data.roadId||'') + (road.Road_Name ? ' — '+road.Road_Name : '');
        const rFolder = getOrCreateFolder_(getRMSFolder_(), 'Roads');
        const lFolder = getOrCreateFolder_(getOrCreateFolder_(rFolder, rLabel), '5_Letters');
        const blob = Utilities.newBlob(Utilities.base64Decode(data.base64), data.mimeType||'application/octet-stream', data.fileName);
        const file = lFolder.createFile(blob);
        file.setSharing(SBDrive.Access.ANYONE_WITH_LINK, SBDrive.Permission.VIEW);
        viewUrl = file.getUrl();
      } catch(e) {}
    }
    const map = {
      Letter_ID:      ltrId,
      Project_ID:     data.projectId    || '',
      Road_ID:        data.roadId       || '',
      Conv_ID:        data.convId       || '',
      Reply_To:       data.replyToId    || '',
      Officer_ID:     data.officerId    || '',
      Department:     data.department   || '',
      Post_Name:      data.postName     || '',
      Division:       data.division     || '',
      Letter_No:      data.letterNo     || '',
      Letter_Date:    data.letterDate   || '',
      Direction:      data.direction    || 'Outgoing',
      Subject:        data.subject      || '',
      Reply_Expected: data.replyExpected|| 'No',
      Reply_Received: 'Pending',
      Reply_Date:     '',
      Drive_Link:     viewUrl
    };
    sheet.appendRow(hdr.map(h => map[h]!==undefined ? map[h] : ''));
    SBApp.flush();
    CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
    const letter = {}; hdr.forEach(h => letter[h] = map[h]!==undefined ? map[h] : '');
    return {success:true, ltrId:ltrId, letter:letter, viewUrl:viewUrl};
  } catch(e) {return {success:false, msg:e.message};}
}

function genOfficerId_(ss) {
  const rows = sheetToObjects_(ss, '9_Officers');
  const max = rows.reduce((m,r) => { const n=parseInt((r.Officer_ID||'').replace(/\D/g,''))||0; return n>m?n:m; }, 0);
  return 'OFC' + String(max+1).padStart(3,'0');
}

function genRoId_(ss) {
  const rows = sheetToObjects_(ss, '9B_Road_Officers');
  const max = rows.reduce((m,r) => { const n=parseInt((r.RO_ID||'').replace(/\D/g,''))||0; return n>m?n:m; }, 0);
  return 'RO' + String(max+1).padStart(3,'0');
}

function getOfficerData() {
  const ss = SBApp.getActiveSpreadsheet();
  ensureOfficerSheets_(ss);
  ensureOfficerFullCols_(ss);
  ensureLetterDeptCol_(ss);
  ensureMasterSheet_(ss);
  const masters = sheetToObjects_(ss, '9_Masters');
  const deptList  = masters.filter(m=>m.Type==='DEPT').map(m=>m.Value);
  const desigList = masters.filter(m=>m.Type==='DESIG').map(m=>m.Value);
  return {
    officers:     sheetToObjects_(ss, '9_Officers'),
    roadOfficers: sheetToObjects_(ss, '9B_Road_Officers'),
    masters:      masters,
    deptList:     deptList.length  ? deptList  : DEPT_LIST_,
    desigList:    desigList.length ? desigList : DESIG_LIST_
  };
}

function addOfficer(data) {
  try {
    const ss = SBApp.getActiveSpreadsheet();
    ensureOfficerSheets_(ss);
    ensureOfficerFullCols_(ss);
    const sheet = ss.getSheetByName('9_Officers');
    const id = genOfficerId_(ss);
    const hdr = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0].map(h=>String(h).trim());
    const map = {
      Officer_ID: id, Name: data.Name||'', Department: data.Department||'',
      Zone: data.Zone||'', Division: data.Division||'', Level: data.Level||'',
      Designation: data.Designation||'', Phone: data.Phone||'', Email: data.Email||'',
      Office_Address: data.Office_Address||'', Notes: data.Notes||'',
      Senior_Officer_ID: data.Senior_Officer_ID||''
    };
    sheet.appendRow(hdr.map(h => map[h]!==undefined ? map[h] : ''));
    SBApp.flush();
    CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
    const officer = {}; hdr.forEach(h => officer[h] = map[h]!==undefined ? map[h] : '');
    return { success:true, id:id, officer:officer };
  } catch(e) { return { success:false, msg:e.message }; }
}

function updateOfficer(officerId, data) {
  try {
    const ss = SBApp.getActiveSpreadsheet();
    ensureOfficerSheets_(ss);
    ensureOfficerFullCols_(ss);
    const sheet = ss.getSheetByName('9_Officers');
    if (!sheet) return { success:false, msg:'Sheet नहीं मिली' };
    const vals = sheet.getDataRange().getValues();
    const hdr = vals[0].map(h=>String(h).trim());
    const hMap = {}; hdr.forEach((h,i)=>hMap[h]=i);
    for (let r=1; r<vals.length; r++) {
      if (String(vals[r][hMap['Officer_ID']]).trim() === officerId) {
        const row = sheet.getRange(r+1,1,1,hdr.length);
        const rv = row.getValues()[0];
        ['Name','Department','Designation','Phone','Email','Notes',
         'Zone','Division','Level','Office_Address','Senior_Officer_ID'].forEach(f => { if (data[f]!==undefined && hMap[f]!==undefined) rv[hMap[f]]=data[f]; });
        row.setValues([rv]);
        SBApp.flush();
        CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
        return { success:true };
      }
    }
    return { success:false, msg:'Officer नहीं मिला' };
  } catch(e) { return { success:false, msg:e.message }; }
}

function deleteOfficer(officerId) {
  try {
    const ss = SBApp.getActiveSpreadsheet();
    ensureOfficerSheets_(ss);
    const sh9b = ss.getSheetByName('9B_Road_Officers');
    if (sh9b && sh9b.getLastRow() > 1) {
      const v = sh9b.getDataRange().getValues();
      const ofcC = v[0].map(h=>String(h).trim()).indexOf('Officer_ID');
      for (let r=v.length-1; r>=1; r--) { if (String(v[r][ofcC]).trim()===officerId) sh9b.deleteRow(r+1); }
    }
    const sh9 = ss.getSheetByName('9_Officers');
    if (!sh9) return { success:false };
    const vals = sh9.getDataRange().getValues();
    const idC = vals[0].map(h=>String(h).trim()).indexOf('Officer_ID');
    for (let r=vals.length-1; r>=1; r--) {
      if (String(vals[r][idC]).trim()===officerId) {
        sh9.deleteRow(r+1);
        SBApp.flush();
        CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
        return { success:true };
      }
    }
    return { success:false, msg:'Officer नहीं मिला' };
  } catch(e) { return { success:false, msg:e.message }; }
}

function linkOfficerToRoad(data) {
  try {
    const ss = SBApp.getActiveSpreadsheet();
    const { sh9b } = ensureOfficerSheets_(ss);
    const existing = sheetToObjects_(ss, '9B_Road_Officers');
    const dup = existing.find(r => r.Road_ID===data.roadId && r.Officer_ID===data.officerId);
    if (dup) return { success:false, msg:'यह अधिकारी इस सड़क से पहले से जुड़ा है' };
    const id = genRoId_(ss);
    sh9b.appendRow([id, data.roadId||'', data.officerId||'', data.workDescription||'']);
    SBApp.flush();
    CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
    return { success:true, id:id };
  } catch(e) { return { success:false, msg:e.message }; }
}

function unlinkOfficerFromRoad(roId) {
  try {
    const ss = SBApp.getActiveSpreadsheet();
    ensureOfficerSheets_(ss);
    const sheet = ss.getSheetByName('9B_Road_Officers');
    if (!sheet) return { success:false };
    const vals = sheet.getDataRange().getValues();
    const idC = vals[0].map(h=>String(h).trim()).indexOf('RO_ID');
    for (let r=vals.length-1; r>=1; r--) {
      if (String(vals[r][idC]).trim()===roId) {
        sheet.deleteRow(r+1);
        SBApp.flush();
        CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
        return { success:true };
      }
    }
    return { success:false, msg:'नहीं मिला' };
  } catch(e) { return { success:false, msg:e.message }; }
}

function syncOfficerRoads(officerId, roadIds) {
  try {
    const ss = SBApp.getActiveSpreadsheet();
    const sh9b = ss.getSheetByName('9B_Road_Officers');
    if (!sh9b) return {success:false, msg:'9B_Road_Officers नहीं मिली'};
    if (sh9b.getLastRow() > 1) {
      const vals = sh9b.getDataRange().getValues();
      const hdr = vals[0].map(h=>String(h).trim());
      const oidC = hdr.indexOf('Officer_ID');
      const ridC = hdr.indexOf('Road_ID');
      for (let r=vals.length-1; r>=1; r--) {
        if (String(vals[r][oidC]).trim()===officerId) {
          const rid = String(vals[r][ridC]).trim();
          if ((roadIds||[]).indexOf(rid)<0) sh9b.deleteRow(r+1);
        }
      }
      SBApp.flush();
    }
    const existing = sheetToObjects_(ss, '9B_Road_Officers')
      .filter(r=>r.Officer_ID===officerId).map(r=>r.Road_ID);
    (roadIds||[]).forEach(function(rid) {
      if (!rid || existing.indexOf(rid)>=0) return;
      const roId = genRoId_(ss);
      sh9b.appendRow([roId, rid, officerId, '']);
      existing.push(rid);
    });
    SBApp.flush();
    CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
    return {success:true};
  } catch(e) { return {success:false, msg:e.message}; }
}

function updateLetterDepartment(letterId, department) {
  try {
    const ss = SBApp.getActiveSpreadsheet();
    ensureLetterDeptCol_(ss);
    const sheet = ss.getSheetByName('5_Letters');
    if (!sheet) return { success:false };
    const vals = sheet.getDataRange().getValues();
    const hdr = vals[0].map(h=>String(h).trim());
    const lidC = hdr.indexOf('Letter_ID');
    const dptC = hdr.indexOf('Department');
    if (dptC<0) return { success:false, msg:'Department column नहीं मिला' };
    for (let r=1; r<vals.length; r++) {
      if (String(vals[r][lidC]).trim()===letterId) {
        sheet.getRange(r+1,dptC+1).setValue(department||'');
        SBApp.flush();
        CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
        return { success:true };
      }
    }
    return { success:false, msg:'Letter नहीं मिला' };
  } catch(e) { return { success:false, msg:e.message }; }
}

function markReplyReceived(letterId) {
  try {
    const ss = SBApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('5_Letters');
    if (!sheet) return { success:false, msg:'Letters sheet नहीं मिली' };
    const vals = sheet.getDataRange().getValues();
    const hdr  = vals[0].map(h=>String(h).trim());
    const lidC = hdr.indexOf('Letter_ID');
    const rrC  = hdr.indexOf('Reply_Received');
    const rdC  = hdr.indexOf('Reply_Date');
    if (lidC<0||rrC<0) return { success:false, msg:'Column नहीं मिला' };
    const today = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'dd/MM/yyyy');
    for (let r=1; r<vals.length; r++) {
      if (String(vals[r][lidC]).trim()===letterId) {
        sheet.getRange(r+1, rrC+1).setValue('Yes');
        if (rdC>=0) sheet.getRange(r+1, rdC+1).setValue(today);
        SBApp.flush();
        CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
        return { success:true };
      }
    }
    return { success:false, msg:'Letter नहीं मिला' };
  } catch(e) { return { success:false, msg:e.message }; }
}

// ── Spreadsheet Menu ────────────────────────────────────────
function onOpen() {
  SBApp.getUi()
    .createMenu('🛣️ Road Management')
    .addItem('📊 Dashboard खोलें (Dialog)', 'openDialog')
    .addItem('📊 Dashboard खोलें (Sidebar)', 'openSidebar')
    .addSeparator()
    .addItem('🔄 Cache Clear करें (data edit करने के बाद)', 'invalidateCacheFromMenu')
    .addSeparator()
    .addItem('⚙️ Sheets Setup करें (पहली बार)', 'setupSheets')
    .addToUi();
}

function openDialog() {
  const html = HtmlService.createHtmlOutputFromFile('Dashboard')
    .setWidth(1200).setHeight(720);
  SBApp.getUi().showModalDialog(html, 'सड़क परियोजना प्रबंधन प्रणाली');
}

function openSidebar() {
  const html = HtmlService.createHtmlOutputFromFile('Dashboard')
    .setTitle('Road Management');
  SBApp.getUi().showSidebar(html);
}

// ══════════════════════════════════════════════════════════════
// OFC — विभागीय अधिकारी प्रबंधन (Dedicated OFC_* Sheets)
// ══════════════════════════════════════════════════════════════

var OFC_SHEETS_ = {
  OFC_Depts:     ['Dept_ID','Dept_Name','Notes'],
  OFC_Officers:  ['Officer_ID','Dept_ID','Officer_Name','Designation','Level_Rank','Senior_Officer_ID','Khand_Zone','Address','Phone','Phone2','Email','Notes'],
  OFC_RoadLinks: ['Map_ID','Road_ID','Officer_ID'],
  OFC_Letters:   ['Letter_ID','Letter_No','Letter_Date','Dept_ID','Officer_ID','Road_IDs','Subject','Status','Reply_Date','Notes']
};

function ofcSetup_(ss) {
  Object.keys(OFC_SHEETS_).forEach(function(name) {
    var sh = ss.getSheetByName(name);
    var cols = OFC_SHEETS_[name];
    if (!sh) {
      sh = ss.insertSheet(name);
      sh.getRange(1, 1, 1, cols.length).setValues([cols])
        .setFontWeight('bold').setBackground('#1a237e').setFontColor('#ffffff');
      sh.setFrozenRows(1);
    } else {
      // Ensure any newly added columns exist in existing sheets
      var lastCol = sh.getLastColumn();
      var hdr = lastCol > 0 ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h){ return String(h).trim(); }) : [];
      cols.forEach(function(col) {
        if (hdr.indexOf(col) < 0) {
          var c = sh.getLastColumn() + 1;
          sh.getRange(1, c).setValue(col)
            .setFontWeight('bold').setBackground('#1a237e').setFontColor('#ffffff');
          hdr.push(col);
        }
      });
    }
  });
}

function ofcRead_(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  var cols = OFC_SHEETS_[name];
  var readCols = Math.min(cols.length, sh.getLastColumn());
  var vals = sh.getRange(1, 1, sh.getLastRow(), readCols).getValues();
  var out = [];
  for (var r = 1; r < vals.length; r++) {
    var obj = {};
    for (var c = 0; c < cols.length; c++) {
      var v = c < readCols ? vals[r][c] : undefined;
      if (v instanceof Date) v = Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      obj[cols[c]] = (v === null || v === undefined) ? '' : String(v);
    }
    if (obj[cols[0]]) out.push(obj);
  }
  return out;
}

function ofcGetAllData() {
  var ss = SBApp.getActiveSpreadsheet();
  ofcSetup_(ss);
  return {
    departments: ofcRead_(ss, 'OFC_Depts'),
    officers:    ofcRead_(ss, 'OFC_Officers'),
    roadLinks:   ofcRead_(ss, 'OFC_RoadLinks'),
    letters:     ofcRead_(ss, 'OFC_Letters')
  };
}

function ofcNewId_(prefix) {
  return prefix + '-' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyMMddHHmmss') + '-' + Math.floor(Math.random() * 900 + 100);
}

function ofcSaveRecord(sheetName, record) {
  if (!OFC_SHEETS_[sheetName]) throw new Error('Invalid OFC sheet: ' + sheetName);
  try {
    var ss = SBApp.getActiveSpreadsheet();
    ofcSetup_(ss); // Ensure all columns exist (e.g. Phone2 on existing sheets)
    var sh = ss.getSheetByName(sheetName);
    var cols = OFC_SHEETS_[sheetName];
    var idCol = cols[0];
    var prefixMap = {OFC_Depts:'OD', OFC_Officers:'OO', OFC_RoadLinks:'OL', OFC_Letters:'OT'};
    var isNew = !record[idCol];
    if (isNew) record[idCol] = ofcNewId_(prefixMap[sheetName] || 'OX');
    var row = cols.map(function(h) { return record[h] !== undefined && record[h] !== null ? record[h] : ''; });
    var last = sh.getLastRow();
    var foundRow = -1;
    if (last >= 2) {
      var allData = sh.getRange(2, 1, last - 1, cols.length).getValues();
      var nameIdx = cols.indexOf('Officer_Name'), deptIdx = cols.indexOf('Dept_ID');
      for (var i = 0; i < allData.length; i++) {
        // Match by Officer_ID
        if (String(allData[i][0]) === String(record[idCol])) { foundRow = i + 2; break; }
        // For new officers: block duplicate name+dept
        if (isNew && sheetName === 'OFC_Officers' && nameIdx >= 0 && deptIdx >= 0) {
          var existName = String(allData[i][nameIdx]).trim().toLowerCase();
          var existDept = String(allData[i][deptIdx]).trim();
          var newName   = String(record['Officer_Name']||'').trim().toLowerCase();
          var newDept   = String(record['Dept_ID']||'').trim();
          if (existName === newName && existDept === newDept && newName !== '-') {
            // Duplicate found — update existing row instead of inserting
            foundRow = i + 2;
            record[idCol] = String(allData[i][0]); // use existing ID
            row = cols.map(function(h) { return record[h] !== undefined && record[h] !== null ? record[h] : ''; });
            break;
          }
        }
      }
    }
    if (foundRow > 0) {
      sh.getRange(foundRow, 1, 1, cols.length).setValues([row]);
    } else {
      sh.appendRow(row);
    }
    if (sheetName === 'OFC_Officers') ofcCascadeLevels_(ss, String(record[idCol]));
    CacheService.getScriptCache().remove(CACHE_KEY_S);
    return record;
  } catch(e) { return { success:false, msg:e.message }; }
}

// Officer save के बाद junior chain का Level_Rank auto-update करता है
function ofcCascadeLevels_(ss, startOfficerId) {
  try {
    var sh = ss.getSheetByName('OFC_Officers');
    if (!sh || sh.getLastRow() < 2) return;
    var cols = OFC_SHEETS_.OFC_Officers;
    var oidIdx = cols.indexOf('Officer_ID');
    var sidIdx = cols.indexOf('Senior_Officer_ID');
    var lrkIdx = cols.indexOf('Level_Rank');
    var readCols = Math.min(cols.length, sh.getLastColumn());
    var data = sh.getRange(2, 1, sh.getLastRow() - 1, readCols).getValues();
    // Build lookup: officerId → {dataIndex, level}
    var map = {};
    for (var i = 0; i < data.length; i++) {
      map[String(data[i][oidIdx])] = { i: i, level: parseInt(data[i][lrkIdx]) || 0 };
    }
    // BFS cascade from saved officer downward through chain
    var queue = [startOfficerId], visited = {};
    while (queue.length) {
      var curId = queue.shift();
      if (visited[curId]) continue;
      visited[curId] = true;
      var cur = map[curId];
      if (!cur) continue;
      var expected = cur.level + 1;
      for (var j = 0; j < data.length; j++) {
        if (String(data[j][sidIdx]) !== curId) continue;
        var jId = String(data[j][oidIdx]);
        if (!visited[jId]) {
          if ((parseInt(data[j][lrkIdx]) || 0) !== expected) {
            data[j][lrkIdx] = expected;
            map[jId].level = expected;
            sh.getRange(j + 2, lrkIdx + 1).setValue(expected);
          }
          queue.push(jId);
        }
      }
    }
  } catch(e) {}
}

function ofcDeleteRecord(sheetName, id) {
  if (!OFC_SHEETS_[sheetName]) throw new Error('Invalid OFC sheet: ' + sheetName);
  try {
    var ss = SBApp.getActiveSpreadsheet();
    ofcSetup_(ss);
    var sh = ss.getSheetByName(sheetName);
    if (!sh || sh.getLastRow() < 2) return false;

    if (sheetName === 'OFC_Officers') {
      var cols = OFC_SHEETS_.OFC_Officers;
      var readCols = Math.min(cols.length, sh.getLastColumn());
      var oidIdx = cols.indexOf('Officer_ID');
      var sidIdx = cols.indexOf('Senior_Officer_ID');
      var lrkIdx = cols.indexOf('Level_Rank');
      var data = sh.getRange(2, 1, sh.getLastRow() - 1, readCols).getValues();

      // Find deleted officer's row and their own senior
      var delRow = -1, delSenior = '';
      for (var i = 0; i < data.length; i++) {
        if (String(data[i][oidIdx]) === String(id)) {
          delRow = i; delSenior = String(data[i][sidIdx] || '').trim(); break;
        }
      }
      if (delRow < 0) return false;

      // Rewire: officers whose senior = deleted → deleted's senior (chain preserved)
      for (var i = 0; i < data.length; i++) {
        if (i === delRow) continue;
        if (String(data[i][sidIdx]) !== String(id)) continue;
        sh.getRange(i + 2, sidIdx + 1).setValue(delSenior);
        // If deleted was a root and juniors now become roots → set Level_Rank=1
        if (!delSenior) sh.getRange(i + 2, lrkIdx + 1).setValue(1);
      }

      // Delete officer row (after rewiring so indices are still valid)
      sh.deleteRow(delRow + 2);
      ofcCleanupLinks_(ss, 'Officer_ID', id);

      // Cascade: from senior (if exists) or from newly promoted roots
      if (delSenior) {
        ofcCascadeLevels_(ss, delSenior);
      } else {
        // Roots: re-read fresh data after row delete and cascade each
        if (sh.getLastRow() > 1) {
          var fresh = sh.getRange(2, 1, sh.getLastRow() - 1, readCols).getValues();
          for (var i = 0; i < fresh.length; i++) {
            if (!String(fresh[i][sidIdx]).trim()) {
              ofcCascadeLevels_(ss, String(fresh[i][oidIdx]));
            }
          }
        }
      }

      CacheService.getScriptCache().remove(CACHE_KEY_S);
      return true;
    }

    // Generic delete for Depts / RoadLinks / Letters
    var ids = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === String(id)) {
        sh.deleteRow(i + 2);
        if (sheetName === 'OFC_Depts') ofcCleanupLinks_(ss, 'Dept_ID', id);
        CacheService.getScriptCache().remove(CACHE_KEY_S);
        return true;
      }
    }
    return false;
  } catch(e) { return false; }
}

// Officer data को OFC format में save करता है (D-style data → OFC_Officers)
function addOfficerOFC(data) {
  try {
    var ss = SBApp.getActiveSpreadsheet();
    ofcSetup_(ss);
    // Dept_Name → Dept_ID lookup (or create dept if missing)
    var deptName = String(data.Department || '').trim();
    var depts = ofcRead_(ss, 'OFC_Depts');
    var deptRec = depts.find(function(d){ return (d.Dept_Name||'').trim() === deptName; });
    if (!deptRec && deptName) {
      deptRec = ofcSaveRecord('OFC_Depts', {Dept_Name: deptName});
    }
    var deptId = deptRec ? deptRec.Dept_ID : '';
    // Level text → Level_Rank number
    var lvlText = String(data.Level || '').toLowerCase();
    var lvlRank = lvlText.indexOf('ce')>-1?1 : lvlText.indexOf('se')>-1?2 : lvlText.indexOf('ee')>-1?3 : lvlText.indexOf('ae')>-1?4 : lvlText.indexOf('je')>-1?5 : 3;
    var rec = {
      Officer_ID:        '',
      Dept_ID:           deptId,
      Officer_Name:      data.Name || '',
      Designation:       data.Designation || '',
      Level_Rank:        lvlRank,
      Senior_Officer_ID: data.Senior_Officer_ID || '',
      Khand_Zone:        data.Zone || data.Division || '',
      Address:           data.Office_Address || '',
      Phone:             data.Phone || '',
      Email:             data.Email || '',
      Notes:             data.Notes || ''
    };
    var saved = ofcSaveRecord('OFC_Officers', rec);
    // Return in D-compatible format for chain-add compatibility
    return { success: true, officer: {
      Officer_ID: saved.Officer_ID,
      Name:       saved.Officer_Name,
      Department: deptName,
      Dept_ID:    saved.Dept_ID,
      Designation:saved.Designation,
      Level:      ['','CE','SE','EE','AE','JE'][lvlRank] || '',
      Level_Rank: saved.Level_Rank,
      Zone:       saved.Khand_Zone,
      Division:   saved.Khand_Zone,
      Phone:      saved.Phone,
      Email:      saved.Email,
      Notes:      saved.Notes,
      Office_Address: saved.Address,
      Senior_Officer_ID: saved.Senior_Officer_ID
    }};
  } catch(e) { return {success:false, msg:e.message}; }
}

// Officer के लिए OFC_RoadLinks को batch sync करता है
function ofcSyncOfficerRoads(officerId, roadIds) {
  try {
    var ss = SBApp.getActiveSpreadsheet();
    ofcSetup_(ss);
    var existing = ofcRead_(ss, 'OFC_RoadLinks').filter(function(l){ return l.Officer_ID === officerId; });
    // Remove links not in roadIds
    existing.forEach(function(l){
      if (roadIds.indexOf(l.Road_ID) < 0) ofcDeleteRecord('OFC_RoadLinks', l.Map_ID);
    });
    // Add new links
    var existingRids = existing.map(function(l){ return l.Road_ID; });
    roadIds.forEach(function(rid){
      if (existingRids.indexOf(rid) < 0) ofcLinkRoadOfficer(rid, officerId);
    });
    return true;
  } catch(e) { return false; }
}

function ofcClearSeniorRef_(ss, officerId) {
  var sh = ss.getSheetByName('OFC_Officers');
  if (!sh || sh.getLastRow() < 2) return;
  var cols = OFC_SHEETS_.OFC_Officers;
  var colIdx = cols.indexOf('Senior_Officer_ID') + 1;
  var vals = sh.getRange(2, colIdx, sh.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]) === String(officerId)) sh.getRange(i + 2, colIdx).setValue('');
  }
}

function ofcCleanupLinks_(ss, field, id) {
  var sh = ss.getSheetByName('OFC_RoadLinks');
  if (!sh || sh.getLastRow() < 2) return;
  var cols = OFC_SHEETS_.OFC_RoadLinks;
  var colIdx = cols.indexOf(field);
  if (colIdx < 0) return;
  var data = sh.getRange(2, 1, sh.getLastRow() - 1, cols.length).getValues();
  for (var i = data.length - 1; i >= 0; i--) {
    if (String(data[i][colIdx]) === String(id)) sh.deleteRow(i + 2);
  }
}

function ofcGetAncestors_(ss, officerId) {
  var officers = ofcRead_(ss, 'OFC_Officers');
  var visited = {}, chain = [], cur = String(officerId);
  while (cur) {
    if (visited[cur]) break;
    visited[cur] = true;
    var o = null;
    for (var i = 0; i < officers.length; i++) {
      if (String(officers[i].Officer_ID) === cur) { o = officers[i]; break; }
    }
    if (!o) break;
    var sid = String(o.Senior_Officer_ID || '').trim();
    if (!sid) break;
    chain.push(sid);
    cur = sid;
  }
  return chain;
}

function ofcSetSeniorOfficer(officerId, seniorOfficerId) {
  try {
    var ss = SBApp.getActiveSpreadsheet();
    ofcSetup_(ss);
    var sh = ss.getSheetByName('OFC_Officers');
    var cols = OFC_SHEETS_.OFC_Officers;
    var oidIdx = cols.indexOf('Officer_ID');
    var sidIdx = cols.indexOf('Senior_Officer_ID');
    var lrkIdx = cols.indexOf('Level_Rank');
    if (!sh || sh.getLastRow() < 2) return false;
    var readCols = Math.min(cols.length, sh.getLastColumn());
    var data = sh.getRange(2, 1, sh.getLastRow() - 1, readCols).getValues();
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][oidIdx]) === String(officerId)) {
        sh.getRange(i + 2, sidIdx + 1).setValue(seniorOfficerId || '');
        // If junior's Level_Rank <= senior's Level_Rank, push junior down
        if (seniorOfficerId) {
          var snrRow = null;
          for (var j = 0; j < data.length; j++) {
            if (String(data[j][oidIdx]) === String(seniorOfficerId)) { snrRow = data[j]; break; }
          }
          if (snrRow) {
            var snrLevel = parseInt(snrRow[lrkIdx]) || 0;
            var jnrLevel = parseInt(data[i][lrkIdx]) || 0;
            if (jnrLevel <= snrLevel) {
              sh.getRange(i + 2, lrkIdx + 1).setValue(snrLevel + 1);
            }
          }
        }
        CacheService.getScriptCache().remove(CACHE_KEY_S);
        // Cascade from junior so entire downstream chain updates
        ofcCascadeLevels_(ss, String(officerId));
        return true;
      }
    }
    return false;
  } catch(e) { return false; }
}

function ofcLinkRoadOfficer(roadId, officerId) {
  try {
    var ss = SBApp.getActiveSpreadsheet();
    ofcSetup_(ss);
    var links = ofcRead_(ss, 'OFC_RoadLinks');
    var existing = links.some(function(m) {
      return m.Road_ID === roadId && m.Officer_ID === officerId;
    });
    if (existing) return {skipped: true};
    // Remove existing direct links for this road where officer is an ancestor of the new officer
    // (senior was placeholder; junior now takes over as प्रत्यक्ष, senior auto-shows via chain)
    var ancestors = ofcGetAncestors_(ss, officerId);
    if (ancestors.length) {
      var sh = ss.getSheetByName('OFC_RoadLinks');
      var cols = OFC_SHEETS_.OFC_RoadLinks;
      var ridIdx = cols.indexOf('Road_ID'), oidIdx = cols.indexOf('Officer_ID');
      var data = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, Math.min(cols.length, sh.getLastColumn())).getValues() : [];
      for (var i = data.length - 1; i >= 0; i--) {
        if (String(data[i][ridIdx]) === String(roadId) && ancestors.indexOf(String(data[i][oidIdx])) >= 0) {
          sh.deleteRow(i + 2);
        }
      }
      CacheService.getScriptCache().remove(CACHE_KEY_S);
    }
    return ofcSaveRecord('OFC_RoadLinks', {Map_ID:'', Road_ID: roadId, Officer_ID: officerId});
  } catch(e) { return {success:false, msg:e.message}; }
}

// All root officers (no senior) get Level_Rank=1; cascade fixes rest
function ofcFixAllLevelRanks() {
  try {
    var ss = SBApp.getActiveSpreadsheet();
    ofcSetup_(ss);
    var sh = ss.getSheetByName('OFC_Officers');
    if (!sh || sh.getLastRow() < 2) return {fixed:0};
    var cols = OFC_SHEETS_.OFC_Officers;
    var oidIdx = cols.indexOf('Officer_ID');
    var sidIdx = cols.indexOf('Senior_Officer_ID');
    var lrkIdx = cols.indexOf('Level_Rank');
    var readCols = Math.min(cols.length, sh.getLastColumn());
    var data = sh.getRange(2, 1, sh.getLastRow() - 1, readCols).getValues();
    // Find roots: no Senior_Officer_ID or senior not in list
    var allIds = {};
    for (var i = 0; i < data.length; i++) allIds[String(data[i][oidIdx])] = true;
    var roots = [];
    for (var i = 0; i < data.length; i++) {
      var sid = String(data[i][sidIdx] || '').trim();
      if (!sid || !allIds[sid]) roots.push(i);
    }
    // Set roots to Level_Rank=1 if not already
    var fixed = 0;
    for (var i = 0; i < roots.length; i++) {
      if (String(data[roots[i]][lrkIdx]) !== '1') {
        sh.getRange(roots[i] + 2, lrkIdx + 1).setValue(1);
        data[roots[i]][lrkIdx] = 1;
        fixed++;
      }
    }
    // Cascade from each root
    for (var i = 0; i < roots.length; i++) {
      ofcCascadeLevels_(ss, String(data[roots[i]][oidIdx]));
    }
    CacheService.getScriptCache().remove(CACHE_KEY_S);
    return {fixed: fixed + 'roots+cascade'};
  } catch(e) { return {fixed:0, error:e.message}; }
}

function ofcDeduplicateOfficers() {
  try {
    var ss = SBApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName('OFC_Officers');
    if (!sh || sh.getLastRow() < 2) return {removed:0};
    var cols = OFC_SHEETS_.OFC_Officers;
    var nameIdx = cols.indexOf('Officer_Name'), deptIdx = cols.indexOf('Dept_ID');
    var readCols = Math.min(cols.length, sh.getLastColumn());
    var data = sh.getRange(2, 1, sh.getLastRow() - 1, readCols).getValues();
    var seen = {}, rowsToDelete = [];
    for (var i = 0; i < data.length; i++) {
      var nm = String(data[i][nameIdx]||'').trim().toLowerCase();
      var dp = String(data[i][deptIdx]||'').trim();
      var key = nm + '|' + dp;
      if (!nm) continue;
      if (seen[key] !== undefined) {
        rowsToDelete.push(i + 2); // keep first occurrence, delete later ones
      } else {
        seen[key] = i;
      }
    }
    // Delete from bottom up to preserve row indices
    for (var r = rowsToDelete.length - 1; r >= 0; r--) {
      sh.deleteRow(rowsToDelete[r]);
    }
    if (rowsToDelete.length > 0) CacheService.getScriptCache().remove(CACHE_KEY_S);
    return {removed: rowsToDelete.length};
  } catch(e) { return {removed:0, error:e.message}; }
}

function ofcUnlinkRoadOfficer(roadId, officerId) {
  try {
    var ss = SBApp.getActiveSpreadsheet();
    var maps = ofcRead_(ss, 'OFC_RoadLinks');
    for (var i = 0; i < maps.length; i++) {
      if (maps[i].Road_ID === roadId && maps[i].Officer_ID === officerId) {
        return ofcDeleteRecord('OFC_RoadLinks', maps[i].Map_ID);
      }
    }
    return false;
  } catch(e) { return {success:false, msg:e.message}; }
}

// ══════════════════════════════════════════════════════════════
//  परियोजना भुगतान (Payment Management) Backend
//  सड़क Measurement एवं ठेकेदार भुगतान (RA Bill) Tracker
//  सभी functions pay_ / pay prefix से हैं — Road Mgmt से कोई conflict नहीं
// ══════════════════════════════════════════════════════════════

const PAY_FOLDER_ID = 'payments';  // Supabase मोड — आभासी folder (सिर्फ़ metadata)

const PAY_HEADERS = {
  Items:          ['ItemID','ItemNo','Description','DetailDesc','Unit','Rate','SanctionedQty'],
  Measurements:   ['MeasID','ItemID','Kind','SancRef','Engineer','Ord','Description','ChFrom','ChTo','Side','MBNo','MBPage','MDate','Nos','Nos1','Nos2','Length','Breadth','BreadthExpr','Depth','DepthExpr','Quantity','RecordMB','RecordDate'],
  Payments:       ['PayID','BillNo','BillType','PDate','MBNo','MBPages','Remarks',
                    'ActualEndDate','SyncRoadWork',
                    'BaseAmount','AbovePct','AboveAmt',
                    'DeductTotal','AdvanceTotal','WithheldAmt','AmtA',
                    'GstOn','GstPct','GstManual','GstManualAmt','GstAmt','AmtF',
                    'LaborCessOn','LaborCessPct','LaborCessManual','LaborCessManualAmt','LaborCessAmt',
                    'IncomeTaxOn','IncomeTaxPct','IncomeTaxManual','IncomeTaxManualAmt','IncomeTaxAmt',
                    'RetentionOn','RetentionPct','RetentionManual','RetentionManualAmt','RetentionAmt',
                    'CgstOn','CgstPct','CgstManual','CgstManualAmt','CgstAmt',
                    'SgstOn','SgstPct','SgstManual','SgstManualAmt','SgstAmt',
                    'NettPaid','TotalAmount','Paid','PaidDate','CreatedAt','DriveLink','FileName'],
  PaymentDetails: ['DetailID','PayID','MeasID','ItemID','Qty','Rate','Amount'],
  PaymentAdj:     ['AdjID','PayID','Kind','Note','Amount'],
  Project:        ['Key','Value']
};
function payR2_(n){ return Math.round((Number(n)||0) * 100) / 100; }
function payBool_(v){ return v===true || v==='true' || v===1 || v==='1'; }

// ── Settings (PAY_ prefix in Script Properties) ────────────────
function payGetSetting_(k){ return PropertiesService.getScriptProperties().getProperty('PAY_' + k) || ''; }
function paySetSetting_(k, v){ PropertiesService.getScriptProperties().setProperty('PAY_' + k, v || ''); }
function payActiveId_(){ return payGetSetting_('ACTIVE_SS_ID'); }

// ── getAllData कैश — एक ही प्रोजेक्ट-स्प्रेडशीट को बार-बार पूरा पढ़ने से बचने के लिए
// (हर लिखाई पर payInvalidateCache_ ज़रूर बुलाएँ, TTL भी छोटा रखा है — पुराना डेटा देर तक न टिके)
function payCacheKeyFor_(ssId){ return ssId ? ('pay_all_' + ssId) : ''; }
const CACHE_KEY_PAYTOTALS = 'pay_all_totals';
function payInvalidateCache_(ssId){
  var id = ssId || payActiveId_();
  var k = payCacheKeyFor_(id);
  if (k) { try { CacheService.getScriptCache().remove(k); } catch(e) {} }
  try { CacheService.getScriptCache().remove(CACHE_KEY_PAYTOTALS); } catch(e) {}
}

// ── Drive folder helpers ───────────────────────────────────────
function payExtractId_(s){ s = String(s || '').trim(); var m = s.match(/[-\w]{25,}/); return m ? m[0] : s; }
function payFolderOrNull_(){
  var id = payGetSetting_('FOLDER_ID') || PAY_FOLDER_ID;
  if (id) { try { return SBDrive.getFolderById(id); } catch(e) {} }
  return null;
}
function payFolder_(){
  var f = payFolderOrNull_();
  if (f) return f;
  f = SBDrive.createFolder('Measurement MB — Projects');
  paySetSetting_('FOLDER_ID', f.getId());
  return f;
}
function payListProjs_(folder){
  var it = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
  var arr = [];
  while (it.hasNext()) {
    var file = it.next();
    arr.push({ id: file.getId(), name: file.getName(),
      updated: Utilities.formatDate(file.getLastUpdated(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') });
  }
  arr.sort(function(a, b){ return String(b.updated).localeCompare(String(a.updated)); });
  return arr;
}

// ── Project state ──────────────────────────────────────────────
function pay_getProjectState(){
  var folder = payFolderOrNull_();
  var id = payActiveId_();
  var active = null;
  if (id) {
    try { var f = SBDrive.getFileById(id); active = { id: id, name: f.getName(), url: f.getUrl() }; }
    catch(e) { active = { id: id, name: '(लोड परियोजना)' }; }
  }
  return {
    folderSet:  !!folder,
    folderId:   folder ? folder.getId()   : '',
    folderName: folder ? folder.getName() : '',
    folderUrl:  folder ? folder.getUrl()  : '',
    active:     active,
    projects:   folder ? payListProjs_(folder) : []
  };
}
function pay_setProjectFolder(idOrUrl){
  var f = SBDrive.getFolderById(payExtractId_(idOrUrl));
  paySetSetting_('FOLDER_ID', f.getId());
  return pay_getProjectState();
}
function pay_createProject(name){
  var folder = payFolder_();
  var nm = (name && String(name).trim()) ||
    ('परियोजना ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'));
  var ss = SBApp.create(nm);
  SBDrive.getFileById(ss.getId()).moveTo(folder);
  paySetSetting_('ACTIVE_SS_ID', ss.getId());
  payEnsureSheets_();
  return pay_getProjectState();
}
function pay_loadProject(id){ paySetSetting_('ACTIVE_SS_ID', String(id || '')); return pay_getProjectState(); }
function pay_closeProject(){ paySetSetting_('ACTIVE_SS_ID', ''); return pay_getProjectState(); }
function pay_renameProject(name){
  var id = payActiveId_();
  if (id && name && String(name).trim()) { try { SBDrive.getFileById(id).setName(String(name).trim()); } catch(e) {} }
  return pay_getProjectState();
}
function pay_deleteProject(id){
  if (!id) return pay_getProjectState();
  try { SBDrive.getFileById(String(id)).setTrashed(true); }
  catch(e) { throw new Error('फ़ाइल हटाने में त्रुटि: ' + e); }
  if (String(payActiveId_()) === String(id)) paySetSetting_('ACTIVE_SS_ID', '');
  return pay_getProjectState();
}

// ── Sheet helpers ──────────────────────────────────────────────
function paySS_(){
  var id = payActiveId_();
  if (!id) throw new Error('कोई परियोजना लोड नहीं — पहले डैशबोर्ड से परियोजना लोड करें।');
  return SBApp.openById(id);
}
function paySSorNull_(){
  var id = payActiveId_();
  if (!id) return null;
  try { return SBApp.openById(id); } catch(e) { return null; }
}
function payEnsureSheets_(){
  var ss = paySS_();
  Object.keys(PAY_HEADERS).forEach(function(name){
    var want = PAY_HEADERS[name];
    var sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name);
      sh.getRange(1, 1, 1, want.length).setValues([want]).setFontWeight('bold');
      sh.setFrozenRows(1);
      return;
    }
    var lastCol = Math.max(1, sh.getLastColumn());
    var cur = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
    if (cur.join('') === '') {
      sh.getRange(1, 1, 1, want.length).setValues([want]).setFontWeight('bold');
      sh.setFrozenRows(1);
      return;
    }
    var missing = want.filter(function(h){ return cur.indexOf(h) === -1; });
    if (missing.length) sh.getRange(1, cur.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
  });
  return true;
}
function payGetHdrs_(sh){ var lc = Math.max(1, sh.getLastColumn()); return sh.getRange(1,1,1,lc).getValues()[0].map(String); }
function payFmtVal_(v){ if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd'); return v; }
function payRowFor_(sh, obj, auto){
  var hdrs = payGetHdrs_(sh);
  return hdrs.map(function(h){ if (auto && auto[h] !== undefined) return auto[h]; return obj[h] !== undefined ? obj[h] : ''; });
}
function payReadSheet_(name, ss){
  var sh = (ss || paySS_()).getSheetByName(name);
  if (!sh) return [];
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0];
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var obj = {}; var empty = true;
    for (var j = 0; j < headers.length; j++) { var val = payFmtVal_(values[i][j]); obj[headers[j]] = val; if (val !== '' && val !== null) empty = false; }
    if (!empty) rows.push(obj);
  }
  return rows;
}
function payFindRow_(sh, idVal){
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) { if (String(data[i][0]) === String(idVal)) return i + 1; }
  return -1;
}
function payReadProj_(ss){ var rows = payReadSheet_('Project', ss); var o = {}; rows.forEach(function(r){ o[r.Key] = r.Value; }); return o; }

// नाम से किसी विशेष परियोजना का भुगतान-डेटा पढ़ें — global ACTIVE_SS_ID पर निर्भर नहीं, इसलिए
// एक ब्राउज़र में दूसरी परियोजना खुली होने पर भी सही (वर्तमान) परियोजना का डेटा मिलता है।
function pay_getDataForProject(name){
  var EMPTY = { noProject: true, items: [], measurements: [], payments: [], paymentDetails: [], paymentAdj: [], project: {} };
  name = String(name || '').trim();
  if (!name) return EMPTY;
  var folder = payFolderOrNull_();
  if (!folder) return EMPTY;
  var match = null;
  var it = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
  while (it.hasNext()) {
    var file = it.next();
    if (file.getName() === name) { match = file; break; }
  }
  if (!match) return EMPTY;
  var ss;
  try { ss = SBApp.openById(match.getId()); } catch(e) { return EMPTY; }
  return {
    activeName:     match.getName(),
    items:          payReadSheet_('Items', ss),
    measurements:   payReadSheet_('Measurements', ss),
    payments:       payReadSheet_('Payments', ss),
    paymentDetails: payReadSheet_('PaymentDetails', ss),
    paymentAdj:     payReadSheet_('PaymentAdj', ss),
    project:        payReadProj_(ss)
  };
}

// सभी परियोजनाओं (Drive folder की हर payment-स्प्रेडशीट) का "Payments" शीट से कुल भुगतान —
// मुख्य डैशबोर्ड की परियोजना-सूची में "कुल भुगतान" कॉलम एक ही बार में भरने के लिए (प्रति-परियोजना अलग कॉल से बचाव)
function pay_getAllProjectsPaymentTotals(){
  var cache = CacheService.getScriptCache();
  var cached = cache.get(CACHE_KEY_PAYTOTALS);
  if (cached) { try { return JSON.parse(cached); } catch(e) {} }
  var totals = {};
  var folder = payFolderOrNull_();
  if (!folder) return totals;
  var it = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
  while (it.hasNext()) {
    var file = it.next();
    try {
      var ss = SBApp.openById(file.getId());
      var payments = payReadSheet_('Payments', ss);
      var total = 0;
      payments.forEach(function(p){ total += Number(p.TotalAmount || p.AmtF || 0) || 0; });
      totals[file.getName()] = total;
    } catch(e) {}
  }
  try { cache.put(CACHE_KEY_PAYTOTALS, JSON.stringify(totals), 600); } catch(e) {}
  return totals;
}

// ── Read all data ──────────────────────────────────────────────
function pay_getAllData(){
  var state = null;
  try { state = pay_getProjectState(); } catch(e) {}
  var ss = paySSorNull_();
  if (!ss) return { noProject: true, items: [], measurements: [], payments: [], paymentDetails: [], paymentAdj: [], project: {}, projectState: state, defaultDeductions: pay_getDefaultDeductions(), unitConfigs: pay_getUnitConfigs() };

  var cacheKey = payCacheKeyFor_(payActiveId_());
  if (cacheKey) {
    try {
      var cached = CacheService.getScriptCache().get(cacheKey);
      if (cached) { var obj = JSON.parse(cached); obj.projectState = state; obj.defaultDeductions = pay_getDefaultDeductions(); obj.unitConfigs = pay_getUnitConfigs(); return obj; }
    } catch(e) {}
  }

  payEnsureSheets_();
  var activeName = '';
  try { activeName = ss.getName(); } catch(e) {}
  var result = {
    activeName:     activeName,
    items:          payReadSheet_('Items'),
    measurements:   payReadSheet_('Measurements'),
    payments:       payReadSheet_('Payments'),
    paymentDetails: payReadSheet_('PaymentDetails'),
    paymentAdj:     payReadSheet_('PaymentAdj'),
    project:        payReadProj_()
  };
  if (cacheKey) { try { CacheService.getScriptCache().put(cacheKey, JSON.stringify(result), 30); } catch(e) {} }
  result.projectState = state;
  result.defaultDeductions = pay_getDefaultDeductions();
  result.unitConfigs = pay_getUnitConfigs();
  return result;
}

// ── सांविधिक कटौतियों की डिफ़ॉल्ट सेटिंग — सभी परियोजनाओं के लिए Common (script-wide, per-project नहीं) ──
function pay_getDefaultDeductions(){
  var raw = payGetSetting_('DEFAULT_DEDUCTIONS');
  if (!raw) return {};
  try { return JSON.parse(raw) || {}; } catch(e) { return {}; }
}
function pay_saveDefaultDeductions(obj){
  paySetSetting_('DEFAULT_DEDUCTIONS', JSON.stringify(obj || {}));
  return pay_getDefaultDeductions();
}

// ── इकाई (Unit) प्रबंधन — सभी परियोजनाओं के लिए Common — हर इकाई के लिए कौन-कौन सेल (नग1/नग2/लंबाई/चौड़ाई/ऊंचाई) सक्रिय होंगे ──
var PAY_DEFAULT_UNIT_CONFIGS = [
  {name:'घन मीटर', nos1:true, nos2:true, length:true,  breadth:true,  depth:true},
  {name:'वर्ग मीटर', nos1:true, nos2:true, length:true,  breadth:true,  depth:false},
  {name:'मीटर',      nos1:true, nos2:true, length:true,  breadth:false, depth:false},
  {name:'संख्या',    nos1:true, nos2:true, length:false, breadth:false, depth:false}
];
function pay_getUnitConfigs(){
  var raw = payGetSetting_('UNIT_CONFIGS');
  if (!raw) return PAY_DEFAULT_UNIT_CONFIGS.slice();
  try {
    var list = JSON.parse(raw);
    return (Array.isArray(list) && list.length) ? list : PAY_DEFAULT_UNIT_CONFIGS.slice();
  } catch(e) { return PAY_DEFAULT_UNIT_CONFIGS.slice(); }
}
function pay_saveUnitConfigs(list){
  var clean = (Array.isArray(list) ? list : []).map(function(u){
    return {
      name:    String((u && u.name) || '').trim(),
      nos1:    !!(u && u.nos1),
      nos2:    !!(u && u.nos2),
      length:  !!(u && u.length),
      breadth: !!(u && u.breadth),
      depth:   !!(u && u.depth)
    };
  }).filter(function(u){ return u.name; });
  paySetSetting_('UNIT_CONFIGS', JSON.stringify(clean));
  return pay_getUnitConfigs();
}

// ── Project metadata (Key-Value sheet) ────────────────────────
function pay_saveProject(obj){
  payEnsureSheets_();
  var sh = paySS_().getSheetByName('Project');
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 2).clearContent();
  var rows = Object.keys(obj).map(function(k){ return [k, obj[k]]; });
  if (rows.length) sh.getRange(2, 1, rows.length, 2).setValues(rows);
  payInvalidateCache_();
  return true;
}
function pay_ignoreOverlaps(sigs){
  var proj = payReadProj_();
  var cur = [];
  try { cur = JSON.parse(proj.ignoredOverlaps || '[]'); } catch(e) {}
  if (!Array.isArray(cur)) cur = [];
  (sigs || []).forEach(function(s){ if (cur.indexOf(s) === -1) cur.push(s); });
  proj.ignoredOverlaps = JSON.stringify(cur);
  pay_saveProject(proj);
  return true;
}

function pay_getDashboardProjects(){
  try {
    var ss = SBApp.getActiveSpreadsheet();
    var rows = sheetToObjects_(ss, '3_Projects');
    return (rows || []).filter(function(r){ return r.Project_ID; }).map(function(r){
      var nm = r.Project_Name || r['Project_Name\n(कार्य का नाम)'] || '';
      return {
        id: r.Project_ID, name: nm, status: r.Status || '',
        contractorName: r.Contractor_Name || '',
        startDate: r.Overall_Start_Date || '',
        endDate: r.Overall_End_Date || '',
        contractCost: r.Contract_Cost || '',
        contractGstPct: r.Contract_GST_Pct || ''
      };
    });
  } catch(e) {
    return [];
  }
}

// Sync contractor/dates from payment system back to main 3_Projects sheet
function pay_syncToMain(data) {
  try {
    var name = (data.projectName || '').trim();
    if (!name) return { success: false, msg: 'project name missing' };
    var ss = SBApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName('3_Projects');
    if (!sh) return { success: false, msg: '3_Projects not found' };
    ensureProjColumns_(ss);
    var vals = sh.getDataRange().getValues();
    var hdr = vals[0].map(function(h){ return String(h).trim(); });
    var nameC = hdr.indexOf('Project_Name');
    var pidC  = hdr.indexOf('Project_ID');
    if (nameC < 0) return { success: false, msg: 'Project_Name col not found' };
    for (var r = 1; r < vals.length; r++) {
      var rowName = String(vals[r][nameC]||'').trim();
      if (rowName === name) {
        var set = function(col, val) {
          var c = hdr.indexOf(col);
          if (c >= 0 && val) sh.getRange(r+1, c+1).setValue(val);
        };
        if (data.contractor)    set('Contractor_Name',    data.contractor);
        if (data.startDate)     set('Overall_Start_Date', data.startDate);
        if (data.endDate)       set('Overall_End_Date',   data.endDate);
        if (data.actualEndDate) set('Actual_End_Date',    data.actualEndDate);
        var pid = String(vals[r][pidC]||'');
        if (data.actualEndDate) {
          // अंतिम बिल की वास्तविक समाप्ति तिथि सहेजते ही — परियोजना व सड़क-लिंक का status
          // Running से हटाकर Completed कर दें (हमेशा, checkbox पर निर्भर नहीं)
          var roadIds = pay_completeProjectRoads_(ss, pid);
          set('Status', 'Completed');
          // checkbox चेक हो तभी सड़कों की आखिरी कार्य तिथि (2_Road_Sections + 1_Roads_Master) भी अपडेट करें —
          // कुछ परियोजनाओं में समाप्ति के बावजूद सड़क पर यह तिथि नहीं चढ़ानी होती
          if (data.syncRoadWork) {
            var myC = hdr.indexOf('Maintenance_Years');
            var projMaintYears = myC >= 0 ? (parseInt(vals[r][myC])||2) : 2;
            pay_syncRoadLastWork_(ss, roadIds, data.actualEndDate, projMaintYears);
          }
        }
        SBApp.flush();
        CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
        return { success: true, projectId: pid };
      }
    }
    return { success: false, msg: 'project not found: '+name };
  } catch(e) {
    return { success: false, msg: e.message };
  }
}

// अंतिम बिल की वास्तविक समाप्ति तिथि सहेजते ही — परियोजना से जुड़ी सड़कों के 3B_Project_Roads लिंक का
// Road_Status हमेशा 'Completed' कर दें (ताकि सड़क सूची में Running बैज हटकर डिफ़ॉल्ट स्थिति दिखे);
// आगे 2_Road_Sections/1_Roads_Master में आखिरी कार्य तिथि चढ़ानी हो तो उसके लिए जुड़े हुए Road_ID लौटाता है
// (नोट: KM_Numbers_Covered एक free-text फ़ील्ड है जो 2_Road_Sections.KM_Number से शब्दशः मेल नहीं खाता,
// इसलिए KM के आधार पर मैच करने के बजाय पूरे Road_ID की सभी sections अपडेट की जाती हैं)
function pay_completeProjectRoads_(ss, projectId) {
  var roadIds = [];
  if (!projectId) return roadIds;
  var prSh = ss.getSheetByName('3B_Project_Roads');
  if (!prSh) return roadIds;
  var prVals = prSh.getDataRange().getValues();
  var prHdr  = prVals[0].map(function(h){ return String(h).trim(); });
  var pidC2 = prHdr.indexOf('Project_ID'), ridC2 = prHdr.indexOf('Road_ID'), statC2 = prHdr.indexOf('Road_Status');
  for (var i = 1; i < prVals.length; i++) {
    if (String(prVals[i][pidC2]||'').trim() !== projectId) continue;
    var rid = String(prVals[i][ridC2]||'').trim();
    if (rid && roadIds.indexOf(rid) === -1) roadIds.push(rid);
    if (statC2 >= 0) prSh.getRange(i+1, statC2+1).setValue('Completed');
  }
  return roadIds;
}

// checkbox ("क्या यह तिथि सड़क सूची में आखिरी कार्य की तिथि के रूप में अपडेट करनी है?") चेक हो तभी बुलाया जाता है —
// परियोजना से जुड़ी सड़कों की सभी 2_Road_Sections रो पर आखिरी कार्य (Last_Work) की वास्तविक तिथि चढ़ाएँ;
// साथ ही 1_Roads_Master पर भी हमेशा यही तिथि + परियोजना की अनुरक्षण अवधि चढ़ाएँ — ताकि "सड़क Edit करें"
// फॉर्म और अनुरक्षण-गणना (getRoadMaintenanceYears) हमेशा परियोजना की ताज़ा तिथि/अवधि दिखाएँ, भले ही
// उस सड़क के लिए Chainage Detail/section दर्ज हो या न हो
function pay_syncRoadLastWork_(ss, roadIds, actualEndDate, maintenanceYears) {
  if (!roadIds || !roadIds.length) return;
  ensureSectionColumns_(ss);
  ensureRoadMasterExtraCols_(ss);
  var d = new Date(actualEndDate);
  var mm = isNaN(d.getTime()) ? '' : String(d.getMonth()+1).padStart(2,'0');
  var yyyy = isNaN(d.getTime()) ? '' : String(d.getFullYear());
  var my = parseInt(maintenanceYears) || 2;

  var sh = ss.getSheetByName('2_Road_Sections');
  if (sh) {
    var vals = sh.getDataRange().getValues();
    var hdr  = vals[0].map(function(h){ return String(h).trim(); });
    var ridC = hdr.indexOf('Road_ID');
    var lwmC = hdr.indexOf('Last_Work_Month'), lwyC = hdr.indexOf('Last_Work_Year'), lwdC = hdr.indexOf('Last_Work_Date');
    if (ridC >= 0) {
      for (var r = 1; r < vals.length; r++) {
        var rid = String(vals[r][ridC]||'').trim();
        if (roadIds.indexOf(rid) === -1) continue;
        if (lwmC >= 0 && mm)   sh.getRange(r+1, lwmC+1).setValue(mm);
        if (lwyC >= 0 && yyyy) sh.getRange(r+1, lwyC+1).setValue(yyyy);
        if (lwdC >= 0)         sh.getRange(r+1, lwdC+1).setValue(actualEndDate);
      }
    }
  }

  var rmSh = ss.getSheetByName('1_Roads_Master');
  if (rmSh) {
    var rmVals = rmSh.getDataRange().getValues();
    var rmHdr  = rmVals[0].map(function(h){ return String(h).trim(); });
    var rmRidC = rmHdr.indexOf('Road_ID');
    var rmLwmC = rmHdr.indexOf('Last_Work_Month'), rmLwyC = rmHdr.indexOf('Last_Work_Year'),
        rmLwdC = rmHdr.indexOf('Last_Work_Date'), rmMyC = rmHdr.indexOf('Maintenance_Years');
    if (rmRidC >= 0) {
      for (var k = 1; k < rmVals.length; k++) {
        var rmRid = String(rmVals[k][rmRidC]||'').trim();
        if (roadIds.indexOf(rmRid) === -1) continue;
        if (rmLwmC >= 0 && mm)   rmSh.getRange(k+1, rmLwmC+1).setValue(mm);
        if (rmLwyC >= 0 && yyyy) rmSh.getRange(k+1, rmLwyC+1).setValue(yyyy);
        if (rmLwdC >= 0)         rmSh.getRange(k+1, rmLwdC+1).setValue(actualEndDate);
        if (rmMyC  >= 0)         rmSh.getRange(k+1, rmMyC+1).setValue(my);
      }
    }
  }
}

// ── Items ──────────────────────────────────────────────────────
function pay_saveItem(item){
  payEnsureSheets_();
  var sh = paySS_().getSheetByName('Items');
  if (!item.ItemID) item.ItemID = Utilities.getUuid();
  var row = payRowFor_(sh, item);
  var idx = payFindRow_(sh, item.ItemID);
  if (idx === -1) sh.appendRow(row); else sh.getRange(idx, 1, 1, row.length).setValues([row]);
  payInvalidateCache_();
  return item.ItemID;
}
function pay_deleteItem(itemId){
  var sh = paySS_().getSheetByName('Items');
  var idx = payFindRow_(sh, itemId);
  if (idx !== -1) sh.deleteRow(idx);
  payInvalidateCache_();
  return true;
}

// ── Measurements ───────────────────────────────────────────────
function paySyncSanc_(itemId){
  if (!itemId) return;
  var meas = payReadSheet_('Measurements');
  var hasSanc = false; var sum = 0;
  meas.forEach(function(m){ if (String(m.ItemID) === String(itemId) && String(m.Kind) === 'sanctioned') { hasSanc = true; sum += Number(m.Quantity) || 0; } });
  if (!hasSanc) return;
  var itemSh = paySS_().getSheetByName('Items');
  var idx = payFindRow_(itemSh, itemId);
  if (idx === -1) return;
  var hdrs = payGetHdrs_(itemSh);
  var col = hdrs.indexOf('SanctionedQty');
  if (col === -1) return;
  itemSh.getRange(idx, col + 1).setValue(Math.round(sum * 1000) / 1000);
}
function pay_saveMeasurement(m){
  payEnsureSheets_();
  var sh = paySS_().getSheetByName('Measurements');
  if (!m.MeasID) m.MeasID = Utilities.getUuid();
  var row = payRowFor_(sh, m);
  var idx = payFindRow_(sh, m.MeasID);
  if (idx === -1) sh.appendRow(row); else sh.getRange(idx, 1, 1, row.length).setValues([row]);
  paySyncSanc_(m.ItemID);
  payInvalidateCache_();
  return m.MeasID;
}
function pay_deleteMeasurement(measId){
  var sh = paySS_().getSheetByName('Measurements');
  var idx = payFindRow_(sh, measId);
  var itemId = '';
  if (idx !== -1) {
    var hdrs = payGetHdrs_(sh);
    var itemCol = hdrs.indexOf('ItemID');
    if (itemCol !== -1) itemId = sh.getRange(idx, itemCol + 1).getValue();
    sh.deleteRow(idx);
  }
  if (itemId) paySyncSanc_(itemId);
  payInvalidateCache_();
  return true;
}
// कई नाप-पंक्तियाँ (जोड़/संपादन/हटाव) एक ही बार में — builder/move/auto-arrange से एक ही round-trip में सहेजने के लिए
function pay_saveMeasurementsBatch(payload){
  payEnsureSheets_();
  var sh = paySS_().getSheetByName('Measurements');
  var deletes = (payload && payload.deletes) || [];
  var saves   = (payload && payload.saves)   || [];
  var touchedItems = {};

  deletes.forEach(function(measId){
    var idx = payFindRow_(sh, measId);
    if (idx === -1) return;
    var hdrs = payGetHdrs_(sh);
    var itemCol = hdrs.indexOf('ItemID');
    var itemId = itemCol !== -1 ? sh.getRange(idx, itemCol + 1).getValue() : '';
    sh.deleteRow(idx);
    if (itemId) touchedItems[itemId] = true;
  });

  var ids = saves.map(function(m){
    if (!m.MeasID) m.MeasID = Utilities.getUuid();
    var row = payRowFor_(sh, m);
    var idx = payFindRow_(sh, m.MeasID);
    if (idx === -1) sh.appendRow(row); else sh.getRange(idx, 1, 1, row.length).setValues([row]);
    if (m.ItemID) touchedItems[m.ItemID] = true;
    return m.MeasID;
  });

  Object.keys(touchedItems).forEach(function(itemId){ paySyncSanc_(itemId); });
  payInvalidateCache_();
  return ids;
}

// ── Payments ───────────────────────────────────────────────────
function payDelDetails_(payId){
  var sh = paySS_().getSheetByName('PaymentDetails');
  var data = sh.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) { if (String(data[i][1]) === String(payId)) sh.deleteRow(i + 1); }
}
function payDelAdj_(payId, ss){
  var sh = (ss || paySS_()).getSheetByName('PaymentAdj');
  if (!sh) return;
  var data = sh.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) { if (String(data[i][1]) === String(payId)) sh.deleteRow(i + 1); }
}
function pay_savePayment(payload){
  payEnsureSheets_();
  var ss = paySS_();
  var paySh = ss.getSheetByName('Payments');
  var detSh = ss.getSheetByName('PaymentDetails');
  var adjSh = ss.getSheetByName('PaymentAdj');
  var payment = payload.payment;
  var details = payload.details || [];
  if (!payment.PayID) payment.PayID = Utilities.getUuid();
  if (!payment.CreatedAt) payment.CreatedAt = new Date().toISOString();

  // फ़्रीज़ — जिस बिल का भुगतान (चेक) हो चुका है उसमें कोई बदलाव न हो, चाहे सेटिंग बाद में बदल जाएँ
  var existingRow = payReadSheet_('Payments', ss).filter(function(r){ return String(r.PayID) === String(payment.PayID); })[0];
  if (existingRow && payBool_(existingRow.Paid)) {
    throw new Error('यह बिल भुगतान (चेक) हो चुका है — अब इसमें बदलाव नहीं किया जा सकता');
  }

  // T1: निर्धारित राशि (Schedule Amount) — चुनी गई नाप-लाइनों का Qty x Rate योग
  var baseAmt = 0;
  details.forEach(function(d){ baseAmt += Number(d.Amount) || 0; });
  baseAmt = payR2_(baseAmt);
  // T2/T3: Above/Below % (परियोजना सेटिंग से) और राशि
  var abovePct = Number(payReadProj_(ss).abovePct) || 0;
  var aboveAmt = payR2_(baseAmt * abovePct / 100);
  var t4 = baseAmt + aboveAmt;

  // T5: कटौती — यदि payload में न भेजी जाए तो मौजूदा (सेव्ड) कटौतियाँ ज्यों की त्यों रहें
  var deductions = payload.deductions;
  var advances   = payload.advances;
  if (deductions === undefined || advances === undefined) {
    var existingAdj = payReadSheet_('PaymentAdj', ss).filter(function(r){ return String(r.PayID) === String(payment.PayID); });
    if (deductions === undefined) deductions = existingAdj.filter(function(r){ return r.Kind === 'deduction'; }).map(function(r){ return { note: r.Note, amount: r.Amount }; });
    if (advances   === undefined) advances   = existingAdj.filter(function(r){ return r.Kind === 'advance';   }).map(function(r){ return { note: r.Note, amount: r.Amount }; });
  }
  var deductTotal = 0; (deductions || []).forEach(function(d){ deductTotal += Number(d.amount) || 0; });
  deductTotal = payR2_(deductTotal);
  var t6 = t4 - deductTotal;

  // T7: Advance — T6 पर जोड़ी जाती है
  var advanceTotal = 0; (advances || []).forEach(function(d){ advanceTotal += Number(d.amount) || 0; });
  advanceTotal = payR2_(advanceTotal);
  var t8 = t6 + advanceTotal; // "कुल भुगतान Amount"

  // T9: Withheld, T10: A
  var withheldAmt = payR2_(payment.WithheldAmt);
  var amtA = t8 - withheldAmt;

  // T11: GST (A पर % आधारित — या checkbox से मैनुअल राशि), T12: F
  var gstOn  = payBool_(payment.GstOn);
  var gstPct = Number(payment.GstPct) || 0;
  var gstManual    = payBool_(payment.GstManual);
  var gstManualAmt = Number(payment.GstManualAmt) || 0;
  var gstAmt = gstOn ? (gstManual ? payR2_(gstManualAmt) : payR2_(amtA * gstPct / 100)) : 0;
  var amtF   = amtA + gstAmt;

  // T13-T17: सांविधिक कटौतियाँ — % A पर आधारित, या checkbox से मैनुअल राशि — F से घटेंगी
  function statAdj(onKey, pctKey, manualKey, manualAmtKey){
    var on  = payBool_(payment[onKey]);
    var pct = Number(payment[pctKey]) || 0;
    var manual    = payBool_(payment[manualKey]);
    var manualAmt = Number(payment[manualAmtKey]) || 0;
    var amt = on ? (manual ? payR2_(manualAmt) : payR2_(amtA * pct / 100)) : 0;
    return { on: on, pct: pct, manual: manual, manualAmt: manualAmt, amt: amt };
  }
  var laborCess = statAdj('LaborCessOn', 'LaborCessPct', 'LaborCessManual', 'LaborCessManualAmt');
  var incomeTax = statAdj('IncomeTaxOn', 'IncomeTaxPct', 'IncomeTaxManual', 'IncomeTaxManualAmt');
  var retention = statAdj('RetentionOn', 'RetentionPct', 'RetentionManual', 'RetentionManualAmt');
  var cgst      = statAdj('CgstOn',      'CgstPct',      'CgstManual',      'CgstManualAmt');
  var sgst      = statAdj('SgstOn',      'SgstPct',      'SgstManual',      'SgstManualAmt');

  // T18: Nett Paid Amount — भुगतान के लिए कुछ राशि (धन/ऋणात्मक) होना ज़रूरी है
  var nettPaid = amtF - (laborCess.amt + incomeTax.amt + retention.amt + cgst.amt + sgst.amt);
  if (Math.abs(nettPaid) < 0.005) {
    throw new Error('भुगतान के लिए कोई Amount नहीं है');
  }

  payment.BaseAmount    = baseAmt;
  payment.AbovePct      = abovePct;
  payment.AboveAmt      = aboveAmt;
  payment.DeductTotal   = deductTotal;
  payment.AdvanceTotal  = advanceTotal;
  payment.WithheldAmt   = withheldAmt;
  payment.AmtA          = payR2_(amtA);
  payment.GstOn         = gstOn;
  payment.GstPct        = gstPct;
  payment.GstManual     = gstManual;
  payment.GstManualAmt  = gstManualAmt;
  payment.GstAmt        = gstAmt;
  payment.AmtF          = payR2_(amtF);
  payment.LaborCessOn   = laborCess.on;  payment.LaborCessPct = laborCess.pct;  payment.LaborCessManual = laborCess.manual;  payment.LaborCessManualAmt = laborCess.manualAmt;  payment.LaborCessAmt = laborCess.amt;
  payment.IncomeTaxOn   = incomeTax.on;  payment.IncomeTaxPct = incomeTax.pct;  payment.IncomeTaxManual = incomeTax.manual;  payment.IncomeTaxManualAmt = incomeTax.manualAmt;  payment.IncomeTaxAmt = incomeTax.amt;
  payment.RetentionOn   = retention.on;  payment.RetentionPct = retention.pct;  payment.RetentionManual = retention.manual;  payment.RetentionManualAmt = retention.manualAmt;  payment.RetentionAmt = retention.amt;
  payment.CgstOn        = cgst.on;       payment.CgstPct      = cgst.pct;       payment.CgstManual      = cgst.manual;       payment.CgstManualAmt      = cgst.manualAmt;       payment.CgstAmt      = cgst.amt;
  payment.SgstOn        = sgst.on;       payment.SgstPct      = sgst.pct;       payment.SgstManual      = sgst.manual;       payment.SgstManualAmt      = sgst.manualAmt;       payment.SgstAmt      = sgst.amt;
  payment.NettPaid      = payR2_(nettPaid);
  // पूरे ऐप में "TotalAmount" = F (GST सहित Gross बिल राशि)
  payment.TotalAmount   = payR2_(amtF);

  var payRow = payRowFor_(paySh, payment);
  var pIdx = payFindRow_(paySh, payment.PayID);
  if (pIdx === -1) paySh.appendRow(payRow); else paySh.getRange(pIdx, 1, 1, payRow.length).setValues([payRow]);
  payDelDetails_(payment.PayID);
  if (details.length) {
    var newRows = details.map(function(d){ return payRowFor_(detSh, d, { DetailID: Utilities.getUuid(), PayID: payment.PayID }); });
    detSh.getRange(detSh.getLastRow() + 1, 1, newRows.length, newRows[0].length).setValues(newRows);
  }
  if (payload.deductions !== undefined || payload.advances !== undefined) {
    payDelAdj_(payment.PayID, ss);
    var adjRows = [];
    (payload.deductions || []).forEach(function(d){ if (Number(d.amount)) adjRows.push([Utilities.getUuid(), payment.PayID, 'deduction', d.note || '', Number(d.amount) || 0]); });
    (payload.advances   || []).forEach(function(d){ if (Number(d.amount)) adjRows.push([Utilities.getUuid(), payment.PayID, 'advance',   d.note || '', Number(d.amount) || 0]); });
    if (adjRows.length) adjSh.getRange(adjSh.getLastRow() + 1, 1, adjRows.length, 5).setValues(adjRows);
  }
  payInvalidateCache_();
  return payment.PayID;
}
function pay_deletePayment(payId){
  var ss = paySS_();
  var paySh = ss.getSheetByName('Payments');
  // ध्यान दें: Paid (चेक जारी) बिल को भी हटाया जा सकता है — केवल सबसे आखिरी बिल हटाने की अनुमति देने का
  // नियम UI स्तर (delPay, Payment_GAS.html) पर 3 चेतावनियों के साथ लागू है; यहाँ सामान्य delete (जैसे
  // duplicate बिल merge करना — mergeIntoBill) के लिए कोई position-आधारित रोक नहीं रखी गई।
  var payment = payReadSheet_('Payments', ss).filter(function(r){ return String(r.PayID) === String(payId); })[0];
  var idx = payFindRow_(paySh, payId);
  if (idx !== -1) paySh.deleteRow(idx);
  payDelDetails_(payId);
  payDelAdj_(payId);
  payInvalidateCache_();
  // अंतिम बिल (BillType='अंतिम', ActualEndDate सेट) हटाया जा रहा है — परियोजना व सड़क-लिंक का status
  // जो pay_syncToMain में 'Completed' किया गया था, उसे वापस 'Running' कर दें
  if (payment && payment.BillType === 'अंतिम' && payment.ActualEndDate) {
    var projName = payReadProj_(ss).name || '';
    if (projName) pay_revertProjectCompletion_(projName);
  }
  return true;
}

// pay_completeProjectRoads_/pay_syncToMain द्वारा किया गया Completion वापस लें — परियोजना व उससे जुड़ी
// सड़कों का Road_Status फिर से 'Running' कर दें (अंतिम बिल डिलीट होने पर सड़क सूची व "मार्ग सेक्शन" दोनों
// में सड़क फिर से Running दिखे); Last_Work_Date/Maintenance_Years जान-बूझकर नहीं छुआ जा रहा — उसका कोई
// पुराना (sync से पहले का) मूल्य रिकॉर्ड नहीं है, इसलिए उसे यथावत रहने दिया गया है
function pay_revertProjectCompletion_(projectName) {
  var name = String(projectName||'').trim();
  if (!name) return;
  var ss = SBApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('3_Projects');
  if (!sh) return;
  var vals = sh.getDataRange().getValues();
  var hdr = vals[0].map(function(h){ return String(h).trim(); });
  var nameC = hdr.indexOf('Project_Name'), pidC = hdr.indexOf('Project_ID'),
      statC = hdr.indexOf('Status'), endC = hdr.indexOf('Actual_End_Date');
  if (nameC < 0) return;
  for (var r = 1; r < vals.length; r++) {
    if (String(vals[r][nameC]||'').trim() !== name) continue;
    if (statC >= 0) sh.getRange(r+1, statC+1).setValue('Running');
    if (endC  >= 0) sh.getRange(r+1, endC+1).setValue('');
    var pid = String(vals[r][pidC]||'');
    var prSh = ss.getSheetByName('3B_Project_Roads');
    if (prSh && pid) {
      var prVals = prSh.getDataRange().getValues();
      var prHdr  = prVals[0].map(function(h){ return String(h).trim(); });
      var pidC2 = prHdr.indexOf('Project_ID'), statC2 = prHdr.indexOf('Road_Status');
      if (pidC2 >= 0 && statC2 >= 0) {
        for (var i = 1; i < prVals.length; i++) {
          if (String(prVals[i][pidC2]||'').trim() !== pid) continue;
          prSh.getRange(i+1, statC2+1).setValue('Running');
        }
      }
    }
    SBApp.flush();
    CacheService.getScriptCache().removeAll([CACHE_KEY_P, CACHE_KEY_S]);
    return;
  }
}
// बिल का "भुगतान/चेक" जारी हुआ चिह्नित करें — तारीख स्वतः आज की लगेगी, और बिल फ़्रीज़ हो जाएगा
// (आगे सेटिंग बदलने पर भी इस बिल के GST/Labour Cess/Income Tax/Retention/CGST/SGST में बदलाव नहीं होगा)
function pay_markPaid(payId){
  payEnsureSheets_();
  var ss = paySS_();
  var sh = ss.getSheetByName('Payments');
  var existing = payReadSheet_('Payments', ss).filter(function(r){ return String(r.PayID) === String(payId); })[0];
  if (!existing) throw new Error('भुगतान नहीं मिला');
  if (payBool_(existing.Paid)) throw new Error('यह बिल पहले से भुगतान हो चुका है');
  var idx = payFindRow_(sh, payId);
  if (idx === -1) throw new Error('भुगतान नहीं मिला');
  var hdrs = payGetHdrs_(sh);
  var paidCol = hdrs.indexOf('Paid') + 1;
  var dateCol = hdrs.indexOf('PaidDate') + 1;
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  if (paidCol > 0) sh.getRange(idx, paidCol).setValue(true);
  if (dateCol > 0) sh.getRange(idx, dateCol).setValue(today);
  payInvalidateCache_();
  return { paidDate: today };
}

// भुगतान-ऐप के किसी बिल की हार्ड-कॉपी अपलोड करें — परियोजना-नाम से स्प्रेडशीट सीधे खोलें
// (global ACTIVE_SS_ID पर निर्भर नहीं), ताकि किसी दूसरे ब्राउज़र की परियोजना से टकराव न हो।
function pay_attachBillFile(payload){
  payload = payload || {};
  var projName = String(payload.projectName || '').trim();
  var payId    = String(payload.payId || '').trim();
  if (!projName || !payId) return { success:false, msg:'projectName/payId आवश्यक' };
  var folder = payFolderOrNull_();
  if (!folder) return { success:false, msg:'Payment फ़ोल्डर सेट नहीं है' };
  var match = null;
  var it = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
  while (it.hasNext()) { var file = it.next(); if (file.getName() === projName) { match = file; break; } }
  if (!match) return { success:false, msg:'परियोजना स्प्रेडशीट नहीं मिली' };
  var ss;
  try { ss = SBApp.openById(match.getId()); } catch(e) { return { success:false, msg:'स्प्रेडशीट खोलने में त्रुटि' }; }
  var sh = ss.getSheetByName('Payments');
  if (!sh) return { success:false, msg:'Payments शीट नहीं मिली' };
  var idx = payFindRow_(sh, payId);
  if (idx === -1) return { success:false, msg:'भुगतान नहीं मिला' };

  var billFolder = getOrCreateFolder_(folder, projName + ' — Bills');
  var blob = Utilities.newBlob(Utilities.base64Decode(payload.base64), payload.mimeType || 'application/octet-stream', payload.fileName);
  var driveFile = billFolder.createFile(blob);
  driveFile.setSharing(SBDrive.Access.ANYONE_WITH_LINK, SBDrive.Permission.VIEW);
  var viewUrl = driveFile.getUrl();

  var hdrs = payGetHdrs_(sh);
  var setCol = function(col, val){
    var c = hdrs.indexOf(col);
    if (c === -1) { c = hdrs.length; sh.getRange(1, c+1).setValue(col); hdrs.push(col); }
    sh.getRange(idx, c+1).setValue(val);
  };
  setCol('DriveLink', viewUrl);
  setCol('FileName',  payload.fileName || '');
  SBApp.flush();
  payInvalidateCache_(match.getId());
  return { success:true, viewUrl: viewUrl, fileName: payload.fileName || '' };
}

// ── Import items from Excel ────────────────────────────────────
function pay_importItems(payload){
  payEnsureSheets_();
  var ss = paySS_();
  var itSh = ss.getSheetByName('Items');
  var meSh = ss.getSheetByName('Measurements');
  var items = (payload && payload.items) || [];
  var meas  = (payload && payload.measurements) || [];
  if (items.length) { var iRows = items.map(function(o){ return payRowFor_(itSh, o); }); itSh.getRange(itSh.getLastRow() + 1, 1, iRows.length, iRows[0].length).setValues(iRows); }
  if (meas.length)  { var mRows = meas.map(function(o){ return payRowFor_(meSh, o); }); meSh.getRange(meSh.getLastRow() + 1, 1, mRows.length, mRows[0].length).setValues(mRows); }
  payInvalidateCache_();
  return { items: items.length, meas: meas.length };
}

// ── Import template (डेटाबेस में अस्थायी टेम्प्लेट) ──────────
function pay_createImportTemplate(){
  var folder = payFolder_();
  var ss = SBApp.create('आयात टेम्प्लेट — Measurement MB');
  SBDrive.getFileById(ss.getId()).moveTo(folder);
  var sh = ss.getSheets()[0]; sh.setName('Items');
  var headers = ['ItemNo','ShortName','DetailDesc','Unit','Rate','ChFrom','ChTo','Side','MeasDesc','Nos1','Nos2','Length','Breadth','Depth','Engineer'];
  var data = [headers,
    ['1','मिट्टी का खुदाई','मिट्टी का खुदाई एवं समतलीकरण — पूरा विवरण।','घन मीटर',185,'0.000','0.300','बायाँ','भाग-1',1,1,300,7,0.15,'श्री र. शर्मा'],
    ['1','','','घन मीटर','','0.300','0.600','बायाँ','भाग-2',1,1,300,7,0.15,'श्री र. शर्मा'],
    ['2','GSB','ग्रेडेड स्टोन बेस।','घन मीटर',1650,'0.000','0.500','','',1,1,500,7,0.20,'श्री र. वर्मा'],
    ['3','बिटुमिनस सतह','DBM + BC (वर्ग मीटर — अंकाई नहीं)।','वर्ग मीटर',540,'0.000','0.600','','BC लेयर',1,1,600,7,'','श्री र. वर्मा']];
  sh.getRange(1, 1, data.length, headers.length).setValues(data);
  sh.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#f1f5fa');
  sh.setFrozenRows(1);
  var unitCol = headers.indexOf('Unit') + 1;
  var unitNames = pay_getUnitConfigs().map(function(u){ return u.name; });
  var rule = SBApp.newDataValidation().requireValueInList(unitNames, true).setAllowInvalid(false).build();
  sh.getRange(2, unitCol, 500, 1).setDataValidation(rule);
  return { url: ss.getUrl(), id: ss.getId() };
}

// ── Sample project ─────────────────────────────────────────────
function pay_createSampleProject(){
  var folder = payFolder_();
  var ss = SBApp.create('नमूना परियोजना');
  SBDrive.getFileById(ss.getId()).moveTo(folder);
  paySetSetting_('ACTIVE_SS_ID', ss.getId());
  payEnsureSheets_();
  payLoadSample_();
  return pay_getProjectState();
}
function payLoadSample_(){
  payEnsureSheets_();
  pay_saveProject({ name: 'मुख्य मार्ग नवीनीकरण कार्य', contractor: 'मेसर्स आदर्श कंस्ट्रक्शन', workOrder: 'WO/2025-26/142', startDate: '2025-10-01', endDate: '2026-03-31', engineers: 'श्री र. शर्मा\nश्री र. वर्मा', estimate: 'स्वीकृत प्राक्कलन' });
  var it1 = pay_saveItem({ ItemNo: '1', Description: 'मिट्टी का खुदाई एवं समतलीकरण', Unit: 'घन मी', Rate: 185 });
  var it2 = pay_saveItem({ ItemNo: '2', Description: 'GSB (ग्रेडेड स्टोन बेस)', Unit: 'घन मी', Rate: 1650 });
  var it3 = pay_saveItem({ ItemNo: '3', Description: 'WMM (वेट मिक्स मेकैडम)', Unit: 'घन मी', Rate: 1980 });
  var it4 = pay_saveItem({ ItemNo: '4', Description: 'बिटुमिनस सतह (DBM + BC)', Unit: 'वर्ग मी', Rate: 540 });
  var s1 = pay_saveMeasurement({ ItemID: it1, Kind: 'sanctioned', Description: 'पूरे लंबाई', ChFrom: '0.000', ChTo: '1.000', Side: 'बायाँ', Nos1: 1, Nos2: 1, Length: 1000, Breadth: 7, Depth: 0.15, Quantity: 1050 });
  var s2 = pay_saveMeasurement({ ItemID: it2, Kind: 'sanctioned', Description: '', ChFrom: '0.000', ChTo: '0.500', Side: '', Nos1: 1, Nos2: 1, Length: 500, Breadth: 7, Depth: 0.20, Quantity: 700 });
  var s4 = pay_saveMeasurement({ ItemID: it4, Kind: 'sanctioned', Description: 'BC लेयर', ChFrom: '0.000', ChTo: '0.600', Side: '', Nos1: 1, Nos2: 1, Length: 600, Breadth: 7, Depth: '', Quantity: 4200 });
  pay_saveMeasurement({ ItemID: it1, Kind: 'actual', SancRef: s1, Description: 'बायाँ भाग', ChFrom: '0.000', ChTo: '0.500', Side: 'बायाँ', MBNo: 'MB-21', MBPage: '12', MDate: '2025-11-05', RecordMB: 'MB-21', RecordDate: '2025-11-06', Nos1: 1, Nos2: 1, Length: 500, Breadth: 7, Depth: 0.15, Quantity: 525 });
  pay_saveMeasurement({ ItemID: it1, Kind: 'actual', SancRef: s1, Description: 'बायाँ भाग', ChFrom: '0.500', ChTo: '1.000', Side: 'बायाँ', MBNo: 'MB-21', MBPage: '13', MDate: '2025-11-18', RecordMB: 'MB-21', RecordDate: '2025-11-19', Nos1: 1, Nos2: 1, Length: 500, Breadth: 7, Depth: 0.15, Quantity: 525 });
  pay_saveMeasurement({ ItemID: it2, Kind: 'actual', SancRef: s2, Description: '', ChFrom: '0.000', ChTo: '0.500', Side: '', MBNo: 'MB-21', MBPage: '20', MDate: '2025-12-02', RecordMB: 'MB-21', RecordDate: '2025-12-03', Nos1: 1, Nos2: 1, Length: 500, Breadth: 7, Depth: 0.20, Quantity: 700 });
  pay_saveMeasurement({ ItemID: it4, Kind: 'actual', SancRef: s4, Description: 'BC लेयर', ChFrom: '0.000', ChTo: '0.600', Side: '', MBNo: 'MB-22', MBPage: '4', MDate: '2026-01-10', RecordMB: 'MB-22', RecordDate: '2026-01-11', Nos1: 1, Nos2: 1, Length: 600, Breadth: 7, Depth: '', Quantity: 4200 });
  return true;
}
