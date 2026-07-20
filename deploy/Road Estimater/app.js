/* ============================================================
   Road Estimate System — app.js
   ------------------------------------------------------------
   ढाँचा (structure):
     1. STORAGE   → IndexedDB (db.* helpers)  — आपका data यहीं रहता है
     2. ENGINE    → HyperFormula  — live calculation + cross-sheet links
     3. STATE     → memory में सारी sheets/estimates
     4. SHEETS    → बनाना, खोलना, rename, delete, grid editing
     5. ESTIMATE  → 15-20 sheets चुनकर समूह बनाना
     6. EXPORT    → xlsx (links समेत) + Print + JSON backup
   हर हिस्सा अलग है ताकि VS Code में आसानी से सुधार सको।
   ============================================================ */

(function () {
  "use strict";

  /* ============== 1. STORAGE ============== */
  /* API वही है (db.open/getAll/put/del/clear) — बाकी app अछूता। दो mode:
     • LOCAL — IndexedDB (PC पर file से खोलने पर / offline) — पहले जैसा
     • CLOUD — hosted site पर login के बाद Supabase (/api/db के ज़रिये)
       → सभी browsers/devices पर एक ही central डेटा                       */
  const DB_NAME = "road_estimate_db";
  const DB_VER = 2;
  let _db = null;
  let _cloudMode = false;
  let _cloudToken = "";
  const CLOUD_STORES = ["sheets", "estimates", "master"];

  /* ---- LOCAL: IndexedDB (मूल code, जस का तस) ---- */
  const idb = {
    open() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VER);
        req.onupgradeneeded = (e) => {
          const d = e.target.result;
          if (!d.objectStoreNames.contains("sheets")) d.createObjectStore("sheets", { keyPath: "id" });
          if (!d.objectStoreNames.contains("estimates")) d.createObjectStore("estimates", { keyPath: "id" });
          if (!d.objectStoreNames.contains("master")) d.createObjectStore("master", { keyPath: "id" });
        };
        req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
        req.onerror = (e) => reject(e.target.error);
      });
    },
    getAll(store) {
      return new Promise((resolve, reject) => {
        const tx = _db.transaction(store, "readonly").objectStore(store).getAll();
        tx.onsuccess = () => resolve(tx.result || []);
        tx.onerror = () => reject(tx.error);
      });
    },
    put(store, obj) {
      return new Promise((resolve, reject) => {
        const tx = _db.transaction(store, "readwrite").objectStore(store).put(obj);
        tx.onsuccess = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
    del(store, id) {
      return new Promise((resolve, reject) => {
        const tx = _db.transaction(store, "readwrite").objectStore(store).delete(id);
        tx.onsuccess = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
    clear(store) {
      return new Promise((resolve, reject) => {
        const tx = _db.transaction(store, "readwrite").objectStore(store).clear();
        tx.onsuccess = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
  };

  /* ---- CLOUD: Supabase via Netlify Function (mirror-first, तेज़) ----
     IndexedDB को cloud का local "mirror" रखा जाता है:
       • पेज हमेशा mirror से तुरंत खुलता है (कोई इंतज़ार नहीं)
       • cloud से मिलान background में — किसी और device से बदलाव मिला
         तो mirror ताज़ा करके एक बार पेज reload
       • हर edit पहले mirror में (तुरंत), फिर पीछे-पीछे queue से cloud में */
  const STAMP_KEY = "est_cloud_stamp";

  async function cloudCall(op, args) {
    const res = await fetch(location.origin + "/api/db", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: op, token: _cloudToken, args: args || {} }),
    });
    const j = await res.json().catch(() => null);
    if (!j || j.ok !== true) throw new Error((j && j.error) || ("Cloud server त्रुटि (" + res.status + ")"));
    return j.result;
  }

  /* cloud writes की serial queue + localStorage में pending-log —
     हर edit तुरंत local (IndexedDB) में; cloud में पीछे-पीछे। refresh/बंद पर
     कोई write बाक़ी रह जाए तो अगली बार boot पर अपने-आप दोबारा भेज दी जाती है
     → न "Reload site?" dialog, न डेटा हानि। */
  const PENDING_KEY = "est_pending_ops";
  let _cloudQueue = Promise.resolve();
  let _cloudPending = 0;
  let _stampTimer = null;
  let _opSeq = 0;
  function _loadPending() { try { return JSON.parse(localStorage.getItem(PENDING_KEY)) || []; } catch (e) { return []; } }
  function _savePending(a) { try { localStorage.setItem(PENDING_KEY, JSON.stringify(a)); } catch (e) {} }
  function cloudEnqueue(cloudOp, args, dkey, isClear) {
    const opId = (++_opSeq) + "_" + Date.now();
    let pend = _loadPending();
    if (isClear) { const pre = (args.store || "") + ":"; pend = pend.filter((p) => (p.dkey || "").indexOf(pre) !== 0); }
    else if (dkey) { pend = pend.filter((p) => p.dkey !== dkey); }   // उसी target की पुरानी हटाओ (नवीनतम ही रखें)
    pend.push({ id: opId, dkey: dkey || null, cloudOp: cloudOp, args: args });
    _savePending(pend);
    _cloudPending++;
    _cloudQueue = _cloudQueue
      .then(() => cloudCall(cloudOp, args))
      .then(() => { _savePending(_loadPending().filter((p) => p.id !== opId)); })
      .catch((e) => console.error("cloud sync:", e))
      .finally(() => { _cloudPending--; _stampSoon(); });
  }
  function _stampSoon() {
    if (_cloudPending > 0) return;
    clearTimeout(_stampTimer);
    _stampTimer = setTimeout(async () => {
      if (_cloudPending > 0) return;
      try { localStorage.setItem(STAMP_KEY, JSON.stringify(await cloudCall("estStamp"))); } catch (e) {}
    }, 800);
  }
  // boot पर बची हुई (unconfirmed) writes दोबारा भेजो — फिर stamp ताज़ा कर दो
  async function flushPendingOnBoot() {
    const pend = _loadPending();
    if (!pend.length) return;
    for (const p of pend) { try { await cloudCall(p.cloudOp, p.args); } catch (e) { console.error("replay:", e); } }
    _savePending([]);
    try { localStorage.setItem(STAMP_KEY, JSON.stringify(await cloudCall("estStamp"))); } catch (e) {}
  }

  async function mirrorWriteAll(all) {
    for (const s of CLOUD_STORES) {
      await idb.clear(s);
      for (const row of (all[s] || [])) await idb.put(s, row.data);
    }
  }

  /* cloud से मिलान: stamp (गिनती+आख़िरी बदलाव समय) तुलना —
     बराबर तो कुछ नहीं उतरता; बदला हो तभी पूरा data (एक ही call में) */
  async function cloudSync(servedFromMirror) {
    const stamp = await cloudCall("estStamp");
    const stampStr = JSON.stringify(stamp);
    const prev = localStorage.getItem(STAMP_KEY);
    const cloudEmpty = !stamp || Object.keys(stamp).length === 0;
    if (cloudEmpty && !prev) {
      /* पहली बार cloud से जुड़े और cloud ख़ाली — इस browser का पुराना डेटा चढ़ाएँ */
      for (const s of CLOUD_STORES) {
        const local = await idb.getAll(s);
        for (let i = 0; i < local.length; i += 20) {
          const batch = local.slice(i, i + 20).map((o) => ({ id: String(o.id), data: o }));
          if (batch.length) await cloudCall("estBulkPut", { store: s, rows: batch });
        }
      }
      localStorage.setItem(STAMP_KEY, JSON.stringify(await cloudCall("estStamp")));
      return false;
    }
    if (prev === stampStr) return false;          /* mirror पहले से ताज़ा */
    const all = await cloudCall("estFetchAll");   /* एक ही call में तीनों stores */
    await mirrorWriteAll(all);
    localStorage.setItem(STAMP_KEY, stampStr);
    return servedFromMirror;   /* true = पेज पुराने mirror से खुल चुका था → reload चाहिए */
  }

  const db = {
    async open() {
      await idb.open();
      _cloudMode = false;
      try {
        if (location.protocol === "http:" || location.protocol === "https:") {
          _cloudToken = sessionStorage.getItem("rms_token") || "";
          if (_cloudToken) {
            const r = await fetch(location.origin + "/api/db").then((x) => x.json()).catch(() => null);
            _cloudMode = !!(r && r.cloud === true);
          }
        }
      } catch (e) { _cloudMode = false; }
      if (_cloudMode) {
        await flushPendingOnBoot();   // पिछली बार की बची writes पहले भेजो (डेटा हानि न हो)
        if (localStorage.getItem(STAMP_KEY)) {
          /* mirror मौजूद — तुरंत खोलो, मिलान background में */
          cloudSync(true)
            .then((changed) => { if (changed) location.reload(); })
            .catch((e) => console.error("cloud sync:", e));
        } else {
          /* इस browser में पहली बार — mirror भरना ज़रूरी है */
          await cloudSync(false);
        }
      }
      return _db;
    },
    /* पढ़ना हमेशा local mirror/IndexedDB से — तुरंत */
    getAll(store) { return idb.getAll(store); },
    put(store, obj) {
      const p = idb.put(store, obj);
      if (_cloudMode) {
        const snap = JSON.parse(JSON.stringify(obj));   /* उसी क्षण की copy */
        cloudEnqueue("estPut", { store: store, id: String(obj.id), data: snap }, store + ":" + obj.id, false);
      }
      return p;
    },
    del(store, id) {
      const p = idb.del(store, id);
      if (_cloudMode) cloudEnqueue("estDel", { store: store, id: String(id) }, store + ":" + id, false);
      return p;
    },
    clear(store) {
      const p = idb.clear(store);
      if (_cloudMode) cloudEnqueue("estClear", { store: store }, store + ":*", true);
      return p;
    },
  };

  /* ============== 2. STATE ============== */
  const state = {
    sheets: {},      // id -> sheet
    order: [],       // sheet ids क्रम में
    estimates: {},   // id -> estimate
    estOrder: [],
    activeSheetId: null,
    activeEstimateId: null,
    activeCell: { r: 0, c: 0 },
    selAnchor: null, // multi-cell selection का दूसरा कोना (null = सिर्फ़ active cell)
    master: {},      // Master Data — category id -> { versions, activeVersion }
  };

  // active estimate रिफ्रेश के बाद भी वही रहे — localStorage में याद रखो
  const ACTIVE_EST_KEY = "est_active_estimate";
  function setActiveEstimateId(id) { state.activeEstimateId = id; try { localStorage.setItem(ACTIVE_EST_KEY, id || ""); } catch (e) {} }
  function restoreActiveEstimateId() {
    let saved = ""; try { saved = localStorage.getItem(ACTIVE_EST_KEY) || ""; } catch (e) {}
    state.activeEstimateId = (saved && state.estOrder.indexOf(saved) >= 0) ? saved : (state.estOrder[0] || null);
  }

  let hf = null;       // HyperFormula instance
  let hfReady = false;
  let _suppressEngine = false; // batch (applyOverheadAll) के दौरान बार-बार buildEngine न हो

  /* ---------- helpers: cell address ---------- */
  function colToLetter(n) { // 0 -> A
    let s = "";
    n = n + 1;
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }
  function addr(r, c) { return colToLetter(c) + (r + 1); }
  function parseAddr(a) { // "E50" -> {r:49, c:4}
    const m = /^([A-Za-z]+)([0-9]+)$/.exec(a);
    if (!m) return null;
    let col = 0; const L = m[1].toUpperCase();
    for (let i = 0; i < L.length; i++) col = col * 26 + (L.charCodeAt(i) - 64);
    return { r: parseInt(m[2], 10) - 1, c: col - 1 };
  }
  function uid(p) { return p + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  // कॉलम-अक्षर → 0-आधारित संख्या (A=0)
  function letterToNum0(L) { let n = 0; const s = L.toUpperCase(); for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64); return n - 1; }
  // formula के relative cell-refs को (dr,dc) से खिसकाओ (Excel जैसा copy/paste); $absolute व quoted-string अछूते; sheet-नाम (Name!) अछूता, cell-भाग adjust
  function shiftFormula(f, dr, dc) {
    if (!f || f[0] !== "=" || (dr === 0 && dc === 0)) return f;
    const re = /("(?:[^"]|"")*")|((?:[A-Za-z_][A-Za-z0-9_]*!)?)(\$?)([A-Za-z]{1,3})(\$?)(\d+)/g;
    return f.replace(re, (m, str, sheetp, colAbs, colL, rowAbs, rowD) => {
      if (str != null) return str;                       // quoted string — अछूता
      let col = letterToNum0(colL), row = parseInt(rowD, 10) - 1;
      if (!colAbs) col = Math.max(0, col + dc);
      if (!rowAbs) row = Math.max(0, row + dr);
      return sheetp + colAbs + colToLetter(col) + rowAbs + (row + 1);
    });
  }

  // नाम को formula-safe बनाओ (alphanumeric + underscore)
  function safeName(name) {
    let n = (name || "").trim().replace(/\s+/g, "_").replace(/[^A-Za-z0-9_]/g, "");
    if (!n) n = "Sheet";
    if (/^[0-9]/.test(n)) n = "S_" + n;
    return n;
  }
  function uniqueName(base, exceptId) {
    let n = base, i = 2;
    const taken = (nm) => state.order.some((id) => id !== exceptId && state.sheets[id].name.toLowerCase() === nm.toLowerCase());
    while (taken(n)) { n = base + "_" + i; i++; }
    return n;
  }

  /* ============== 3. ENGINE (HyperFormula) ============== */
  function sheetMatrix(sheet) {
    const m = [];
    for (let r = 0; r < sheet.rows; r++) {
      const row = [];
      for (let c = 0; c < sheet.cols; c++) {
        const cell = sheet.cells[addr(r, c)];
        row.push(cell ? (cell.f != null ? cell.f : cell.v) : null);
      }
      m.push(row);
    }
    return m;
  }

  // तेज़ लोडिंग: engine केवल working शीटों पर बने; ~1000 master library शीटें
  // formula-graph में भाग नहीं लेतीं (rate-links mref→state.master से जाते हैं),
  // इसलिए उन्हें engine से बाहर रखो — जैसे-जैसे खोली जाएँ वैसे-वैसे शामिल होती जाएँ।
  let _engineMasters = new Set();  // engine में शामिल master शीटों के नाम
  function buildEngine() {
    if (typeof HyperFormula === "undefined") { hfReady = false; return; }
    try {
      const masterByName = {};
      for (const id of state.order) { const s = state.sheets[id]; if (s.kind === "master") masterByName[s.name] = id; }
      const included = new Set();
      for (const id of state.order) { const s = state.sheets[id]; if (s.kind !== "master" || _engineMasters.has(s.name)) included.add(id); }
      // शामिल शीटों के formula में यदि किसी (बाहर रखी) master शीट का reference हो, उसे भी जोड़ो
      const reRef = /(?:'([^']+)'|([^\s'!()+\-*/,;:&<>=^%]+))!/g;
      for (const id of Array.from(included)) {
        const s = state.sheets[id]; if (!s || !s.cells) continue;
        for (const a in s.cells) {
          const f = s.cells[a] && s.cells[a].f;
          if (!f || f.indexOf("!") < 0) continue;
          let m; reRef.lastIndex = 0;
          while ((m = reRef.exec(f))) { const nm = m[1] || m[2]; if (masterByName[nm] != null) included.add(masterByName[nm]); }
        }
      }
      const data = {};
      for (const id of state.order) { if (included.has(id)) data[state.sheets[id].name] = sheetMatrix(state.sheets[id]); }
      if (Object.keys(data).length === 0) data["_empty"] = [[null]];
      hf = HyperFormula.buildFromSheets(data, { licenseKey: "gpl-v3" });
      hfReady = true;
    } catch (e) { console.error("Engine build error:", e); hfReady = false; }
  }

  function hfSheetId(name) {
    try { return hf.getSheetId(name); } catch (e) { return undefined; }
  }

  function setEngineCell(sheet, r, c, raw) {
    if (!hfReady) return;
    const sid = hfSheetId(sheet.name);
    if (sid === undefined) return;
    let val = raw;
    if (raw === "" || raw == null) val = null;
    else if (raw[0] !== "=" && isNumeric(raw)) val = Number(raw);
    try { hf.setCellContents({ sheet: sid, row: r, col: c }, [[val]]); } catch (e) { /* ignore */ }
  }

  function computedValue(sheet, r, c) {
    const cell = sheet.cells[addr(r, c)];
    if (hfReady) {
      const sid = hfSheetId(sheet.name);
      if (sid !== undefined) {
        try {
          const v = hf.getCellValue({ sheet: sid, row: r, col: c });
          if (v != null && typeof v === "object" && "type" in v && v.type === "ERROR") return { err: true, val: v.value || "#ERR" };
          const val = v == null ? "" : v;
          if (cell && cell.f != null && val !== "" && (typeof val === "number" || typeof val === "string")) cell._v = val;   // formula का last-computed मान cache — engine तैयार होने से पहले दिखे
          return { err: false, val: val };
        } catch (e) { /* fall through */ }
      }
    }
    // engine तैयार नहीं — formula हो तो cached मान (न हो तो खाली; formula-text नहीं); वरना सीधा value
    if (!cell) return { err: false, val: "" };
    if (cell.f != null) return { err: false, val: cell._v != null ? cell._v : "" };
    return { err: false, val: cell.v };
  }

  function isNumeric(x) { return x !== "" && x !== null && !isNaN(x) && isFinite(Number(x)); }

  /* ============== 4. SHEETS ============== */
  // नई शीट का सुंदर dialog (दो fields एक साथ — native prompt की जगह)
  //   opts.kind = "master" (Analysis library की मूल शीट) या "working" (Rate Analysis की खाली copy)
  function newSheet(opts) {
    opts = opts || {};
    const isMaster = opts.kind === "master";
    const isMorth = (opts.source || "morth") === "morth";
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const groupOpts = chaptersOf(opts.source).map((g) => "<option value='" + g.key + "'" + (g.key === (opts.group || defaultChapterKey(opts.source)) ? " selected" : "") + ">" + escapeHtml(g.name) + "</option>").join("");
    const sizeOpts = SIZES.map((s) => "<option value='" + s.key + "'" + (s.key === (opts.size || projectSize) ? " selected" : "") + ">" + s.name + "</option>").join("");
    const head = isMaster ? ("नया " + (isMorth ? "MoRTH" : "MoRD") + " Analysis") : "नई Analysis शीट";
    overlay.innerHTML =
      "<div class='modal'>" +
      "<h3>" + head + "</h3>" +
      "<p class='sub'>शीट के नाम में <b>space नहीं</b> चलेगा (formula-link के लिए) — space की जगह अपने-आप <b>_</b> लग जाएगा।</p>" +
      "<label class='ns-fld'>शीट का नाम (formula-link)<input id='nsName' type='text' placeholder='जैसे: GSB_Large' autocomplete='off' /></label>" +
      "<div class='ns-preview' id='nsPreview'></div>" +
      "<label class='ns-fld'>Analysis (आइटम) का नाम <span class='muted'>— print में ऊपर बड़ा आएगा</span><input id='nsTitle' type='text' placeholder='जैसे: Analysis of Rate for GSB' autocomplete='off' /></label>" +
      (isMaster ? "<label class='ns-fld'>MoRTH क्रम संख्या <span class='muted'>— इसी क्रम में chapter में sort होगा</span><input id='nsSerial' type='text' placeholder='जैसे: 4.5 या 305' value='" + escapeHtml(opts.serial != null ? String(opts.serial) : "") + "' autocomplete='off' /></label>" : "") +
      (isMaster ? "<label class='ns-fld'>Chapter (समूह)<select id='nsGroup'>" + groupOpts + "</select></label>" : "") +
      (isMaster && isMorth ? "<label class='ns-fld'>Project size<select id='nsSize'>" + sizeOpts + "</select></label>" : "") +
      "<div class='row'><button class='btn' id='nsCancel'>रद्द</button><button class='btn primary' id='nsOk'>बनाएँ</button></div>" +
      "</div>";
    document.body.appendChild(overlay);
    const nameEl = overlay.querySelector("#nsName"), titleEl = overlay.querySelector("#nsTitle"), prev = overlay.querySelector("#nsPreview");
    const refreshPrev = () => { const v = nameEl.value.trim(); prev.textContent = v ? "शीट का नाम बनेगा:  " + safeName(v) : ""; nameEl.style.borderColor = ""; };
    nameEl.addEventListener("input", refreshPrev);
    const close = () => overlay.remove();
    const submit = () => {
      const rawName = nameEl.value.trim();
      if (!rawName) { nameEl.style.borderColor = "var(--red)"; nameEl.focus(); return; }
      const base = uniqueName(safeName(rawName));
      const title = titleEl.value.trim() || base.replace(/_/g, " ");
      const grpEl = overlay.querySelector("#nsGroup");
      const sizeEl = overlay.querySelector("#nsSize");
      const serialEl = overlay.querySelector("#nsSerial");
      close();
      createSheet(base, title, {
        kind: opts.kind || "working",
        group: grpEl ? grpEl.value : (opts.group || "misc"),
        source: opts.source || "morth",
        size: sizeEl ? sizeEl.value : opts.size,
        serial: serialEl ? serialEl.value.trim() : (opts.serial || ""),
      });
    };
    overlay.querySelector("#nsCancel").addEventListener("click", close);
    overlay.querySelector("#nsOk").addEventListener("click", submit);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
      else if (e.key === "Enter") { e.preventDefault(); submit(); }
    });
    nameEl.focus();
  }

  // Analysis sheet का ढाँचा — column headers + subheads (Labour/Machinery/Material) +
  //  हर subhead का section-total, फिर Sub Total, फिर (final) Total।
  //  विशेष पंक्तियों के C-cell पर role marker रहता है: "sec" | "sectot" | "subtot" | "grandtot"।
  const ANALYSIS_COLS = ["SN", "Ref MoRTH", "Description", "Unit", "Quantity", "Rate", "Amount"];
  const SEC_STYLE = { b: 1, bg: "EAF1F8", al: "left" };
  const SECTOT_STYLE = { b: 1, bg: "F2F7FC" };
  const TOTAL_STYLE = { b: 1, bg: "FFF2CC" };
  const OHCP_STYLE = { b: 1, bg: "FDEFDC" };          // Overhead / Contractor Profit पंक्ति
  const TAKEOUT_STYLE = { b: 1, bg: "FFF9C4", fc: "5A4B00" };   // "Taking output =" की Quantity/Unit — भरने हेतु अलग रंग (हल्का पीला)
  const PERUNIT_STYLE = { b: 1, bg: "F2F7FC" };                  // Rate per Unit = Total ÷ Quantity
  const FINALRATE_STYLE = { b: 1, bg: "D7E2F5" };               // Say Rs. = FLOOR(rate, 0.10) — Analysis का final Rate
  const ITEM_ROWS_PER_SECTION = 3;
  const ANALYSIS_PREAMBLE_ROWS = 4;   // पहले section (Labour) से ऊपर खाली पंक्तियाँ

  /* Overhead व Contractor Profit — % estimate से आते हैं, सभी analysis पर लागू।
     sep=true → अलग-अलग (Overhead A पर, फिर Contractor Profit (A+Overhead) पर)।
     sep=false → दोनों एक साथ (combined %), A पर। */
  const OH_DEFAULTS = { sep: true, ohPct: 10, cpPct: 10, combPct: 12.5 };
  let ohSettings = Object.assign({}, OH_DEFAULTS);
  // estimate के Overhead-groups (हर group = Remark + %); पुराने estimate के single % → एक group
  function estOhGroups(est) {
    if (!est) return [];
    if (Array.isArray(est.ohGroups) && est.ohGroups.length) return est.ohGroups;
    return [{
      id: "ohg_default", remark: "",
      sep: est.ohSep !== false,
      ohPct: est.ohPct != null ? mrNum(est.ohPct) : OH_DEFAULTS.ohPct,
      cpPct: est.cpPct != null ? mrNum(est.cpPct) : OH_DEFAULTS.cpPct,
      combPct: est.combPct != null ? mrNum(est.combPct) : OH_DEFAULTS.combPct,
    }];
  }
  function ohFromGroup(g) {
    return { sep: g.sep !== false, ohPct: mrNum(g.ohPct), cpPct: mrNum(g.cpPct), combPct: mrNum(g.combPct) };
  }
  function estOhSettings(est) {
    if (!est) return Object.assign({}, OH_DEFAULTS);
    return ohFromGroup(estOhGroups(est)[0]);
  }
  function setActiveEstimateOh() { ohSettings = estOhSettings(state.estimates[state.activeEstimateId]); }
  // इस sheet पर कौन-सा OH group लागू हो — sheet.ohGroupId से; न मिले तो पहला group
  function ohSettingsForSheet(sheet) {
    const est = state.estimates[state.activeEstimateId];
    const gs = est ? estOhGroups(est) : [];
    if (!gs.length) return ohSettings;
    const g = (sheet && sheet.ohGroupId && gs.find((x) => x.id === sheet.ohGroupId)) || gs[0];
    return ohFromGroup(g);
  }
  function ohGroupDesc(g) {
    return g.sep === false ? ("एक साथ " + fmtPct(g.combPct) + "%") : ("OH " + fmtPct(g.ohPct) + "% + CP " + fmtPct(g.cpPct) + "%");
  }
  function fmtPct(p) { p = Math.round(mrNum(p) * 100) / 100; return String(p); }
  // ── कार्य-समूह (work group) — हर समूह = नाम + मुख्य? + अपना RMR + अपने Overhead ──
  //  storage: est.workGroups = [{id,name,isMain,rmrId,ohGroupId}] (RMR est.rmrs में, OH est.ohGroups में)
  function estWorkGroups(est) {
    if (!est) return [];
    if (Array.isArray(est.workGroups) && est.workGroups.length) return est.workGroups;
    // पुराने estimate (अलग rmrs + ohGroups) → समूहों में जोड़ो
    const rmrs = est.rmrs || [];
    const ohs = estOhGroups(est);
    const n = Math.max(rmrs.length, ohs.length, 1);
    const out = [];
    for (let i = 0; i < n; i++) {
      const r = rmrs[i], o = ohs[i];
      out.push({
        id: uid("wg"),
        name: (r && r.name) || (o && o.remark) || ("समूह " + (i + 1)),
        isMain: i === 0, rmrId: r ? r.id : null, ohGroupId: o ? o.id : null,
      });
    }
    return out;
  }
  // form के लिए हर समूह का पूरा डेटा (RMR की queryDist + OH के %) एक object में
  function neWgData(est) {
    const wgs = estWorkGroups(est);
    const rmrs = est ? (est.rmrs || []) : [];
    const ohs = est ? estOhGroups(est) : [];
    return wgs.map((wg) => {
      const r = rmrs.find((x) => x.id === wg.rmrId);
      const o = ohs.find((x) => x.id === wg.ohGroupId) || {};
      return {
        id: wg.id, name: wg.name, isMain: !!wg.isMain, rmrId: wg.rmrId, ohGroupId: wg.ohGroupId,
        queryDist: r ? (r.queryDist || {}) : {},
        sep: o.sep !== false, ohPct: o.ohPct, cpPct: o.cpPct, combPct: o.combPct,
      };
    });
  }
  function buildAnalysisTemplate(sectionNames) {
    const cols = ANALYSIS_COLS.length;
    const cells = {}, merges = [];
    ANALYSIS_COLS.forEach((h, c) => { cells[addr(0, c)] = { v: h }; });
    let r = 1 + ANALYSIS_PREAMBLE_ROWS;   // header के बाद 4 खाली पंक्तियाँ, फिर sections
    sectionNames.forEach((nm) => {
      cells[addr(r, 2)] = { v: "", s: Object.assign({}, SEC_STYLE), role: "sec", secName: nm };
      merges.push({ s: { r: r, c: 2 }, e: { r: r, c: cols - 1 } });
      const itemStart = r + 1;
      r = itemStart + ITEM_ROWS_PER_SECTION;
      cells[addr(r, 2)] = { v: "", s: Object.assign({}, SECTOT_STYLE), role: "sectot" };
      cells[addr(r, 6)] = { f: "=ROUND(SUM(" + addr(itemStart, 6) + ":" + addr(r - 1, 6) + "),2)", s: Object.assign({}, SECTOT_STYLE) };
      r++;
    });
    cells[addr(r, 2)] = { v: "Sub Total", s: Object.assign({}, TOTAL_STYLE), role: "subtot" };
    r++;
    cells[addr(r, 2)] = { v: "Total", s: Object.assign({}, TOTAL_STYLE), role: "grandtot" };
    r++;
    cells[addr(r, 2)] = { v: "Rate per Unit =", s: Object.assign({}, PERUNIT_STYLE), role: "perunit" };
    cells[addr(r, 6)] = { s: Object.assign({}, PERUNIT_STYLE) };
    r++;
    cells[addr(r, 2)] = { v: "Say Rs. =", s: Object.assign({}, FINALRATE_STYLE), role: "finalrate" };
    cells[addr(r, 6)] = { s: Object.assign({}, FINALRATE_STYLE) };
    r++;
    // "Taking output =" पंक्ति (अंतिम preamble row = display row 5): C=label, D=Quantity, E=Unit —
    //  D/E को अलग रंग/format ताकि Analysis बनाते समय ये ही भरे जाएँ (formula-link insert/delete पर slip-proof — HF refs adjust)
    const toR = ANALYSIS_PREAMBLE_ROWS;   // r=4 → display row 5
    cells[addr(toR, 2)] = { v: "Taking output =", s: { b: 1, al: "left" } };
    cells[addr(toR, 3)] = { v: "", s: Object.assign({}, TAKEOUT_STYLE, { al: "right" }) };    // D5 = Quantity
    cells[addr(toR, 4)] = { v: "", s: Object.assign({}, TAKEOUT_STYLE, { al: "center" }) };   // E5 = Unit
    return { cells, merges, rows: r, cols };
  }
  // पुराने Analysis में भी row 5 (Taking output) का format — C5 label + D5/E5 अलग रंग (value बरकरार; slip-proof HF वैसे ही)
  //  सुरक्षित: सिर्फ़ analysis (master/working) शीट, और row 5 जब खाली/taking-output जैसा हो तभी; idempotent
  function migrateTakingOutput() {
    const r = ANALYSIS_PREAMBLE_ROWS;   // display row 5
    const re = /taking|output|out\s*put|unit\s*=|इकाई|मात्रा|आउटपुट/i;
    let changed = 0;
    for (const id of state.order) {
      const s = state.sheets[id];
      if (!s || (s.kind !== "master" && s.kind !== "working")) continue;
      if (!(s.rows > ANALYSIS_PREAMBLE_ROWS)) continue;
      const cC = s.cells[addr(r, 2)];
      const cv = cC ? (cC.f != null ? "" : (cC.v == null ? "" : String(cC.v))) : "";
      if (cv.trim() && !re.test(cv)) continue;   // इस शीट का row 5 taking-output जैसा नहीं — छेड़ो मत
      const c2 = s.cells[addr(r, 2)] || (s.cells[addr(r, 2)] = { v: "" }); delete c2.f; c2.v = "Taking output ="; c2.s = { b: 1, al: "left" };
      const c3 = s.cells[addr(r, 3)] || (s.cells[addr(r, 3)] = { v: "" }); c3.s = Object.assign({}, TAKEOUT_STYLE, { al: "right" });
      const c4 = s.cells[addr(r, 4)] || (s.cells[addr(r, 4)] = { v: "" }); c4.s = Object.assign({}, TAKEOUT_STYLE, { al: "center" });
      db.put("sheets", s); changed++;
    }
    return changed;
  }
  // पुराने Analysis में grand Total के बाद "Rate per Unit =" व "Say Rs. =" (final rate) पंक्तियाँ जोड़ो (idempotent; HF ज़रूरी)
  // grand Total के बाद "Rate per Unit =" + "Say Rs. =" पंक्तियाँ जोड़ो (न हों तो) — cells सीधे (HF की ज़रूरत नहीं)
  function ensureFinalRateRows(s) {
    if (!s) return false;
    if (analysisScan(s).finalRow >= 0) return false;   // पहले से है
    ensureGrandtotRole(s);   // MoRD/imported में grandtot role न हो तो "Total" label से मार्क करो
    const info = analysisScan(s);
    if (info.grandRow < 0) return false;   // structured नहीं
    const gr = info.grandRow;
    for (let r = s.rows - 1; r > gr; r--) for (let c = 0; c < s.cols; c++) {   // grandtot के बाद की पंक्तियाँ 2 नीचे
      const from = addr(r, c), to = addr(r + 2, c);
      if (s.cells[from]) { s.cells[to] = s.cells[from]; delete s.cells[from]; } else delete s.cells[to];
    }
    s.cells[addr(gr + 1, 2)] = { v: "Rate per Unit =", s: Object.assign({}, PERUNIT_STYLE), role: "perunit" };
    s.cells[addr(gr + 1, 6)] = { s: Object.assign({}, PERUNIT_STYLE) };
    s.cells[addr(gr + 2, 2)] = { v: "Say Rs. =", s: Object.assign({}, FINALRATE_STYLE), role: "finalrate" };
    s.cells[addr(gr + 2, 6)] = { s: Object.assign({}, FINALRATE_STYLE) };
    s.rows += 2;
    return true;
  }
  function migrateFinalRateRows() {
    let n = 0;
    _suppressEngine = true;
    try {
      for (const id of state.order.slice()) {
        const s = state.sheets[id];
        if (!s || (s.kind !== "master" && s.kind !== "working")) continue;
        if (ensureFinalRateRows(s)) { rebuildAnalysisTotals(s); persistSheet(s, true); n++; }
      }
    } finally { _suppressEngine = false; }
    if (hfReady) buildEngine();
    return n;
  }

  function createSheet(base, title, opts) {
    opts = opts || {};
    const tpl = buildAnalysisTemplate(["Labour", "Machinery", "Material"]);
    const cols = tpl.cols, cells = tpl.cells, merges = tpl.merges, rows = tpl.rows;
    const source = opts.source === "mord" ? "mord" : "morth";
    const sheet = { id: uid("sht"), name: base, rows, cols, cells, merges, colWidths: defaultColWidths(cols), title: title, lockTop: 1, lockBottom: 2, updatedAt: Date.now(),
      kind: opts.kind || "working", group: opts.group || defaultChapterKey(source), masterId: opts.masterId || null, source: source, serial: opts.serial != null ? String(opts.serial).trim() : "" };
    if (source === "morth") {
      sheet.size = isSize(opts.size) ? opts.size : projectSize;
      sheet.itemKey = opts.itemKey || uid("item");
      sheet.itemName = opts.itemName || title || base;
    }
    state.sheets[sheet.id] = sheet;
    state.order.push(sheet.id);
    if (hfReady) { try { hf.addSheet(sheet.name); hf.setSheetContent(hfSheetId(sheet.name), sheetMatrix(sheet)); } catch (e) { buildEngine(); } }
    rebuildAnalysisTotals(sheet);   // section-total/subtotal/grandtotal के formula + letters
    applyOverheadToSheet(sheet);    // Overhead + Contractor Profit (current estimate % अनुसार)
    db.put("sheets", sheet);
    renderSheetList();
    if (sheet.kind === "master") { renderMasterAnalysis(); openMasterForEdit(sheet.id); }
    else { openSheet(sheet.id); setActiveView("rate-analysis"); }
    refreshEstimateSheetPicker();
    status("नई शीट बनी: " + sheet.name);
    return sheet;
  }

  function openSheet(id) {
    armed = null; clearPointHL();
    // master शीट पहली बार खुले तो उसे engine में शामिल कर लो (lazy) — ताकि उसके formula सही मान दिखाएँ
    const _os = state.sheets[id];
    if (_os && _os.kind === "master" && !_engineMasters.has(_os.name)) {
      _engineMasters.add(_os.name);
      buildEngine();
    }
    state.activeSheetId = id;
    state.activeCell = { r: 0, c: 0 };
    state.selAnchor = null;
    renderSheetList();
    renderGrid();
    updateKindBanner();
  }

  // grid के ऊपर बताए कि यह master है या load की गई copy
  function updateKindBanner() {
    const el = document.getElementById("sheetKindBanner");
    if (!el) return;
    const s = state.sheets[state.activeSheetId];
    if (!s) { el.style.display = "none"; return; }
    if (s.kind === "dom" || s.kind === "boq" || s.kind === "summary" || s.kind === "bitumen") { el.style.display = "none"; return; }   // DOM/BOQ/Summary/Bitumen — कोई banner नहीं
    const tag = (s.source === "mord" ? "MoRD" : "MoRTH") + ((s.source || "morth") === "morth" && isSize(s.size) ? " · " + sizeName(s.size) : "") + (s.rmrName ? " · RMR: " + s.rmrName : "");
    if (s.kind === "master") {
      el.style.display = "none";   // master banner नहीं दिखाना (आवश्यकता नहीं)
    } else if (isWorkingCopy(s)) {
      const m = state.sheets[s.masterId];
      const pref = s.syncPref === "master" ? " · अभी: हमेशा Master भी" : s.syncPref === "local" ? " · अभी: केवल यह file" : "";
      el.className = "kind-banner copy";
      el.innerHTML = "🔗 <b>Loaded copy</b> [" + escapeHtml(tag) + "] (Master: " + escapeHtml(m ? (m.itemName || m.name) : "?") + ") — बदलाव इसी file में; हर बदलाव पर पूछेगा Master में भी डालें या नहीं" + escapeHtml(pref) + ".";
      el.style.display = "";
    } else {
      el.className = "kind-banner";
      el.innerHTML = "📄 <b>खाली working शीट</b> — किसी master से जुड़ी नहीं।";
      el.style.display = "";
    }
  }

  // silent=true → केवल auto re-rate / auto-link जैसे system बदलाव; "अंतिम सुधार" समय नहीं बदलता
  // (updatedAt सिर्फ़ तब बदले जब user ने खुद शीट के अंदर कुछ बदला हो)
  function persistSheet(sheet, silent) {
    if (!silent) sheet.updatedAt = Date.now();
    else if (!sheet.updatedAt) sheet.updatedAt = Date.now();  // पुरानी शीट जिसमें कभी stamp नहीं लगा
    db.put("sheets", sheet);
  }

  // कौन-कौन सी शीट इस शीट से link हैं (इसके cell को formula में पढ़ती हैं)
  function findDependents(id) {
    const target = state.sheets[id];
    if (!target) return [];
    const re = new RegExp("(^|[^A-Za-z0-9_'!])" + escapeReg(target.name) + "!");
    const deps = [];
    for (const sid of state.order) {
      if (sid === id) continue;
      const s = state.sheets[sid];
      let n = 0;
      for (const a in s.cells) { const cell = s.cells[a]; if (cell.f && re.test(cell.f)) n++; }
      if (n) deps.push(s.name + " (" + n + " cell)");
    }
    return deps;
  }

  function deleteActiveSheet() {
    const id = state.activeSheetId;
    if (!id) return Promise.resolve(false);
    const sheet = state.sheets[id];
    const rateView = document.getElementById("view-rate-analysis");
    const inRateView = !!(rateView && rateView.classList.contains("active"));

    // Rate Analysis से master शीट "हटाना" = सिर्फ़ इस सूची से बंद करना —
    // Master Data (library) की मूल शीट पर कोई असर नहीं
    if (sheet.kind === "master" && inRateView) {
      return askConfirm({
        icon: "🗄️", tone: "info", okCls: "primary",
        title: "Master शीट यहाँ से बंद करें?",
        chip: sheet.name,
        body: "यह <b>Master Analysis</b> की मूल शीट है — यहाँ से हटाने पर सिर्फ़ इस सूची से बंद होगी।",
        note: "🛡️ Master Data में यह शीट पूरी तरह <b>सुरक्षित</b> रहेगी। स्थायी रूप से हटाना हो तो Master Data खंड से हटाएँ।",
        ok: "बंद करें",
      }).then((yes) => {
        if (!yes) return false;
        state.activeSheetId = state.order.find((x) => state.sheets[x] && state.sheets[x].kind === "working") || null;
        renderSheetList();
        if (state.activeSheetId) renderGrid(); else clearGrid();
        updateKindBanner();
        status("Master शीट सूची से बंद हुई — Master Data में सुरक्षित है");
        return true;
      });
    }

    const deps = findDependents(id);
    const isMaster = sheet.kind === "master";
    const isCopy = sheet.kind === "working" && sheet.masterId;
    return askConfirm({
      icon: "🗑", tone: "danger",
      title: isMaster ? "Master Analysis स्थायी रूप से हटाएँ?" : "शीट हटाएँ?",
      chip: sheet.name,
      body: isMaster
        ? "यह शीट <b>Master library</b> से स्थायी रूप से हट जाएगी।"
        : (isCopy
          ? "यह सिर्फ़ load की गई <b>copy</b> है — Master Data की मूल शीट पर कोई असर <b>नहीं</b> होगा।"
          : "यह working शीट स्थायी रूप से हट जाएगी।"),
      note: deps.length
        ? "⚠ नीचे दी शीट इससे link हैं — हटाने पर उनके link <b>#REF!</b> (error) हो जाएँगे। बेहतर होगा पहले उनके link ठीक/हटा लें।"
        : "✓ इससे कोई शीट link नहीं है — हटाना सुरक्षित है।",
      noteTone: deps.length ? "warn" : "safe",
      list: deps,
      ok: "हटाएँ",
    }).then((yes) => {
      if (!yes) return false;
      if (hfReady) { try { hf.removeSheet(hfSheetId(sheet.name)); } catch (e) { } }
      delete state.sheets[id];
      state.order = state.order.filter((x) => x !== id);
      // estimates से भी हटाओ
      for (const eid of state.estOrder) {
        const est = state.estimates[eid];
        if (est.sheetIds.includes(id)) { est.sheetIds = est.sheetIds.filter((x) => x !== id); db.put("estimates", est); }
      }
      db.del("sheets", id);
      // हटाने के बाद पहले किसी load किए (working) analysis को सक्रिय रखें
      state.activeSheetId = state.order.find((x) => state.sheets[x] && state.sheets[x].kind === "working") || null;
      renderSheetList();
      if (state.activeSheetId) renderGrid(); else clearGrid();
      updateKindBanner();
      refreshEstimateSheetPicker();
      renderEstimate();
      // Master-edit view में से हटाया हो तो वापस Master Data सूची पर लौटो
      const meView = document.getElementById("view-master-edit");
      if (isMaster && meView && meView.classList.contains("active")) setActiveView("master");
      status("शीट हटाई गई");
      return true;
    });
  }

  function renameActiveSheet(rawName) {
    const id = state.activeSheetId;
    if (!id) return;
    const sheet = state.sheets[id];
    const oldName = sheet.name;
    let nn = uniqueName(safeName(rawName), id);
    if (nn === oldName) return;

    // बाकी sheets के formulas में reference update (links बने रहें)
    const re = new RegExp("(^|[^A-Za-z0-9_'!])" + escapeReg(oldName) + "!", "g");
    for (const sid of state.order) {
      const s = state.sheets[sid];
      let changed = false;
      for (const a in s.cells) {
        const cell = s.cells[a];
        if (cell.f) {
          const nf = cell.f.replace(re, (m, p1) => p1 + nn + "!");
          if (nf !== cell.f) { cell.f = nf; changed = true; }
        }
      }
      if (changed) persistSheet(s);
    }
    sheet.name = nn;
    persistSheet(sheet);
    buildEngine(); // नाम बदलने पर engine दुबारा बनाना safe है
    renderSheetList();
    renderGrid();
    refreshEstimateSheetPicker();
    renderEstimate();
    document.getElementById("sheetNameInput").value = nn;
    status("नाम बदला: " + nn);
  }
  function escapeReg(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  function setCell(sheet, r, c, raw) {
    const a = addr(r, c);
    const prev = sheet.cells[a] || null;
    const prevStyle = prev ? prev.s : null; // editing पर formatting बचाओ
    const prevRole = prev ? prev.role : null, prevSec = prev ? prev.secName : null; // section markers बचाओ
    const prevMref = prev ? prev.mref : null; // Primary Rate से link (auto-update)
    raw = raw == null ? "" : String(raw);
    if (raw.trim() === "") {
      if (prevStyle || prevRole) sheet.cells[a] = { v: "" }; // रंग/format/marker वाला cell खाली पर बना रहे
      else delete sheet.cells[a];
    }
    else if (raw[0] === "=") sheet.cells[a] = { f: raw };
    else if (isNumeric(raw)) sheet.cells[a] = { v: Number(raw) };
    else sheet.cells[a] = { v: raw };
    if (sheet.cells[a]) {
      if (prevStyle && !sheet.cells[a].s) sheet.cells[a].s = prevStyle;
      if (prevRole) sheet.cells[a].role = prevRole;
      if (prevSec != null) sheet.cells[a].secName = prevSec;
      if (prevMref && raw.trim() !== "" && prevMref.field !== "royalty") sheet.cells[a].mref = prevMref; // खाली न हो तो link बना रहे (royalty manually भरने पर unlink → manual मान टिके)
    }
    setEngineCell(sheet, r, c, raw);
    persistSheet(sheet);
  }

  // Analysis template की डिफ़ॉल्ट column-चौड़ाई (px) — A4 portrait में फिट (~680px)
  function defaultColWidths(n) {
    const tpl = [42, 90, 300, 46, 64, 64, 78]; // SN, Ref, Description, Unit, Qty, Rate, Amount
    const w = [];
    for (let i = 0; i < n; i++) w.push(tpl[i] != null ? tpl[i] : 80);
    return w;
  }

  // पुरानी शीट में lock/width-जानकारी न हो तो भर दो (migration)
  function ensureLock(s) {
    if (typeof s.lockTop !== "number") s.lockTop = 1;   // Row 1 = column-headers (locked)
    if (typeof s.lockBottom !== "number") s.lockBottom = 1;
    if (typeof s.title !== "string") s.title = "";       // grid के बाहर का heading
    const min = s.lockTop + s.lockBottom + 1;
    if (s.rows < min) s.rows = min;
    if (!Array.isArray(s.colWidths)) s.colWidths = defaultColWidths(s.cols);
    while (s.colWidths.length < s.cols) s.colWidths.push(80);
    if (s.colWidths.length > s.cols) s.colWidths.length = s.cols;
  }
  function isLockedRow(s, r) { return r < (s.lockTop || 0) || r >= s.rows - (s.lockBottom || 0); }
  // सेक्शन-पट्टी (पूरी-चौड़ाई merged पंक्ति, जैसे "a) Labour")
  function isSectionRow(s, r) { const c = s.cells && s.cells[addr(r, 2)]; if (c && c.role) return true; return (s.merges || []).some((m) => m.s.r === r && m.s.c === 0 && (m.e.c - m.s.c) >= 1); }

  // किसी item-पंक्ति को उसी सेक्शन में ऊपर/नीचे — सेक्शन-पट्टी/header/footer पार नहीं
  function moveAnalysisRow(r, dir) {
    const sheet = state.sheets[state.activeSheetId]; if (!sheet) return;
    const t = r + dir;
    if (t < 0 || t >= sheet.rows) return;
    if (isLockedRow(sheet, r) || isSectionRow(sheet, r)) return;          // header/footer/section न हिले
    if (isLockedRow(sheet, t) || isSectionRow(sheet, t)) return;          // सेक्शन की सीमा पार नहीं
    pushUndo("sheet");
    // दो पंक्तियों के cells आपस में बदलो (style समेत); =E*F जैसे same-row formula की row ठीक करो
    const A = {}, B = {};
    for (let c = 0; c < sheet.cols; c++) {
      const ar = addr(r, c), at = addr(t, c);
      if (sheet.cells[ar]) A[c] = sheet.cells[ar];
      if (sheet.cells[at]) B[c] = sheet.cells[at];
      delete sheet.cells[ar]; delete sheet.cells[at];
    }
    for (const c in A) { const cell = A[c]; if (cell.f) cell.f = shiftFormulaRows(cell.f, dir); sheet.cells[addr(t, +c)] = cell; }
    for (const c in B) { const cell = B[c]; if (cell.f) cell.f = shiftFormulaRows(cell.f, -dir); sheet.cells[addr(r, +c)] = cell; }
    persistSheet(sheet);
    if (hfReady) buildEngine();
    state.activeCell = { r: t, c: state.activeCell.c };
    renderGrid();
    scrollToActive();
  }

  // row/col insert-delete पर merged-cells (title आदि) की रेंज भी ठीक रखो
  function adjustMerges(sheet, kind, index, count) {
    if (!Array.isArray(sheet.merges)) return;
    count = Math.max(1, count || 1);
    const dEnd = index + count - 1;               // delete range का अंतिम
    const out = [];
    for (const m of sheet.merges) {
      let sr = m.s.r, er = m.e.r, sc = m.s.c, ec = m.e.c;
      if (kind === "insRow") { if (index <= sr) { sr += count; er += count; } else if (index <= er) er += count; }
      else if (kind === "delRow") {
        if (sr >= index && er <= dEnd) continue;   // पूरी तरह हटी → drop
        if (sr > dEnd) sr -= count; else if (sr >= index) sr = index;
        if (er > dEnd) er -= count; else if (er >= index) er = index - 1;
        if (er < sr) continue;
      }
      else if (kind === "insCol") { if (index <= sc) { sc += count; ec += count; } else if (index <= ec) ec += count; }
      else if (kind === "delCol") {
        if (sc >= index && ec <= dEnd) continue;
        if (sc > dEnd) sc -= count; else if (sc >= index) sc = index;
        if (ec > dEnd) ec -= count; else if (ec >= index) ec = index - 1;
        if (ec < sc) continue;
      }
      if (er >= sr && ec >= sc && !(er === sr && ec === sc)) out.push({ s: { r: sr, c: sc }, e: { r: er, c: ec } });
    }
    sheet.merges = out;
  }

  // नई पंक्ति चुने हुए (active) cell के ठीक ऊपर — body में clamp होकर
  function addRow() { const s = state.sheets[state.activeSheetId]; if (!s) return; structuralEdit("insRow", state.activeCell.r); }
  function addCol() { const s = state.sheets[state.activeSheetId]; if (!s) return; pushUndo("sheet"); ensureLock(s); s.cols++; s.colWidths.push(80); persistSheet(s); if (hfReady) buildEngine(); renderGrid(); }
  // चुने cell की पंक्ति/कॉलम हटाएँ (structuralEdit खुद confirm + lock-guard करता है)
  function delActiveRow() { const s = state.sheets[state.activeSheetId]; if (!s) return; structuralEdit("delRow", state.activeCell.r); }
  function delActiveCol() { const s = state.sheets[state.activeSheetId]; if (!s) return; structuralEdit("delCol", state.activeCell.c); }

  /* ---------- बीच में Row/Column insert/delete — links अपने-आप समायोजित ----------
     HyperFormula के CRUD (addRows/removeRows/...) हर दूसरी शीट के formula को
     भी ठीक कर देते हैं (जैसे =Analysis!E50 → =Analysis!E51), इसलिए BoQ का link slip नहीं होता।
  */
  // batched/silent structural core — extra props (style + role/secName markers) बचाकर
  //  N पंक्ति/कॉलम एक साथ insert/delete; HF CRUD से सभी links slip-proof रहते हैं।
  function structuralBatch(kind, index, count, silent) {
    const sheet = state.sheets[state.activeSheetId];
    if (!sheet) return false;
    if (!hfReady) buildEngine();
    if (!hfReady) { if (!silent) alert("Links सुरक्षित रखने के लिए calculation engine (HyperFormula) ज़रूरी है।\nInternet जोड़कर page दोबारा खोलें।"); return false; }
    const sid = hfSheetId(sheet.name);
    if (sid === undefined) { buildEngine(); return false; }
    ensureLock(sheet);
    count = Math.max(1, count || 1);
    if (kind === "insRow") { index = Math.max(sheet.lockTop, Math.min(index, sheet.rows - sheet.lockBottom)); }
    else if (kind === "delRow" && !silent && isLockedRow(sheet, index)) { alert("यह पंक्ति लॉक है — इसे हटाया नहीं जा सकता।"); return false; }
    if (kind === "delRow" && sheet.rows - count < 1) return false;
    if (kind === "delCol" && sheet.cols - count < 1) return false;
    if (!silent && (kind === "delRow" || kind === "delCol") &&
      !confirm("क्या यह " + (kind === "delRow" ? "पंक्ति" : "कॉलम") + " हटाएँ?\nइसमें मौजूद cell को सीधे जोड़ने वाले link #REF! बन सकते हैं।")) return false;

    // extra props (style + markers) सहेजो — syncAllFromEngine सिर्फ़ value/formula लाता है
    const savedExtra = [];
    for (const a in sheet.cells) {
      const cell = sheet.cells[a]; const extra = {}; let has = false;
      for (const k of ["s", "role", "secName", "mref", "lead", "leadText", "itemId", "sumkind", "utilShort"]) { if (cell[k] != null) { extra[k] = cell[k]; has = true; } }
      if (has) { const p = parseAddr(a); if (p) savedExtra.push({ r: p.r, c: p.c, extra }); }
    }
    try {
      if (kind === "insRow") hf.addRows(sid, [index, count]);
      else if (kind === "delRow") hf.removeRows(sid, [index, count]);
      else if (kind === "insCol") hf.addColumns(sid, [index, count]);
      else if (kind === "delCol") hf.removeColumns(sid, [index, count]);
    } catch (e) { console.error(e); if (!silent) alert("यह क्रिया अभी नहीं हो सकी: " + e.message); return false; }

    if (kind === "insRow") sheet.rows += count;
    else if (kind === "delRow") sheet.rows -= count;
    else if (kind === "insCol") { sheet.cols += count; for (let i = 0; i < count; i++) sheet.colWidths.splice(index, 0, 80); }
    else if (kind === "delCol") { sheet.cols -= count; sheet.colWidths.splice(index, count); }
    adjustMerges(sheet, kind, index, count);

    syncAllFromEngine();
    for (const os of savedExtra) {
      let nr = os.r, nc = os.c;
      if (kind === "insRow") { if (os.r >= index) nr += count; }
      else if (kind === "delRow") { if (os.r >= index && os.r < index + count) continue; if (os.r >= index + count) nr -= count; }
      else if (kind === "insCol") { if (os.c >= index) nc += count; }
      else if (kind === "delCol") { if (os.c >= index && os.c < index + count) continue; if (os.c >= index + count) nc -= count; }
      if (nr < 0 || nr >= sheet.rows || nc < 0 || nc >= sheet.cols) continue;
      const a = addr(nr, nc);
      const cell = sheet.cells[a] || (sheet.cells[a] = { v: "" });
      Object.assign(cell, os.extra);
    }
    persistSheet(sheet);
    state.activeCell = { r: Math.min(state.activeCell.r, sheet.rows - 1), c: Math.min(state.activeCell.c, sheet.cols - 1) };
    return true;
  }

  function structuralEdit(kind, index) {
    const sheet = state.sheets[state.activeSheetId];
    if (!sheet) return;
    // section/total (marked) पंक्ति −Row से न हटे — उसके लिए "− उपशीर्षक"
    if (kind === "delRow") { const mc = sheet.cells[addr(index, 2)]; if (mc && mc.role) { alert("यह section/total पंक्ति है — इसे नीचे '− उपशीर्षक' बटन से हटाएँ।"); return; } }
    pushUndo("all");
    if (!structuralBatch(kind, index, 1, false)) { undoStack.pop(); return; }   // रद्द → snapshot हटाओ
    if (kind === "insRow" || kind === "delRow") rebuildAnalysisTotals(sheet); // section-totals का दायरा ठीक रखो
    renderGrid();
    refreshEstimateSheetPicker();
    const did = { insRow: "पंक्ति जोड़ी", delRow: "पंक्ति हटाई", insCol: "कॉलम जोड़ा", delCol: "कॉलम हटाया" }[kind];
    status(did + " — सभी शीट-links अपने-आप समायोजित (slip नहीं हुए)");
  }
  // चुनी हुई कई पंक्तियाँ (r1..r2) एक साथ हटाओ — lock/section छोड़कर, नीचे से ऊपर (index-shift से बचने), slip-proof
  function deleteRowRange(r1, r2) {
    const sheet = state.sheets[state.activeSheetId]; if (!sheet) return;
    ensureLock(sheet);
    if (r1 > r2) { const t = r1; r1 = r2; r2 = t; }
    const dels = [];
    for (let rr = r1; rr <= r2; rr++) {
      if (isLockedRow(sheet, rr)) continue;                       // header/footer lock — न हटाएँ
      const mc = sheet.cells[addr(rr, 2)]; if (mc && mc.role) continue;   // section/total — न हटाएँ
      dels.push(rr);
    }
    if (!dels.length) { alert("चुनी हुई पंक्तियों में कोई हटाने योग्य item-पंक्ति नहीं (सब lock/section हैं)।"); return; }
    const skipped = (r2 - r1 + 1) - dels.length;
    if (!confirm("क्या चुनी हुई " + dels.length + " पंक्तियाँ हटाएँ?" + (skipped ? "\n(" + skipped + " lock/section पंक्तियाँ छोड़ दी जाएँगी)" : ""))) return;
    pushUndo("all");
    for (let i = dels.length - 1; i >= 0; i--) structuralBatch("delRow", dels[i], 1, true);   // नीचे से ऊपर, silent
    rebuildAnalysisTotals(sheet);
    renderGrid();
    refreshEstimateSheetPicker();
    status(dels.length + " पंक्तियाँ हटाई — सभी शीट-links अपने-आप समायोजित (slip नहीं हुए)");
  }

  /* ===== Analysis subheads (Labour/Machinery/…) — add/delete + section totals ===== */
  // विशेष पंक्तियाँ scan करके ढाँचा लौटाओ
  function analysisScan(sheet) {
    const sections = []; let subRow = -1, grandRow = -1, ohRow = -1, cpRow = -1, ohcpRow = -1, perRow = -1, finalRow = -1, cur = null;
    for (let r = 0; r < sheet.rows; r++) {
      const cell = sheet.cells[addr(r, 2)];
      const role = cell && cell.role;
      if (role === "sec") { if (cur) sections.push(cur); cur = { head: r, name: (cell.secName || ""), itemStart: r + 1, itemEnd: r, tot: -1 }; }
      else if (role === "sectot") { if (cur) { cur.tot = r; cur.itemEnd = r - 1; sections.push(cur); cur = null; } }
      else if (role === "subtot") { if (cur) { sections.push(cur); cur = null; } subRow = r; }
      else if (role === "overhead") ohRow = r;
      else if (role === "profit") cpRow = r;
      else if (role === "ohcp") ohcpRow = r;
      else if (role === "grandtot") { if (cur) { sections.push(cur); cur = null; } grandRow = r; }
      else if (role === "perunit") perRow = r;
      else if (role === "finalrate") finalRow = r;
    }
    if (cur) sections.push(cur);
    return { sections, subRow, grandRow, ohRow, cpRow, ohcpRow, perRow, finalRow };
  }
  function isRoyaltySec(sheet, sec) { return /royal|रॉयल|रायल्टी/i.test((sheet.cells[addr(sec.head, 2)] || {}).secName || ""); }
  // grandtot role न हो पर "Total" label वाली पंक्ति हो (MoRD/imported), तो उसे grandtot मार्क करो → grandRow लौटाओ
  function ensureGrandtotRole(sheet) {
    for (let r = 0; r < sheet.rows; r++) { const c = sheet.cells[addr(r, 2)]; if (c && c.role === "grandtot") return r; }
    const info = analysisScan(sheet);
    const start = info.subRow >= 0 ? info.subRow + 1 : 1;
    for (let r = start; r < sheet.rows; r++) {
      const c = sheet.cells[addr(r, 2)]; const v = c ? (c.f != null ? "" : (c.v == null ? "" : String(c.v))) : "";
      if (/\btotal\b/i.test(v) && !/sub\s*total/i.test(v) && !/total\s*\(\s*[a-z]\s*\)/i.test(v)) {
        const cc = sheet.cells[addr(r, 2)] || (sheet.cells[addr(r, 2)] = {}); cc.role = "grandtot"; return r;
      }
    }
    return -1;
  }
  // "Taking output =" पंक्ति का Quantity-cell (D) — नाम से खोजो ताकि row जोड़ने/हटाने पर संदर्भ slip न करे
  function takingOutputQtyRef(sheet) {
    for (let r = 0; r < sheet.rows; r++) {
      const c = sheet.cells[addr(r, 2)];
      const v = c ? (c.f != null ? "" : (c.v == null ? "" : String(c.v))) : "";
      if (/taking\s*out\s*put/i.test(v)) return addr(r, 3);
    }
    return addr(ANALYSIS_PREAMBLE_ROWS, 3);   // fallback D5
  }
  function isStructuredAnalysis(sheet) { return analysisScan(sheet).subRow >= 0; }
  // formula cell लिखो (style बचाकर) — role/markers साफ़ रखते हुए
  function putFormula(sheet, r, c, f) {
    const a = addr(r, c); const prev = sheet.cells[a] || {};
    const cell = { f: f }; if (prev.s) cell.s = prev.s;
    sheet.cells[a] = cell;
  }
  // सभी section-total/subtotal/grandtotal के formula + letters दोबारा बनाओ
  function rebuildAnalysisTotals(sheet) {
    const info = analysisScan(sheet);
    if (info.subRow < 0 && info.sections.every((s) => s.tot < 0)) return; // structured नहीं
    info.sections.forEach((sec, i) => {
      const letter = String.fromCharCode(97 + i);
      const hc = sheet.cells[addr(sec.head, 2)];
      if (hc) { hc.v = letter + ")  " + (hc.secName || sec.name || ""); }
      if (sec.tot >= 0) {
        const tc = sheet.cells[addr(sec.tot, 2)] || (sheet.cells[addr(sec.tot, 2)] = {});
        tc.v = "Total (" + letter + ")"; tc.role = "sectot";
        const rng = sec.itemEnd >= sec.itemStart ? "=ROUND(SUM(" + addr(sec.itemStart, 6) + ":" + addr(sec.itemEnd, 6) + "),2)" : "=0";
        putFormula(sheet, sec.tot, 6, rng);
      }
    });
    const hasRoy = info.sections.some((s) => isRoyaltySec(sheet, s));
    const hasGrand = info.grandRow >= 0;   // grandtot हो तो Royalty उसमें (Sub Total से बाहर); न हो तो Sub Total में
    if (info.subRow >= 0) {
      const sc = sheet.cells[addr(info.subRow, 2)] || (sheet.cells[addr(info.subRow, 2)] = {}); sc.v = (hasRoy && hasGrand) ? "Sub Total without Royality =" : "Sub Total ="; sc.role = "subtot";
      const parts = info.sections.filter((s) => s.tot >= 0 && (hasGrand ? !isRoyaltySec(sheet, s) : true)).map((s) => addr(s.tot, 6));
      putFormula(sheet, info.subRow, 6, parts.length ? "=ROUND(" + parts.join("+") + ",2)" : "=0");
    }
    // Overhead / Contractor Profit — A = Sub Total पर (सब 2 दशमलव); % इस sheet के OH group से
    const oh = ohSettingsForSheet(sheet);
    const grandParts = [];
    if (info.subRow >= 0) {
      const subA = addr(info.subRow, 6); grandParts.push(subA);
      if (info.ohcpRow >= 0) {
        const c = sheet.cells[addr(info.ohcpRow, 2)] || (sheet.cells[addr(info.ohcpRow, 2)] = {});
        c.role = "ohcp"; c.v = "Overhead + Contractor Profit @ " + fmtPct(oh.combPct) + "%";
        putFormula(sheet, info.ohcpRow, 6, "=ROUND(" + subA + "*" + mrNum(oh.combPct) + "/100,2)");
        grandParts.push(addr(info.ohcpRow, 6));
      }
      let ohA = null;
      if (info.ohRow >= 0) {
        const c = sheet.cells[addr(info.ohRow, 2)] || (sheet.cells[addr(info.ohRow, 2)] = {});
        c.role = "overhead"; c.v = "Overhead Charges @ " + fmtPct(oh.ohPct) + "%";
        putFormula(sheet, info.ohRow, 6, "=ROUND(" + subA + "*" + mrNum(oh.ohPct) + "/100,2)");
        ohA = addr(info.ohRow, 6); grandParts.push(ohA);
      }
      if (info.cpRow >= 0) {
        const c = sheet.cells[addr(info.cpRow, 2)] || (sheet.cells[addr(info.cpRow, 2)] = {});
        c.role = "profit"; c.v = "Contractor Profit @ " + fmtPct(oh.cpPct) + "%";
        const base = ohA ? "(" + subA + "+" + ohA + ")" : subA;   // A + Overhead पर
        putFormula(sheet, info.cpRow, 6, "=ROUND(" + base + "*" + mrNum(oh.cpPct) + "/100,2)");
        grandParts.push(addr(info.cpRow, 6));
      }
    }
    // Royalty section (हो तो) — grand Total में जोड़ो (OH/CP उस पर नहीं)
    const roySec = info.sections.find((s) => isRoyaltySec(sheet, s) && s.tot >= 0);
    if (info.grandRow >= 0) {
      const gc = sheet.cells[addr(info.grandRow, 2)] || (sheet.cells[addr(info.grandRow, 2)] = {}); gc.v = hasRoy ? "Total incl Royality =" : "Total ="; gc.role = "grandtot";
      const gParts = grandParts.slice(); if (roySec) gParts.push(addr(roySec.tot, 6));
      putFormula(sheet, info.grandRow, 6, gParts.length ? "=ROUND(" + gParts.join("+") + ",2)" : "=0");
    }
    // Rate per Unit = Total ÷ Quantity;  Say Rs. = FLOOR(rate, 0.10) — Analysis का final Rate
    const qtyRef = takingOutputQtyRef(sheet);   // "Taking output =" पंक्ति का D (row जोड़ने/हटाने पर भी सही — slip नहीं)
    if (info.perRow >= 0 && info.grandRow >= 0) {
      const pc = sheet.cells[addr(info.perRow, 2)] || (sheet.cells[addr(info.perRow, 2)] = {}); pc.v = "Rate per Unit ="; pc.role = "perunit";
      putFormula(sheet, info.perRow, 6, "=IFERROR(ROUND(" + addr(info.grandRow, 6) + "/" + qtyRef + ",4),\"\")");
    }
    if (info.finalRow >= 0 && info.perRow >= 0) {
      const fc = sheet.cells[addr(info.finalRow, 2)] || (sheet.cells[addr(info.finalRow, 2)] = {}); fc.v = "Say Rs. ="; fc.role = "finalrate";
      putFormula(sheet, info.finalRow, 6, "=IFERROR(FLOOR(" + addr(info.perRow, 6) + ",0.1),\"\")");
    }
    // lock: Royalty हो तो सिर्फ़ Total/perunit/finalrate lock (royalty items editable रहें); वरना Sub Total से नीचे सब
    const lockFrom = roySec ? (info.grandRow >= 0 ? info.grandRow : info.subRow) : (info.subRow >= 0 ? info.subRow : -1);
    if (lockFrom >= 0) sheet.lockBottom = Math.max(1, sheet.rows - lockFrom);
    persistSheet(sheet);
    if (hfReady && !_suppressEngine) buildEngine();
  }

  // एक analysis में Overhead/Contractor Profit पंक्तियाँ (ohSettings अनुसार) बना/अपडेट करो
  function applyOverheadToSheet(sheet) {
    if (!sheet || !isStructuredAnalysis(sheet)) return false;
    ensureGrandtotRole(sheet); // MoRD/पुराने analysis: "Total" पंक्ति को grandtot मार्क करो ताकि OH/CP लग सके
    if (rowWithRole(sheet, "grandtot") < 0) return false;
    const needRoles = ohSettingsForSheet(sheet).sep ? ["overhead", "profit"] : ["ohcp"];
    // पहले से सही charge-पंक्तियाँ हों तो सिर्फ़ % (formula/label) अपडेट करो — structural churn नहीं
    const cur = [];
    for (let r = 0; r < sheet.rows; r++) { const role = (sheet.cells[addr(r, 2)] || {}).role; if (role === "overhead" || role === "profit" || role === "ohcp") cur.push(role); }
    if (cur.length === needRoles.length && cur.every((v, i) => v === needRoles[i])) { rebuildAnalysisTotals(sheet); return true; }
    const prevA = state.activeSheetId, prevC = state.activeCell;
    state.activeSheetId = sheet.id;
    sheet.lockBottom = 1;   // structural ops के लिए ढीला
    // मौजूदा charge पंक्तियाँ हटाओ (नीचे→ऊपर)
    const chargeRows = [];
    for (let r = 0; r < sheet.rows; r++) { const role = (sheet.cells[addr(r, 2)] || {}).role; if (role === "overhead" || role === "profit" || role === "ohcp") chargeRows.push(r); }
    for (let i = chargeRows.length - 1; i >= 0; i--) structuralBatch("delRow", chargeRows[i], 1, true);
    // Sub Total के ठीक बाद ज़रूरी पंक्तियाँ डालो
    const sub = rowWithRole(sheet, "subtot");
    if (sub < 0) { state.activeSheetId = prevA; state.activeCell = prevC; return false; }
    const need = needRoles;
    structuralBatch("insRow", sub + 1, need.length, true);
    need.forEach((role, i) => {
      sheet.cells[addr(sub + 1 + i, 2)] = { v: "", s: Object.assign({}, OHCP_STYLE), role: role };
      sheet.cells[addr(sub + 1 + i, 6)] = { s: Object.assign({}, OHCP_STYLE) };
    });
    // Sub Total से नीचे सब (A + charges + Total) lock
    const newSub = rowWithRole(sheet, "subtot");
    sheet.lockBottom = Math.max(1, sheet.rows - newSub);
    rebuildAnalysisTotals(sheet);
    state.activeSheetId = prevA; state.activeCell = prevC;
    return true;
  }
  // सभी analyses में overhead/profit अपडेट करो (active estimate के % अनुसार)
  function applyOverheadAll() {
    setActiveEstimateOh();
    let n = 0;
    const prevSup = _suppressEngine;   // boot आदि में पहले से suppressed हो तो वैसा ही रखो (extra buildEngine न हो)
    _suppressEngine = true;
    try { for (const id of state.order.slice()) { if (applyOverheadToSheet(state.sheets[id])) n++; } }
    finally { _suppressEngine = prevSup; }
    if (!_suppressEngine) { if (hfReady) buildEngine(); if (state.activeSheetId) renderGrid(); }
    return n;
  }

  // नया उपशीर्षक जोड़ो (Sub Total से ठीक पहले)
  function addSubhead() {
    const sheet = state.sheets[state.activeSheetId]; if (!sheet) return;
    const info = analysisScan(sheet);
    if (info.subRow < 0) { alert("इस analysis में उपशीर्षक-ढाँचा नहीं है (नया analysis बनाएँ)।"); return; }
    askText({ title: "नया उपशीर्षक (Subhead)", sub: "क्रम-अक्षर (a, b, c…) अपने-आप लगेगा।", label: "उपशीर्षक का नाम", placeholder: "जैसे: Sundries / Overhead", ok: "जोड़ें" }).then((nm) => {
      if (nm === null) return;
      const at = analysisScan(sheet).subRow;         // ताज़ा subRow
      const block = 2 + ITEM_ROWS_PER_SECTION;       // header + items + sectot
      pushUndo("all");
      if (!structuralBatch("insRow", at, block, true)) { undoStack.pop(); return; }
      const headR = at, totR = at + 1 + ITEM_ROWS_PER_SECTION;
      sheet.cells[addr(headR, 2)] = { v: "", s: Object.assign({}, SEC_STYLE), role: "sec", secName: nm };
      sheet.merges.push({ s: { r: headR, c: 2 }, e: { r: headR, c: sheet.cols - 1 } });
      sheet.cells[addr(totR, 2)] = { v: "", s: Object.assign({}, SECTOT_STYLE), role: "sectot" };
      sheet.cells[addr(totR, 6)] = { s: Object.assign({}, SECTOT_STYLE) };
      rebuildAnalysisTotals(sheet);
      state.activeCell = { r: headR + 1, c: 2 };
      renderGrid(); scrollToActive();
      status("उपशीर्षक जुड़ा: " + nm);
    });
  }
  // active cell जिस उपशीर्षक में है, उसे पूरा हटाओ
  function deleteActiveSubhead() {
    const sheet = state.sheets[state.activeSheetId]; if (!sheet) return;
    const info = analysisScan(sheet);
    if (info.subRow < 0) { alert("इस analysis में उपशीर्षक-ढाँचा नहीं है।"); return; }
    const r = state.activeCell.r;
    const sec = info.sections.find((s) => r >= s.head && r <= (s.tot >= 0 ? s.tot : s.itemEnd));
    if (!sec) { alert("पहले उस उपशीर्षक की किसी पंक्ति पर cursor रखें जिसे हटाना है।"); return; }
    if (info.sections.length <= 1) { alert("कम-से-कम एक उपशीर्षक ज़रूरी है।"); return; }
    const nm = (sheet.cells[addr(sec.head, 2)] || {}).secName || "";
    if (!confirm("यह पूरा उपशीर्षक हटाएँ: " + nm + " ?\n(इसके सभी item व section-total भी हट जाएँगे)")) return;
    const start = sec.head, end = sec.tot >= 0 ? sec.tot : sec.itemEnd;
    pushUndo("all");
    if (!structuralBatch("delRow", start, end - start + 1, true)) { undoStack.pop(); return; }
    rebuildAnalysisTotals(sheet);
    renderGrid(); scrollToActive();
    status("उपशीर्षक हटाया: " + nm);
  }
  // क्या active row किसी "Add Royality" section में है? (picker royalty-mode के लिए)
  function inRoyaltySection(sheet, r) {
    const info = analysisScan(sheet);
    const sec = info.sections.find((s) => r >= s.head && r <= (s.tot >= 0 ? s.tot : s.itemEnd));
    return !!(sec && /royal|रॉयल|रायल्टी/i.test((sheet.cells[addr(sec.head, 2)] || {}).secName || ""));
  }
  // "Add Royality" उपशीर्षक — Material section के हर material को copy करके royalty पंक्तियाँ बनाए:
  //  नाम material से sync; Quantity material की E से link (=E{mr}); Royalty दर RMR/Primary की royalty से link (कई का औसत भी — point 2)
  // ＋ Royality बटन — न हो तो जोड़ो, हो तो हटाओ (toggle)
  function toggleRoyaltySection() {
    const sheet = state.sheets[state.activeSheetId]; if (!sheet) return;
    const info = analysisScan(sheet);
    const roy = info.sections.find((s) => /royal|रॉयल|रायल्टी/i.test((sheet.cells[addr(s.head, 2)] || {}).secName || ""));
    if (roy) removeRoyaltySection(sheet, roy); else addRoyaltySection();
  }
  function removeRoyaltySection(sheet, roy) {
    if (!confirm("'Add Royality' उपशीर्षक हटाएँ? (इसकी सभी पंक्तियाँ हट जाएँगी)")) return;
    const start = roy.head, end = roy.tot >= 0 ? roy.tot : roy.itemEnd;
    pushUndo("all");
    if (!structuralBatch("delRow", start, end - start + 1, true)) { undoStack.pop(); return; }
    rebuildAnalysisTotals(sheet);
    ensureLock(sheet); persistSheet(sheet); if (hfReady) buildEngine();
    renderGrid(); scrollToActive();
    status("'Add Royality' उपशीर्षक हटाया");
  }
  function addRoyaltySection() {
    const sheet = state.sheets[state.activeSheetId]; if (!sheet) return;
    const info = analysisScan(sheet);
    if (info.subRow < 0) { alert("इस analysis में उपशीर्षक-ढाँचा नहीं है।"); return; }
    if (info.sections.some((s) => /royal|रॉयल|रायल्टी/i.test((sheet.cells[addr(s.head, 2)] || {}).secName || ""))) { alert("इस Analysis में पहले से 'Add Royality' उपशीर्षक है — हटाने के लिए फिर से ＋ Royality दबाएँ।"); return; }
    const matSec = info.sections.find((s) => /material|माल|सामग्री/i.test((sheet.cells[addr(s.head, 2)] || {}).secName || ""));
    if (!matSec) { alert("इस Analysis में 'Material' उपशीर्षक नहीं मिला — Royality उसी के अनुसार बनता है।"); return; }
    const matRows = [];
    for (let r = matSec.itemStart; r <= matSec.itemEnd; r++) {
      const nc = sheet.cells[addr(r, 2)];
      const nm = nc ? (nc.f != null ? "" : (nc.v == null ? "" : String(nc.v))) : "";
      if (nm.trim()) matRows.push(r);
    }
    if (!matRows.length) { alert("Material section में कोई material नहीं मिला।"); return; }
    let gRow = ensureGrandtotRole(sheet);            // grandtot न हो तो "Total" label से मार्क करो (MoRD/imported)
    const at = gRow >= 0 ? gRow : info.subRow;        // Total से पहले; न हो तो Sub Total से पहले
    if (at < 0) { alert("इस Analysis में उपयुक्त Total/Sub Total पंक्ति नहीं मिली।"); return; }
    const n = matRows.length, block = 2 + n;         // header + n items + sectot
    pushUndo("all");
    if (!structuralBatch("insRow", at, block, true)) { undoStack.pop(); return; }
    const headR = at, totR = at + 1 + n;
    sheet.cells[addr(headR, 2)] = { v: "", s: Object.assign({}, SEC_STYLE), role: "sec", secName: "Add Royality" };
    sheet.merges.push({ s: { r: headR, c: 2 }, e: { r: headR, c: sheet.cols - 1 } });
    matRows.forEach((mr, i) => {
      const rr = headR + 1 + i;
      const nameCell = sheet.cells[addr(mr, 2)], unitCell = sheet.cells[addr(mr, 3)], rateCell = sheet.cells[addr(mr, 5)];
      const nm = nameCell ? (nameCell.f != null ? "" : (nameCell.v == null ? "" : String(nameCell.v))) : "";
      domSetSheetCell(sheet, rr, 2, nm);
      if (nameCell && nameCell.mref) (sheet.cells[addr(rr, 2)] || (sheet.cells[addr(rr, 2)] = { v: nm })).mref = Object.assign({}, nameCell.mref);   // नाम material से sync
      const un = unitCell ? (unitCell.f != null ? "" : (unitCell.v == null ? "" : String(unitCell.v))) : "";
      if (un) domSetSheetCell(sheet, rr, 3, un);
      domSetSheetCell(sheet, rr, 4, "=" + addr(mr, 4));   // Quantity — material की E से link (slip-proof)
      let roVal = null, roMref = null;
      if (rateCell && rateCell.mref && rateCell.mref.field === "rate") { roMref = Object.assign({}, rateCell.mref, { field: "royalty" }); roVal = mrefRoyaltyNum(roMref); }
      domSetSheetCell(sheet, rr, 5, roVal != null ? nf(roVal) : "0");   // Royalty दर — RMR/Primary से; न हो तो manual 0
      if (roMref) (sheet.cells[addr(rr, 5)] || (sheet.cells[addr(rr, 5)] = { v: 0 })).mref = roMref;
      domSetSheetCell(sheet, rr, 6, amtFormula(rr));   // Amount = Quantity × Royalty
    });
    sheet.cells[addr(totR, 2)] = { v: "", s: Object.assign({}, SECTOT_STYLE), role: "sectot" };
    sheet.cells[addr(totR, 6)] = { s: Object.assign({}, SECTOT_STYLE) };
    rebuildAnalysisTotals(sheet);
    ensureLock(sheet); persistSheet(sheet); if (hfReady) buildEngine();
    state.activeCell = { r: headR + 1, c: 5 };
    renderGrid(); scrollToActive();
    status("'Add Royality' उपशीर्षक जुड़ा — " + n + " material की royalty (RMR/Primary से linked; इसी क्रम में delete '− उपशीर्षक' से)");
  }

  /* ===== एक-बार का Format सुधार — पुराने analysis को नए ढाँचे (section totals + Sub Total + Total) में ===== */
  function rowWithRole(sheet, role) { for (let r = 0; r < sheet.rows; r++) { const c = sheet.cells[addr(r, 2)]; if (c && c.role === role) return r; } return -1; }
  // पुरानी section-पट्टियाँ (merged col-C या "a) …" जैसा text) खोजो
  function findSectionBars(sheet) {
    const bars = [], seen = new Set();
    for (const m of (sheet.merges || [])) { if (m.s.r === m.e.r && m.s.c === 2 && m.e.c >= 5) { if (!seen.has(m.s.r)) { bars.push(m.s.r); seen.add(m.s.r); } } }
    for (let r = 0; r < sheet.rows; r++) { if (seen.has(r)) continue; const c = sheet.cells[addr(r, 2)]; if (c && /^[a-z]\)\s/i.test(String(c.v || ""))) bars.push(r); }
    return bars.sort((a, b) => a - b);
  }
  function migrateLegacyAnalysis(sheet) {
    if (isStructuredAnalysis(sheet)) return false;         // पहले से नया format
    const bars = findSectionBars(sheet);
    if (!bars.length) return false;                        // analysis-जैसा नहीं
    // 1) section-पट्टियों को role="sec" tag करो (नाम parse)
    bars.forEach((br) => {
      const c = sheet.cells[addr(br, 2)] || (sheet.cells[addr(br, 2)] = { v: "" });
      const v = String(c.v || "");
      c.role = "sec"; c.secName = c.secName || v.replace(/^[a-z]\)\s*/i, "") || "Section";
      if (!c.s) c.s = Object.assign({}, SEC_STYLE);
    });
    const prevActive = state.activeSheetId, prevCell = state.activeCell;
    state.activeSheetId = sheet.id;
    // 2) पुराना footer (Total…) → grandtot; न हो तो नई पंक्ति
    let footer = -1;
    for (let r = sheet.rows - 1; r > bars[bars.length - 1]; r--) { const c = sheet.cells[addr(r, 2)]; if (c && /^\s*(sub\s*)?total/i.test(String(c.v || ""))) { footer = r; break; } }
    if (footer < 0) { structuralBatch("insRow", sheet.rows - (sheet.lockBottom || 1), 1, true); footer = sheet.rows - 1; }
    { const c = sheet.cells[addr(footer, 2)] || (sheet.cells[addr(footer, 2)] = {}); c.role = "grandtot"; c.v = "Total"; if (!c.s) c.s = Object.assign({}, TOTAL_STYLE); }
    // 3) grandtot से ठीक पहले Sub Total जोड़ो
    const gr = rowWithRole(sheet, "grandtot");
    structuralBatch("insRow", gr, 1, true);
    sheet.cells[addr(gr, 2)] = { v: "Sub Total", s: Object.assign({}, TOTAL_STYLE), role: "subtot" };
    // 4) हर section के items के बाद section-total जोड़ो (नीचे→ऊपर, ताकि index स्थिर रहें)
    const headers = []; let subR = -1;
    for (let r = 0; r < sheet.rows; r++) { const c = sheet.cells[addr(r, 2)]; if (c && c.role === "sec") headers.push(r); else if (c && c.role === "subtot") subR = r; }
    const P = []; for (let i = 0; i < headers.length; i++) P.push(i < headers.length - 1 ? headers[i + 1] : subR);
    for (let i = headers.length - 1; i >= 0; i--) {
      const pos = P[i];
      structuralBatch("insRow", pos, 1, true);
      sheet.cells[addr(pos, 2)] = { v: "", s: Object.assign({}, SECTOT_STYLE), role: "sectot" };
      sheet.cells[addr(pos, 6)] = { s: Object.assign({}, SECTOT_STYLE) };
    }
    sheet.lockTop = sheet.lockTop || 1; sheet.lockBottom = 2;
    rebuildAnalysisTotals(sheet);
    state.activeSheetId = prevActive; state.activeCell = prevCell;
    return true;
  }
  function runFormatFix() {
    const targets = state.order.map((id) => state.sheets[id]).filter((s) => s && !isStructuredAnalysis(s) && findSectionBars(s).length);
    if (!targets.length) { alert("कोई पुराने-format का analysis नहीं मिला — सब पहले से ठीक हैं।"); return; }
    if (!confirm(targets.length + " पुराने analysis को नए format में बदलें?\n(हर section का Total + Sub Total + Total जुड़ेगा — यह एक बार का सुधार है)")) return;
    let done = 0;
    for (const s of targets) { try { if (migrateLegacyAnalysis(s)) done++; } catch (e) { console.error("format-fix fail:", s.name, e); } }
    buildEngine();
    if (state.activeSheetId) renderGrid();
    renderMasterAnalysis();
    alert(done + " analysis नए format में बदल गए।");
    status("Format सुधार पूरा: " + done + " analysis");
  }

  // structural बदलाव के बाद state को engine से दोबारा मिलाओ
  function syncAllFromEngine() {
    for (const id of state.order) {
      const s = state.sheets[id];
      const sid = hfSheetId(s.name);
      if (sid === undefined) continue;
      if (id === state.activeSheetId) {
        // इसी शीट में data खिसकी है → पूरी तरह दोबारा बनाओ
        const cells = {};
        for (let r = 0; r < s.rows; r++) {
          for (let c = 0; c < s.cols; c++) {
            let ser;
            try { ser = hf.getCellSerialized({ sheet: sid, row: r, col: c }); } catch (e) { ser = null; }
            if (ser == null || ser === "") continue;
            if (typeof ser === "string" && ser[0] === "=") cells[addr(r, c)] = { f: ser };
            else if (typeof ser === "number") cells[addr(r, c)] = { v: ser };
            else cells[addr(r, c)] = { v: String(ser) };
          }
        }
        s.cells = cells;
        persistSheet(s);
      } else {
        // दूसरी शीट: सिर्फ़ formula-text बदल सकता है (reference shift), values वैसी ही
        let changed = false;
        for (const a in s.cells) {
          const cell = s.cells[a];
          if (cell.f == null) continue;
          const p = parseAddr(a);
          if (!p) continue;
          let nf;
          try { nf = hf.getCellFormula({ sheet: sid, row: p.r, col: p.c }); } catch (e) { nf = null; }
          if (nf != null && nf !== cell.f) { cell.f = nf; changed = true; }
        }
        if (changed) persistSheet(s);
      }
    }
  }

  /* ============== 4b. GRID RENDER ============== */
  const grid = document.getElementById("grid");
  const emptyState = document.getElementById("emptyState");

  // एक ही editor-panel को दो जगह इस्तेमाल करते हैं: Rate Analysis (working copy) और
  // Master Data › Analysis Edit (master शीट)। DOM node move करने से grid/formula-bar आदि
  // का पूरा logic वैसे ही चलता है; सिर्फ़ "master-mode" class से दिखावट थोड़ी अलग।
  const editorPanel = document.getElementById("editorPanel");
  const rateLayout = document.querySelector("#view-rate-analysis .layout");
  function mountEditor(where) {
    const host = where === "master" ? document.getElementById("masterEditHost")
      : where === "dom" ? document.getElementById("domEditorHost")
      : where === "boq" ? document.getElementById("boqEditorHost")
      : where === "summary" ? document.getElementById("sumEditorHost")
      : where === "bitumen" ? document.getElementById("bitumenEditorHost")
      : rateLayout;
    if (host && editorPanel && editorPanel.parentNode !== host) host.appendChild(editorPanel);
    if (editorPanel) { editorPanel.classList.toggle("master-mode", where === "master"); editorPanel.classList.toggle("dom-mode", where === "dom" || where === "boq" || where === "summary" || where === "bitumen"); }
  }

  function clearGrid() {
    grid.style.display = "none";
    emptyState.style.display = "block";
    document.getElementById("sheetNameInput").value = "";
    document.getElementById("sheetTitleInput").value = "";
    const kb = document.getElementById("sheetKindBanner"); if (kb) kb.style.display = "none";
    setEditorEnabled(false);
  }

  function setEditorEnabled(on) {
    ["sheetTitleInput", "sheetNameInput", "btnAddRow", "btnDelRow", "btnAddSubhead", "btnDelSubhead", "btnAddRoyalty", "btnDelSheet", "btnSheetExcel", "btnMasterItem", "formulaInput", "btnLinkRef"].forEach((idn) => {
      const el = document.getElementById(idn);
      if (el) el.disabled = !on;
    });
  }

  // merges से cover-set (दबे cell) और span-map (top-left पर colspan/rowspan) बनाओ
  function mergeLookup(sheet) {
    const cover = new Set(), span = {};
    for (const m of (sheet.merges || [])) {
      const sr = m.s.r, sc = m.s.c;
      const er = Math.min(m.e.r, sheet.rows - 1), ec = Math.min(m.e.c, sheet.cols - 1);
      if (sr < 0 || sc < 0 || sr >= sheet.rows || sc >= sheet.cols || er < sr || ec < sc) continue;
      span[sr + "_" + sc] = { cs: ec - sc + 1, rs: er - sr + 1 };
      for (let r = sr; r <= er; r++)
        for (let c = sc; c <= ec; c++)
          if (!(r === sr && c === sc)) cover.add(r + "_" + c);
    }
    return { cover, span };
  }

  function renderGrid() {
    const sheet = state.sheets[state.activeSheetId];
    if (!sheet) { clearGrid(); return; }
    emptyState.style.display = "none";
    grid.style.display = "table";
    setEditorEnabled(true);
    document.getElementById("sheetNameInput").value = sheet.name;
    document.getElementById("sheetTitleInput").value = sheet.title || "";

    ensureLock(sheet);
    const mm = mergeLookup(sheet); // merged-cells (title आदि)

    // colgroup — row-number column छोटा; Description (col C) को चौड़ी default width;
    //  बाकी कॉलम auto (content के अनुसार)। col-width auto-layout में सिर्फ़ शुरुआती/न्यूनतम
    //  माप है — text लंबा होने पर column अपने-आप बढ़ जाता है।
    let html = "<colgroup><col style='width:44px'>";
    for (let c = 0; c < sheet.cols; c++) {
      if (c === 2) html += "<col style='width:" + ((sheet.colWidths && sheet.colWidths[2]) || 300) + "px'>";
      else html += "<col>";
    }
    html += "</colgroup><thead><tr><th class='corner rowhead'></th>";
    for (let c = 0; c < sheet.cols; c++) html += "<th>" + colToLetter(c) + "</th>";
    html += "</tr></thead><tbody>";
    for (let r = 0; r < sheet.rows; r++) {
      let rowCls = "";
      if (r < sheet.lockTop) rowCls = " lock-top";                          // ऊपर के header
      else if (r >= sheet.rows - sheet.lockBottom) rowCls = " lock-bottom"; // सबसे नीचे का footer/result
      html += "<tr class='" + rowCls.trim() + "'><th class='rowhead'>" + (r + 1) + "</th>";
      for (let c = 0; c < sheet.cols; c++) {
        if (mm.cover.has(r + "_" + c)) continue; // merge के नीचे दबा cell — छोड़ो
        const sp = mm.span[r + "_" + c];
        const cell = sheet.cells[addr(r, c)];
        const cv = computedValue(sheet, r, c);
        let cls = "";
        if (cell && cell.f != null) cls += " has-formula";
        if (cv.err) cls += " err";
        const isText = typeof cv.val === "string" && !cv.err;
        if (isText) cls += " text";
        if (sp && sp.cs > 1) cls += " merged";
        // Rate column (F) की link-स्थिति दिखाओ (पता चले किससे जुड़ा है / नहीं)
        let titleAttr = "";
        if (c === 5 && r >= sheet.lockTop && cell) {
          const dcell = sheet.cells[addr(r, 2)];
          const isRow = !(dcell && dcell.role);   // section/total पंक्ति नहीं
          if (cell.mref && cell.mref.rmr && cell.mref.field === "rate") {
            // Material rate — RMR से linked (या RMR में वह material न हो तो चेतावनी)
            const resolved = mrefRateNum(cell.mref);
            if (resolved == null) { cls += " rate-rmr-missing"; titleAttr = " title=\"RMR '" + escapeHtml(sheet.rmrName || "") + "' में यह material नहीं — फ़िलहाल Master की दर दिख रही है; RMR में यह material जोड़ें\""; }
            else { cls += " rate-rmr"; titleAttr = " title=\"RMR '" + escapeHtml(sheet.rmrName || "") + "' से linked" + (Array.isArray(cell.mref.matIds) ? " · " + cell.mref.matIds.length + " material का औसत" : "") + "\""; }
          } else if (!cell.mref && isRow && (cell.f != null || (cell.v !== "" && cell.v != null))) {
            cls += " rate-manual";   // manually भरा — किसी से link नहीं
          }
        }
        // Lead वाला Quantity cell — computed number की जगह 2-line expression (बिना space)
        let cellHtml = null;
        if (cell && cell.leadText != null) { cls += " lead-cell"; cellHtml = cell.lead ? leadHtml(cell.lead) : escapeHtml(cell.leadText); }
        const styleAttr = cell && cell.s ? " style=\"" + cellStyleCss(cell.s) + "\"" : "";
        const spanAttr = sp ? (sp.cs > 1 ? " colspan='" + sp.cs + "'" : "") + (sp.rs > 1 ? " rowspan='" + sp.rs + "'" : "") : "";
        html += "<td data-r='" + r + "' data-c='" + c + "' class='" + cls.trim() + "'" + spanAttr + styleAttr + titleAttr + ">" + (cellHtml != null ? cellHtml : escapeHtml(fmtCellDisplay(sheet, cv.val, c))) + "</td>";
      }
      html += "</tr>";
    }
    html += "</tbody>";
    grid.innerHTML = html;
    highlightActive();
    if (armed && armed.pointTarget && armed.pointTarget.sheetId === state.activeSheetId)
      showPointHL(armed.pointTarget.sheetId, armed.pointTarget.r, armed.pointTarget.c);
  }

  // cell.s (compact style) → inline CSS, ताकि import की हुई formatting grid में दिखे
  function cellStyleCss(s) {
    let css = "";
    if (s.bg) css += "background:#" + s.bg + ";";
    if (s.fc) css += "color:#" + s.fc + ";";
    if (s.b) css += "font-weight:700;";
    if (s.i) css += "font-style:italic;";
    if (s.sz) css += "font-size:" + Math.max(10, Math.min(s.sz, 18)) + "px;";
    if (s.al) css += "text-align:" + s.al + ";";
    return css;
  }

  function fmt(v) {
    if (v == null || v === "") return "";
    if (typeof v === "number") {
      if (!isFinite(v)) return String(v);
      return v.toFixed(2); // हमेशा 2 दशमलव (जैसे 525.00, 4068.00)
    }
    return String(v);
  }
  const QTY_COL = 4; // Analysis का Quantity कॉलम (E)
  function fmtCol(v, c) {
    if (c === QTY_COL && typeof v === "number" && isFinite(v)) return v.toFixed(3); // Quantity → 3 दशमलव
    return fmt(v);
  }
  // accounting format — comma (भारतीय) + 2 दशमलव (जैसे 1,23,456.00)
  function fmtAccounting(v) { return v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  // sheet-aware display — BOQ के Rate(E)/Amount(F) accounting format में
  function fmtCellDisplay(sheet, v, c) {
    if (sheet && sheet.kind === "boq" && (c === 4 || c === 5) && typeof v === "number" && isFinite(v)) return fmtAccounting(v);
    if (sheet && sheet.kind === "summary" && (c === 3 || c === 4) && typeof v === "number" && isFinite(v)) return fmtAccounting(v);   // Summary — Cost Rs / Lacs accounting
    if (sheet && sheet.kind === "bitumen" && typeof v === "number" && isFinite(v)) {   // Bitumen — दूरी सादा, रेट 2-दशमलव, राशि accounting
      if (c === 4 || c === 5) return String(v);       // Refinery/कुल दूरी — सादा (327, 654)
      if (c === 6) return v.toFixed(2);               // Cartage Rate — 1.90
      if (c >= 2) return fmtAccounting(v);            // Basic/Total Cartage/Total Amount/Say — 49,002.00
    }
    return fmtCol(v, c);
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m])); }

  // चुना गया आयत (anchor + active); range न हो तो सिर्फ़ active cell
  function selRange() {
    const a = state.selAnchor || state.activeCell, b = state.activeCell;
    return { r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c), r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c) };
  }
  function hasSelRange() { const s = selRange(); return s.r1 !== s.r2 || s.c1 !== s.c2; }

  function highlightActive() {
    const barEditing = armed && armed.surface === "bar"; // formula-bar में cross-sheet edit चल रहा
    grid.querySelectorAll("td.sel, td.in-sel").forEach((td) => td.classList.remove("sel", "in-sel"));
    const sheet = state.sheets[state.activeSheetId];
    if (!barEditing && sheet && hasSelRange()) {
      const rng = selRange();
      for (let rr = rng.r1; rr <= rng.r2; rr++)
        for (let cc = rng.c1; cc <= rng.c2; cc++) {
          const t = grid.querySelector(`td[data-r='${rr}'][data-c='${cc}']`);
          if (t) t.classList.add("in-sel");
        }
    }
    const { r, c } = state.activeCell;
    const td = grid.querySelector(`td[data-r='${r}'][data-c='${c}']`);
    if (td && !barEditing) td.classList.add("sel");
    const cell = sheet ? sheet.cells[addr(r, c)] : null;
    const fi = document.getElementById("formulaInput");
    if (!barEditing) { // bar-editing के दौरान label/formula-bar को मत बदलो
      document.getElementById("activeCellLabel").textContent = sheet ? addr(r, c) : "—";
      fi.value = cell ? (cell.f != null ? cell.f : cell.v) : "";
    }
  }

  function selectCell(r, c) {
    const sheet = state.sheets[state.activeSheetId];
    if (!sheet) return;
    r = Math.max(0, Math.min(sheet.rows - 1, r));
    c = Math.max(0, Math.min(sheet.cols - 1, c));
    state.activeCell = { r, c };
    state.selAnchor = null;   // single-cell select
    highlightActive();
  }
  // चयन बढ़ाओ (Shift+Arrow / mouse-drag) — anchor स्थिर, active हिले
  function extendSelTo(r, c) {
    const sheet = state.sheets[state.activeSheetId];
    if (!sheet) return;
    if (!state.selAnchor) state.selAnchor = { r: state.activeCell.r, c: state.activeCell.c };
    r = Math.max(0, Math.min(sheet.rows - 1, r));
    c = Math.max(0, Math.min(sheet.cols - 1, c));
    state.activeCell = { r, c };
    highlightActive();
  }
  // चुने आयत के cells साफ़ करो (locked/section-total पंक्ति छोड़कर; रंग बचाकर)
  function clearRange(sheet, rng) {
    pushUndo("sheet");
    for (let r = rng.r1; r <= rng.r2; r++) {
      if (isLockedRow(sheet, r)) continue;
      if ((sheet.cells[addr(r, 2)] || {}).role) continue; // section/total पंक्ति न छेड़ो
      for (let c = rng.c1; c <= rng.c2; c++) {
        const a = addr(r, c), cell = sheet.cells[a];
        if (!cell) continue;
        if (cell.s) sheet.cells[a] = { v: "", s: cell.s }; // रंग/format बना रहे (link/formula हटे)
        else delete sheet.cells[a];
      }
    }
    persistSheet(sheet);
    if (hfReady) buildEngine();
  }
  // Excel जैसा Ctrl+D — ऊपर की पंक्ति का मान/formula नीचे भरो (formula की row-refs अपने-आप शिफ्ट)
  function copyCellDown(sheet, sr, sc, tr, tc) {
    if (isLockedRow(sheet, tr)) return;
    if ((sheet.cells[addr(tr, 2)] || {}).role) return; // section/total पंक्ति में fill नहीं
    const src = sheet.cells[addr(sr, sc)];
    const ta = addr(tr, tc);
    if (!src || (src.f == null && (src.v === "" || src.v == null))) return; // ऊपर खाली → छोड़ो
    let cell;
    if (src.f != null) cell = { f: shiftFormulaRows(src.f, tr - sr) };
    else cell = { v: src.v };
    if (src.s) cell.s = src.s; // formatting भी कॉपी
    sheet.cells[ta] = cell;    // role/mref कॉपी नहीं (नया अलग item)
  }
  function fillDown() {
    const sheet = state.sheets[state.activeSheetId]; if (!sheet) return;
    pushUndo("sheet");
    const rng = selRange();
    if (rng.r1 === rng.r2) {
      for (let c = rng.c1; c <= rng.c2; c++) copyCellDown(sheet, rng.r1 - 1, c, rng.r1, c); // ऊपर वाले से
    } else {
      for (let c = rng.c1; c <= rng.c2; c++)
        for (let r = rng.r1 + 1; r <= rng.r2; r++) copyCellDown(sheet, rng.r1, c, r, c); // top-row नीचे भरो
    }
    persistSheet(sheet);
    if (hfReady) buildEngine();
    maybeSyncToMaster(sheet);
    renderGrid();
    status("Ctrl+D — ऊपर वाला " + (rng.r1 === rng.r2 ? "cell" : "पंक्ति") + " नीचे कॉपी हुआ");
  }

  /* ===== कई cell copy/cut/paste (सभी spreadsheet पर; formula-सहित, relative-adjust) ===== */
  let _clip = null;   // {h,w,r0,c0,cells:[[{f|v}|null]], tsv, cut, srcSheetId}
  // चुने आयत को internal clipboard + OS-clipboard(TSV) दोनों में रखो
  function copyRangeToClip(sheet, rng, cut, e) {
    const cells = [], lines = [];
    for (let r = rng.r1; r <= rng.r2; r++) {
      const rowCells = [], rowTxt = [];
      for (let c = rng.c1; c <= rng.c2; c++) {
        const cell = sheet.cells[addr(r, c)];
        rowCells.push(cell ? { f: cell.f, v: cell.v } : null);
        const cv = computedValue(sheet, r, c);            // OS-clipboard में दिखने वाला (computed) मान
        let t = (cv && cv.val != null) ? cv.val : "";
        rowTxt.push(t === "" ? "" : String(t));
      }
      cells.push(rowCells); lines.push(rowTxt.join("\t"));
    }
    const tsv = lines.join("\n");
    _clip = { h: rng.r2 - rng.r1 + 1, w: rng.c2 - rng.c1 + 1, r0: rng.r1, c0: rng.c1, cells: cells, tsv: tsv, cut: !!cut, srcSheetId: sheet.id };
    if (e && e.clipboardData) { e.clipboardData.setData("text/plain", tsv); e.preventDefault(); }
    else if (navigator.clipboard) { try { navigator.clipboard.writeText(tsv); } catch (er) {} }
    status((cut ? "Cut" : "Copy") + ": " + _clip.h + "×" + _clip.w + " cell" + (_clip.cells.some((row) => row.some((x) => x && x.f != null)) ? " (formula सहित)" : ""));
  }
  // एक clip-cell को target पर stamp करो — formula हो तो relative-shift; target का role/style/mref बचाकर
  function stampClipCell(sheet, tr, tc, cell, srcR, srcC) {
    if (tr < 0 || tc < 0 || tr >= sheet.rows || tc >= sheet.cols) return;
    const a = addr(tr, tc), prev = sheet.cells[a] || null;
    const pStyle = prev ? prev.s : null, pRole = prev ? prev.role : null, pSec = prev ? prev.secName : null, pMref = prev ? prev.mref : null;
    let raw = "";
    if (cell) { if (cell.f != null) raw = shiftFormula(cell.f, tr - srcR, tc - srcC); else if (cell.v != null) raw = String(cell.v); }
    raw = String(raw);
    if (raw.trim() === "") { if (pStyle || pRole) sheet.cells[a] = { v: "" }; else delete sheet.cells[a]; }
    else if (raw[0] === "=") sheet.cells[a] = { f: raw };
    else if (isNumeric(raw)) sheet.cells[a] = { v: Number(raw) };
    else sheet.cells[a] = { v: raw };
    if (sheet.cells[a]) { if (pStyle) sheet.cells[a].s = pStyle; if (pRole) sheet.cells[a].role = pRole; if (pSec != null) sheet.cells[a].secName = pSec; if (pMref && raw.trim() !== "") sheet.cells[a].mref = pMref; }
  }
  // internal clip को active cell (या single→पूरे चयन में tile) पर paste
  function pasteInternalClip(sheet) {
    if (!_clip) return false;
    pushUndo("sheet");
    const sr = state.activeCell.r, sc = state.activeCell.c;
    const clip = _clip;
    let stamps = [];   // {tr,tc,i,j}
    if (clip.h === 1 && clip.w === 1) {                    // single cell → पूरे चयन में भरो
      const rng = selRange();
      for (let r = rng.r1; r <= rng.r2; r++) for (let c = rng.c1; c <= rng.c2; c++) stamps.push({ tr: r, tc: c, i: 0, j: 0 });
    } else {                                               // block → active cell से
      for (let i = 0; i < clip.h; i++) for (let j = 0; j < clip.w; j++) stamps.push({ tr: sr + i, tc: sc + j, i: i, j: j });
    }
    let maxR = sheet.rows - 1, maxC = sheet.cols - 1;
    stamps.forEach((s) => { maxR = Math.max(maxR, s.tr); maxC = Math.max(maxC, s.tc); });
    if (maxR + 1 > sheet.rows) sheet.rows = maxR + 1;
    if (maxC + 1 > sheet.cols) { sheet.cols = maxC + 1; while (sheet.colWidths.length < sheet.cols) sheet.colWidths.push(80); }
    stamps.forEach((s) => stampClipCell(sheet, s.tr, s.tc, clip.cells[s.i][s.j], clip.r0 + s.i, clip.c0 + s.j));
    // cut था → source cells साफ़ (उसी sheet पर)
    if (clip.cut && clip.srcSheetId && state.sheets[clip.srcSheetId]) {
      const ss = state.sheets[clip.srcSheetId];
      for (let i = 0; i < clip.h; i++) for (let j = 0; j < clip.w; j++) { const a = addr(clip.r0 + i, clip.c0 + j); const pv = ss.cells[a]; if (pv && pv.s) ss.cells[a] = { v: "", s: pv.s }; else delete ss.cells[a]; }
      _clip.cut = false; if (ss !== sheet) { ensureLock(ss); persistSheet(ss); }
    }
    ensureLock(sheet); persistSheet(sheet); buildEngine(); maybeSyncToMaster(sheet); renderGrid();
    status("Paste हुआ" + (clip.cells.some((row) => row.some((x) => x && x.f != null)) ? " (formula relative-adjust)" : ""));
    return true;
  }

  // active cell को view में लाओ (Ctrl+Arrow छलांग के बाद ज़रूरी)
  function scrollToActive() {
    const td = grid.querySelector("td.sel");
    if (td) td.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  // cell में data है या नहीं (खाली value भी "नहीं" मानी जाएगी)
  function cellHasData(sheet, r, c) {
    const cell = sheet.cells[addr(r, c)];
    return !!cell && (cell.f != null || (cell.v !== "" && cell.v != null));
  }
  function rowHasData(sheet, r) {
    for (let c = 0; c < sheet.cols; c++) if (cellHasData(sheet, r, c)) return true;
    return false;
  }

  // Excel जैसा Ctrl+Arrow: data block के किनारे/अगले data तक छलांग
  function ctrlJump(sheet, r, c, dr, dc) {
    const inB = (rr, cc) => rr >= 0 && rr < sheet.rows && cc >= 0 && cc < sheet.cols;
    let nr = r + dr, nc = c + dc;
    if (!inB(nr, nc)) return { r, c };
    if (cellHasData(sheet, r, c) && cellHasData(sheet, nr, nc)) {
      // भरे हुए block के आखिर तक जाओ
      while (inB(nr + dr, nc + dc) && cellHasData(sheet, nr + dr, nc + dc)) { nr += dr; nc += dc; }
      return { r: nr, c: nc };
    }
    // खाली cells छोड़कर अगले भरे cell तक
    while (inB(nr, nc) && !cellHasData(sheet, nr, nc)) { nr += dr; nc += dc; }
    if (inB(nr, nc)) return { r: nr, c: nc };
    // आगे कोई data नहीं → sheet के किनारे पर जाओ
    let lr = r, lc = c, tr = r + dr, tc = c + dc;
    while (inB(tr, tc)) { lr = tr; lc = tc; tr += dr; tc += dc; }
    return { r: lr, c: lc };
  }

  // सबसे दूर का भरा हुआ cell (Ctrl+End के लिए)
  function lastDataCell(sheet) {
    let lr = 0, lc = 0;
    for (let r = 0; r < sheet.rows; r++)
      for (let c = 0; c < sheet.cols; c++)
        if (cellHasData(sheet, r, c)) { lr = Math.max(lr, r); lc = Math.max(lc, c); }
    return { r: lr, c: lc };
  }

  /* ============== Formula editing + cross-sheet "point mode" (Excel जैसा) ==============
     armed = अभी चल रहा एक formula-edit session — cell के अंदर या formula-bar में।
     जब formula में reference की जगह हो (= या +,-,*,/,( के बाद), तब किसी cell/शीट पर
     click (या arrow) करने से reference अपने-आप जुड़ता है। दूसरी शीट हो तो =SheetName!A1 बनता है।
  */
  let armed = null;

  function refExpectedText(v) {
    if (!v || v[0] !== "=") return false;
    const t = v.replace(/\s+$/, "");
    return t === "=" || "=+-*/(,:<>&^%".indexOf(t[t.length - 1]) >= 0;
  }
  function sheetRefText(originId, targetId, r, c) {
    const a = addr(r, c);
    return targetId === originId ? a : state.sheets[targetId].name + "!" + a;
  }
  function clearPointHL() { grid.querySelectorAll("td.point").forEach((x) => x.classList.remove("point")); }
  function showPointHL(targetSheetId, r, c) {
    clearPointHL();
    if (targetSheetId !== state.activeSheetId) return; // वह शीट अभी दिख नहीं रही
    const ptd = grid.querySelector(`td[data-r='${r}'][data-c='${c}']`);
    if (ptd) ptd.classList.add("point");
  }

  /* ===== Editing के दौरान formula जिन cells से link है उन्हें highlight (Excel जैसा) ===== */
  // formula में इसी शीट के cell/range refs निकालो → {r,c} सूची
  function formulaRefCells(sheet, f) {
    const out = [];
    if (!f || typeof f !== "string" || f[0] !== "=") return out;
    const re = /(?:('[^']+'|[A-Za-z_][A-Za-z0-9_]*)!)?(\$?[A-Za-z]{1,3}\$?\d+)(?::(\$?[A-Za-z]{1,3}\$?\d+))?/g;
    let m;
    while ((m = re.exec(f))) {
      if (m[1]) { const nm = m[1].replace(/^'|'$/g, ""); if (nm !== sheet.name) continue; } // दूसरी शीट → grid में नहीं
      const a = parseAddr(m[2].replace(/\$/g, "")); if (!a) continue;
      if (m[3]) {
        const b = parseAddr(m[3].replace(/\$/g, ""));
        if (b) {
          const r1 = Math.min(a.r, b.r), r2 = Math.max(a.r, b.r), c1 = Math.min(a.c, b.c), c2 = Math.max(a.c, b.c);
          for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) out.push({ r: r, c: c });
          continue;
        }
      }
      out.push({ r: a.r, c: a.c });
    }
    return out;
  }
  function clearRefHL() { grid.querySelectorAll("td.ref-hl").forEach((x) => x.classList.remove("ref-hl")); }
  function showRefHL(sheet, f) {
    clearRefHL();
    for (const p of formulaRefCells(sheet, f)) {
      const td = grid.querySelector(`td[data-r='${p.r}'][data-c='${p.c}']`);
      if (td) td.classList.add("ref-hl");
    }
  }

  /* ============== UNDO / REDO (Ctrl+Z / Ctrl+Y) ==============
     हर user-बदलाव से ठीक पहले snapshot लिया जाता है। content edit → active sheet का
     snapshot; row/col structural → सभी sheets का (ताकि cross-sheet links भी वापस आएँ)। */
  const undoStack = [], redoStack = [];
  const UNDO_MAX = 60;
  function snapSheet(s) {
    return { id: s.id, cells: JSON.parse(JSON.stringify(s.cells)), merges: JSON.parse(JSON.stringify(s.merges || [])),
      colWidths: (s.colWidths || []).slice(), rows: s.rows, cols: s.cols, lockTop: s.lockTop, lockBottom: s.lockBottom, title: s.title };
  }
  function makeSnap(scope) {
    const list = (scope === "all")
      ? state.order.map((id) => state.sheets[id]).filter(Boolean)
      : (state.activeSheetId && state.sheets[state.activeSheetId] ? [state.sheets[state.activeSheetId]] : []);
    return { activeId: state.activeSheetId, activeCell: { r: state.activeCell.r, c: state.activeCell.c }, sheets: list.map(snapSheet) };
  }
  function pushUndo(scope) {
    const snap = makeSnap(scope || "sheet");
    if (!snap.sheets.length) return;
    undoStack.push(snap);
    if (undoStack.length > UNDO_MAX) undoStack.shift();
    redoStack.length = 0;   // नई क्रिया → redo साफ़
  }
  function snapOfSame(ref) {   // ref में जो sheets हैं, उनका वर्तमान state (redo/undo के लिए)
    return { activeId: state.activeSheetId, activeCell: { r: state.activeCell.r, c: state.activeCell.c },
      sheets: ref.sheets.map((ss) => state.sheets[ss.id]).filter(Boolean).map(snapSheet) };
  }
  function restoreSnap(snap) {
    for (const ss of snap.sheets) {
      const s = state.sheets[ss.id]; if (!s) continue;
      s.cells = JSON.parse(JSON.stringify(ss.cells));
      s.merges = JSON.parse(JSON.stringify(ss.merges));
      s.colWidths = ss.colWidths.slice();
      s.rows = ss.rows; s.cols = ss.cols; s.lockTop = ss.lockTop; s.lockBottom = ss.lockBottom; s.title = ss.title;
      persistSheet(s);
    }
    armed = null; clearPointHL(); clearRefHL();
    buildEngine();
    if (snap.activeId && state.sheets[snap.activeId]) state.activeSheetId = snap.activeId;
    state.activeCell = { r: Math.max(0, snap.activeCell.r || 0), c: Math.max(0, snap.activeCell.c || 0) };
    state.selAnchor = null;
    renderSheetList(); renderGrid(); updateKindBanner(); refreshEstimateSheetPicker();
  }
  function undo() {
    if (!undoStack.length) { status("Undo के लिए कुछ नहीं है"); return; }
    const snap = undoStack.pop();
    redoStack.push(snapOfSame(snap));
    restoreSnap(snap);
    status("↶ Undo — पिछला बदलाव पूर्ववत");
  }
  function redo() {
    if (!redoStack.length) { status("Redo के लिए कुछ नहीं है"); return; }
    const snap = redoStack.pop();
    undoStack.push(snapOfSame(snap));
    restoreSnap(snap);
    status("↷ Redo");
  }

  // किसी cell को reference बनाकर formula में डालो (click या arrow से)
  function armedPoint(targetSheetId, r, c) {
    if (!armed) return;
    if (!armed.pointMode) { armed.baseText = armed.getText(); armed.pointMode = true; }
    armed.pointTarget = { sheetId: targetSheetId, r, c };
    armed.setText(armed.baseText + sheetRefText(armed.originSheetId, targetSheetId, r, c));
    showPointHL(targetSheetId, r, c);
  }

  // दूसरी शीट चुनी गई → editing formula-bar में ले आओ ताकि शीट बदलने पर भी जारी रहे
  function handoffToBar(targetSheetId) {
    if (!armed) return;
    if (armed.surface === "bar") { // पहले से bar में है → बस दिखती शीट बदलो
      state.activeSheetId = targetSheetId;
      renderSheetList(); renderGrid();
      armed.setText(armed.getText()); // fi दुबारा focus
      return;
    }
    const text = armed.getText();
    const pm = armed.pointMode, base = armed.baseText, pt = armed.pointTarget;
    const o = { originSheetId: armed.originSheetId, r: armed.r, c: armed.c };
    if (armed.teardown) armed.teardown(); // in-cell input हटाओ (commit किए बिना)
    armed = null;
    beginBarEditing(o.originSheetId, o.r, o.c, text, pm, base, pt);
    state.activeSheetId = targetSheetId;
    renderSheetList(); renderGrid();
    armed.setText(armed.getText()); // fi focus + cursor end
  }

  function beginBarEditing(originSheetId, r, c, text, pm, base, pt) {
    const fi = document.getElementById("formulaInput");
    fi.disabled = false;
    fi.value = text;
    armed = {
      surface: "bar", originSheetId, r, c,
      pointMode: !!pm, baseText: base || "", pointTarget: pt || null,
      getText: () => fi.value,
      setText: (s) => { fi.value = s; fi.focus(); const n = s.length; try { fi.setSelectionRange(n, n); } catch (e) {} },
      refExpected: () => refExpectedText(fi.value),
    };
    document.getElementById("activeCellLabel").textContent = "✎ " + state.sheets[originSheetId].name + "!" + addr(r, c);
  }

  function commitArmed(move) {
    if (!armed) return;
    const a = armed; armed = null;
    clearPointHL();
    state.activeSheetId = a.originSheetId;
    const sheet = state.sheets[a.originSheetId];
    if (sheet) userSetCell(sheet, a.r, a.c, a.getText());
    renderSheetList(); renderGrid();
    selectCell(move === "down" ? a.r + 1 : a.r, a.c);
    scrollToActive(); grid.focus();
  }
  function cancelArmed() {
    if (!armed) return;
    const a = armed; armed = null;
    clearPointHL();
    state.activeSheetId = a.originSheetId;
    renderSheetList(); renderGrid();
    selectCell(a.r, a.c); grid.focus();
  }

  // double-click / F2 / type → inline edit
  //   mode = "enter" (टाइप करके शुरू) → arrow commit+move करता है (Excel enter-mode)
  //   mode = "edit"  (F2/double-click) → arrow सिर्फ़ text cursor हिलाता है
  function startEdit(r, c, initial, mode) {
    const sheet = state.sheets[state.activeSheetId];
    const td = grid.querySelector(`td[data-r='${r}'][data-c='${c}']`);
    if (!td) return;
    const originSheetId = state.activeSheetId;
    const enterMode = mode === "enter";
    const cell = sheet.cells[addr(r, c)];
    const cur = initial != null ? initial : (cell ? (cell.f != null ? cell.f : cell.v) : "");
    // एडिट के दौरान row सिकुड़े नहीं — cell की मौजूदा ऊँचाई edit भर के लिए fix रखो
    const keepH = td.getBoundingClientRect().height;
    td.style.height = keepH + "px";
    const inp = document.createElement("input");
    inp.value = cur;
    td.textContent = "";
    td.appendChild(inp);
    inp.focus();
    const L0 = inp.value.length;
    inp.setSelectionRange(L0, L0); // cursor आखिर में (Excel जैसा)

    // editing के दौरान formula जिन cells से link है उन्हें highlight; typing पर live अपडेट
    showRefHL(sheet, inp.value);
    inp.addEventListener("input", () => showRefHL(sheet, inp.value));

    let done = false;
    const finish = () => { done = true; td.style.height = ""; if (armed && armed.surface === "cell") armed = null; clearPointHL(); clearRefHL(); };

    armed = {
      surface: "cell", originSheetId, r, c,
      pointMode: false, baseText: "", pointTarget: null,
      getText: () => inp.value,
      setText: (s) => { inp.value = s; inp.focus(); const n = s.length; try { inp.setSelectionRange(n, n); } catch (e) {} },
      refExpected: () => refExpectedText(inp.value),
      teardown: () => { done = true; td.style.height = ""; if (inp.parentNode) inp.remove(); }, // commit किए बिना हटाओ
    };

    const clampRC = (rr, cc) => ({
      r: Math.max(0, Math.min(sheet.rows - 1, rr)),
      c: Math.max(0, Math.min(sheet.cols - 1, cc)),
    });

    const commit = (move) => {
      if (done) return;
      finish();
      userSetCell(sheet, r, c, inp.value);
      renderGrid();
      if (move === "down") selectCell(r + 1, c);
      else if (move === "up") selectCell(r - 1, c);
      else if (move === "right") selectCell(r, c + 1);
      else if (move === "left") selectCell(r, c - 1);
      else selectCell(r, c);
      scrollToActive();
      grid.focus();
    };

    const dirs = { ArrowUp: [-1, 0, "up"], ArrowDown: [1, 0, "down"], ArrowLeft: [0, -1, "left"], ArrowRight: [0, 1, "right"] };

    inp.addEventListener("keydown", (e) => {
      e.stopPropagation(); // grid के keydown तक न पहुँचे

      if (e.key in dirs) {
        const [dr, dc, moveName] = dirs[e.key];
        if (armed && armed.pointMode) { // pointer आगे बढ़ाओ (उसी शीट में)
          e.preventDefault();
          const t = armed.pointTarget || { r, c };
          const p = clampRC(t.r + dr, t.c + dc);
          armedPoint(originSheetId, p.r, p.c);
          return;
        }
        if (refExpectedText(inp.value)) { // point mode शुरू
          e.preventDefault();
          const p = clampRC(r + dr, c + dc);
          armedPoint(originSheetId, p.r, p.c);
          return;
        }
        if (enterMode && inp.value[0] !== "=") { e.preventDefault(); commit(moveName); return; } // सादा डेटा
        return; // edit-mode/formula: arrow सिर्फ़ text cursor हिलाए
      }

      // arrow के अलावा कोई key → point mode बंद (बना reference रहने दो)
      if (armed && armed.pointMode && e.key !== "Enter" && e.key !== "Tab" && e.key !== "Escape") {
        armed.pointMode = false; clearPointHL();
      }

      if (e.key === "Enter") { e.preventDefault(); commit(e.shiftKey ? "up" : "down"); }
      else if (e.key === "Tab") { e.preventDefault(); commit(e.shiftKey ? "left" : "right"); }
      else if (e.key === "Escape") {
        e.preventDefault();
        if (armed && armed.pointMode) { // point रद्द, editing जारी
          inp.value = armed.baseText; armed.pointMode = false; clearPointHL();
          const n = inp.value.length; inp.setSelectionRange(n, n);
        } else { finish(); renderGrid(); highlightActive(); grid.focus(); }
      }
    });
    inp.addEventListener("blur", () => { if (!done) commit(null); });
  }

  /* ============== 5. ESTIMATES ============== */
  function newEstimate() {
    const est = { id: uid("est"), name: "नया आकलन", sheetIds: [], createdAt: Date.now() };
    state.estimates[est.id] = est;
    state.estOrder.push(est.id);
    setActiveEstimateId(est.id);
    db.put("estimates", est);
    renderEstimateSelect();
    renderEstimate();
    status("नया estimate बना");
  }

  function renderEstimateSelect() {
    const sel = document.getElementById("estimateSelect");
    if (!sel) return;
    sel.innerHTML = "";
    if (state.estOrder.length === 0) {
      const o = document.createElement("option"); o.textContent = "— कोई estimate नहीं —"; sel.appendChild(o); return;
    }
    for (const id of state.estOrder) {
      const o = document.createElement("option");
      o.value = id; o.textContent = state.estimates[id].name;
      if (id === state.activeEstimateId) o.selected = true;
      sel.appendChild(o);
    }
  }

  function renderEstimate() {
    if (typeof updateTopbarEstimate === "function") updateTopbarEstimate();
    const body = document.getElementById("estimateBody");
    if (!body) return; // Estimate panel अभी हटा है — बाद में सेट होगा
    const est = state.estimates[state.activeEstimateId];
    if (!est) { body.innerHTML = "<div class='empty-state small'><p class='muted'>कोई estimate बनाएँ, फिर शीट जोड़ें।</p></div>"; return; }

    let html = "";
    html += "<div class='est-meta'>";
    html += "<input type='text' class='est-name-input' id='estName' value='" + escapeHtml(est.name) + "' />";
    html += "<button class='mini x' id='estDelete' title='Estimate हटाएँ'>🗑</button>";
    html += "</div>";

    html += "<div class='add-sheet-row'><select id='estSheetPicker'></select><button class='btn sm primary' id='estAddSheet'>जोड़ें</button></div>";

    html += "<div class='est-section-title'>चुनी गई शीट (" + est.sheetIds.length + ")</div>";
    html += "<ul class='est-sheets'>";
    est.sheetIds.forEach((sid, i) => {
      const s = state.sheets[sid];
      if (!s) return;
      html += "<li data-id='" + sid + "'>";
      html += "<span class='num'>" + (i + 1) + "</span>";
      html += "<span class='enm' data-open='" + sid + "'>" + escapeHtml(s.name) + "</span>";
      html += "<button class='mini' data-up='" + sid + "' title='ऊपर'>▲</button>";
      html += "<button class='mini' data-down='" + sid + "' title='नीचे'>▼</button>";
      html += "<button class='mini x' data-rm='" + sid + "' title='हटाएँ'>✕</button>";
      html += "</li>";
    });
    html += "</ul>";

    html += "<div class='est-actions'>";
    html += "<button class='btn primary' id='estExport'>⬇ Excel (.xlsx) — links समेत</button>";
    html += "<button class='btn' id='estPrint'>🖨 सभी शीट प्रिंट करें</button>";
    html += "</div>";

    body.innerHTML = html;
    refreshEstimateSheetPicker();
    wireEstimateBody(est);
  }

  function refreshEstimateSheetPicker() {
    const picker = document.getElementById("estSheetPicker");
    if (!picker) return;
    const est = state.estimates[state.activeEstimateId];
    picker.innerHTML = "";
    const avail = state.order.filter((id) => !est.sheetIds.includes(id));
    if (avail.length === 0) { const o = document.createElement("option"); o.textContent = "— सभी शीट जुड़ चुकीं —"; o.value = ""; picker.appendChild(o); return; }
    for (const id of avail) { const o = document.createElement("option"); o.value = id; o.textContent = state.sheets[id].name; picker.appendChild(o); }
  }

  function wireEstimateBody(est) {
    document.getElementById("estName").addEventListener("change", (e) => { est.name = e.target.value || "आकलन"; db.put("estimates", est); renderEstimateSelect(); });
    document.getElementById("estDelete").addEventListener("click", () => {
      if (!confirm("Estimate हटाएँ?")) return;
      delete state.estimates[est.id];
      state.estOrder = state.estOrder.filter((x) => x !== est.id);
      db.del("estimates", est.id);
      setActiveEstimateId(state.estOrder[0] || null);
      renderEstimateSelect(); renderEstimate();
    });
    document.getElementById("estAddSheet").addEventListener("click", () => {
      const v = document.getElementById("estSheetPicker").value;
      if (!v) return;
      est.sheetIds.push(v); db.put("estimates", est); renderEstimate();
    });
    const body = document.getElementById("estimateBody");
    body.querySelectorAll("[data-open]").forEach((el) => el.addEventListener("click", () => openSheet(el.getAttribute("data-open"))));
    body.querySelectorAll("[data-rm]").forEach((el) => el.addEventListener("click", () => { est.sheetIds = est.sheetIds.filter((x) => x !== el.getAttribute("data-rm")); db.put("estimates", est); renderEstimate(); }));
    body.querySelectorAll("[data-up]").forEach((el) => el.addEventListener("click", () => moveSheet(est, el.getAttribute("data-up"), -1)));
    body.querySelectorAll("[data-down]").forEach((el) => el.addEventListener("click", () => moveSheet(est, el.getAttribute("data-down"), 1)));
    document.getElementById("estExport").addEventListener("click", () => exportEstimateXlsx(est));
    document.getElementById("estPrint").addEventListener("click", () => printEstimate(est));
  }

  function moveSheet(est, sid, dir) {
    const i = est.sheetIds.indexOf(sid);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= est.sheetIds.length) return;
    [est.sheetIds[i], est.sheetIds[j]] = [est.sheetIds[j], est.sheetIds[i]];
    db.put("estimates", est); renderEstimate();
  }

  /* ============== 6a. EXPORT xlsx (links बरकरार) ============== */
  // est का हर state.sheet — Bitumen · Rate Analysis · DOM · BOQ · Summary (RMR data-rows है, अलग जुड़ती)
  function estAllSheetIds(est) {
    const ids = [];
    const add = (id) => { if (id && state.sheets[id] && ids.indexOf(id) < 0) ids.push(id); };
    add(est.bitumenSheetId);                                            // Bitumen Rate Analysis
    // Rate Analysis — इस estimate के work-group (rmrId|ohGroupId) वाली सभी working शीट
    const gk = new Set(estWorkGroups(est).map((g) => (g.rmrId || "") + "|" + (g.ohGroupId || "")));
    for (const id of state.order) { const s = state.sheets[id]; if (s && s.kind === "working" && gk.has((s.rmrId || "") + "|" + (s.ohGroupId || ""))) add(id); }
    (est.sheetIds || []).forEach(add);                                  // कोई अतिरिक्त चुनी शीट
    if (est.domSheets) Object.keys(est.domSheets).forEach((k) => add(est.domSheets[k]));   // DOM (समूहवार)
    if (est.boqSheets) Object.keys(est.boqSheets).forEach((k) => add(est.boqSheets[k]));   // BOQ (समूहवार)
    (est.subEstimates || []).forEach((s) => { add(s.domSheetId); add(s.boqSheetId); });    // Sub-estimate DOM/BOQ
    add(est.summarySheetId);                                            // Summary
    return ids;
  }
  // app cell.s (रंग/bold/align) → xlsx-js-style format
  const XL_THIN = { style: "thin", color: { rgb: "808A9B" } };   // print में साफ़ दिखे (थोड़ा गहरा)
  const XL_BD = { top: XL_THIN, bottom: XL_THIN, left: XL_THIN, right: XL_THIN };
  function xlCellStyle(s, isNum, numVal) {
    const st = { border: XL_BD, alignment: { vertical: "center", wrapText: true } };   // wrap → सभी लाइनें दिखें
    const f = { sz: 12 };   // base font थोड़ा बड़ा (A4 print हेतु)
    if (s) {
      if (s.bg) st.fill = { patternType: "solid", fgColor: { rgb: String(s.bg).replace(/^#/, "") } };
      if (s.b) f.bold = true; if (s.i) f.italic = true;
      if (s.sz) f.sz = Math.max(9, Math.min(s.sz, 24));
      if (s.fc) f.color = { rgb: String(s.fc).replace(/^#/, "") };
      if (s.al) st.alignment.horizontal = s.al;
    }
    st.font = f;
    if (!st.alignment.horizontal) st.alignment.horizontal = isNum ? "right" : "left";
    if (isNum) st.numFmt = (numVal != null && Number.isInteger(numVal)) ? "#,##0" : "#,##0.00";
    return st;
  }
  const xlQuote = (nm) => "'" + String(nm).replace(/'/g, "''") + "'";
  function xlWsFromSheet(lib, sheet, useStyle, rmrMap) {
    const ws = {}; let maxR = 0, maxC = 0;
    const NC = sheet.cols;
    const off = (sheet.kind === "working" && sheet.title && sheet.title.trim()) ? 1 : 0;   // Analysis का नाम banner
    const cw = (sheet.colWidths && sheet.colWidths.length) ? sheet.colWidths.slice() : [];
    const MAXW = 680, totW = cw.reduce((a, b) => a + (b || 80), 0), sc = totW > MAXW ? MAXW / totW : 1;   // A4-फिट स्केल
    const noteLines = (txt, c) => { const w = Math.max(30, (cw[c] || 80) * sc); const cpl = Math.max(4, Math.floor(w / 8.5)); return Math.max(1, Math.ceil(String(txt).length / cpl)); };
    const rowLines = {};
    if (off) {   // title banner (row 0) — sheet.title (item नाम)
      const ttl = sheet.title.trim();
      for (let c = 0; c < NC; c++) { const ref = lib.utils.encode_cell({ r: 0, c }); ws[ref] = { t: "s", v: c === 0 ? ttl : "" }; if (useStyle) ws[ref].s = xlCellStyle({ b: 1, al: "center", sz: 13, bg: "2E3A73", fc: "FFFFFF" }, false, null); }
      rowLines[0] = Math.min(2, noteLines(ttl, 0)); maxC = Math.max(maxC, NC - 1);
    }
    for (let r = 0; r < sheet.rows; r++) for (let c = 0; c < sheet.cols; c++) {
      const cell = sheet.cells[addr(r, c)]; if (!cell) continue;
      const outR = r + off, ref = lib.utils.encode_cell({ r: outR, c });
      let o, numVal = null, linked = null, txtLines = null;
      const mref = cell.mref;
      const isRoy = !!(mref && mref.field === "royalty");
      if (rmrMap && mref && mref.rmr && rmrMap[mref.rmr]) {   // RMR-linked रेट/royalty → cross-sheet formula
        const link = rmrMap[mref.rmr];
        const colIdx = isRoy ? 6 : 7;   // RMR की Royalty(−) कॉलम = 6, Total Rate Incl. Cartage = 7
        const mids = Array.isArray(mref.matIds) ? mref.matIds : (mref.matId != null ? [mref.matId] : []);
        const refs = mids.map((mid) => { const rr = link.rowByMat[mid]; return rr == null ? null : (xlQuote(link.sheetName) + "!" + lib.utils.encode_cell({ r: rr, c: colIdx })); });
        if (refs.length && refs.every((x) => x)) linked = refs.length === 1 ? refs[0] : ("AVERAGE(" + refs.join(",") + ")");
      }
      if (linked) {
        numVal = isRoy ? mrefRoyaltyNum(mref) : mrefRateNum(mref); o = { t: "n", f: linked }; if (numVal != null) o.v = numVal;
      } else if (cell.f != null) {
        const cv = computedValue(sheet, r, c);
        o = { f: (off ? shiftFormula(cell.f, off, 0) : cell.f).replace(/^=/, "") };   // banner से नीचे खिसका → refs +off
        if (cv && !cv.err && typeof cv.val === "number") { o.t = "n"; o.v = cv.val; numVal = cv.val; }
        else if (cv && !cv.err && cv.val !== "") { o.t = "s"; o.v = String(cv.val); txtLines = String(cv.val); }
        else { o.t = "n"; }
      } else if (typeof cell.v === "number") { o = { t: "n", v: cell.v }; numVal = cell.v; }
      else { o = { t: "s", v: String(cell.v) }; txtLines = String(cell.v); }
      if (useStyle) o.s = xlCellStyle(cell.s, numVal != null || !!linked, numVal);
      ws[ref] = o;
      if (txtLines) rowLines[outR] = Math.max(rowLines[outR] || 1, noteLines(txtLines, c));
      maxR = Math.max(maxR, outR); maxC = Math.max(maxC, c);
    }
    ws["!ref"] = lib.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(maxR, 0), c: Math.max(maxC, 0) } });
    if (cw.length) ws["!cols"] = cw.map((w) => ({ wpx: Math.max(30, Math.round((w || 80) * sc)) }));
    const rowsArr = []; for (let r = 0; r <= maxR; r++) rowsArr[r] = { hpt: Math.max(18, (rowLines[r] || 1) * 16 + 3) };   // wrap-लाइनों अनुसार ऊँचाई
    ws["!rows"] = rowsArr;
    const mg = []; if (off) mg.push({ s: { r: 0, c: 0 }, e: { r: 0, c: NC - 1 } });
    (sheet.merges || []).forEach((m) => mg.push({ s: { r: m.s.r + off, c: m.s.c }, e: { r: m.e.r + off, c: m.e.c } }));
    if (mg.length) ws["!merges"] = mg;
    // हर खाली सेल पर भी border — print में पूरा grid साफ़/भरा दिखे (merge-ढके सेल छोड़कर)
    if (useStyle) {
      const covered = new Set();
      mg.forEach((m) => { for (let rr = m.s.r; rr <= m.e.r; rr++) for (let cc = m.s.c; cc <= m.e.c; cc++) if (!(rr === m.s.r && cc === m.s.c)) covered.add(rr + "_" + cc); });
      const emptyS = xlCellStyle(null, false, null);
      for (let r = 0; r <= maxR; r++) for (let c = 0; c <= maxC; c++) {
        const ref = lib.utils.encode_cell({ r: r, c: c });
        if (ws[ref] || covered.has(r + "_" + c)) continue;
        ws[ref] = { t: "s", v: "", s: emptyS };
      }
    }
    ws["!margins"] = { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 };
    return ws;
  }
  function xlWsFromRMR(lib, est, rmr, useStyle, rmrMap, sheetName) {
    const TITLE = { b: 1, al: "center", sz: 13, bg: "2E3A73", fc: "FFFFFF" };
    const HEAD = { b: 1, al: "center", bg: "46538F", fc: "FFFFFF" };
    const headers = ["क्रम", "Material का नाम", "Query का नाम", "दूरी (km)", "Material Rate", "Cartage Rate", "Royalty (−)", "Total Rate Incl. Cartage"];
    const NC = headers.length, ws = {};
    const putV = (r, c, v, s) => { const ref = lib.utils.encode_cell({ r, c }); const isN = typeof v === "number"; const o = isN ? { t: "n", v: v } : { t: "s", v: v == null ? "" : String(v) }; if (useStyle) o.s = xlCellStyle(s, isN, isN ? v : null); ws[ref] = o; };
    const putF = (r, c, f, v, s) => { const ref = lib.utils.encode_cell({ r, c }); const o = { t: "n", f: f }; if (v != null) o.v = v; if (useStyle) o.s = xlCellStyle(s, true, null); ws[ref] = o; };
    putV(0, 0, "RMR — " + (rmr.name || ""), TITLE);
    headers.forEach((h, c) => putV(1, c, h, HEAD));
    const rowByMat = {}, rowLines = {}; let r = 2;
    (rmr.rows || []).forEach((row, i) => {
      const mat = rmrMaterial(row);
      const dist = (row.distance == null || row.distance === "") ? "" : mrNum(row.distance);
      const cartage = (mrNum(row.distance) > 0) ? round2(rmrCartage(row.distance)) : "";
      const total = rmrRateForMat(rmr.id, row.matId);
      rowByMat[row.matId] = r; const rn = r + 1;
      putV(r, 0, i + 1, { al: "center" });
      putV(r, 1, mat.material || "", { al: "left" });
      putV(r, 2, mat.query || "", { al: "left" });
      putV(r, 3, dist, { al: "right" });
      putV(r, 4, (mrNum(mat.matRate) || ""), { al: "right" });
      putV(r, 5, cartage, { al: "right" });
      putV(r, 6, (mat.royalty ? mrNum(mat.royalty) : ""), { al: "right" });
      putF(r, 7, "E" + rn + "-G" + rn + "+F" + rn, (total == null ? null : round2(total)), { al: "right", b: 1 });   // Total = Material − Royalty + Cartage (live)
      rowLines[r] = Math.max(Math.ceil((mat.material || "").length / 30), Math.ceil((mat.query || "").length / 18), 1);
      r++;
    });
    ws["!ref"] = lib.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(r - 1, 1), c: NC - 1 } });
    ws["!cols"] = [{ wpx: 44 }, { wpx: 220 }, { wpx: 130 }, { wpx: 80 }, { wpx: 100 }, { wpx: 100 }, { wpx: 90 }, { wpx: 150 }];
    const rrows = []; for (let k = 0; k <= r - 1; k++) rrows[k] = { hpt: Math.max(18, (rowLines[k] || 1) * 16 + 3) };
    ws["!rows"] = rrows;
    ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: NC - 1 } }];
    if (rmrMap) rmrMap[rmr.id] = { sheetName: sheetName, rowByMat: rowByMat };
    return ws;
  }
  async function exportEstimateXlsx(est, ids) {
    ids = (ids && ids.length) ? ids : (est.sheetIds || []);
    const ok = await window.__sheetjsReady;
    if (!ok || typeof XLSX === "undefined") { alert("Excel engine (SheetJS) load नहीं हुआ — internet जाँचें।"); return; }
    const rmrs = (est.rmrs || []).filter((r) => r && (r.rows || []).length);
    if (!ids.length && !rmrs.length) { alert("इस Estimate में कोई शीट/RMR नहीं मिली।"); return; }
    const XS = await loadXlsxStyle();   // रंग/format के लिए (न मिले तो सादा)
    const lib = XS || XLSX;
    const wb = lib.utils.book_new();
    const usedNames = {};
    const uniqName = (raw) => { let nm = String(raw || "Sheet").replace(/[\[\]\*\?\/\\:]/g, "_").slice(0, 31) || "Sheet"; const base = nm; let k = 2; while (usedNames[nm.toLowerCase()]) { nm = base.slice(0, 28) + "_" + k; k++; } usedNames[nm.toLowerCase()] = true; return nm; };
    const rmrMap = {};   // rmrId → {sheetName, rowByMat} — Analysis के cross-sheet link हेतु
    rmrs.forEach((rmr) => { const nm = uniqName(rmr.name || "RMR"); const ws = xlWsFromRMR(lib, est, rmr, !!XS, rmrMap, nm); lib.utils.book_append_sheet(wb, ws, nm); });
    for (const sid of ids) { const sheet = state.sheets[sid]; if (!sheet) continue; lib.utils.book_append_sheet(wb, xlWsFromSheet(lib, sheet, !!XS, rmrMap), uniqName(sheet.name)); }
    const fname = safeName(est.name) + "_" + dateStamp() + ".xlsx";
    lib.writeFile(wb, fname, { bookType: "xlsx" });
    status("Excel बना: " + fname + (XS ? " — रंग/format व RMR-links सहित" : " (formatting lib नहीं मिली; सादा फाइल)"));
  }

  /* ============== 6b. PRINT सभी शीट ============== */
  function printEstimate(est, ids) {
    ids = (ids && ids.length) ? ids : (est.sheetIds || []);
    if (!ids.length) { alert("इस Estimate में कोई शीट नहीं मिली।"); return; }
    const area = document.getElementById("printArea");
    let html = "";
    ids.forEach((sid, idx) => {
      const sheet = state.sheets[sid];
      if (!sheet) return;
      html += "<div class='print-sheet'>";
      const ptitle = (sheet.title && sheet.title.trim()) ? sheet.title.trim() : sheet.name;
      html += "<div class='print-title'>" + escapeHtml(ptitle) + "</div>";
      html += "<div class='print-head'><div class='pmeta'><span>आकलन: " + escapeHtml(est.name) + "</span><span>शीट " + (idx + 1) + "/" + ids.length + " · " + dateStamp() + "</span></div></div>";
      ensureLock(sheet);
      const mm = mergeLookup(sheet);
      html += "<table class='ptable'><colgroup>";
      for (let c = 0; c < sheet.cols; c++) html += "<col style='width:" + (sheet.colWidths[c] || 80) + "px'>";
      html += "</colgroup><tbody>";
      for (let r = 0; r < sheet.rows; r++) {
        // खाली body पंक्ति छोड़ें; header/footer हमेशा रखें
        if (!isLockedRow(sheet, r) && !rowHasData(sheet, r)) continue;
        let rcls = "";
        if (r < sheet.lockTop) rcls = "pt-head";
        else if (r >= sheet.rows - sheet.lockBottom) rcls = "pt-foot";
        html += "<tr class='" + rcls + "'>";
        for (let c = 0; c < sheet.cols; c++) {
          if (mm.cover.has(r + "_" + c)) continue;
          const sp = mm.span[r + "_" + c];
          const cell = sheet.cells[addr(r, c)];
          const cv = computedValue(sheet, r, c);
          let cls = typeof cv.val === "string" ? "t" : "";
          if (sp && sp.cs > 1) cls += " merged";
          const styleAttr = cell && cell.s ? " style=\"" + cellStyleCss(cell.s) + "\"" : "";
          const spanAttr = sp ? (sp.cs > 1 ? " colspan='" + sp.cs + "'" : "") + (sp.rs > 1 ? " rowspan='" + sp.rs + "'" : "") : "";
          html += "<td class='" + cls.trim() + "'" + spanAttr + styleAttr + ">" + escapeHtml(fmtCol(cv.val, c)) + "</td>";
        }
        html += "</tr>";
      }
      html += "</tbody></table></div>";
    });
    area.innerHTML = html;
    window.print();
  }

  /* ============== 6c. JSON backup / restore ============== */
    // सभी UI/look settings (chapters, project-size आदि) localStorage से — ताकि backup में जाएँ
  function collectSettings() {
    const s = {};
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.indexOf("re_") === 0) s[k] = localStorage.getItem(k); } } catch (e) {}
    return s;
  }
  function backupJson() {
    const data = {
      version: 3, exportedAt: new Date().toISOString(),
      sheets: state.order.map((id) => state.sheets[id]),
      estimates: state.estOrder.map((id) => state.estimates[id]),
      master: Object.keys(state.master).map((k) => state.master[k]), // Machine/Labour/Cartage/Material… सब versions समेत
      settings: collectSettings(),   // Chapters (MoRTH/MoRD), project-size आदि — पूरा "look"
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "RES_backup_" + dateStamp() + ".json"; a.click();
    URL.revokeObjectURL(a.href);
    status("Backup download हुआ");
  }

  async function restoreJson(file) {
    const txt = await file.text();
    let data;
    try { data = JSON.parse(txt); } catch (e) { alert("फाइल पढ़ी नहीं जा सकी।"); return; }
    if (!confirm("यह मौजूदा सारा data replace कर देगा (sheets + estimates + Master Data)। जारी रखें?")) return;
    await db.clear("sheets"); await db.clear("estimates"); await db.clear("master");
    state.sheets = {}; state.order = []; state.estimates = {}; state.estOrder = []; state.master = {};
    for (const s of (data.sheets || [])) { ensureLock(s); ensureSheetMeta(s); state.sheets[s.id] = s; state.order.push(s.id); await db.put("sheets", s); }
    for (const e of (data.estimates || [])) { state.estimates[e.id] = e; state.estOrder.push(e.id); await db.put("estimates", e); }
    for (const m of (data.master || [])) {
      (m.versions || []).forEach((v) => (v.rows || []).forEach((r) => { if (!r.id) r.id = uid("mrow"); })); // स्थायी id
      state.master[m.id] = m; await db.put("master", m);
    }
    // settings (Chapters, project-size आदि) — पूरा look भी वापस लाओ
    if (data.settings && typeof data.settings === "object") {
      try { for (const k in data.settings) if (k.indexOf("re_") === 0) localStorage.setItem(k, data.settings[k]); } catch (e) {}
      reloadChaptersFromStorage();
      persistChaptersCloud();   // restore किए chapters cloud में भी भेजो → हर browser में दिखें
      const pv = localStorage.getItem("re_projectSize"); if (isSize(pv)) projectSize = pv;
    }
    state.activeSheetId = state.order[0] || null;
    setActiveEstimateId(state.estOrder[0] || null);
    buildEngine();
    reRateAllAnalyses(); applyOverheadAll();
    renderSheetList(); renderEstimateSelect(); renderEstimate();
    renderMasterAnalysis(); updateProjectSizeUI();
    if (state.activeSheetId) renderGrid(); else clearGrid();
    status("Restore पूरा — sheets + estimates + Master Data + Chapters/look");
  }
  // localStorage से Chapters दोबारा memory में लाओ (restore के बाद)
  function reloadChaptersFromStorage() {
    let legacy = null;
    try { const j = JSON.parse(localStorage.getItem("re_chapters")); if (Array.isArray(j) && j.length) legacy = j; } catch (e) {}
    for (const src of ["morth", "mord"]) {
      let list = null;
      try { const j = JSON.parse(localStorage.getItem("re_chapters_" + src)); if (Array.isArray(j) && j.length && j.every((x) => x && x.key && x.name)) list = j; } catch (e) {}
      if (!list) list = (legacy || DEFAULT_ANALYSIS_GROUPS).map((x) => ({ key: x.key, name: x.name }));
      CHAPTERS[src] = list;
    }
    sortChapters("morth"); sortChapters("mord");
  }

  /* ---------- Excel cell-style को हल्के रूप में पकड़ो (grid में दिखाने के लिए) ---------- */
  function hex6(x) {
    if (!x) return null;
    let v = (typeof x === "string") ? x : (x.rgb || "");
    if (!v) return null;
    v = String(v).replace(/^#/, "");
    if (v.length === 8) v = v.slice(2); // ARGB → RGB
    return /^[0-9A-Fa-f]{6}$/.test(v) ? v.toUpperCase() : null;
  }
  function compactStyle(s) {
    if (!s) return null;
    const out = {};
    if (s.font) {
      if (s.font.bold) out.b = 1;
      if (s.font.italic) out.i = 1;
      if (s.font.sz) out.sz = Math.round(s.font.sz);
      const fc = hex6(s.font.color); if (fc && fc !== "000000") out.fc = fc;
    }
    let bg = null;
    if (s.fill) bg = hex6(s.fill.fgColor) || hex6(s.fill.bgColor);
    if (!bg) bg = hex6(s.fgColor) || hex6(s.bgColor);
    if (bg && bg !== "FFFFFF") out.bg = bg;
    if (s.alignment && s.alignment.horizontal) {
      const h = s.alignment.horizontal;
      if (h === "left" || h === "center" || h === "right") out.al = h;
    }
    return Object.keys(out).length ? out : null;
  }

  // इसी शीट के references की row-संख्या delta से बदलो (Sheet! वाले cross-refs को छोड़कर)
  function shiftFormulaRows(f, delta) {
    return f.replace(/(^|[^A-Za-z0-9_!])(\$?)([A-Za-z]{1,3})(\$?)(\d+)/g, (m, pre, d1, col, d2, row) => {
      const nr = parseInt(row, 10) + delta;
      if (nr < 1) return m;
      return pre + d1 + col + d2 + nr;
    });
  }

  // top पर लगातार merged (पूरी-चौड़ाई) पंक्तियाँ = title → उन्हें grid से निकालकर sheet.title बनाओ
  function hoistTitle(sheet) {
    const merges = sheet.merges || [];
    const topMergeAt = (r) => merges.find((m) => m.s.r === r && m.s.c === 0 && (m.e.c - m.s.c) >= 1);
    const titleLines = [];
    let drop = 0, r = 0;
    while (r < sheet.rows) {
      const m = topMergeAt(r);
      if (!m) break;
      const cell = sheet.cells[addr(r, 0)];
      if (cell && cell.f == null && cell.v != null && String(cell.v).trim() !== "") titleLines.push(String(cell.v).trim());
      const span = m.e.r - m.s.r + 1;
      r += span; drop += span;
    }
    if (drop === 0) return;
    sheet.title = titleLines.join(" — ");
    // बची हुई पंक्तियाँ ऊपर खिसकाओ + formula की row -drop करो
    const newCells = {};
    for (const key in sheet.cells) {
      const p = parseAddr(key);
      if (!p || p.r < drop) continue;
      const cell = sheet.cells[key];
      const nc = {};
      if (cell.f != null) nc.f = shiftFormulaRows(cell.f, -drop);
      else if (cell.v !== undefined) nc.v = cell.v;
      if (cell.s) nc.s = cell.s;
      newCells[addr(p.r - drop, p.c)] = nc;
    }
    sheet.cells = newCells;
    sheet.rows -= drop;
    sheet.merges = merges.filter((m) => m.s.r >= drop).map((m) => ({ s: { r: m.s.r - drop, c: m.s.c }, e: { r: m.e.r - drop, c: m.e.c } }));
  }

  /* ============== 6d. Excel IMPORT (मौजूदा फाइल लाओ — formatting समेत) ============== */
  async function importXlsx(file) {
    const ok = await window.__sheetjsReady;
    if (!ok || typeof XLSX === "undefined") { alert("Excel engine load नहीं हुआ — internet जाँचें।"); return; }
    const XS = await loadXlsxStyle();      // styles पढ़ने के लिए (न मिले तो सादा import)
    const X = XS || XLSX;
    const buf = await file.arrayBuffer();
    const wb = X.read(buf, { type: "array", cellFormula: true, cellStyles: true });
    let added = 0;
    for (const wsName of wb.SheetNames) {
      const ws = wb.Sheets[wsName];
      const ref = ws["!ref"]; if (!ref) continue;
      const range = X.utils.decode_range(ref);
      const rows = range.e.r + 1, cols = range.e.c + 1;
      const cells = {};
      for (let r = range.s.r; r <= range.e.r; r++) {
        for (let c = range.s.c; c <= range.e.c; c++) {
          const cell = ws[X.utils.encode_cell({ r, c })];
          if (!cell) continue;
          const a = addr(r, c);
          const st = XS ? compactStyle(cell.s) : null;
          let entry = null;
          if (cell.f) entry = { f: "=" + cell.f };
          else if (cell.t === "n") entry = { v: cell.v };
          else if (cell.v != null && cell.v !== "") entry = { v: String(cell.v) };
          else if (st) entry = { v: "" };        // सिर्फ़ रंग/format वाला खाली cell भी रखो
          if (!entry) continue;
          if (st) entry.s = st;
          cells[a] = entry;
        }
      }
      // Excel की merged-cells (जैसे title जो सभी columns में फैला हो) — हूबहू रखो
      const merges = (ws["!merges"] || []).map((m) => ({ s: { r: m.s.r, c: m.s.c }, e: { r: m.e.r, c: m.e.c } }));
      // Excel की column-चौड़ाई (wpx/wch) → px
      let colWidths = null;
      const colsMeta = ws["!cols"];
      if (Array.isArray(colsMeta) && colsMeta.length) {
        colWidths = [];
        for (let c = 0; c < Math.max(cols, 5); c++) {
          const cm = colsMeta[c];
          let w = cm && (cm.wpx || (cm.wch ? Math.round(cm.wch * 7 + 6) : null));
          colWidths.push(w || 80);
        }
      }
      const nm = uniqueName(safeName(wsName));
      const sheet = { id: uid("sht"), name: nm, rows: Math.max(rows, 10), cols: Math.max(cols, 5), cells, merges, colWidths, title: "", lockTop: 1, lockBottom: 1, updatedAt: Date.now(), kind: "master", group: "misc", masterId: null };
      hoistTitle(sheet);   // top की merged title-row को grid से बाहर (banner) ले आओ
      ensureLock(sheet);
      ensureSheetMeta(sheet);   // source/size/itemKey (MoRTH · Small मानकर)
      state.sheets[sheet.id] = sheet; state.order.push(sheet.id);
      await db.put("sheets", sheet);
      added++;
    }
    buildEngine();
    renderSheetList(); renderMasterAnalysis(); refreshEstimateSheetPicker();
    if (!state.activeSheetId && state.order.length) openSheet(state.order[0]);
    status(added + " शीट import हुईं — Master Data › Analysis Section में मिलेंगी" + (XS ? " (formatting समेत)" : ""));
  }

  /* ============== 6e. नमूना (Sample) Analysis Excel डाउनलोड ==============
     Analysis फॉर्मेट की एक तैयार .xlsx — Amount/totals में formulas पहले से,
     borders/रंग/bold समेत professional formatting। quantity/rate भरें, बाकी अपने-आप;
     फिर ⬆ Excel Import से वापस लाएँ।
  */
  // styling-सक्षम fork (xlsx-js-style) सिर्फ़ ज़रूरत पर load — global XLSX को छेड़े बिना
  let __xlsxStyle = null;
  function loadXlsxStyle() {
    if (__xlsxStyle) return Promise.resolve(__xlsxStyle);
    return new Promise((resolve) => {
      const prev = window.XLSX;
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js";
      s.onload = () => { __xlsxStyle = window.XLSX; window.XLSX = prev; resolve(__xlsxStyle); }; // global वापस original
      s.onerror = () => { window.XLSX = prev; resolve(null); };
      document.head.appendChild(s);
    });
  }

  async function downloadSampleXlsx() {
    const ok = await window.__sheetjsReady;
    if (!ok || typeof XLSX === "undefined") { alert("Excel engine (SheetJS) load नहीं हुआ — internet जाँचें।"); return; }
    const XS = await loadXlsxStyle();          // styles के लिए (न मिले तो सादा फाइल)
    const lib = XS || XLSX;
    const F = (f) => ({ f });                   // formula cell (बिना =)
    // कॉलम: A=SN  B=Ref  C=Description  D=Unit  E=Quantity  F=Rate  G=Amount
    const rows = [
      ["Analysis of Filter Media (नमूना — अपना item/नाम यहाँ भरें)", "", "", "", "", "", ""],
      ["SN", "Ref MoRTH Spec.", "Description", "Unit", "Quantity", "Rate", "Amount"],
      ["15.24", "710.1.4 / IRC:78", "Filter media of stone aggregate conforming to clause 2504.2.2 of MoRTH specifications", "", "", "", ""],
      ["", "", "Unit = cum", "", "", "", ""],
      ["", "", "Taking output = 10 cum.", "", "", "", ""],
      ["", "", "a) Labour", "", "", "", ""],
      ["", "", "Mate", "day", 0.320, 525, F("E7*F7")],
      ["", "", "Mazdoor for filling, watering, ramming etc.", "day", 7, 425, F("E8*F8")],
      ["", "", "Mazdoor (Skilled)", "day", 1, 470, F("E9*F9")],
      ["", "", "b) Material", "", "", "", ""],
      ["", "", "Filter media of stone aggregate (clause 2504.2.2)", "cum", 12, 2182.60, F("E11*F11")],
      ["", "", "c) Machinery", "", "", "", ""],
      ["", "", "Water Tanker of 6 KL capacity", "hour", 0.060, 967, F("E13*F13")],
      ["", "", "d) Overhead charges @18% on (a+b+c)", "", "", "", F("0.18*(G7+G8+G9+G11+G13)")],
      ["", "", "e) Contractor's profit @10% on (a+b+c+d)", "", "", "", F("0.10*(G7+G8+G9+G11+G13+G14)")],
      ["", "", "Add Royalty", "", "", "", ""],
      ["", "", "Filter media royalty (clause 2504.2.2)", "cum", 12, 160, F("E17*F17")],
      ["", "", "cost for 10 cum of Filter Media = a+b+c+d+e", "", "", "", F("G7+G8+G9+G11+G13+G14+G15+G17")],
      ["", "", "Rate per cum = (a+b+c+d+e)/10", "", "", "", F("G18/10")],
      ["", "", "say", "", "", "", F("ROUND(G19,0)")],
    ];
    const NR = rows.length, NC = 7;

    // ---- styles (xlsx-js-style format) ----
    const thin = { style: "thin", color: { rgb: "AAB4C0" } };
    const bd = { top: thin, bottom: thin, left: thin, right: thin };
    const NAVY = "0B3D6B";
    const stBase = { border: bd, alignment: { vertical: "center" } };
    const stTitle = { border: bd, font: { bold: true, sz: 14, color: { rgb: NAVY } }, alignment: { horizontal: "center", vertical: "center" }, fill: { patternType: "solid", fgColor: { rgb: "EAF1F8" } } };
    const stHead = { border: bd, font: { bold: true, sz: 11, color: { rgb: "FFFFFF" } }, alignment: { horizontal: "center", vertical: "center", wrapText: true }, fill: { patternType: "solid", fgColor: { rgb: NAVY } } };
    const stText = { border: bd, alignment: { horizontal: "left", vertical: "center", wrapText: true } };
    const stCenter = { border: bd, alignment: { horizontal: "center", vertical: "center" } };
    const stNum = { border: bd, alignment: { horizontal: "right", vertical: "center" }, numFmt: "0.00" };
    const stNote = { border: bd, font: { italic: true, color: { rgb: "555555" } }, alignment: { horizontal: "left", vertical: "center" } };
    const stSection = { border: bd, font: { bold: true, color: { rgb: NAVY } }, alignment: { horizontal: "left", vertical: "center" }, fill: { patternType: "solid", fgColor: { rgb: "F2F6FB" } } };
    const stTotal = { border: bd, font: { bold: true }, alignment: { horizontal: "left", vertical: "center" } };
    const stTotalNum = { border: bd, font: { bold: true }, alignment: { horizontal: "right", vertical: "center" }, numFmt: "0.00" };
    const stSay = { border: bd, font: { bold: true, sz: 12, color: { rgb: "7A5B00" } }, alignment: { horizontal: "center", vertical: "center" }, fill: { patternType: "solid", fgColor: { rgb: "FFF2CC" } } };
    const stSayNum = { border: bd, font: { bold: true, sz: 12, color: { rgb: "7A5B00" } }, alignment: { horizontal: "right", vertical: "center" }, numFmt: "0.00", fill: { patternType: "solid", fgColor: { rgb: "FFF2CC" } } };

    const sectionRows = new Set([5, 9, 11, 15]);
    const totalRows = new Set([13, 14, 17, 18]);
    const noteRows = new Set([3, 4]);
    const itemRows = new Set([6, 7, 8, 10, 12, 16]);
    const styleFor = (r, c) => {
      if (r === 0) return stTitle;
      if (r === 1) return stHead;
      if (r === NR - 1) return c === 6 ? stSayNum : stSay;          // say row
      if (sectionRows.has(r)) return stSection;
      if (totalRows.has(r)) return c === 6 ? stTotalNum : stTotal;
      if (noteRows.has(r)) return c === 2 ? stNote : stBase;
      if (itemRows.has(r)) return c === 2 ? stText : (c === 3 ? stCenter : (c >= 4 ? stNum : stBase));
      if (r === 2) return c === 0 ? stCenter : (c <= 2 ? stText : stBase); // data row
      return stBase;
    };

    // ---- worksheet बनाओ ----
    const ws = {};
    for (let r = 0; r < NR; r++) {
      for (let c = 0; c < NC; c++) {
        const val = rows[r][c];
        const ref = lib.utils.encode_cell({ r, c });
        let cell;
        if (val && typeof val === "object" && val.f != null) cell = { t: "n", f: val.f };
        else if (typeof val === "number") cell = { t: "n", v: val };
        else cell = { t: "s", v: val == null ? "" : String(val) };
        if (XS) cell.s = styleFor(r, c);   // styling-lib हो तभी
        ws[ref] = cell;
      }
    }
    ws["!ref"] = lib.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: NR - 1, c: NC - 1 } });
    ws["!cols"] = [{ wpx: 42 }, { wpx: 90 }, { wpx: 300 }, { wpx: 46 }, { wpx: 64 }, { wpx: 64 }, { wpx: 78 }]; // A4-फिट
    ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: NC - 1 } }]; // title A1:G1
    ws["!rows"] = rows.map((_, r) => (r === 0 ? { hpt: 26 } : r === 2 ? { hpt: 56 } : { hpt: 18 }));

    const wb = lib.utils.book_new();
    lib.utils.book_append_sheet(wb, ws, "Analysis_Sample");
    lib.writeFile(wb, "Sample_Analysis.xlsx", { bookType: "xlsx" });
    status(XS ? "नमूना Excel (formatted) download हुआ — भरकर ⬆ Excel Import से अपलोड करें"
              : "नमूना Excel download हुआ (formatting lib नहीं मिली; सादा फाइल)");
  }

  /* ============== Sidebar render ============== */
  // Rate Analysis की बाईं सूची — सिर्फ़ load किए (working) Analysis; साथ ही, अगर कोई master
  // सीधे edit के लिए खुला है तो वह भी (अलग चिह्न के साथ) दिखे।
  // एक working/master शीट का card (li) बनाओ — group-wise render में दोबारा इस्तेमाल
  function makeSheetLi(id, s) {
    const isWork = s.kind === "working";
    const li = document.createElement("li");
    li.className = "sl-card" + (id === state.activeSheetId ? " active" : "");
    const srcLabel = (s.source === "mord") ? "MoRD" : "MoRTH";
    const srcCls = (s.source === "mord") ? "mord" : "morth";
    // स्रोत Master की स्थिति MoRTH/MoRD के आगे (बिना text): Checked → हरा ✓, वरना → ⚠ चेतावनी
    let srcTick = "";
    if (isWork && s.masterId && state.sheets[s.masterId]) {
      srcTick = state.sheets[s.masterId].checked
        ? "<span class='sl-tick' title='स्रोत Master Analysis Checked (जाँची हुई) है'>✓</span>"
        : "<span class='sl-warn' title='स्रोत Master अभी Checked नहीं है'>⚠</span>";
    }
    const sizeLabel = (s.source !== "mord" && s.size) ? sizeName(s.size) : "";
    const desc = (s.title && s.title !== s.name) ? s.title : "";
    let chips = "";
    if (sizeLabel) chips += "<span class='sl-chip size'>📐 " + escapeHtml(sizeLabel) + "</span>";
    if (!isWork) chips += "<span class='sl-chip master' title='Master Analysis — सीधा बदलाव'>🗄️ master</span>";
    // RMR/Overhead अब समूह-header से पता चलते हैं — card पर दोहराना नहीं (साफ़ दिखे)
    const acts = isWork
      ? "<div class='sl-acts'>" +
          "<button class='sl-mv up' title='ऊपर ले जाएँ — DOM & BOQ में भी इसी क्रम में'>▲</button>" +
          "<button class='sl-mv down' title='नीचे ले जाएँ'>▼</button>" +
          "<button class='sl-x' title='यहाँ से हटाएँ — Master Data की मूल शीट सुरक्षित रहेगी'>×</button>" +
        "</div>"
      : "";
    li.innerHTML =
      "<div class='sl-body'>" +
        "<div class='sl-row1'><span class='sl-title'>" + escapeHtml(s.name) + "</span><span class='sl-code " + srcCls + "'>" + srcLabel + "</span>" + srcTick + "</div>" +
        (chips ? "<div class='sl-chips'>" + chips + "</div>" : "") +
      "</div>" + acts;
    if (desc) li.title = desc;
    li.addEventListener("mousedown", (e) => { if (armed && armed.refExpected()) e.preventDefault(); });
    li.addEventListener("click", () => {
      if (armed && armed.refExpected()) { handoffToBar(id); return; }
      if (armed && armed.surface === "bar") { commitArmed("stay"); }
      openSheet(id);
    });
    const delEl = li.querySelector(".sl-x");
    if (delEl) delEl.addEventListener("click", (e) => {
      e.stopPropagation();
      state.activeSheetId = id; renderSheetList(); renderGrid();
      deleteActiveSheet();
    });
    const mvUp = li.querySelector(".sl-mv.up");
    if (mvUp) mvUp.addEventListener("click", (e) => { e.stopPropagation(); const est = state.estimates[state.activeEstimateId]; if (est && moveEstimateItem(est, id, -1)) renderSheetList(); });
    const mvDn = li.querySelector(".sl-mv.down");
    if (mvDn) mvDn.addEventListener("click", (e) => { e.stopPropagation(); const est = state.estimates[state.activeEstimateId]; if (est && moveEstimateItem(est, id, 1)) renderSheetList(); });
    li.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const menu = [];
      if (isWork) {   // item को समूह में ऊपर/नीचे (DOM व BOQ भी उसी क्रम में)
        menu.push({ label: "⬆  आइटम ऊपर", action: () => { const est = state.estimates[state.activeEstimateId]; if (est && moveEstimateItem(est, id, -1)) renderSheetList(); } });
        menu.push({ label: "⬇  आइटम नीचे", action: () => { const est = state.estimates[state.activeEstimateId]; if (est && moveEstimateItem(est, id, 1)) renderSheetList(); } });
        menu.push({ sep: true });
      }
      menu.push({ label: "✎  नाम बदलें", action: () => renameSheetById(id) });
      menu.push({ label: "🗑  शीट हटाएँ", action: () => { state.activeSheetId = id; renderSheetList(); renderGrid(); deleteActiveSheet(); }, cls: "danger" });
      showMenu(e.clientX, e.clientY, menu);
    });
    return li;
  }

  // Rate Analysis की बाईं सूची — active estimate के कार्य-समूह-वार; हर समूह में "+ Analysis"
  let _openWgId;   // accordion — खुला समूह; null = सभी collapsed; undefined = अभी default तय करना है
  function renderSheetList() {
    const list = document.getElementById("sheetList");
    const q = (document.getElementById("sheetSearch").value || "").toLowerCase();
    list.innerHTML = "";
    const matchQ = (s) => !q || s.name.toLowerCase().includes(q);
    const est = state.estimates[state.activeEstimateId];
    const groups = est ? estWorkGroups(est) : [];
    const wgKey = (r, o) => (r || "") + "|" + (o || "");

    const works = [];
    for (const id of state.order) { const s = state.sheets[id]; if (s.kind === "working") works.push({ id, s }); }
    const working = works.length;
    let shown = 0;

    // सीधे edit के लिए खुली Master शीट (यदि कोई) — सबसे ऊपर
    const activeS = state.sheets[state.activeSheetId];
    if (activeS && activeS.kind !== "working" && matchQ(activeS)) { list.appendChild(makeSheetLi(state.activeSheetId, activeS)); shown++; }

    if (groups.length) {
      const assigned = new Set();
      const otherKeys = new Set();   // दूसरे estimates के group-keys — उनकी शीटें यहाँ न दिखें
      for (const eid of state.estOrder) {
        if (eid === state.activeEstimateId) continue;
        estWorkGroups(state.estimates[eid]).forEach((g) => otherKeys.add(wgKey(g.rmrId, g.ohGroupId)));
      }
      const expandAll = !!q;   // खोज के समय सभी समूह खुले
      // accordion — कौन-सा समूह खुला रहे (खोज न हो तो)। null = user ने सब collapse किया → वैसा ही रहने दो;
      // undefined या पुराना/अमान्य id → default खोलो (active-sheet का, वरना मुख्य/पहला)
      if (!expandAll && _openWgId !== null && !groups.some((g) => g.id === _openWgId)) {
        const asGk = (activeS && activeS.kind === "working") ? wgKey(activeS.rmrId, activeS.ohGroupId) : null;
        const def = (asGk && groups.find((g) => wgKey(g.rmrId, g.ohGroupId) === asGk)) || groups.find((g) => g.isMain) || groups[0];
        _openWgId = def ? def.id : null;
      }
      for (const g of groups) {
        const gk = wgKey(g.rmrId, g.ohGroupId);
        const mine = works.filter((w) => wgKey(w.s.rmrId, w.s.ohGroupId) === gk);
        mine.forEach((w) => assigned.add(w.id));
        const ord = estGroupOrder(est, gk, mine.map((w) => w.id));   // साझा item-क्रम
        mine.sort((a, b) => ord.indexOf(a.id) - ord.indexOf(b.id));
        const n = mine.length;
        const isOpen = expandAll || g.id === _openWgId;
        const head = document.createElement("li");
        head.className = "sl-group-head" + (isOpen ? " open" : "");
        head.innerHTML =
          "<span class='slg-toggle'>" + (isOpen ? "▾" : "▸") + "</span>" +
          "<span class='slg-name'>" + (g.isMain ? "★ " : "") + escapeHtml(g.name) + "</span>" +
          "<span class='slg-count' title='लोड किए Analysis'>" + n + "</span>" +
          "<span class='slg-actions'>" +
            (n > 0 ? "<button type='button' class='slg-save' title='इस समूह के सभी Analysis को सेट (template) के रूप में सहेजें — भविष्य में किसी और Estimate में एक साथ लोड करने के लिए'>💾 सेट</button>" : "") +
            "<button type='button' class='slg-load' title='इस समूह में Analysis लोड करें'>+ Analysis</button>" +
          "</span>";
        head.addEventListener("click", () => { _openWgId = (_openWgId === g.id) ? null : g.id; renderSheetList(); });
        head.querySelector(".slg-load").addEventListener("click", (e) => { e.stopPropagation(); openLoadAnalysisPicker(g.id); });
        const sv = head.querySelector(".slg-save"); if (sv) sv.addEventListener("click", (e) => { e.stopPropagation(); saveGroupAsSet(g); });
        list.appendChild(head);
        if (isOpen) {
          let vis = 0;
          for (const { id, s } of mine) { if (!matchQ(s)) continue; list.appendChild(makeSheetLi(id, s)); shown++; vis++; }
          if (n === 0 || vis === 0) {
            const em = document.createElement("li"); em.className = "sl-group-empty muted";
            em.textContent = (n === 0) ? "अभी कोई Analysis नहीं — “+ Analysis” दबाएँ" : "कोई मेल नहीं";
            list.appendChild(em);
          }
        }
      }
      // अवर्गीकृत (किसी भी estimate के समूह से मेल नहीं) — विरासत शीटें न खोएँ
      const orphans = works.filter(({ id, s }) => !assigned.has(id) && !otherKeys.has(wgKey(s.rmrId, s.ohGroupId)) && matchQ(s));
      if (orphans.length) {
        const head = document.createElement("li"); head.className = "sl-group-head other";
        head.innerHTML = "<span class='slg-name'>📄 अन्य (समूह-रहित)</span>";
        list.appendChild(head);
        orphans.forEach(({ id, s }) => { list.appendChild(makeSheetLi(id, s)); shown++; });
      }
    } else {
      // कोई active estimate/समूह नहीं → सपाट सूची
      for (const { id, s } of works) { if (!matchQ(s)) continue; list.appendChild(makeSheetLi(id, s)); shown++; }
      if (shown === 0) {
        const li = document.createElement("li"); li.className = "muted-row";
        li.innerHTML = q ? "कोई मेल नहीं।" : "पहले कोई Estimate खोलें, फिर समूह में <b>+ Analysis</b> से लाएँ।";
        list.appendChild(li);
      }
    }
    document.getElementById("sheetCount").textContent = working + " load किए" + (q ? " · " + shown + " मिलीं" : "");
  }

  /* ============== utils ============== */
  function dateStamp() { const d = new Date(); const p = (n) => String(n).padStart(2, "0"); return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()); }
  function dateDMY() { const d = new Date(); const p = (n) => String(n).padStart(2, "0"); return p(d.getDate()) + "/" + p(d.getMonth() + 1) + "/" + d.getFullYear(); } // आज DD/MM/YYYY
  function dmyNum(s) { const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s || ""); return m ? (+m[3]) * 10000 + (+m[2]) * 100 + (+m[1]) : 0; } // sort-key
  let statusTimer = null;
  function status(msg) { const el = document.getElementById("statusMsg"); el.textContent = msg; clearTimeout(statusTimer); statusTimer = setTimeout(() => { el.textContent = "तैयार"; }, 4000); }

  function setEngineStatus() {
    const el = document.getElementById("engineStatus");
    if (hfReady) { el.textContent = "✓ calc engine"; el.className = "engine-pill ok"; }
    else { el.textContent = "⚠ engine offline"; el.className = "engine-pill warn"; el.title = "HyperFormula load नहीं हुआ — internet जाँचें। Data entry फिर भी चलेगी।"; }
  }

  /* ============== Right-click context menu (Excel जैसा) ============== */
  let _menuEl = null;
  function closeMenu() { if (_menuEl) { _menuEl.remove(); _menuEl = null; } }
  // items: { label, action, cls?, disabled? } या { sep:true }
  function showMenu(x, y, items) {
    closeMenu();
    const menu = document.createElement("div");
    menu.className = "ctx-menu";
    items.forEach((it) => {
      if (it.sep) { const s = document.createElement("div"); s.className = "sep"; menu.appendChild(s); return; }
      const b = document.createElement("button");
      b.textContent = it.label;
      if (it.cls) b.className = it.cls;
      if (it.disabled) { b.disabled = true; b.style.opacity = ".55"; b.style.cursor = "default"; }
      else b.addEventListener("click", () => { closeMenu(); it.action(); });
      menu.appendChild(b);
    });
    document.body.appendChild(menu);
    _menuEl = menu;
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = Math.min(x, window.innerWidth - mw - 6) + "px";
    menu.style.top = Math.min(y, window.innerHeight - mh - 6) + "px";
  }

  function setupContextMenu() {
    document.addEventListener("click", closeMenu);
    document.addEventListener("scroll", closeMenu, true);
    window.addEventListener("resize", closeMenu);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });

    grid.addEventListener("contextmenu", (e) => {
      const td = e.target.closest("td[data-r]");
      if (!td || !state.activeSheetId) return;
      e.preventDefault();
      const r = +td.dataset.r, c = +td.dataset.c;
      // multi-cell चयन के भीतर right-click → चयन बना रहे (Copy के लिए); वरना single-select
      const _s = selRange(); const inSel = (r >= _s.r1 && r <= _s.r2 && c >= _s.c1 && c <= _s.c2);
      if (!inSel) selectCell(r, c);
      const sheet = state.sheets[state.activeSheetId];
      ensureLock(sheet);
      const isDomBoq = (sheet.kind === "dom" || sheet.kind === "boq");
      const items = [];
      // Copy / Cut / Paste — हर spreadsheet पर (formula-सहित, relative-adjust)
      items.push({ label: "📋  Copy" + (hasSelRange() ? " (कई cell)" : "") + "  ·  Ctrl+C", action: () => copyRangeToClip(sheet, selRange(), false, null) });
      items.push({ label: "✂️  Cut  ·  Ctrl+X", action: () => copyRangeToClip(sheet, selRange(), true, null) });
      if (_clip) items.push({ label: "📥  Paste  ·  Ctrl+V", action: () => pasteInternalClip(sheet) });
      items.push({ sep: true });
      // DOM/BOQ — पूरे आइटम को ऊपर/नीचे (तीनों जगह उसी क्रम में)
      if (isDomBoq) {
        const est = state.estimates[state.activeEstimateId];
        let itemId = null;
        if (sheet.kind === "dom") { for (let rr = r; rr >= 1; rr--) { const cc = sheet.cells[addr(rr, 2)]; if (cc && cc.role === "domhdr") { itemId = cc.itemId; break; } } }
        else { const mc = sheet.cells[addr(r, 0)]; itemId = (mc && mc.itemId) ? mc.itemId : null; }   // BOQ: पंक्ति के marker से
        if (itemId) {
          const isExtra = String(itemId).indexOf("xtr:") === 0;
          items.push({ label: "⬆  आइटम ऊपर", action: () => domBoqMoveItem(itemId, -1) });
          items.push({ label: "⬇  आइटम नीचे", action: () => domBoqMoveItem(itemId, 1) });
          if (_domSubId || isExtra) items.push({ label: isExtra ? "🗑  यह आइटम हटाएँ" : "🗑  यह आइटम हटाएँ (इस Sub-Estimate से)", action: () => domBoqDeleteItem(itemId), cls: "danger" });
          items.push({ sep: true });
        }
      }
      // "Master से…" व "Lead" सिर्फ़ Analysis शीट पर — DOM/BOQ पर नहीं
      if (!isDomBoq) {
        items.push({ label: (c === 5 && inRoyaltySection(sheet, r)) ? "🔍  Master से Royality भरें (नाम+royalty)" : (c === 5 ? "🔍  Master से केवल रेट भरें" : "🔍  Master से आइटम (नाम+रेट) जोड़ें"), action: () => openMasterPicker() });
        if (c === 4 && !isLockedRow(sheet, r) && !(sheet.cells[addr(r, 2)] || {}).role) {
          items.push({ label: ((sheet.cells[addr(r, 4)] || {}).lead ? "🧮  Lead बदलें" : "🧮  Lead जोड़ें") + " (Value1 × Length/4 + Value2)", action: () => openLeadDialog() });
        }
        items.push({ sep: true });
      }
      if (isLockedRow(sheet, r)) {
        items.push({ label: "🔒 लॉक पंक्ति (header/footer) — insert/delete नहीं", disabled: true });
      } else {
        if (!isDomBoq && !isSectionRow(sheet, r)) {
          items.push({ label: "⬆  आइटम ऊपर (इसी सेक्शन में)", action: () => moveAnalysisRow(r, -1) });
          items.push({ label: "⬇  आइटम नीचे (इसी सेक्शन में)", action: () => moveAnalysisRow(r, 1) });
          items.push({ sep: true });
        }
        items.push({ label: "⬆  ऊपर नई पंक्ति डालें", action: () => structuralEdit("insRow", r) });
        items.push({ label: "⬇  नीचे नई पंक्ति डालें", action: () => structuralEdit("insRow", r + 1) });
        const selR = selRange();
        if (selR.r2 > selR.r1) {   // कई पंक्तियाँ चुनी हैं → सभी हटाएँ
          items.push({ label: "🗑  चुनी हुई " + (selR.r2 - selR.r1 + 1) + " पंक्तियाँ हटाएँ", action: () => deleteRowRange(selR.r1, selR.r2), cls: "danger" });
        } else {
          items.push({ label: "🗑  पंक्ति " + (r + 1) + " हटाएँ", action: () => structuralEdit("delRow", r), cls: "danger" });
        }
      }
      // कॉलम insert/delete जान-बूझकर हटाया — Analysis के fixed कॉलम (C=Description, F=Rate, G=Amount) न खिसकें
      showMenu(e.clientX, e.clientY, items);
    });
  }

  // सूची में किसी शीट का नाम बदलो
  function renameSheetById(id) {
    const s = state.sheets[id];
    if (!s) return;
    const raw = prompt("शीट का नया नाम:", s.name);
    if (raw === null) return;
    state.activeSheetId = id;
    renameActiveSheet(raw);
  }

  /* ============== आसान तरीका: 🔗 Link picker (dropdown से शीट+cell चुनो) ============== */
  function openLinkPicker() {
    const sheet = state.sheets[state.activeSheetId];
    if (!sheet || state.order.length === 0) return;
    const { r, c } = state.activeCell;

    const defId = state.order.find((id) => id !== state.activeSheetId) || state.activeSheetId;
    let opts = "";
    for (const id of state.order)
      opts += "<option value='" + id + "'" + (id === defId ? " selected" : "") + ">" + escapeHtml(state.sheets[id].name) + "</option>";

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML =
      "<div class='modal'>" +
      "<h3>🔗 दूसरी शीट से link जोड़ें</h3>" +
      "<p class='sub'>यह <b>" + addr(r, c) + "</b> में <b>=शीट!cell</b> डाल देगा। बाद में उस शीट में पंक्ति/कॉलम जोड़ने पर भी link अपने-आप ठीक रहेगा।</p>" +
      "<label>किस शीट से?</label><select id='lpSheet'>" + opts + "</select>" +
      "<label>कौन-सा cell? (जैसे E50)</label><input id='lpCell' type='text' value='A1' />" +
      "<div class='preview' id='lpPreview'></div>" +
      "<div class='row'><button class='btn' id='lpCancel'>रद्द</button><button class='btn primary' id='lpOk'>जोड़ें</button></div>" +
      "</div>";
    document.body.appendChild(overlay);

    const selEl = overlay.querySelector("#lpSheet");
    const cellEl = overlay.querySelector("#lpCell");
    const prev = overlay.querySelector("#lpPreview");
    const refresh = () => { prev.textContent = "= " + state.sheets[selEl.value].name + "!" + cellEl.value.toUpperCase().trim(); };
    selEl.addEventListener("change", refresh);
    cellEl.addEventListener("input", refresh);
    refresh();
    cellEl.focus(); cellEl.select();

    const close = () => overlay.remove();
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    overlay.querySelector("#lpCancel").addEventListener("click", close);
    overlay.querySelector("#lpOk").addEventListener("click", () => {
      const ca = cellEl.value.toUpperCase().trim();
      if (!parseAddr(ca)) { alert("cell का पता सही नहीं — जैसे A1, E50 लिखें।"); return; }
      const tname = state.sheets[selEl.value].name;
      if (sheet.cells[addr(r, c)] && !confirm(addr(r, c) + " में पहले से कुछ है — उसे बदलकर link लगाएँ?")) return;
      userSetCell(sheet, r, c, "=" + tname + "!" + ca);
      renderGrid(); selectCell(r, c); grid.focus();
      close();
      status("Link जुड़ा: " + addr(r, c) + " → " + tname + "!" + ca);
    });
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); overlay.querySelector("#lpOk").click(); }
      else if (e.key === "Escape") { e.preventDefault(); close(); }
    });
  }

  /* ============== Rate Analysis: Master से Labour/Machinery/Material जोड़ें ==============
     चुने item को active पंक्ति में डालता है — मानक कॉलम: C=Description, D=Unit, F=Rate,
     G=Amount(=Quantity×Rate). उपयोगकर्ता सिर्फ़ E=Quantity भरता है। रेट loaded Master version से।
  */
  const PICKER_CATS = [
    ["labour", "Labour"], ["machine", "Machine (MoRTH)"], ["machine_mord", "Machine (MoRD)"],
    ["material_query", "Material (Query)"], ["material_loading", "Loading/Unloading"], ["material_sor", "Material SOR"], ["item_sor", "Item SOR"],
  ];
  // "Loading/Unloading" — virtual category: rows वही Material Query Rate के, पर रेट = प्रति-यूनिट Loading/Unloading charge
  function loadingChargeDesc() { const cm = state.master["cartage"]; const d = cm && cm.loadingUnloading && cm.loadingUnloading.desc; return (d && d.trim()) || "Loading/Unloading Charges"; }
  function masterItemName(cat, row) {
    if (cat === "item_sor") return (row.itemno ? row.itemno + " — " : "") + (row.desc || "");
    if (cat === "material_loading") return loadingChargeDesc() + " — " + (row.desc || "");   // किस material का loading, वह भी दिखे
    return row.desc || "";
  }
  function masterItemRate(cat, row) {
    if (cat === "material_query") return mrNum(row.query_rate) - mrNum(row.royalty) - mrNum(row.loading); // Final Rate = Query − Royality − Loading/Unloading
    if (cat === "material_loading") return mrNum(row.loading);   // प्रति-यूनिट Loading/Unloading charge (km-आधारित नहीं)
    return mrNum(row.rate);
  }
  function round2(n) { n = mrNum(n); return Math.round((n + Number.EPSILON) * 100) / 100; } // 2 दशमलव
  // mref का वर्तमान रेट — RMR से जुड़ा हो तो RMR का carted rate; वरना Primary Rate (single/औसत)
  function mrefRateNum(mref) {
    if (mref.rmr) {
      // RMR (Material + Cartage) से — कई material का औसत हो तो वही materials (matIds) जो Master में चुने थे
      if (Array.isArray(mref.matIds)) {
        const rates = mref.matIds.map((id) => rmrRateForMat(mref.rmr, id)).filter((x) => x != null);
        return rates.length ? round2(rates.reduce((a, b) => a + b, 0) / rates.length) : null;
      }
      return rmrRateForMat(mref.rmr, mref.matId);
    }
    if (Array.isArray(mref.rowIds)) {
      const rates = mref.rowIds.map((id) => { const rr = masterRowById(mref.cat, id); return rr ? mrNum(masterItemRate(mref.cat, rr)) : null; }).filter((x) => x != null);
      if (!rates.length) return null;
      return round2(rates.reduce((a, b) => a + b, 0) / rates.length);
    }
    const rr = masterRowById(mref.cat, mref.rowId);
    return rr ? round2(mrNum(masterItemRate(mref.cat, rr))) : null;
  }
  // RMR खोजो (सभी estimates में) व उसके किसी material का carted rate
  function findRmrById(rmrId) {
    for (const eid of state.estOrder) { const e = state.estimates[eid]; const r = (e.rmrs || []).find((x) => x.id === rmrId); if (r) return r; }
    return null;
  }
  function rmrRateForMat(rmrId, matId) {
    const rmr = findRmrById(rmrId); if (!rmr) return null;
    const row = rmr.rows.find((x) => x.matId === matId); if (!row) return null;
    const mat = rmrMaterial(row);
    return round2(mat.matRate - mat.royalty + rmrCartage(row.distance));   // Total Rate Incl. Cartage
  }
  function rmrRoyaltyForMat(rmrId, matId) {
    const rmr = findRmrById(rmrId); if (!rmr) return null;
    const row = rmr.rows.find((x) => x.matId === matId); if (!row) return null;
    return round2(rmrMaterial(row).royalty);
  }
  // किसी master item का royalty दर (सिर्फ़ material में; labour/machine/sor में 0)
  function masterItemRoyalty(cat, row) {
    if (cat === "material_query" || cat === "material_loading") return mrNum(row.royalty);
    return 0;
  }
  // mref का royalty — RMR-linked हो तो RMR की royalty दर; वरना Primary Rate की royalty (कई हों तो औसत — point 2 का ध्यान)
  function mrefRoyaltyNum(mref) {
    if (!mref) return null;
    if (mref.rmr) {
      if (Array.isArray(mref.matIds)) {
        const vs = mref.matIds.map((id) => rmrRoyaltyForMat(mref.rmr, id)).filter((x) => x != null);
        return vs.length ? round2(vs.reduce((a, b) => a + b, 0) / vs.length) : null;
      }
      return rmrRoyaltyForMat(mref.rmr, mref.matId);
    }
    if (Array.isArray(mref.rowIds)) {
      const vs = mref.rowIds.map((id) => { const rr = masterRowById(mref.cat, id); return rr ? masterItemRoyalty(mref.cat, rr) : null; }).filter((x) => x != null);
      return vs.length ? round2(vs.reduce((a, b) => a + b, 0) / vs.length) : null;
    }
    const rr = masterRowById(mref.cat, mref.rowId);
    return rr ? round2(masterItemRoyalty(mref.cat, rr)) : null;
  }

  /* ===== Primary Rate → Analysis live-update =====
     insertMasterItem से जुड़े cells पर mref {cat,rowId,field} रहता है। Primary Rate की
     loaded version में नाम/रेट बदलने (या version Load बदलने) पर सभी analyses के वे cell
     अपने-आप ताज़ा हो जाते हैं (Amount = Qty×Rate engine से recompute)। */
  function masterRowById(cat, rowId) {
    const rows = loadedVersionRows(cat);
    return rows ? (rows.find((x) => x.id === rowId) || null) : null;
  }
  function reRateAllAnalyses() {
    let touched = 0;
    for (const id of state.order) {
      const sheet = state.sheets[id];
      if (!sheet || !sheet.cells) continue;
      let changed = false;
      for (const a in sheet.cells) {
        const cell = sheet.cells[a];
        if (!cell || !cell.mref) continue;
        if (cell.mref.bitumen) {   // Bitumen row — Estimate के Bitumen Final Rate (Say Rs) से live
          const be = estOfWorkingSheet(sheet);
          const num = be ? bitumenRateByType(be, cell.mref.bitumen) : null;
          if (num != null && (cell.f != null || mrNum(cell.v) !== num)) { delete cell.f; cell.v = num; changed = true; }
        } else if (cell.mref.field === "name") {
          const row = masterRowById(cell.mref.cat, cell.mref.rowId);
          if (!row) continue; // master row मौजूद नहीं → वैसा ही रहने दो
          const nm = masterItemName(cell.mref.cat, row);
          if (cell.f != null || cell.v !== nm) { delete cell.f; cell.v = nm; changed = true; }
        } else if (cell.mref.field === "rate") {
          const num = mrefRateNum(cell.mref);   // single या कई items का औसत (2 दशमलव)
          if (num == null) continue;
          // बचा हुआ formula हटाओ — नहीं तो grid formula का मान दिखाएगा, linked rate नहीं (इसलिए "हरा पर अपडेट नहीं")
          if (cell.f != null || mrNum(cell.v) !== num) { delete cell.f; cell.v = num; changed = true; }
        } else if (cell.mref.field === "royalty") {
          const num = mrefRoyaltyNum(cell.mref);   // RMR/Primary की royalty (कई हों तो औसत)
          if (num == null) continue;
          if (cell.f != null || mrNum(cell.v) !== num) { delete cell.f; cell.v = num; changed = true; }
        }
      }
      if (changed) { persistSheet(sheet, true); touched++; }   // auto re-rate — "अंतिम सुधार" समय अछूता रहे
    }
    if (touched && !_suppressEngine) { if (hfReady) buildEngine(); if (state.activeSheetId) renderGrid(); }
    return touched;
  }
  let _reRateTimer = null;
  function scheduleReRate() { clearTimeout(_reRateTimer); _reRateTimer = setTimeout(reRateAllAnalyses, 300); }

  // 🔄 दर-refresh — जो रेट manually भरा है (link नहीं) उसे नाम मिलाकर Primary Rate से जोड़ो, फिर ताज़ा करो
  function relinkAnalysisRates() {
    const norm = (s) => String(s == null ? "" : s).trim().toLowerCase().replace(/\s+/g, " ");
    const map = {};
    for (const pc of PICKER_CATS) {
      const cat = pc[0], rows = loadedVersionRows(cat);
      if (!rows) continue;
      for (const row of rows) { const key = norm(masterItemName(cat, row)); if (key && !(key in map)) map[key] = { cat: cat, rowId: row.id }; }
    }
    let linked = 0;
    for (const id of state.order) {
      const sheet = state.sheets[id]; if (!sheet || !sheet.cells) continue;
      let changed = false;
      for (let r = 0; r < sheet.rows; r++) {
        const fcell = sheet.cells[addr(r, 5)], dcell = sheet.cells[addr(r, 2)];
        if (!fcell || fcell.mref) continue;                 // पहले से linked नहीं / रेट-cell है
        if (dcell && dcell.role) continue;                  // section/total पंक्ति नहीं
        const hasRate = fcell.f != null || (fcell.v !== "" && fcell.v != null);
        if (!hasRate) continue;
        const nm = dcell ? norm(dcell.v) : "";
        const m = nm && map[nm];
        if (!m) continue;
        fcell.mref = { cat: m.cat, rowId: m.rowId, field: "rate" };
        if (dcell) dcell.mref = { cat: m.cat, rowId: m.rowId, field: "name" };
        linked++; changed = true;
      }
      if (changed) persistSheet(sheet);
    }
    const rerated = reRateAllAnalyses();
    return { linked: linked, rerated: rerated };
  }

  // conservative auto-link (boot पर) — पुराने analyses के वे master-आइटम जिनका नाम व रेट दोनों
  //  मास्टर से मेल खाते हैं, उन्हें चुपचाप link कर दो (मान नहीं बदलेगा) ताकि "manual" पीला न दिखे।
  function autoLinkMasterRates() {
    const norm = (s) => String(s == null ? "" : s).trim().toLowerCase().replace(/\s+/g, " ");
    const map = {};
    for (const pc of PICKER_CATS) {
      const cat = pc[0], rows = loadedVersionRows(cat);
      if (!rows) continue;
      for (const row of rows) { const key = norm(masterItemName(cat, row)); if (key && !(key in map)) map[key] = { cat: cat, rowId: row.id, rate: mrNum(masterItemRate(cat, row)) }; }
    }
    let linked = 0;
    for (const id of state.order) {
      const sheet = state.sheets[id]; if (!sheet || !sheet.cells) continue;
      let changed = false;
      for (let r = 0; r < sheet.rows; r++) {
        const fcell = sheet.cells[addr(r, 5)], dcell = sheet.cells[addr(r, 2)];
        if (!fcell || fcell.mref) continue;
        if (dcell && dcell.role) continue;
        if (fcell.v === "" || fcell.v == null || !isFinite(mrNum(fcell.v))) continue; // संख्या-रेट ही
        const nm = dcell ? norm(dcell.v) : "";
        const m = nm && map[nm];
        if (!m) continue;
        if (Math.abs(mrNum(fcell.v) - m.rate) > 0.005) continue;   // रेट भी वही हो तभी link
        fcell.mref = { cat: m.cat, rowId: m.rowId, field: "rate" };
        if (dcell) dcell.mref = { cat: m.cat, rowId: m.rowId, field: "name" };
        linked++; changed = true;
      }
      if (changed) persistSheet(sheet, true);   // सिर्फ़ master-link जोड़ा — "अंतिम सुधार" समय अछूता रहे
    }
    return linked;
  }
  //  mode "both" (Description से) → नाम + Unit + Rate; mode "rate" (Rate से) → केवल Rate (नाम अछूता)
  function insertMasterItem(cat, row, mode) {
    const sheet = state.sheets[state.activeSheetId]; if (!sheet) return;
    const r = state.activeCell.r;
    if (isLockedRow(sheet, r) || (sheet.cells[addr(r, 2)] || {}).role) { alert("यह section/total/header पंक्ति है — item यहाँ नहीं जोड़ा जा सकता। किसी item-पंक्ति पर जाएँ।"); return; }
    pushUndo("sheet");
    if (sheet.cols < 7) { sheet.cols = 7; ensureLock(sheet); buildEngine(); }
    const name = masterItemName(cat, row), rate = masterItemRate(cat, row), unit = row.unit || "";
    if (mode === "rate") {
      setCell(sheet, r, 5, nf(round2(rate)));                      // F = Rate (केवल)
      setCell(sheet, r, 6, amtFormula(r));                          // G = ROUND(Qty × Rate, 2)
      if (sheet.cells[addr(r, 5)]) sheet.cells[addr(r, 5)].mref = { cat: cat, rowId: row.id, field: "rate" };
      persistSheet(sheet); maybeSyncToMaster(sheet); renderGrid();
      selectCell(r, 4); scrollToActive();
      status("रेट भरा: ₹" + nf(round2(rate)) + " — नाम अपरिवर्तित; रेट Primary Rate से linked");
      return;
    }
    setCell(sheet, r, 2, name);                                   // C = Description
    if (unit) setCell(sheet, r, 3, unit);                          // D = Unit
    setCell(sheet, r, 5, nf(round2(rate)));                        // F = Rate
    setCell(sheet, r, 6, amtFormula(r));                           // G = ROUND(Qty × Rate, 2)
    // Primary Rate से live link — बाद में उस item का नाम/रेट बदलने पर यहाँ अपने-आप अपडेट
    if (sheet.cells[addr(r, 2)]) sheet.cells[addr(r, 2)].mref = { cat: cat, rowId: row.id, field: "name" };
    if (sheet.cells[addr(r, 5)]) sheet.cells[addr(r, 5)].mref = { cat: cat, rowId: row.id, field: "rate" };
    persistSheet(sheet);
    maybeSyncToMaster(sheet);
    renderGrid();
    selectCell(r, 4); scrollToActive();                           // E = Quantity
    status(name + " जुड़ा — अब मात्रा (Quantity) भरें");
  }
  function amtFormula(r) { return "=ROUND(" + addr(r, 4) + "*" + addr(r, 5) + ",2)"; } // Amount 2 दशमलव
  // कई items का औसत रेट भरो (Primary Rate से linked — बदलने पर औसत भी बदलेगा)
  function insertMasterItemAvg(cat, rowsSel) {
    const sheet = state.sheets[state.activeSheetId]; if (!sheet || !rowsSel.length) return;
    const r = state.activeCell.r;
    if (isLockedRow(sheet, r) || (sheet.cells[addr(r, 2)] || {}).role) { alert("यह section/total/header पंक्ति है — यहाँ नहीं भरा जा सकता।"); return; }
    pushUndo("sheet");
    if (sheet.cols < 7) { sheet.cols = 7; ensureLock(sheet); buildEngine(); }
    const rates = rowsSel.map((row) => mrNum(masterItemRate(cat, row)));
    const avg = round2(rates.reduce((a, b) => a + b, 0) / rates.length);
    setCell(sheet, r, 5, nf(avg));
    setCell(sheet, r, 6, amtFormula(r));
    if (sheet.cells[addr(r, 5)]) sheet.cells[addr(r, 5)].mref = { cat: cat, rowIds: rowsSel.map((x) => x.id), field: "rate", agg: "avg" };
    persistSheet(sheet); maybeSyncToMaster(sheet); renderGrid();
    selectCell(r, 4); scrollToActive();
    status(rowsSel.length + " items का औसत रेट भरा: ₹" + nf(avg) + " — Primary Rate से linked");
  }
  // Royality section — चुने material(s) की Royality दर F में भरो (field:"royalty"; कई हों तो औसत — point 2)
  function fillRoyaltyLink(cat, rowsSel) {
    const sheet = state.sheets[state.activeSheetId]; if (!sheet || !rowsSel.length) return;
    const r = state.activeCell.r;
    if (isLockedRow(sheet, r) || (sheet.cells[addr(r, 2)] || {}).role) { alert("यह section/total/header पंक्ति है।"); return; }
    pushUndo("sheet");
    if (sheet.cols < 7) { sheet.cols = 7; ensureLock(sheet); buildEngine(); }
    const vals = rowsSel.map((row) => mrNum(masterItemRoyalty(cat, row)));
    const avg = round2(vals.reduce((a, b) => a + b, 0) / vals.length);
    setCell(sheet, r, 5, nf(avg));
    if (sheet.cells[addr(r, 5)]) sheet.cells[addr(r, 5)].mref = rowsSel.length === 1
      ? { cat: cat, rowId: rowsSel[0].id, field: "royalty" }
      : { cat: cat, rowIds: rowsSel.map((x) => x.id), field: "royalty", agg: "avg" };
    setCell(sheet, r, 6, amtFormula(r));
    persistSheet(sheet); buildEngine(); renderGrid();
    selectCell(r, 5); scrollToActive();
    status(rowsSel.length === 1 ? ("Royalty भरी: ₹" + nf(avg) + " — Primary/RMR से linked") : (rowsSel.length + " material की औसत Royalty: ₹" + nf(avg)));
  }

  /* ===== Lead — Quantity = Value1 × Road Length/4 + Value2 (Machinery आदि) ===== */
  // compact (बिना space) — "4.856x13.20/4+2.654"; Value2 न हो तो "+..." नहीं
  function leadLine1(v1, roadLen) { return (String(v1).trim() || "0") + "x" + mrNum(roadLen).toFixed(2) + "/4"; }
  function leadLine2(v2) { return "+" + String(v2).trim(); }
  function hasLeadV2(v2) { return String(v2).trim() !== "" && mrNum(v2) !== 0; }   // Value2 भरा है?
  function leadText(v1, roadLen, v2) { return leadLine1(v1, roadLen) + (hasLeadV2(v2) ? leadLine2(v2) : ""); }
  // cell में 2 लाइन (चौड़ाई कम रहे): पहली लाइन ...×.../4, दूसरी +Value2 (यदि हो)
  function leadHtml(lead) {
    let h = "<span class='ll'>" + escapeHtml(leadLine1(lead.v1, lead.roadLen)) + "</span>";
    if (hasLeadV2(lead.v2)) h += "<span class='ll'>" + escapeHtml(leadLine2(lead.v2)) + "</span>";
    return h;
  }
  function leadValue(v1, roadLen, v2) { return mrNum(v1) * mrNum(roadLen) / 4 + mrNum(v2); } // exact (cell जो compute करेगा)
  function leadValStr(v1, roadLen, v2) { const n = leadValue(v1, roadLen, v2); return (Math.round(n * 1000) / 1000).toFixed(3); }
  // Quantity cell में lead भरो — cell में expression दिखे, value से Amount बने
  function applyLead(r, v1, roadLen, v2) {
    const sheet = state.sheets[state.activeSheetId]; if (!sheet) return;
    if (isLockedRow(sheet, r) || (sheet.cells[addr(r, 2)] || {}).role) { alert("यह item-पंक्ति नहीं है।"); return; }
    pushUndo("sheet");
    if (sheet.cols < 7) { sheet.cols = 7; ensureLock(sheet); }
    const expr = "=" + mrNum(v1) + "*" + mrNum(roadLen) + "/4+" + mrNum(v2);
    setCell(sheet, r, 4, expr);                     // E = Quantity (formula → number)
    const cell = sheet.cells[addr(r, 4)];
    if (cell) { cell.lead = { v1: String(v1).trim(), roadLen: mrNum(roadLen), v2: String(v2).trim() }; cell.leadText = leadText(v1, roadLen, v2); }
    setCell(sheet, r, 6, amtFormula(r));             // G = ROUND(Qty × Rate, 2)
    persistSheet(sheet); if (hfReady) buildEngine(); maybeSyncToMaster(sheet); renderGrid();
    selectCell(r, 4); scrollToActive();
    status("Lead भरा — Quantity = " + leadValStr(v1, roadLen, v2) + " (cell में expression दिखेगा)");
  }
  // छोटा dialog — Value1, Road Length (estimate से), Value2
  function openLeadDialog() {
    const sheet = state.sheets[state.activeSheetId]; if (!sheet) return;
    const r = state.activeCell.r;
    if (isLockedRow(sheet, r) || (sheet.cells[addr(r, 2)] || {}).role) { alert("Lead किसी item की Quantity पंक्ति पर ही लगेगा।"); return; }
    const existing = (sheet.cells[addr(r, 4)] || {}).lead;
    const est = state.estimates[state.activeEstimateId];
    const defLen = existing ? existing.roadLen : (est && est.length != null && est.length !== "" ? mrNum(est.length) : "");
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML =
      "<div class='modal'>" +
      "<h3>🧮 Lead जोड़ें — Quantity (पंक्ति " + (r + 1) + ")</h3>" +
      "<p class='sub'>Quantity = <b>Value1 × Road Length/4 + Value2</b>। cell में यही expression दिखेगा; Amount = Quantity × Rate।</p>" +
      "<label class='ns-fld'>Value 1<input id='ldV1' type='text' placeholder='जैसे: 4.856' autocomplete='off' value='" + escapeHtml(existing ? existing.v1 : "") + "' /></label>" +
      "<label class='ns-fld'>Road Length (km) <span class='muted'>— Estimate से</span><input id='ldLen' type='text' placeholder='जैसे: 13.20' autocomplete='off' value='" + escapeHtml(defLen === "" ? "" : String(defLen)) + "' /></label>" +
      "<label class='ns-fld'>Value 2<input id='ldV2' type='text' placeholder='जैसे: 2.654' autocomplete='off' value='" + escapeHtml(existing ? existing.v2 : "") + "' /></label>" +
      "<div class='lead-prev' id='ldPrev'></div>" +
      "<div class='row'><button class='btn' id='ldCancel'>रद्द</button><button class='btn primary' id='ldOk'>भरें</button></div>" +
      "</div>";
    document.body.appendChild(overlay);
    const v1El = overlay.querySelector("#ldV1"), lenEl = overlay.querySelector("#ldLen"), v2El = overlay.querySelector("#ldV2"), prev = overlay.querySelector("#ldPrev");
    const refresh = () => { prev.innerHTML = "दिखेगा:  <b>" + escapeHtml(leadText(v1El.value, lenEl.value, v2El.value)) + "</b><br>Quantity = <b>" + leadValStr(v1El.value, lenEl.value, v2El.value) + "</b>"; };
    [v1El, lenEl, v2El].forEach((el) => el.addEventListener("input", refresh));
    refresh();
    const close = () => overlay.remove();
    const submit = () => { close(); applyLead(r, v1El.value, lenEl.value, v2El.value); };
    overlay.querySelector("#ldCancel").addEventListener("click", close);
    overlay.querySelector("#ldOk").addEventListener("click", submit);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } else if (e.key === "Enter") { e.preventDefault(); submit(); } });
    v1El.focus();
  }
  // active पंक्ति जिस subhead में है उसका नाम (structured या legacy दोनों)
  function sectionNameForRow(sheet, r) {
    const info = analysisScan(sheet);
    for (const sec of info.sections) { if (r >= sec.head && r <= (sec.tot >= 0 ? sec.tot : sec.itemEnd)) return (sheet.cells[addr(sec.head, 2)] || {}).secName || sec.name || ""; }
    // legacy: ऊपर की ओर section-bar खोजो
    for (let rr = r; rr >= 0; rr--) {
      const cell = sheet.cells[addr(rr, 2)];
      if (!cell) continue;
      const v = String(cell.v || "");
      if (cell.role === "sec") return cell.secName || v;
      if (/^[a-z]\)\s/i.test(v)) return v.replace(/^[a-z]\)\s*/i, "");
    }
    return "";
  }
  // subhead-नाम + source से picker की default category
  function pickerCatForRow(sheet, r) {
    const nm = sectionNameForRow(sheet, r).toLowerCase();
    if (/labour|श्रम|मजदूर/.test(nm)) return "labour";
    if (/machin|मशीन|यंत्र/.test(nm)) return (sheet.source === "mord") ? "machine_mord" : "machine";
    if (/material|माल|सामग्री/.test(nm)) return "material_query";
    return null;
  }
  function openMasterPicker() {
    const sheet = state.sheets[state.activeSheetId]; if (!sheet) return;
    const r = state.activeCell.r;
    const isRoyalty = (state.activeCell.c === 5) && inRoyaltySection(sheet, r);   // Royality section की F-cell → royalty भरो
    const mode = (state.activeCell.c === 5) ? "rate" : "both";   // Rate कॉलम → checkbox (single/औसत)
    const fieldNm = isRoyalty ? "royalty" : "rate";
    const valFn = (cat, row) => isRoyalty ? masterItemRoyalty(cat, row) : masterItemRate(cat, row);   // दिखाने/भरने का मान
    // इस cell में पहले से link हो तो उसी category + चुने items दिखाओ
    const rcell = sheet.cells[addr(r, 5)];
    const existing = (rcell && rcell.mref && rcell.mref.field === fieldNm) ? rcell.mref : null;
    const autoCat = existing ? existing.cat : (isRoyalty ? "material_query" : pickerCatForRow(sheet, r));   // section अनुसार category
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const subTxt = isRoyalty
      ? "Material चुनें (एक या कई) — उसकी <b>Royality दर</b> भरेगी (नाम+royalty दिखते हैं)। कई चुनने पर <b>औसत royalty</b>। Primary/RMR से linked रहेगी।"
      : mode === "rate"
      ? ("loaded version से item चुनें (एक या कई) — <b>केवल रेट</b> भरेगा (नाम अपरिवर्तित)। कई चुनने पर उनका <b>औसत रेट</b>। रेट Primary Rate से linked रहेगा।" +
         (existing ? "<br>✓ <b>पहले से चुने items (checked) का ही औसत इस cell में है</b> — बदलकर फिर भरें।" : ""))
      : "loaded version से item चुनें — <b>नाम+Unit+Rate</b> भर जाएँगे, Amount=मात्रा×Rate; आप मात्रा भरें।";
    const footer = mode === "rate"
      ? "<div class='pk-foot'><span id='pkSelInfo' class='pk-selinfo'>कोई item नहीं चुना</span><button class='btn' id='pkClose'>बंद</button><button class='btn primary' id='pkFill' disabled>✓ भरें</button></div>"
      : "<div class='row'><button class='btn' id='pkClose'>बंद करें</button></div>";
    overlay.innerHTML =
      "<div class='modal wide'>" +
      "<h3>🔍 Master से " + (isRoyalty ? "Royality" : (mode === "rate" ? "रेट" : "जोड़ें")) + " — पंक्ति " + (r + 1) + " में</h3>" +
      "<p class='sub'>" + subTxt + "</p>" +
      "<div class='picker-bar'><select id='pkCat'>" + PICKER_CATS.map((c) => "<option value='" + c[0] + "'" + (c[0] === autoCat ? " selected" : "") + ">" + c[1] + "</option>").join("") + "</select>" +
      "<input id='pkSearch' type='search' placeholder='नाम से खोजें…' /></div>" +
      "<div id='pkList' class='picker-list'></div>" + footer + "</div>";
    document.body.appendChild(overlay);
    const catEl = overlay.querySelector("#pkCat"), srEl = overlay.querySelector("#pkSearch"), listEl = overlay.querySelector("#pkList");
    // rate mode: चुने rowIds — पहले से link हो तो वही pre-select (कौन-कौन का औसत लिया, दिखे)
    const selected = new Set(existing ? (Array.isArray(existing.rowIds) ? existing.rowIds : [existing.rowId]) : []);
    const selectedRows = () => { const rows = loadedVersionRows(catEl.value) || []; return rows.filter((x) => selected.has(x.id)); };
    const updateFooter = () => {
      if (mode !== "rate") return;
      const info = overlay.querySelector("#pkSelInfo"), fill = overlay.querySelector("#pkFill");
      const rows = selectedRows();
      if (!rows.length) { info.textContent = "कोई item नहीं चुना"; fill.disabled = true; return; }
      const rates = rows.map((x) => mrNum(valFn(catEl.value, x)));
      const avg = round2(rates.reduce((a, b) => a + b, 0) / rates.length);
      const lbl = isRoyalty ? "Royalty" : "रेट";
      info.innerHTML = rows.length === 1 ? ("1 चुना · " + lbl + " <b>₹" + nf(round2(rates[0])) + "</b>") : (rows.length + " चुने · औसत " + lbl + " <b>₹" + nf(avg) + "</b>");
      fill.disabled = false;
    };
    const renderList = () => {
      const cat = catEl.value, rows = loadedVersionRows(cat);
      if (!rows || !rows.length) { listEl.innerHTML = "<div class='pk-empty'>इस श्रेणी का कोई version Load नहीं — Master Data में जाकर Load करें।</div>"; updateFooter(); return; }
      const q = srEl.value.trim().toLowerCase();
      const matches = rows.filter((row) => !q || masterItemName(cat, row).toLowerCase().includes(q));
      if (!matches.length) { listEl.innerHTML = "<div class='pk-empty'>कोई मेल नहीं।</div>"; return; }
      if (mode === "rate") {
        listEl.innerHTML = matches.slice(0, 300).map((row) =>
          "<label class='pk-item pk-check'><input type='checkbox' data-id='" + row.id + "'" + (selected.has(row.id) ? " checked" : "") + " /><span class='pk-nm'>" + escapeHtml(masterItemName(cat, row)) +
          "</span><span class='pk-meta'>" + (isRoyalty ? "" : escapeHtml(row.unit || "") + " · ") + "₹" + nf(round2(valFn(cat, row))) + (isRoyalty ? " royalty" : "") + "</span></label>").join("");
        listEl.querySelectorAll("input[type=checkbox]").forEach((chk) => chk.addEventListener("change", () => { if (chk.checked) selected.add(chk.dataset.id); else selected.delete(chk.dataset.id); updateFooter(); }));
        updateFooter();
      } else {
        listEl.innerHTML = matches.slice(0, 300).map((row) =>
          "<button class='pk-item' data-id='" + row.id + "'><span class='pk-nm'>" + escapeHtml(masterItemName(cat, row)) +
          "</span><span class='pk-meta'>" + escapeHtml(row.unit || "") + " · ₹" + nf(round2(masterItemRate(cat, row))) + "</span></button>").join("");
        listEl.querySelectorAll(".pk-item").forEach((b) => b.addEventListener("click", () => {
          const row = rows.find((x) => x.id === b.dataset.id); if (row) insertMasterItem(cat, row, mode);
          overlay.remove();
        }));
      }
    };
    catEl.addEventListener("change", () => { selected.clear(); renderList(); });
    srEl.addEventListener("input", renderList);
    if (mode === "rate") {
      overlay.querySelector("#pkFill").addEventListener("click", () => {
        const rows = selectedRows(); if (!rows.length) return;
        const cat = catEl.value;
        if (isRoyalty) fillRoyaltyLink(cat, rows);
        else if (rows.length === 1) insertMasterItem(cat, rows[0], "rate"); else insertMasterItemAvg(cat, rows);
        overlay.remove();
      });
    }
    overlay.querySelector("#pkClose").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") overlay.remove(); });
    srEl.focus();
    renderList();
  }

  /* ============== APP SHELL: navigation + estimate projects ============== */
  const VIEW_LABELS = {
    "load": "Estimate Home", "basic-sheet": "Basic Sheet", "basic-analysis": "Basic Analysis",
    "rate-analysis": "Rate Analysis", "dom-boq": "DOM & BOQ", "summary": "Summary",
    "master": "Master Data", "master-cat": "Master Data", "master-edit": "Master Data › Analysis Edit",
    "rmr": "Basic Analysis › RMR", "bitumen": "Basic Analysis › Bitumen", "dom": "DOM & BOQ › DOM", "boq": "DOM & BOQ › BOQ",
    "cover": "Basic Sheet › Cover Page", "checklist": "Basic Sheet › Checklist", "index": "Basic Sheet › Index", "report": "Basic Sheet › Report", "reference": "Basic Sheet › Reference"
  };
  const VIEW_PARENT = { "master-cat": "master", "master-edit": "master", "rmr": "basic-analysis", "bitumen": "basic-analysis", "dom": "dom-boq", "boq": "dom-boq", "cover": "basic-sheet", "checklist": "basic-sheet", "index": "basic-sheet", "report": "basic-sheet", "reference": "basic-sheet" }; // sub-page → कौन-सा nav highlight हो
  function setActiveView(name) {
    // editor-panel को सही जगह mount करो (Rate Analysis / Master edit / DOM)
    if (name === "rate-analysis") mountEditor("rate");
    else if (name === "master-edit") mountEditor("master");
    else if (name === "dom") mountEditor("dom");
    else if (name === "boq") mountEditor("boq");
    else if (name === "summary") mountEditor("summary");
    else if (name === "bitumen") mountEditor("bitumen");
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + name));
    const navName = VIEW_PARENT[name] || name;
    document.querySelectorAll(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.view === navName));
    const sec = document.getElementById("tbSection");
    if (sec) sec.textContent = VIEW_LABELS[name] || name;
    // Master Data (library) पर estimate का नाम नहीं दिखाना — वह estimate-निरपेक्ष है
    const isMasterView = (name === "master" || name === "master-cat" || name === "master-edit");
    const estEl = document.getElementById("currentEstimateName");
    if (estEl) estEl.style.display = isMasterView ? "none" : "";
    // master tools (calc engine / दर-refresh / Format सुधार / Backup / Restore) सिर्फ़ Master Data में;
    // बाक़ी sections में उनकी जगह "Estimate बंद करें" (जब कोई estimate खुला हो)
    const mTools = document.getElementById("topbarMasterTools");
    if (mTools) mTools.style.display = isMasterView ? "" : "none";
    const closeBtn = document.getElementById("btnCloseEstimate");
    if (closeBtn) closeBtn.style.display = (!isMasterView && state.activeEstimateId) ? "" : "none";
    if (name === "load") renderEstimateProjectList();
    if (name === "dom-boq") renderSubEstimates();
    if (name === "rate-analysis") {   // active estimate के समूह-वार सूची ताज़ा
      const as = state.sheets[state.activeSheetId];
      if (as && (as.kind === "dom" || as.kind === "boq" || as.kind === "summary" || as.kind === "bitumen")) { state.activeSheetId = null; renderGrid(); }   // DOM/BOQ/Summary/Bitumen शीट rate-editor में न दिखे
      renderSheetList();
    }
    if (name === "master") {
      renderMasterOverview();   // Primary Rate कार्ड + loaded date — तुरंत (हल्का)
      // ~1000 items की भारी Analysis library अगले frame में — पहले Primary Rate paint हो जाए
      requestAnimationFrame(function () {
        var mv = document.getElementById("view-master");
        if (mv && mv.classList.contains("active")) renderMasterAnalysis();
      });
    }
    if (name === "master-cat") renderCat();
    if (name === "master-edit") renderMasterEdit();
    if (name === "rmr") renderRMR();
    if (name === "bitumen") renderBitumen();
    if (name === "dom") renderDOM();
    if (name === "boq") renderBOQ();
    if (name === "cover") renderCover();
    if (name === "checklist") renderChecklist();
    if (name === "index") renderIndex();
    if (name === "report") renderReport();
    if (name === "reference") renderReference();
    if (name === "rate-analysis") reRateAllAnalyses();   // RMR/Primary बदलने के बाद खोलने पर दरें ताज़ा
    if (name === "summary") { try { reRateAllAnalyses(); } catch (e) { } renderSummary(); }   // Summary — ताज़ा दरें + गणना
  }
  // Master Data कार्डों पर "अभी कौन-सी date का rate effective है" दिखाओ
  function renderMasterOverview() {
    document.querySelectorAll("[data-badge]").forEach((el) => {
      const m = state.master[el.dataset.badge];
      if (m && m.loadedVersion) { el.textContent = "✓ Effective: " + m.loadedVersion; el.className = "card-badge loaded"; }
      else { el.textContent = "कोई version load नहीं"; el.className = "card-badge none"; }
    });
  }

  /* ============== ANALYSIS SECTION — MoRTH / MoRD master analysis library ==============
     हर master analysis किसी source ("morth"/"mord") व chapter (group) में रहती है।
     MoRTH में हर item (itemKey) के Large/Medium/Small project के अलग variant होते हैं।
     kind:"master" = library की मूल शीट; kind:"working" = Rate Analysis की copy (masterId से जुड़ी)। */
  const DEFAULT_ANALYSIS_GROUPS = [
    { key: "earthwork",  name: "Site Clearance व Earthwork (मिट्टी कार्य)" },
    { key: "granular",   name: "Granular Sub-base व Base (GSB / WMM / WBM)" },
    { key: "bituminous", name: "Bituminous Works (Prime/Tack, DBM, BC)" },
    { key: "concrete",   name: "Cement Concrete व RCC Works" },
    { key: "drainage",   name: "Drainage व Protection Works" },
    { key: "structures", name: "Structures (Culverts / Bridges)" },
    { key: "furniture",  name: "Road Furniture, Signage व Marking" },
    { key: "misc",       name: "Miscellaneous (विविध)" },
  ];
  // Chapter सूची — MoRTH व MoRD की बिल्कुल अलग-अलग (localStorage में अलग save); नाम अनुसार sorted
  const CHAPTERS = { morth: null, mord: null };
  (function initChapters() {
    let legacy = null;
    try { const j = JSON.parse(localStorage.getItem("re_chapters")); if (Array.isArray(j) && j.length && j.every((x) => x && x.key && x.name)) legacy = j; } catch (e) {}
    for (const src of ["morth", "mord"]) {
      let list = null;
      try { const j = JSON.parse(localStorage.getItem("re_chapters_" + src)); if (Array.isArray(j) && j.length && j.every((x) => x && x.key && x.name)) list = j; } catch (e) {}
      if (!list) list = (legacy || DEFAULT_ANALYSIS_GROUPS).map((x) => ({ key: x.key, name: x.name }));
      CHAPTERS[src] = list;
    }
  })();
  function chaptersOf(src) { return CHAPTERS[(src === "mord") ? "mord" : "morth"]; }
  function sortChapters(src) { chaptersOf(src).sort((a, b) => (a.name || "").localeCompare(b.name || "", undefined, { numeric: true, sensitivity: "base" })); }
  // Chapters अब cloud (master store) में भी — ताकि हर browser/device पर एक ही दिखें
  const CHAPTERS_META_ID = "__meta_chapters__";
  function chaptersRecord() { return { id: CHAPTERS_META_ID, _meta: "chapters", morth: CHAPTERS.morth || [], mord: CHAPTERS.mord || [] }; }
  function persistChaptersCloud() { try { db.put("master", chaptersRecord()); } catch (e) {} }

  // ── Analysis सेट (template) — कई Analysis एक साथ किसी भी estimate के समूह में लोड करने के लिए ──
  const SETS_META_ID = "__analysis_sets__";
  let analysisSets = [];   // [{id, name, items:[masterId,...]}]
  function saveAnalysisSetsCloud() { try { db.put("master", { id: SETS_META_ID, _meta: "sets", sets: analysisSets }); } catch (e) {} }
  // Summary templates (काम-प्रकार अनुसार) — user-saved (built-in अलग)
  const SUMTPL_META_ID = "__summary_templates__";
  let summaryTemplates = [];
  function saveSummaryTemplatesCloud() { try { db.put("master", { id: SUMTPL_META_ID, _meta: "sumtpl", templates: summaryTemplates }); } catch (e) {} }
  // विभागीय अधिकारी — नाम एक बार भरे जाएँ, Master में सुरक्षित; अगली बार sorted drop-down
  const OFFICERS_META_ID = "__dept_officers__";
  // विभागीय अधिकारी — कार्यालय (खंड/वृत्त नाम) + पद के अनुसार नाम सुरक्षित
  //  मॉडल: { offices:{ [officeName]:{ ee:[], ae:[], je:[], jePra:[], se:[] } }, legacy:{ je,ae,ee,se } }
  let deptOfficers = { offices: {}, legacy: {} };
  function ensureOfficersStore() {
    if (!deptOfficers || typeof deptOfficers !== "object") deptOfficers = {};
    if (!deptOfficers.offices) {   // पुराना flat {je,ae,ee,se} → legacy में
      const legacy = {};
      ["je", "ae", "ee", "se"].forEach((k) => { if (Array.isArray(deptOfficers[k])) legacy[k] = deptOfficers[k]; });
      deptOfficers = { offices: {}, legacy: legacy };
    }
    if (!deptOfficers.offices) deptOfficers.offices = {};
    if (!deptOfficers.legacy) deptOfficers.legacy = {};
    return deptOfficers;
  }
  function saveDeptOfficersCloud() { try { db.put("master", { id: OFFICERS_META_ID, _meta: "officers", officers: deptOfficers }); } catch (e) {} }
  // किसी कार्यालय+पद के लिए नाम-सूची (पुराने legacy नाम भी सुझाव में)
  function officerNames(office, desig) {
    ensureOfficersStore();
    const set = new Set();
    const o = deptOfficers.offices[String(office || "").trim()];
    if (o && Array.isArray(o[desig])) o[desig].forEach((n) => set.add(n));
    if (Array.isArray(deptOfficers.legacy[desig])) deptOfficers.legacy[desig].forEach((n) => set.add(n));
    return Array.from(set).filter(Boolean).sort((a, b) => a.localeCompare(b, "hi"));
  }
  function addOfficer(office, desig, name) {
    name = String(name || "").trim(); office = String(office || "").trim();
    if (!name || !office) return;
    ensureOfficersStore();
    const o = deptOfficers.offices[office] || (deptOfficers.offices[office] = {});
    if (!Array.isArray(o[desig])) o[desig] = [];
    if (!o[desig].some((x) => x.toLowerCase() === name.toLowerCase())) {
      o[desig].push(name); o[desig].sort((a, b) => a.localeCompare(b, "hi")); saveDeptOfficersCloud();
    }
  }
  // किसी समूह की सभी loaded Analysis को एक सेट के रूप में सहेजो
  function saveGroupAsSet(g) {
    const items = [];
    for (const id of state.order) {
      const s = state.sheets[id];
      if (s.kind === "working" && (s.rmrId || "") === (g.rmrId || "") && (s.ohGroupId || "") === (g.ohGroupId || "") && s.masterId) items.push(s.masterId);
    }
    if (!items.length) { alert("इस समूह में अभी कोई Analysis नहीं — पहले '+ Analysis' से लोड करें।"); return; }
    const name = prompt("इस सेट का नाम (भविष्य में किसी और Estimate के समूह में एक साथ लोड करने के लिए):", g.name || "");
    if (name === null) return;
    const nm = name.trim(); if (!nm) return;
    const ex = analysisSets.find((x) => x.name.toLowerCase() === nm.toLowerCase());
    if (ex) { if (!confirm("'" + nm + "' नाम का सेट पहले से है — बदल दें?")) return; ex.items = items; }
    else analysisSets.push({ id: uid("set"), name: nm, items: items });
    saveAnalysisSetsCloud();
    status("सेट सहेजा: " + nm + " (" + items.length + " Analysis)");
  }
  // सेट को अभी चुने कार्य-समूह (_loadWgId) में एक साथ लोड करो
  function loadSetIntoCurrentGroup(setId) {
    const set = analysisSets.find((x) => x.id === setId); if (!set) return;
    resolveLoadWg();
    _openWgId = _loadWgId;   // लोड हुआ समूह खुला दिखे
    let n = 0, miss = 0;
    for (const mid of set.items) { if (state.sheets[mid]) { loadAnalysisToWorkspace(mid); n++; } else miss++; }
    renderSheetList();
    status("सेट '" + set.name + "' से " + n + " Analysis लोड" + (miss ? (" · " + miss + " master अब नहीं मिले") : ""));
  }
  function deleteAnalysisSet(setId) {
    const i = analysisSets.findIndex((x) => x.id === setId); if (i < 0) return;
    const nm = analysisSets[i].name;
    if (!confirm("सेट '" + nm + "' हटाएँ? (Analysis पर असर नहीं)")) return;
    analysisSets.splice(i, 1); saveAnalysisSetsCloud(); status("सेट हटाया: " + nm);
  }
  function applyChaptersRecord(rec) {
    if (!rec) return false;
    let any = false;
    for (const src of ["morth", "mord"]) {
      const list = rec[src];
      if (Array.isArray(list) && list.length && list.every((x) => x && x.key && x.name)) { CHAPTERS[src] = list.map((x) => ({ key: x.key, name: x.name })); any = true; }
    }
    if (any) { sortChapters("morth"); sortChapters("mord"); try { localStorage.setItem("re_chapters_morth", JSON.stringify(CHAPTERS.morth)); localStorage.setItem("re_chapters_mord", JSON.stringify(CHAPTERS.mord)); } catch (e) {} }
    return any;
  }
  function saveChapters(src) { src = (src === "mord") ? "mord" : "morth"; sortChapters(src); try { localStorage.setItem("re_chapters_" + src, JSON.stringify(CHAPTERS[src])); } catch (e) {} persistChaptersCloud(); }
  sortChapters("morth"); sortChapters("mord");
  function defaultChapterKey(src) { const list = chaptersOf(src); return list.some((g) => g.key === "misc") ? "misc" : (list.length ? list[list.length - 1].key : "misc"); }
  // शीट का chapter-key — उसके source की सूची में न हो (हटाया गया) तो उसी source के default chapter में दिखाओ
  function chapterKeyOf(s) { const src = (s.source === "mord") ? "mord" : "morth"; const list = chaptersOf(src); const k = s.group || defaultChapterKey(src); return list.some((g) => g.key === k) ? k : defaultChapterKey(src); }
  function groupName(src, key) { const list = chaptersOf(src); const g = list.find((x) => x.key === key); return g ? g.name : (list.length ? list[list.length - 1].name : "—"); }
  function chapterAnalysisCount(src, key) { return sourceMasters(src).filter((s) => chapterKeyOf(s) === key).length; }
  function uniqueChapterKey(src, nm) {
    const list = chaptersOf(src);
    const base = "ch_" + ((nm || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 16) || "x");
    let k = base, i = 1; while (list.some((g) => g.key === k)) k = base + "_" + (i++);
    return k;
  }
  function addChapter(src) {
    src = (src === "mord") ? "mord" : "morth";
    const lbl = src === "mord" ? "MoRD" : "MoRTH";
    askText({ title: "नया Chapter (" + lbl + ")", sub: "यह Chapter सिर्फ़ " + lbl + " में जुड़ेगा।", label: "Chapter का नाम", placeholder: "जैसे: Retaining Walls", ok: "बनाएँ" }).then((nm) => {
      if (nm === null) return;
      chaptersOf(src).push({ key: uniqueChapterKey(src, nm), name: nm }); saveChapters(src);
      renderMasterAnalysis(); status("नया " + lbl + " Chapter बना: " + nm);
    });
  }
  function renameChapter(src, key) {
    const g = chaptersOf(src).find((x) => x.key === key); if (!g) return;
    askText({ title: "Chapter का नाम बदलें", label: "नया नाम", value: g.name, ok: "बदलें" }).then((nm) => {
      if (nm === null || nm === g.name) return;
      g.name = nm; saveChapters(src); renderMasterAnalysis(); status("Chapter का नाम बदला: " + nm);
    });
  }
  function deleteChapter(src, key) {
    const list = chaptersOf(src); const g = list.find((x) => x.key === key); if (!g) return;
    const n = chapterAnalysisCount(src, key);
    if (n > 0) { alert("इस Chapter (" + g.name + ") में " + n + " Analysis पड़ा हुआ है — पहले उन्हें हटाएँ या दूसरे Chapter में भेजें, फिर Chapter हटाएँ।"); return; }
    if (list.length <= 1) { alert("कम-से-कम एक Chapter ज़रूरी है।"); return; }
    if (!confirm("Chapter हटाएँ: " + g.name + " ?\n(इसमें कोई Analysis नहीं है)")) return;
    CHAPTERS[src] = list.filter((x) => x.key !== key); saveChapters(src);
    renderMasterAnalysis(); status("Chapter हटाया: " + g.name);
  }
  const SIZES = [{ key: "large", name: "Large" }, { key: "medium", name: "Medium" }, { key: "small", name: "Small" }];
  function isSize(k) { return k === "large" || k === "medium" || k === "small"; }
  function sizeName(k) { const s = SIZES.find((x) => x.key === k); return s ? s.name : k; }

  function ensureSheetMeta(s) {
    if (typeof s.kind !== "string") s.kind = "master";
    if (s.source !== "morth" && s.source !== "mord") s.source = "morth";   // पुराने → MoRTH
    if (typeof s.group !== "string") s.group = defaultChapterKey(s.source);
    if (typeof s.serial !== "string") s.serial = "";                       // MoRTH क्रम संख्या (sort key)
    if (s.source === "morth") {
      if (!isSize(s.size)) s.size = "small";                               // पुराने → Small मानकर
      if (typeof s.itemKey !== "string" || !s.itemKey) s.itemKey = uid("item");
      if (typeof s.itemName !== "string" || !s.itemName) s.itemName = (s.title || s.name);
    }
  }
  function isMasterSheet(s) { return !!s && s.kind !== "working"; }
  function isWorkingCopy(s) { return !!(s && s.kind === "working" && s.masterId && state.sheets[s.masterId]); }
  function masterSheets() { return state.order.map((id) => state.sheets[id]).filter(isMasterSheet); }
  function sourceMasters(src) { return masterSheets().filter((s) => (s.source || "morth") === src); }
  function morthVariant(itemKey, size) { return masterSheets().find((s) => (s.source || "morth") === "morth" && s.itemKey === itemKey && s.size === size); }
  function morthAnyVariant(itemKey) { for (const sz of ["large", "medium", "small"]) { const v = morthVariant(itemKey, sz); if (v) return v; } return null; }

  /* ---- global project size (Large/Medium/Small) — MoRTH के सभी loaded analysis पर लागू ---- */
  let projectSize = (function () { const v = localStorage.getItem("re_projectSize"); return isSize(v) ? v : "large"; })();
  function updateProjectSizeUI() {
    document.querySelectorAll("#projSizeBar .psb-btn").forEach((b) => b.classList.toggle("active", b.dataset.size === projectSize));
  }
  // किसी master variant की content को loaded copy में बिठाओ (copy की पहचान/नाम वही रहे)
  function swapCopyToVariant(copy, variant) {
    const dimsDiffer = copy.rows !== variant.rows || copy.cols !== variant.cols;
    copy.cells = JSON.parse(JSON.stringify(variant.cells));
    copy.merges = JSON.parse(JSON.stringify(variant.merges || []));
    copy.rows = variant.rows; copy.cols = variant.cols;
    copy.colWidths = (variant.colWidths || []).slice();
    copy.title = variant.title; copy.lockTop = variant.lockTop; copy.lockBottom = variant.lockBottom;
    copy.masterId = variant.id; copy.size = variant.size; copy.itemKey = variant.itemKey; copy.itemName = variant.itemName;
    copy.syncPref = null; copy.updatedAt = Date.now();
    if (copy.rmrId) { repointMaterialToRmr(copy, copy.rmrId); if (copy.rmrName) copy.title = (copy.title ? copy.title + "  " : "") + "[RMR: " + copy.rmrName + "]"; } // size बदलने पर RMR link बना रहे
    if (hfReady) { try { hf.setSheetContent(hfSheetId(copy.name), sheetMatrix(copy)); if (dimsDiffer) buildEngine(); } catch (e) { buildEngine(); } }
    db.put("sheets", copy);
  }
  function setProjectSize(sz) {
    if (!isSize(sz)) return;
    projectSize = sz; localStorage.setItem("re_projectSize", sz); updateProjectSizeUI();
    let changed = 0;
    for (const id of state.order.slice()) {
      const c = state.sheets[id];
      if (!c || c.kind !== "working" || (c.source || "morth") !== "morth") continue;
      if (c.size === sz) continue;
      const variant = morthVariant(c.itemKey, sz);
      if (!variant) continue;                  // उस size का master variant नहीं → वैसा ही रहने दो
      swapCopyToVariant(c, variant); changed++;
    }
    if (changed) { renderSheetList(); if (state.activeSheetId) renderGrid(); updateKindBanner(); refreshEstimateSheetPicker(); }
    status("Project size: " + sizeName(sz) + (changed ? " · " + changed + " loaded MoRTH analysis बदले" : ""));
  }

  let morthSearchQ = "", mordSearchQ = "";
  // नाम-अनुसार तुलना (Hindi/English, numeric-aware)
  function cmpText(a, b) { return String(a || "").localeCompare(String(b || ""), undefined, { numeric: true, sensitivity: "base" }); }
  // MoRTH क्रम संख्या के अनुसार तुलना — serial वाले पहले (numeric), फिर नाम से
  function cmpSerial(sa, sb, na, nb) {
    sa = String(sa || "").trim(); sb = String(sb || "").trim();
    if (sa && sb) { const c = cmpText(sa, sb); return c !== 0 ? c : cmpText(na, nb); }
    if (sa && !sb) return -1;
    if (!sa && sb) return 1;
    return cmpText(na, nb);
  }
  // कौन-से chapter खुले हैं (default: सभी बंद/collapsed) — MoRTH व MoRD अलग-अलग
  const morthOpen = new Set(), mordOpen = new Set();
  // एक समय में केवल एक ही chapter खुला रहे — नया खोलने पर बाकी अपने आप collapse
  function toggleChapterOpen(setObj, key, reRender) {
    const wasOpen = setObj.has(key);
    setObj.clear();
    if (!wasOpen) setObj.add(key);   // बंद था तो सिर्फ़ यही खोलो; खुला था तो सब बंद
    reRender();
  }
  function renderMasterAnalysis() { renderMorthAnalysis(); renderMordAnalysis(); updateProjectSizeUI(); }
  // Master Data का कोई tab (primary/morth/mord) सक्रिय करो
  function activateMasterTab(which) {
    which = which || "primary";
    document.querySelectorAll("#masterTabs .mtab").forEach((x) => x.classList.toggle("active", x.dataset.mtab === which));
    document.querySelectorAll("#view-master .mtab-panel").forEach((p) => p.classList.toggle("active", p.id === "mtab-" + which));
    if (which === "morth") renderMorthAnalysis();
    else if (which === "mord") renderMordAnalysis();
  }

  // chapter का header — collapsible toggle (caret + नाम + count badge) + rename/delete बटन
  function chapterHeadHtml(g, count, open) {
    return "<div class='ag-head" + (open ? " open" : "") + "'>" +
      "<button class='ag-toggle' data-chaptoggle='" + g.key + "' title='" + (open ? "बंद करें" : "खोलें") + "'>" +
        "<span class='ag-caret'>▸</span>" +
        "<span class='ag-name'>" + escapeHtml(g.name) + "</span>" +
        "<span class='ag-count" + (count === 0 ? " zero" : "") + "' title='इस chapter में " + count + " Analysis'>" + count + "</span>" +
      "</button>" +
      "<span class='ag-head-right'>" +
        "<button class='ag-ic-btn' data-chapedit='" + g.key + "' title='Chapter का नाम बदलें'>✎</button>" +
        "<button class='ag-ic-btn danger' data-chapdel='" + g.key + "' title='Chapter हटाएँ (खाली होने पर)'>🗑</button>" +
      "</span></div>";
  }

  // MoRD — chapterwise सूची (हर शीट अपने-आप में)
  function renderMordAnalysis() {
    const box = document.getElementById("mordAnalysisGroups");
    if (!box) return;
    const q = mordSearchQ.trim().toLowerCase();
    const all = sourceMasters("mord").filter((s) => !q || s.name.toLowerCase().includes(q) || (s.title || "").toLowerCase().includes(q));
    let html = "";
    for (const g of chaptersOf("mord")) {
      const inG = all.filter((s) => chapterKeyOf(s) === g.key).sort((a, b) => cmpSerial(a.serial, b.serial, a.name, b.name));
      if (q && inG.length === 0) continue;
      const open = q ? true : mordOpen.has(g.key);   // खोज के समय सब खुले
      html += "<div class='analysis-group'>" + chapterHeadHtml(g, inG.length, open);
      if (open) {
        if (inG.length === 0) html += "<div class='ag-empty muted'>इस chapter में अभी कोई MoRD analysis नहीं</div>";
        else {
          html += "<table class='ag-table'><thead><tr>" +
            "<th class='c-ref'>क्रम व Analysis का नाम</th>" +
            "<th class='c-size'>Analysis</th>" +
            "<th class='c-mod'>अंतिम सुधार</th>" +
            "<th class='c-act'>Action</th></tr></thead><tbody>";
          for (const s of inG) {
            const ck = s.checked ? "<span class='ag-ckmark' title='यह Analysis Checked (जाँची हुई) है'>✓</span> " : "";
            html += "<tr" + (s.checked ? " class='row-checked'" : "") + "><td class='c-ref'><div class='agi-main'><span class='agi-nm'>" + ck + (s.serial ? "<span class='agi-sn'>" + escapeHtml(s.serial) + "</span>" : "") + escapeHtml(s.name) + "</span>" + (s.title ? "<span class='agi-tt'>" + escapeHtml(s.title) + "</span>" : "") + "</div></td>";
            html += "<td class='c-size'><button class='chip has' data-dedit='" + s.id + "' title='यह Analysis खोलकर संपादित करें'>✎ खोलें</button></td>";
            html += "<td class='c-mod'>" + fmtDateTime(s.updatedAt) + "</td>";
            html += "<td class='c-act'><span class='agi-acts'>";
            if (estIsAdmin())   // Check/Uncheck केवल Admin
              html += "<button class='btn xs " + (s.checked ? "ck-on" : "ck-off") + "' data-dcheck='" + s.id + "' title='" + (s.checked ? "Checked है — क्लिक कर हटाएँ" : "Checked (जाँची हुई) मार्क करें") + "'>" + (s.checked ? "✓ Checked" : "✓ Check") + "</button>";
            else if (s.checked)  // non-admin: सिर्फ़ स्थिति दिखे (बटन नहीं)
              html += "<span class='ck-tag' title='Admin द्वारा Checked'>✓ Checked</span>";
            html += "<button class='btn xs primary' data-dload='" + s.id + "'>📂 Load</button>";
            html += "<button class='btn xs' data-dren='" + s.id + "' title='नाम/विवरण/क्रम/Chapter बदलें'>✎ Edit</button>";
            html += "<button class='btn xs' data-dchap='" + s.id + "'>📁 Chapter</button>";
            html += "<button class='btn xs danger' data-ddel='" + s.id + "'>🗑</button>";
            html += "</span></td></tr>";
          }
          html += "</tbody></table>";
        }
      }
      html += "</div>";
    }
    box.innerHTML = html;
  }

  // MoRTH — chapterwise → item (itemKey) → Large/Medium/Small variant
  function renderMorthAnalysis() {
    const box = document.getElementById("morthAnalysisGroups");
    if (!box) return;
    const q = morthSearchQ.trim().toLowerCase();
    const all = sourceMasters("morth").filter((s) => !q || (s.itemName || s.name).toLowerCase().includes(q) || s.name.toLowerCase().includes(q) || (s.title || "").toLowerCase().includes(q));
    let html = "";
    for (const g of chaptersOf("morth")) {
      const inG = all.filter((s) => chapterKeyOf(s) === g.key);
      // item (itemKey) के अनुसार समेटो
      const items = [];
      const byKey = {};
      for (const s of inG) { if (!byKey[s.itemKey]) { byKey[s.itemKey] = { key: s.itemKey, name: s.itemName || s.name, desc: s.title || "", serial: s.serial || "", upd: 0, variants: {} }; items.push(byKey[s.itemKey]); } byKey[s.itemKey].variants[s.size] = s; if (!byKey[s.itemKey].serial && s.serial) byKey[s.itemKey].serial = s.serial; if (!byKey[s.itemKey].desc && s.title) byKey[s.itemKey].desc = s.title; if ((s.updatedAt || 0) > byKey[s.itemKey].upd) byKey[s.itemKey].upd = s.updatedAt || 0; }
      items.sort((a, b) => cmpSerial(a.serial, b.serial, a.name, b.name));
      if (q && items.length === 0) continue;
      const open = q ? true : morthOpen.has(g.key);   // खोज के समय सब खुले
      html += "<div class='analysis-group'>" + chapterHeadHtml(g, items.length, open);
      if (open) {
        if (items.length === 0) html += "<div class='ag-empty muted'>इस chapter में अभी कोई MoRTH item नहीं</div>";
        else {
          html += "<table class='ag-table'><thead><tr>" +
            "<th class='c-ref'>क्रम व Analysis का नाम</th>" +
            "<th class='c-size'>Large / Medium / Small</th>" +
            "<th class='c-mod'>अंतिम सुधार</th>" +
            "<th class='c-act'>Action</th></tr></thead><tbody>";
          for (const it of items) {
            const exVars = SIZES.map((sz) => it.variants[sz.key]).filter(Boolean);
            const allCk = exVars.length && exVars.every((v) => v.checked);
            const nmCk = allCk ? "<span class='ag-ckmark' title='सभी variant Checked (जाँचे हुए) हैं'>✓</span> " : "";
            html += "<tr class='morth-item" + (allCk ? " row-checked" : "") + "'><td class='c-ref'><div class='agi-main'><span class='agi-nm'>" + nmCk + (it.serial ? "<span class='agi-sn'>" + escapeHtml(it.serial) + "</span>" : "") + escapeHtml(it.name) + "</span>";
            if (it.desc && it.desc !== it.name) html += "<span class='agi-tt'>" + escapeHtml(it.desc) + "</span>";
            html += "</div></td>";
            // size variants — हर existing variant के साथ छोटा Check टॉगल
            html += "<td class='c-size'><span class='size-chips'>";
            for (const sz of SIZES) {
              const v = it.variants[sz.key];
              if (v) {
                const vckBtn = estIsAdmin()   // Check/Uncheck केवल Admin
                  ? "<button class='vck' data-mcheck='" + v.id + "' title='" + (v.checked ? sz.name + " Checked है — क्लिक कर हटाएँ" : sz.name + " को Checked मार्क करें") + "'>" + (v.checked ? "✓" : "○") + "</button>"
                  : (v.checked ? "<span class='vck' title='Admin द्वारा Checked'>✓</span>" : "");
                html += "<span class='vwrap" + (v.checked ? " checked" : "") + "'>" +
                  "<button class='chip has' data-medit='" + v.id + "' title='" + sz.name + " variant खोलकर संपादित करें'>✎ " + sz.name + "</button>" +
                  vckBtn +
                  "</span>";
              } else html += "<button class='chip add' data-madd='" + it.key + "' data-size='" + sz.key + "' title='" + sz.name + " variant जोड़ें'>+ " + sz.name + "</button>";
            }
            html += "</span></td>";
            html += "<td class='c-mod'>" + fmtDateTime(it.upd) + "</td>";
            html += "<td class='c-act'><span class='agi-acts'>";
            html += "<button class='btn xs primary' data-mload='" + it.key + "' title='मौजूदा project size (" + sizeName(projectSize) + ") में load करें'>📂 Load</button>";
            html += "<button class='btn xs' data-mren='" + it.key + "' title='नाम/विवरण/क्रम/Chapter बदलें'>✎ Edit</button>";
            html += "<button class='btn xs' data-mchap='" + it.key + "'>📁 Chapter</button>";
            html += "<button class='btn xs danger' data-mdel='" + it.key + "'>🗑</button>";
            html += "</span></td></tr>";
          }
          html += "</tbody></table>";
        }
      }
      html += "</div>";
    }
    box.innerHTML = html;
  }

  // Master analysis को Master Data के अपने editor में खोलो (Rate Analysis से अलग)
  let masterEditReturnTab = "morth";
  function openMasterForEdit(id) {
    const s = state.sheets[id]; if (!s) return;
    masterEditReturnTab = (s.source === "mord") ? "mord" : "morth";
    openSheet(id);
    setActiveView("master-edit");
  }
  function editMasterAnalysis(id) {
    const s = state.sheets[id]; if (!s) return;
    openMasterForEdit(id);
    status("Master Analysis edit (master library): " + (s.itemName || s.name));
  }
  // Master-edit view का header (item · source · size + variant chips)
  function renderMasterEdit() {
    const s = state.sheets[state.activeSheetId];
    const titleEl = document.getElementById("meTitle");
    const chipsEl = document.getElementById("meChips");
    if (!titleEl || !chipsEl) return;
    if (!s) { titleEl.textContent = ""; chipsEl.innerHTML = ""; chipsEl.style.display = "none"; return; }
    const src = (s.source === "mord") ? "MoRD" : "MoRTH";
    const szTxt = ((s.source || "morth") === "morth" && isSize(s.size)) ? " · " + sizeName(s.size) : "";
    titleEl.innerHTML = "<span class='meh-src " + (s.source === "mord" ? "mord" : "morth") + "'>" + src + szTxt + "</span><span class='meh-nm'>" + escapeHtml(s.itemName || s.name) + "</span><span class='meh-chap'>" + escapeHtml(groupName(s.source, s.group)) + "</span>";
    // Size (Large/Medium/Small) chips नहीं दिखाना (आवश्यकता नहीं)
    chipsEl.innerHTML = ""; chipsEl.style.display = "none";
  }

  // chapter (group) बदलो — MoRTH item के लिए सभी variant, MoRD के लिए एक शीट
  function chooseChapter(src, currentKey, cb) {
    const buttons = chaptersOf(src).map((g) => ({ label: (g.key === currentKey ? "● " : "") + g.name, value: g.key, cls: g.key === currentKey ? "primary" : "" }));
    askChoice("कौन-सा chapter (समूह)?", buttons).then((v) => { if (v) cb(v); });
  }
  function changeMordChapter(id) {
    const s = state.sheets[id]; if (!s) return;
    chooseChapter("mord", chapterKeyOf(s), (v) => { s.group = v; persistSheet(s); renderMordAnalysis(); status("Chapter बदला: " + s.name); });
  }
  function changeMorthChapter(itemKey) {
    const vs = masterSheets().filter((s) => (s.source || "morth") === "morth" && s.itemKey === itemKey);
    if (!vs.length) return;
    chooseChapter("morth", chapterKeyOf(vs[0]), (v) => { vs.forEach((s) => { s.group = v; persistSheet(s); }); renderMorthAnalysis(); status("Chapter बदला (सभी size variant)"); });
  }
  function renameMorthItem(itemKey) {
    const vs = masterSheets().filter((s) => (s.source || "morth") === "morth" && s.itemKey === itemKey);
    if (!vs.length) return;
    const raw = prompt("Item का नाम (सभी size variant पर लागू):", vs[0].itemName || vs[0].name);
    if (raw === null) return;
    const nm = raw.trim(); if (!nm) return;
    vs.forEach((s) => { s.itemName = nm; persistSheet(s); });
    renderMorthAnalysis(); status("Item का नाम बदला: " + nm);
  }

  // updatedAt → "DD/MM/YYYY HH:MM"
  function fmtDateTime(ts) {
    if (!ts) return "—";
    const d = new Date(ts); if (isNaN(d.getTime())) return "—";
    const p = (n) => String(n).padStart(2, "0");
    return p(d.getDate()) + "/" + p(d.getMonth() + 1) + "/" + d.getFullYear() + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  // link-safe rename (grid-UI के बिना) — MoRD "Edit" details में नाम बदलने के लिए
  function _renameSheetLinkSafe(id, rawName) {
    const sheet = state.sheets[id]; if (!sheet) return "";
    const oldName = sheet.name;
    const nn = uniqueName(safeName(rawName), id);
    if (nn === oldName) return oldName;
    const re = new RegExp("(^|[^A-Za-z0-9_'!])" + escapeReg(oldName) + "!", "g");
    for (const sid of state.order) {
      const s = state.sheets[sid]; let changed = false;
      for (const a in s.cells) { const c = s.cells[a]; if (c.f) { const nf = c.f.replace(re, (m, p1) => p1 + nn + "!"); if (nf !== c.f) { c.f = nf; changed = true; } } }
      if (changed) persistSheet(s);
    }
    sheet.name = nn; persistSheet(sheet);
    if (hfReady) buildEngine();
    return nn;
  }

  // "✎ Edit" — नया-Analysis जैसा विवरण-form, पर मौजूदा को संपादित करता है
  function openAnalysisEditModal(src, key) {
    const isMorth = src !== "mord";
    let vs, s0;
    if (isMorth) { vs = masterSheets().filter((s) => (s.source || "morth") === "morth" && s.itemKey === key); if (!vs.length) return; s0 = vs[0]; }
    else { s0 = state.sheets[key]; if (!s0) return; }
    const curGroup = chapterKeyOf(s0);
    const groupOpts = chaptersOf(src).map((g) => "<option value='" + g.key + "'" + (g.key === curGroup ? " selected" : "") + ">" + escapeHtml(g.name) + "</option>").join("");
    const nameFld = isMorth
      ? "<label class='ns-fld'>Analysis (आइटम) का नाम<input id='edName' type='text' autocomplete='off' /></label>"
      : "<label class='ns-fld'>शीट का नाम (formula-link)<input id='edName' type='text' autocomplete='off' /></label><div class='ns-preview' id='edPreview'></div>";
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML =
      "<div class='modal'>" +
      "<h3>विवरण संपादित करें — " + (isMorth ? "MoRTH" : "MoRD") + "</h3>" +
      (isMorth ? "<p class='sub'>बदलाव इस item के सभी size variant पर लागू होगा।</p>"
               : "<p class='sub'>शीट के नाम में <b>space नहीं</b> — space की जगह अपने-आप <b>_</b> लगेगा; formula-link सुरक्षित रहेगा।</p>") +
      nameFld +
      "<label class='ns-fld'>विवरण (Description) <span class='muted'>— print में ऊपर बड़ा आएगा</span><input id='edTitle' type='text' autocomplete='off' /></label>" +
      "<label class='ns-fld'>क्रम संख्या <span class='muted'>— chapter में इसी क्रम में sort</span><input id='edSerial' type='text' autocomplete='off' /></label>" +
      "<label class='ns-fld'>Chapter (समूह)<select id='edGroup'>" + groupOpts + "</select></label>" +
      "<div class='row'><button class='btn' id='edCancel'>रद्द</button><button class='btn primary' id='edOk'>सहेजें</button></div>" +
      "</div>";
    document.body.appendChild(overlay);
    const $ = (sel) => overlay.querySelector(sel);
    $("#edName").value = isMorth ? (s0.itemName || s0.name || "") : (s0.name || "");
    $("#edTitle").value = s0.title || "";
    $("#edSerial").value = s0.serial != null ? String(s0.serial) : "";
    const prev = $("#edPreview");
    if (!isMorth && prev) {
      const rp = () => { const v = $("#edName").value.trim(); prev.textContent = v ? "शीट का नाम बनेगा:  " + safeName(v) : ""; };
      $("#edName").addEventListener("input", rp); rp();
    }
    const close = () => overlay.remove();
    const submit = () => {
      const nameVal = $("#edName").value.trim();
      const title = $("#edTitle").value.trim();
      const serial = $("#edSerial").value.trim();
      const group = $("#edGroup").value;
      if (!nameVal) { $("#edName").style.borderColor = "var(--red)"; $("#edName").focus(); return; }
      close();
      if (isMorth) {
        vs.forEach((s) => { s.itemName = nameVal; s.title = title; s.serial = serial; s.group = group; persistSheet(s); });
        renderMorthAnalysis(); status("विवरण सहेजा: " + nameVal);
      } else {
        if (safeName(nameVal) !== s0.name) _renameSheetLinkSafe(s0.id, nameVal);
        s0.title = title; s0.serial = serial; s0.group = group; persistSheet(s0);
        renderMordAnalysis(); status("विवरण सहेजा: " + s0.name);
      }
    };
    $("#edCancel").addEventListener("click", close);
    $("#edOk").addEventListener("click", submit);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } else if (e.key === "Enter") { e.preventDefault(); submit(); } });
    $("#edName").focus();
  }

  // बिना confirm/UI के एक शीट हटाओ (item-delete में बार-बार confirm न पूछे)
  function removeSheetSilently(id) {
    const sheet = state.sheets[id]; if (!sheet) return;
    if (hfReady) { try { hf.removeSheet(hfSheetId(sheet.name)); } catch (e) {} }
    delete state.sheets[id];
    state.order = state.order.filter((x) => x !== id);
    for (const eid of state.estOrder) { const est = state.estimates[eid]; if (est.sheetIds.includes(id)) { est.sheetIds = est.sheetIds.filter((x) => x !== id); db.put("estimates", est); } }
    db.del("sheets", id);
  }
  function deleteMorthItem(itemKey) {
    const vs = masterSheets().filter((s) => (s.source || "morth") === "morth" && s.itemKey === itemKey);
    if (!vs.length) return;
    const deps = vs.flatMap((s) => findDependents(s.id));
    askConfirm({
      icon: "🗑", tone: "danger",
      title: "Item स्थायी रूप से हटाएँ?",
      chip: vs[0].itemName || vs[0].name,
      body: "इसके सभी size variant (<b>" + vs.map((s) => sizeName(s.size)).join(", ") + "</b>) Master library से हट जाएँगे।",
      note: deps.length
        ? "⚠ नीचे दी शीट इनसे link हैं — हटाने पर उनके link <b>#REF!</b> (error) हो सकते हैं।"
        : "✓ इनसे कोई शीट link नहीं है — हटाना सुरक्षित है।",
      noteTone: deps.length ? "warn" : "safe",
      list: deps,
      ok: "हटाएँ",
    }).then((yes) => {
      if (!yes) return;
      vs.forEach((s) => removeSheetSilently(s.id));
      state.activeSheetId = state.order.find((x) => state.sheets[x] && state.sheets[x].kind === "working") || null;
      renderSheetList(); if (state.activeSheetId) renderGrid(); else clearGrid(); updateKindBanner();
      refreshEstimateSheetPicker(); renderEstimate(); renderMorthAnalysis();
      status("Item हटाया गया");
    });
  }
  // MoRD शीट (single) हटाओ
  function deleteMordSheet(id) {
    const s = state.sheets[id]; if (!s) return;
    state.activeSheetId = id;
    deleteActiveSheet().then(() => renderMordAnalysis());
  }
  function renameMordSheet(id) { renameSheetById(id); renderMordAnalysis(); }

  // किसी MoRTH item में नया size variant जोड़ो (किसी मौजूदा variant की content से)
  function addMorthVariant(itemKey, size) {
    if (!isSize(size)) return;
    if (morthVariant(itemKey, size)) { editMasterAnalysis(morthVariant(itemKey, size).id); return; }
    const tpl = morthAnyVariant(itemKey);
    // कोई और size का Analysis ही नहीं → सीधे नया (कुछ पूछने को नहीं)
    if (!tpl) {
      const nm = "Item";
      createSheet(uniqueName(safeName(nm + "_" + size)), nm, { kind: "master", source: "morth", size: size, itemKey: itemKey, itemName: nm, group: defaultChapterKey("morth") });
      return;
    }
    // दूसरे size का Analysis मौजूद है → auto-copy मत करो, पहले पूछो
    const itemName = tpl.itemName || tpl.name;
    askChoice(
      "“" + itemName + "” के लिये " + sizeName(size) + " का Analysis अभी नहीं बना है।\nआप क्या करना चाहते हैं?",
      [
        { label: "📋 दूसरे size से कॉपी करके एडिट करें", value: "copy", cls: "primary" },
        { label: "🆕 नया (खाली) Analysis बनाएँ", value: "new" },
        { label: "रद्द करें", value: "cancel" },
      ]
    ).then((choice) => {
      if (!choice || choice === "cancel") return;
      if (choice === "new") {
        createSheet(uniqueName(safeName(itemName + "_" + size)), itemName, { kind: "master", source: "morth", size: size, itemKey: itemKey, itemName: itemName, group: chapterKeyOf(tpl) });
        return;
      }
      // copy → दूसरे size की पूरी शीट कॉपी करके नया variant
      const sheet = JSON.parse(JSON.stringify(tpl));
      sheet.id = uid("sht"); sheet.name = uniqueName(safeName(itemName + "_" + size)); sheet.kind = "master";
      sheet.source = "morth"; sheet.size = size; sheet.itemKey = itemKey; sheet.itemName = itemName; sheet.group = chapterKeyOf(tpl);
      sheet.masterId = null; sheet.syncPref = null; sheet.updatedAt = Date.now();
      state.sheets[sheet.id] = sheet; state.order.push(sheet.id);
      if (hfReady) { try { hf.addSheet(sheet.name); hf.setSheetContent(hfSheetId(sheet.name), sheetMatrix(sheet)); } catch (e) { buildEngine(); } }
      db.put("sheets", sheet);
      renderMorthAnalysis(); openMasterForEdit(sheet.id);
      status(sizeName(size) + " variant कॉपी हुआ (" + itemName + ") — अब इसमें बदलाव करें");
    });
  }

  // Rate Analysis में किसी master variant की working-copy बनाओ और खोलो
  // material (Query) से linked cells को RMR से link कर दो (carted rate उसी RMR से)
  function repointMaterialToRmr(copy, rmrId) {
    let linked = 0, missing = 0;
    for (const a in copy.cells) {
      const cell = copy.cells[a];
      if (!(cell && cell.mref && cell.mref.field === "rate" && cell.mref.cat === "material_query")) continue;
      let ok;
      if (Array.isArray(cell.mref.rowIds)) {
        // औसत — वही material जो Master में चुने थे, RMR से जोड़ो
        cell.mref = { rmr: rmrId, matIds: cell.mref.rowIds.slice(), field: "rate", agg: "avg" };
        ok = cell.mref.matIds.some((id) => rmrRateForMat(rmrId, id) != null);
      } else {
        cell.mref = { rmr: rmrId, matId: cell.mref.rowId, field: "rate" };
        ok = rmrRateForMat(rmrId, cell.mref.matId) != null;
      }
      if (ok) linked++; else missing++;   // missing = यह material RMR में नहीं है
    }
    return { linked: linked, missing: missing };
  }
  /* ===== Bitumen — Analysis के bitumen row को Estimate के Bitumen Final Rate (Say Rs) से link ===== */
  function bitumenEntriesOf(est) {   // Estimate विवरण के असली Bitumen entries (न हों तो खाली → linking नहीं)
    return (est && Array.isArray(est.bitumenCartage)) ? est.bitumenCartage.filter((x) => x && String(x.type || "").trim() && mrNum(x.rate) > 0) : [];
  }
  function bitNorm(s) { return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]/g, ""); }
  // किसी bitumen entry का Final Rate (Bitumen शीट का "Say Rs" = FLOOR(Basic+Cartage, 0.10))
  function bitumenSayFor(est, entry) {
    const basic = mrNum(entry.rate), dist = mrNum(entry.dist);
    const totalDist = (String(entry.side || "Both Side") === "Both Side") ? dist * 2 : dist;
    const cartage = totalDist * bitumenCartageRate();
    const total = round2(basic + cartage);
    return Math.floor(total * 10) / 10;   // FLOOR(value, 0.10)
  }
  function bitumenRateByType(est, typeName) {
    const t = bitNorm(typeName); if (!t) return null;
    const ent = bitumenEntriesOf(est).find((e) => bitNorm(e.type) === t) || bitumenEntriesOf(est).find((e) => { const et = bitNorm(e.type); return et && (t.includes(et) || et.includes(t)); });
    return ent ? bitumenSayFor(est, ent) : null;
  }
  // cell-नाम किसी bitumen/emulsion type से मेल खाता है? → उस entry का type लौटाओ
  function bitumenTypeMatch(name, est) {
    if (!/bitumen|emulsion|बिटु|इमल्शन|बिटूमेन/i.test(String(name || ""))) return null;
    const n = bitNorm(name); if (!n) return null;
    let best = null;
    bitumenEntriesOf(est).forEach((e) => { const et = bitNorm(e.type); if (et && (n.includes(et) || et.includes(n))) { if (!best || et.length > bitNorm(best).length) best = e.type; } });
    return best;
  }
  // किसी working sheet का estimate (उसके rmrId से; न मिले तो active)
  function estOfWorkingSheet(sheet) {
    if (sheet && sheet.rmrId) { for (const eid of state.estOrder) { const e = state.estimates[eid]; if (e && (e.rmrs || []).some((r) => r.id === sheet.rmrId)) return e; } }
    return state.estimates[state.activeEstimateId] || null;
  }
  // Analysis में bitumen वाली पंक्तियाँ ढूँढकर उनकी दर Estimate के Bitumen Final Rate से link करो
  function linkBitumenToEstimate(copy, est) {
    if (!est) return { linked: 0 };
    let linked = 0;
    for (let r = 0; r < copy.rows; r++) {
      if ((copy.cells[addr(r, 2)] || {}).role) continue;   // section/total नहीं
      const nc = copy.cells[addr(r, 2)];
      const nm = nc ? (nc.f != null ? "" : (nc.v == null ? "" : String(nc.v))) : "";
      const type = bitumenTypeMatch(nm, est); if (!type) continue;
      const val = bitumenRateByType(est, type); if (val == null) continue;
      const fa = addr(r, 5), prevS = (copy.cells[fa] || {}).s;
      copy.cells[fa] = { v: val, mref: { bitumen: type, field: "rate" } };
      if (prevS) copy.cells[fa].s = prevS;
      copy.cells[addr(r, 6)] = Object.assign({}, copy.cells[addr(r, 6)], { f: amtFormula(r) });   // Amount = Qty × Rate
      linked++;
    }
    return { linked: linked };
  }
  function loadAnalysisToWorkspace(masterId) {
    const m = state.sheets[masterId]; if (!m) return;
    // Analysis अभी Checked नहीं है → insert से पहले चेतावनी (फिर भी insert का विकल्प)
    if (!m.checked) {
      askConfirm({
        icon: "⚠️", tone: "info", okCls: "primary",
        title: "यह Analysis अभी Checked नहीं है",
        chip: (m.itemName || m.name),
        body: "यह Master Analysis अभी <b>Checked</b> (जाँची हुई) नहीं है।",
        note: "Rate Analysis में यह एक <b>copy</b> बनकर आएगा — बाद में Master में सुधार करने पर यहाँ (इस copy में) वह सुधार अपने आप <b>नहीं</b> आएगा। फिर भी insert करना चाहें तो आगे बढ़ें।",
        noteTone: "warn",
        cancel: "रद्द", ok: "फिर भी Insert करें",
      }).then((yes) => { if (yes) _resolveAndLoad(masterId); });
      return;
    }
    _resolveAndLoad(masterId);
  }
  function _resolveAndLoad(masterId) {
    const est = state.estimates[state.activeEstimateId];
    const rmrs = (est && est.rmrs) ? est.rmrs : [];
    const groups = est ? estOhGroups(est) : [];
    // RMR व Overhead दोनों sticky (load picker में तय) — बार-बार नहीं पूछते
    const rmrId = (_loadRmrId && rmrs.some((r) => r.id === _loadRmrId)) ? _loadRmrId : null;
    const ohGroupId = groups.length ? ((groups.some((g) => g.id === _loadOhGroupId) ? _loadOhGroupId : groups[0].id)) : null;
    maybeLoadWithDeps(masterId, rmrId, ohGroupId);
  }
  // वर्तमान user की भूमिका — कई स्रोतों से (जो पहले मिले): URL ?role= (सबसे विश्वसनीय),
  // फिर parent window का sessionStorage, फिर इसी frame का session/localStorage
  function estUserRole() {
    let role = "";
    try { role = new URLSearchParams(location.search).get("role") || ""; } catch (e) {}
    if (!role) { try { role = (JSON.parse(window.parent.sessionStorage.getItem("rms_user") || "{}").role) || ""; } catch (e) {} }
    if (!role) { try { role = (JSON.parse(sessionStorage.getItem("rms_user") || "{}").role) || ""; } catch (e) {} }
    if (!role) { try { role = (JSON.parse(localStorage.getItem("rms_user") || "{}").role) || ""; } catch (e) {} }
    return role;
  }
  function estIsAdmin() { return estUserRole() === "admin"; }   // Analysis "Check" केवल Admin कर सकता है

  // Analysis को Checked/Unchecked टॉगल करो (silent persist — "अंतिम सुधार" समय नहीं बदलता)
  function toggleAnalysisChecked(id) {
    if (!estIsAdmin()) { status("Analysis 'Check' केवल Admin कर सकता है"); return; }   // सुरक्षा — non-admin रोको
    const s = state.sheets[id]; if (!s) return;
    s.checked = !s.checked;
    persistSheet(s, true);
    renderMorthAnalysis(); renderMordAnalysis();
    status((s.checked ? "✓ Checked मार्क किया — " : "Checked हटाया — ") + (s.itemName || s.name));
  }
  // दूसरी शीट से डाटा आ रहा हो (formula-link) → पहले पूछो कि उन्हें भी load करें (recursive)
  function maybeLoadWithDeps(masterId, rmrId, ohGroupId) {
    const deps = collectMasterDeps(masterId);   // इस Analysis के पीछे जुड़ी master शीटें
    if (!deps.length) { doLoadAnalysis(masterId, rmrId, ohGroupId); return; }
    askDepsToLoad(masterId, deps).then((chosen) => {
      if (chosen == null) return;                          // रद्द
      if (!chosen.length) { doLoadAnalysis(masterId, rmrId, ohGroupId); return; }  // सिर्फ़ यही शीट
      doLoadAnalysisChain(masterId, chosen, rmrId, ohGroupId);
    });
  }
  // masterId के formula-references से transitively जुड़ी सभी master शीट ids (खुद को छोड़कर)
  function collectMasterDeps(masterId) {
    const masterByName = {};
    for (const id of state.order) { const s = state.sheets[id]; if (s.kind === "master") masterByName[s.name] = id; }
    const reRef = /(?:'([^']+)'|([^\s'!()+\-*/,;:&<>=^%]+))!/g;
    const seen = new Set([masterId]);
    const order = [];
    const stack = [masterId];
    while (stack.length) {
      const s = state.sheets[stack.pop()]; if (!s || !s.cells) continue;
      for (const a in s.cells) {
        const f = s.cells[a] && s.cells[a].f;
        if (!f || f.indexOf("!") < 0) continue;
        let m; reRef.lastIndex = 0;
        while ((m = reRef.exec(f))) { const nm = m[1] || m[2]; const dep = masterByName[nm]; if (dep != null && !seen.has(dep)) { seen.add(dep); order.push(dep); stack.push(dep); } }
      }
    }
    return order;
  }
  // copy की formulas में जुड़ी शीटों के नाम बदलो (master-नाम → load की गई copy का नाम)
  function rewriteRefs(sheet, nameMap) {
    for (const oldName in nameMap) {
      const newName = nameMap[oldName];
      if (!newName || oldName === newName) continue;
      const re = new RegExp("(^|[^A-Za-z0-9_'!])" + escapeReg(oldName) + "!", "g");
      for (const a in sheet.cells) { const cell = sheet.cells[a]; if (cell.f) cell.f = cell.f.replace(re, (mm, p1) => p1 + newName + "!"); }
    }
  }
  // master m की एक working-copy बनाओ (state में जोड़े बिना object लौटाओ)
  function buildCopyOf(m, rmrId, ohGroupId) {
    const rmr = rmrId ? findRmrById(rmrId) : null;
    const copy = JSON.parse(JSON.stringify(m));
    copy.id = uid("sht");
    copy.name = uniqueName(safeName((m.itemName || m.name) + ((m.source || "morth") === "morth" ? "_" + m.size : "") + (rmr ? "_" + rmr.name : "") + "_copy"));
    copy.kind = "working"; copy.masterId = m.id; copy.syncPref = null; copy.updatedAt = Date.now();
    copy.rmrId = rmrId || null; copy.rmrName = rmr ? rmr.name : "";
    copy.ohGroupId = ohGroupId || null;
    if (rmr) copy.title = (copy.title ? copy.title + "  " : "") + "[RMR: " + rmr.name + "]";
    if (rmrId) repointMaterialToRmr(copy, rmrId);
    linkBitumenToEstimate(copy, state.estimates[state.activeEstimateId]);   // Bitumen → Estimate Final Rate
    ensureFinalRateRows(copy);   // Rate per Unit + Say Rs. (final rate) पंक्तियाँ हों
    return copy;
  }
  // main + चुनी हुई dependency शीटें एक साथ load; आपस के references copy-नामों पर re-point
  function doLoadAnalysisChain(mainId, depIds, rmrId, ohGroupId) {
    const mMain = state.sheets[mainId]; if (!mMain) return;
    const dupMain = state.order.some((id) => { const s = state.sheets[id]; return s && s.kind === "working" && s.masterId === mainId && (s.rmrId || null) === (rmrId || null) && (s.ohGroupId || null) === (ohGroupId || null); });
    if (dupMain) { alert("यह Analysis इसी RMR व Overhead group से पहले ही load है।"); return; }
    const nameMap = {}; const created = [];
    for (const mid of depIds.concat([mainId])) {         // deps पहले, main आख़िर
      const m = state.sheets[mid]; if (!m) continue;
      // पहले से इसी RMR+OH से load है तो दोबारा नहीं — उसी copy-नाम पर link जोड़ो
      const existing = mid !== mainId && state.order.find((id) => { const s = state.sheets[id]; return s && s.kind === "working" && s.masterId === mid && (s.rmrId || null) === (rmrId || null) && (s.ohGroupId || null) === (ohGroupId || null); });
      if (existing) { nameMap[m.name] = state.sheets[existing].name; continue; }
      const copy = buildCopyOf(m, rmrId, ohGroupId);
      state.sheets[copy.id] = copy; state.order.push(copy.id);   // uniqueName अगली copy के लिए इसे देख ले
      nameMap[m.name] = copy.name; created.push(copy);
    }
    for (const copy of created) rewriteRefs(copy, nameMap);       // आपसी links को copy-नामों पर मोड़ो
    for (const copy of created) {
      if (hfReady) { try { hf.addSheet(copy.name); hf.setSheetContent(hfSheetId(copy.name), sheetMatrix(copy)); } catch (e) { } }
      applyOverheadToSheet(copy); db.put("sheets", copy);
    }
    buildEngine();
    reRateAllAnalyses();
    const mainCopy = created.find((c) => c.masterId === mainId);
    if (mainCopy) openSheet(mainCopy.id);
    setActiveView("rate-analysis");
    refreshEstimateSheetPicker();
    status("Analysis + " + created.filter((c) => c.masterId !== mainId).length + " linked शीट load हुईं");
  }
  // dependency चुनने का modal — default सब चुनी हुई
  function askDepsToLoad(mainId, depIds) {
    return new Promise((resolve) => {
      const mainNm = (state.sheets[mainId].itemName || state.sheets[mainId].name);
      const rows = depIds.map((id) => { const s = state.sheets[id]; const nm = (s.itemName || s.name); const src = (s.source || "morth") === "mord" ? "MoRD" : "MoRTH"; return "<label class='dep-row'><input type='checkbox' checked data-dep='" + id + "'><span class='dep-nm'>" + escapeHtml(nm) + "</span><span class='dep-src'>" + src + "</span></label>"; }).join("");
      const ov = document.createElement("div");
      ov.className = "modal-overlay";
      ov.innerHTML =
        "<div class='modal'><h3>🔗 जुड़ी शीटें भी load करें?</h3>" +
        "<p class='sub'>“<b>" + escapeHtml(mainNm) + "</b>” नीचे दी शीटों से डाटा लेती है। जिन्हें साथ load करना हो चुनें — तब इस Analysis के links इन load की गई copy से जुड़ जाएँगे।</p>" +
        "<div class='dep-list'>" + rows + "</div>" +
        "<div class='row wrap' style='margin-top:12px'>" +
          "<button class='btn primary' data-act='sel'>✓ चुनी हुई भी load करें</button>" +
          "<button class='btn' data-act='none'>सिर्फ़ यही शीट</button>" +
          "<button class='btn' data-act='cancel'>रद्द</button>" +
        "</div></div>";
      document.body.appendChild(ov);
      const done = (val) => { ov.remove(); resolve(val); };
      ov.querySelector("[data-act='sel']").addEventListener("click", () => { const ids = Array.from(ov.querySelectorAll("[data-dep]")).filter((c) => c.checked).map((c) => c.dataset.dep); done(ids); });
      ov.querySelector("[data-act='none']").addEventListener("click", () => done([]));
      ov.querySelector("[data-act='cancel']").addEventListener("click", () => done(null));
      ov.addEventListener("mousedown", (e) => { if (e.target === ov) done(null); });
    });
  }
  function doLoadAnalysis(masterId, rmrId, ohGroupId) {
    const m = state.sheets[masterId]; if (!m) return;
    const rmr = rmrId ? findRmrById(rmrId) : null;
    // एक ही analysis एक ही RMR + एक ही OH group से केवल एक बार
    const dup = state.order.some((id) => {
      const s = state.sheets[id];
      return s && s.kind === "working" && s.masterId === masterId &&
        (s.rmrId || null) === (rmrId || null) && (s.ohGroupId || null) === (ohGroupId || null);
    });
    if (dup) { alert("यह Analysis " + (rmr ? "'" + rmr.name + "' RMR" : "बिना RMR") + " व इसी Overhead group से पहले ही load है।\n(किसी दूसरे RMR/group से load कर सकते हैं।)"); return; }
    const copy = JSON.parse(JSON.stringify(m));
    copy.id = uid("sht");
    copy.name = uniqueName(safeName((m.itemName || m.name) + ((m.source || "morth") === "morth" ? "_" + m.size : "") + (rmr ? "_" + rmr.name : "") + "_copy"));
    copy.kind = "working"; copy.masterId = m.id; copy.syncPref = null; copy.updatedAt = Date.now();
    copy.rmrId = rmrId || null; copy.rmrName = rmr ? rmr.name : "";
    copy.ohGroupId = ohGroupId || null;   // Overhead/Profit इसी group के % से
    if (rmr) copy.title = (copy.title ? copy.title + "  " : "") + "[RMR: " + rmr.name + "]";   // RMR नाम analysis पर
    const rl = rmrId ? repointMaterialToRmr(copy, rmrId) : null;
    const bl = linkBitumenToEstimate(copy, state.estimates[state.activeEstimateId]);   // Bitumen row → Estimate का Bitumen Final Rate
    ensureFinalRateRows(copy);   // Rate per Unit + Say Rs. (final rate) पंक्तियाँ हों
    state.sheets[copy.id] = copy; state.order.push(copy.id);
    if (hfReady) { try { hf.addSheet(copy.name); hf.setSheetContent(hfSheetId(copy.name), sheetMatrix(copy)); } catch (e) { buildEngine(); } }
    db.put("sheets", copy);
    applyOverheadToSheet(copy);   // चुने group के % से Overhead/Profit पंक्तियाँ
    reRateAllAnalyses();   // RMR/Primary दरें cell में भर दो
    openSheet(copy.id);
    setActiveView("rate-analysis");
    refreshEstimateSheetPicker();
    const est2 = state.estimates[state.activeEstimateId];
    const grp = est2 ? estOhGroups(est2).find((g) => g.id === ohGroupId) : null;
    const rmrMsg = rl ? (" · RMR material: " + rl.linked + " linked" + (rl.missing ? ", " + rl.missing + " नहीं मिला ⚠" : " ✓")) : "";
    const bitMsg = (bl && bl.linked) ? (" · Bitumen: " + bl.linked + " linked ✓") : "";
    status("Analysis load हुआ" + (rmr ? " · RMR: " + rmr.name : "") + (grp && grp.remark ? " · OH group: " + grp.remark : "") + rmrMsg + bitMsg + " — " + copy.name);
  }
  // MoRTH item को मौजूदा project size में load करो (वह size न हो तो उपलब्ध से)
  function loadMorthItem(itemKey) {
    const v = morthVariant(itemKey, projectSize) || morthAnyVariant(itemKey);
    if (!v) return;
    if (v.size !== projectSize) status("इस item का " + sizeName(projectSize) + " variant नहीं — " + sizeName(v.size) + " load किया");
    loadAnalysisToWorkspace(v.id);
  }

  // Rate Analysis का "📂 Load" — पहले source (MoRTH/MoRD), फिर सूची
  let _loadSrc = "morth";   // पिछली बार चुना source (MoRTH/MoRD) याद रखो — दुबारा-दुबारा मत पूछो
  let _loadWgId = null;     // पिछली बार चुना कार्य-समूह — बदलने तक इसी पर बना रहे
  let _loadRmrId = null;    // चुने समूह से derived RMR
  let _loadOhGroupId = null; // चुने समूह से derived Overhead group
  // चुने कार्य-समूह से RMR + Overhead group निकालो
  function resolveLoadWg() {
    const est = state.estimates[state.activeEstimateId];
    const wgs = est ? estWorkGroups(est) : [];
    const wg = wgs.find((w) => w.id === _loadWgId) || wgs.find((w) => w.isMain) || wgs[0];
    _loadRmrId = wg ? (wg.rmrId || null) : null;
    _loadOhGroupId = wg ? (wg.ohGroupId || null) : null;
  }
  function openLoadAnalysisPicker(wgId) { showAnalysisListPicker(wgId); }
  // एकीकृत सूची modal — MoRTH/MoRD और Project size (Large/Medium/Small) modal के अंदर ही toggle से;
  // बार-बार सवाल नहीं, एक जगह चुनो और जितने चाहे Analysis load करो।
  //  preWgId दिया हो (किसी समूह के "+ Analysis" से) → वही समूह पहले से चुना रहेगा।
  function showAnalysisListPicker(preWgId) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    // इस estimate के कार्य-समूह — चुने समूह का RMR + Overhead इस Analysis पर लगेगा
    const est0 = state.estimates[state.activeEstimateId];
    const wgs0 = est0 ? estWorkGroups(est0) : [];
    if (preWgId && wgs0.some((w) => w.id === preWgId)) _loadWgId = preWgId;   // समूह-विशेष लोड
    if (_loadWgId && !wgs0.some((w) => w.id === _loadWgId)) _loadWgId = null;
    if (!_loadWgId && wgs0.length) _loadWgId = (wgs0.find((w) => w.isMain) || wgs0[0]).id;
    resolveLoadWg();   // _loadRmrId + _loadOhGroupId चुने समूह से
    const wgBtns = wgs0.map((w) => {
      const oh = (est0.ohGroups || []).find((g) => g.id === w.ohGroupId);
      const tt = oh ? ohGroupDesc(oh) : "";
      return "<button class='lap-wg-btn' data-wg='" + w.id + "' title='" + escapeHtml(tt) + "'>" + (w.isMain ? "★ " : "🗂 ") + escapeHtml(w.name) + "</button>";
    }).join("");
    // सहेजे गए सेट (कई Analysis एक साथ) — इसी समूह में लोड करने के लिए
    const setBar = analysisSets.length
      ? "<div class='lap-setbar' id='lapSetBar' title='सहेजे गए सेट — एक क्लिक में कई Analysis इस समूह में लोड (right-click: सेट हटाएँ)'>" +
          "<span class='psb-label'>📋 सेट:</span>" +
          analysisSets.map((st) => "<button class='lap-set-btn' data-set='" + st.id + "'>" + escapeHtml(st.name) + " <b>" + st.items.length + "</b></button>").join("") +
        "</div>"
      : "";
    overlay.innerHTML =
      "<div class='modal pick'>" +
      "<div class='pk-head'><h3>📂 Analysis लोड करें</h3><button class='pk-x' id='lapClose'>✕</button></div>" +
      "<div class='lap-controls'>" +
        "<div class='lap-srctabs'>" +
          "<button class='mtab' data-src='morth'>🛣️ MoRTH</button>" +
          "<button class='mtab' data-src='mord'>🏘️ MoRD</button>" +
        "</div>" +
        "<div class='proj-size-bar' id='lapSizeBar' title='MoRTH project size — इसी size के variant load होंगे'>" +
          "<span class='psb-label'>Project:</span>" +
          SIZES.map((s) => "<button class='psb-btn' data-size='" + s.key + "'>" + s.name + "</button>").join("") +
        "</div>" +
      "</div>" +
      "<div class='lap-wgbar' id='lapWgBar' title='चुने कार्य-समूह का RMR व Overhead/Profit इस Analysis पर लगेगा (हर समूह का Analysis अलग रहेगा)'>" +
        "<span class='psb-label'>कार्य-समूह:</span>" + wgBtns +
        (wgs0.length ? "" : "<span class='lap-rmrnote muted'>इस estimate में अभी कोई कार्य-समूह नहीं</span>") +
      "</div>" +
      setBar +
      "<p class='sub'>एक या कई Analysis चुनें (क्लिक कर टिक करें), फिर नीचे <b>लोड करें</b>। हर Analysis यहाँ <b>copy</b> बनकर खुलेगा (Master सुरक्षित)।</p>" +
      "<input type='search' id='lapSearch' class='search' placeholder='🔍 खोजें…' />" +
      "<div class='lap-list' id='lapList'></div>" +
      "<div class='lap-foot'><span class='lap-selinfo' id='lapSelInfo'>कोई Analysis नहीं चुना</span>" +
        "<button class='btn primary' id='lapLoadSel' disabled>✓ चुने लोड करें</button></div>" +
      "</div>";
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    const listEl = overlay.querySelector("#lapList");
    const searchEl = overlay.querySelector("#lapSearch");
    const selected = new Set();   // चुने हुए loadId
    const selInfo = overlay.querySelector("#lapSelInfo");
    const loadSelBtn = overlay.querySelector("#lapLoadSel");
    function updateFoot() {
      const n = selected.size;
      selInfo.textContent = n ? (n + " Analysis चुने") : "कोई Analysis नहीं चुना";
      loadSelBtn.disabled = n === 0;
      loadSelBtn.textContent = n ? ("✓ चुने " + n + " लोड करें") : "✓ चुने लोड करें";
    }
    const sizeBar = overlay.querySelector("#lapSizeBar");

    function renderList() {
      overlay.querySelectorAll(".lap-srctabs .mtab").forEach((t) => t.classList.toggle("active", t.dataset.src === _loadSrc));
      overlay.querySelectorAll("#lapSizeBar .psb-btn").forEach((b) => b.classList.toggle("active", b.dataset.size === projectSize));
      overlay.querySelectorAll("#lapWgBar .lap-wg-btn").forEach((b) => b.classList.toggle("active", b.dataset.wg === _loadWgId));
      sizeBar.style.display = _loadSrc === "morth" ? "" : "none";   // size सिर्फ़ MoRTH के लिए
      let listHtml = "";
      if (_loadSrc === "mord") {
        const all = sourceMasters("mord");
        listHtml = buildPickerGroups(all.map((s) => ({ loadId: s.id, name: s.name, sub: s.title, group: chapterKeyOf(s), checked: !!s.checked, serial: s.serial })), "mord");
      } else {
        const byKey = {};
        for (const s of sourceMasters("morth")) { if (!byKey[s.itemKey]) { byKey[s.itemKey] = { group: chapterKeyOf(s), name: s.itemName || s.name, variants: {} }; } byKey[s.itemKey].variants[s.size] = s; }
        const items = [];
        for (const k in byKey) { const it = byKey[k]; const v = it.variants[projectSize] || it.variants.large || it.variants.medium || it.variants.small; if (v) items.push({ loadId: v.id, name: it.name, sub: sizeName(v.size) + (v.size !== projectSize ? " (इस item का " + sizeName(projectSize) + " नहीं)" : ""), group: it.group, checked: !!v.checked, serial: v.serial }); }
        listHtml = buildPickerGroups(items, "morth");
      }
      listEl.innerHTML = listHtml || "<div class='ag-empty muted'>अभी कोई master analysis नहीं — Master Data में बनाएँ।</div>";
      const q = searchEl.value.trim().toLowerCase();
      listEl.querySelectorAll(".lap-item").forEach((b) => {
        const lid = b.dataset.load;
        if (q) { const nm = b.querySelector(".lap-nm").textContent.toLowerCase(); if (!nm.includes(q)) b.style.display = "none"; }
        if (selected.has(lid)) b.classList.add("sel");   // re-render पर चुनाव बरक़रार
        b.addEventListener("click", () => {
          if (selected.has(lid)) { selected.delete(lid); b.classList.remove("sel"); }
          else { selected.add(lid); b.classList.add("sel"); }
          updateFoot();
        });
      });
    }

    overlay.querySelectorAll(".lap-srctabs .mtab").forEach((t) => t.addEventListener("click", () => { _loadSrc = t.dataset.src; renderList(); }));
    overlay.querySelectorAll("#lapSizeBar .psb-btn").forEach((b) => b.addEventListener("click", () => { setProjectSize(b.dataset.size); renderList(); }));
    overlay.querySelectorAll("#lapWgBar .lap-wg-btn").forEach((b) => b.addEventListener("click", () => { _loadWgId = b.dataset.wg; resolveLoadWg(); renderList(); }));
    // चुने हुए सभी एक साथ लोड करो
    loadSelBtn.addEventListener("click", () => {
      if (!selected.size) return;
      const ids = Array.from(selected);
      close();
      _openWgId = _loadWgId;   // जिस समूह में लोड हुआ वही खुला दिखे
      ids.forEach((lid) => { if (state.sheets[lid]) loadAnalysisToWorkspace(lid); });
      renderSheetList();
      status(ids.length + " Analysis लोड हुए");
    });
    // सहेजे सेट → इसी समूह में एक साथ लोड (right-click: हटाएँ)
    overlay.querySelectorAll("#lapSetBar .lap-set-btn").forEach((b) => {
      b.addEventListener("click", () => { close(); loadSetIntoCurrentGroup(b.dataset.set); });
      b.addEventListener("contextmenu", (e) => { e.preventDefault(); deleteAnalysisSet(b.dataset.set); if (!analysisSets.some((x) => x.id === b.dataset.set)) b.remove(); });
    });
    searchEl.addEventListener("input", renderList);
    overlay.querySelector("#lapClose").addEventListener("click", close);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } });
    renderList();
    searchEl.focus();
  }
  // entries: {loadId, name, sub, group?} — chapterwise समूह में HTML
  function buildPickerGroups(entries, src) {
    let html = "";
    for (const g of chaptersOf(src)) {
      const inG = entries.filter((e) => (e.group || defaultChapterKey(src)) === g.key);
      if (inG.length === 0) continue;
      html += "<div class='lap-group'><div class='lap-gname'>" + escapeHtml(g.name) + "</div>";
      for (const e of inG) {
        const ckBadge = e.checked
          ? "<span class='lap-ck on' title='Checked (जाँची हुई)'>✓ Checked</span>"
          : "<span class='lap-ck off' title='अभी Checked नहीं'>⚠ Uncheck</span>";
        const snTxt = (e.serial != null && String(e.serial).trim() !== "") ? String(e.serial).trim() : "";
        const snBadge = snTxt ? "<span class='lap-sn'>" + escapeHtml(snTxt) + "</span> " : "";   // क्रम संख्या — नाम से पहले (search में भी आता है)
        html += "<button class='lap-item' data-load='" + e.loadId + "'><span class='lap-nm'>" + snBadge + escapeHtml(e.name) + ckBadge + "</span>" + (e.sub ? "<span class='lap-tt'>" + escapeHtml(e.sub) + "</span>" : "") + "</button>";
      }
      html += "</div>";
    }
    return html;
  }

  /* ===== working-copy → master sync (बदलाव पर पूछो) ===== */
  let _syncDialogOpen = false;
  // working-copy की सामग्री master पर भेजो (master का id/name/group अछूता)।
  //  पंक्ति/कॉलम की संख्या बदली हो तो master में अपने-आप नहीं भेजते — क्योंकि master से
  //  जुड़े (BoQ आदि) links पते-आधारित हैं और structural बदलाव सीधे master पर ही slip-proof होता है।
  function syncWorkingToMaster(working) {
    const m = state.sheets[working.masterId];
    if (!m) return;
    if (working.rows !== m.rows || working.cols !== m.cols) {
      alert("इस copy में पंक्ति/कॉलम की संख्या बदली है — यह बदलाव Master में अपने-आप नहीं भेजा जा सकता " +
        "(Master से जुड़े links slip हो सकते हैं)।\nपंक्ति/कॉलम वाला structural बदलाव Master पर सीधे करें: " +
        "Master Data › MoRTH/MoRD Analysis › इस Analysis पर ✎ Edit।\n\nफ़िलहाल मान/रेट के बदलाव copy में सुरक्षित हैं।");
      return;
    }
    m.cells = JSON.parse(JSON.stringify(working.cells));
    m.merges = JSON.parse(JSON.stringify(working.merges || []));
    m.colWidths = (working.colWidths || []).slice();
    m.title = working.title; m.lockTop = working.lockTop; m.lockBottom = working.lockBottom;
    m.updatedAt = Date.now();
    if (hfReady) { try { hf.setSheetContent(hfSheetId(m.name), sheetMatrix(m)); } catch (e) { buildEngine(); } }
    db.put("sheets", m);
    status("Master भी अपडेट हुआ: " + m.name);
  }
  // working-copy में किसी user-बदलाव के बाद — पूछो/लागू करो
  function maybeSyncToMaster(sheet) {
    if (!isWorkingCopy(sheet)) return;
    if (sheet.syncPref === "local") return;
    if (sheet.syncPref === "master") { syncWorkingToMaster(sheet); return; }
    if (_syncDialogOpen) return;                 // एक समय में एक ही dialog
    _syncDialogOpen = true;
    askChoice("इस loaded Analysis (copy) में बदलाव हुआ — कहाँ लागू करें?", [
      { label: "केवल इस file में", value: "local" },
      { label: "Master में भी", value: "master", cls: "primary" },
      { label: "हमेशा केवल file", value: "local-always" },
      { label: "हमेशा Master भी", value: "master-always", cls: "primary" },
    ]).then((v) => {
      _syncDialogOpen = false;
      if (v === "local-always") { sheet.syncPref = "local"; persistSheet(sheet); }
      else if (v === "master-always") { sheet.syncPref = "master"; persistSheet(sheet); syncWorkingToMaster(sheet); }
      else if (v === "master") { syncWorkingToMaster(sheet); }
      // local या रद्द → कुछ नहीं (बदलाव सिर्फ़ copy में)
    });
  }
  // user-cell-edit का एकल chokepoint: setCell + master-sync पूछो
  function userSetCell(sheet, r, c, raw) {
    pushUndo("sheet");
    setCell(sheet, r, c, raw);
    maybeSyncToMaster(sheet);
  }
  function updateTopbarEstimate() {
    const el = document.getElementById("currentEstimateName");
    if (!el) return;
    const est = state.estimates[state.activeEstimateId];
    el.textContent = est ? est.name : "कोई estimate लोड नहीं";
    // "Estimate बंद करें" की दृश्यता active estimate बदलने/restore होने पर भी ताज़ा रहे
    const active = document.querySelector(".view.active");
    const vid = active ? active.id.replace("view-", "") : "";
    const isMasterView = (vid === "master" || vid === "master-cat" || vid === "master-edit");
    const closeBtn = document.getElementById("btnCloseEstimate");
    if (closeBtn) closeBtn.style.display = (!isMasterView && state.activeEstimateId) ? "" : "none";
  }
  // अभी खुला (active) estimate बंद करो — deactivate + Load Estimate पर ले जाओ
  function closeActiveEstimate() {
    const est = state.estimates[state.activeEstimateId];
    if (!est) { status("कोई estimate खुला नहीं है"); return; }
    setActiveEstimateId(null);
    applyOverheadAll();
    renderEstimateSelect(); renderEstimate(); updateTopbarEstimate();
    setActiveView("load");   // बंद के बाद Load Estimate पर — नया खोलें/बनाएँ
    status("Estimate बंद हुआ: " + est.name);
  }
  function renderEstimateProjectList() {
    renderEstActions();   // loaded estimate का Actions पैनल
    const ul = document.getElementById("estimateProjectList");
    if (!ul) return;
    ul.innerHTML = "";
    if (state.estOrder.length === 0) {
      ul.innerHTML = "<li class='muted-row'>अभी कोई estimate नहीं — ऊपर \"नया Estimate\" से बनाएँ।</li>";
      return;
    }
    for (const id of state.estOrder) {
      const e = state.estimates[id];
      const li = document.createElement("li");
      const meta = [e.roadCode, e.length ? e.length + " km" : "", e.year].filter(Boolean).join(" · ");
      li.innerHTML = "<div class='ei-main'><div class='ei-name'>" + escapeHtml(e.name) +
        "</div><div class='ei-meta'>" + escapeHtml(meta || (e.sheetIds.length + " शीट")) + "</div></div>" +
        "<span class='ei-actions'>" +
          "<button type='button' class='btn xs ei-detail' title='इस Estimate का विवरण सुधारें'>✎ विवरण</button>" +
          "<span class='btn xs ei-open'>खोलें</span>" +
          "<button type='button' class='btn xs ei-del danger' title='इस Estimate को हटाएँ'>🗑</button>" +
        "</span>";
      li.addEventListener("click", () => {
        setActiveEstimateId(id);
        applyOverheadAll();   // इस estimate के Overhead/Profit % सभी analysis पर
        renderEstimateSelect(); renderEstimate(); updateTopbarEstimate();
        setActiveView("basic-sheet");   // Estimate खुलते ही पहले Basic Sheet
        status("Estimate खुला: " + e.name);
      });
      // "विवरण" — edit form खोलो (li का open trigger न हो इसलिए stopPropagation)
      li.querySelector(".ei-detail").addEventListener("click", (ev) => { ev.stopPropagation(); openEstimateForm(id); });
      li.querySelector(".ei-del").addEventListener("click", (ev) => { ev.stopPropagation(); deleteEstimate(id); });
      ul.appendChild(li);
    }
  }
  function deleteEstimate(id) {
    const e = state.estimates[id]; if (!e) return;
    if (!confirm("Estimate हटाएँ?\n\n'" + (e.name || "") + "'\n\nयह पूर्ववत नहीं होगा।")) return;
    delete state.estimates[id];
    state.estOrder = state.estOrder.filter((x) => x !== id);
    db.del("estimates", id);
    if (state.activeEstimateId === id) { setActiveEstimateId(state.estOrder[0] || null); renderEstimateSelect(); renderEstimate(); updateTopbarEstimate(); }
    renderEstimateProjectList();
    status("Estimate हटाया: " + (e.name || ""));
  }
  /* ============== MASTER DATA — सभी rate-श्रेणियाँ (एक generic ढाँचा) ==============
     हर पंक्ति का स्थायी id होता है (Analysis इसी id से रेट लेगा), इसलिए version बदलने या
     बीच में पंक्ति insert करने पर भी पुराना version load करने पर रेट गलत item में नहीं जाएगा।
     dates DD/MM/YYYY में।
  */
  const MASTER_CATS = {
    machine: { name: "Machine Rate (MoRTH)", cols: [
      { key: "sn", label: "क्रम", w: "54px", num: true }, { key: "desc", label: "Description of Machine" },
      { key: "activity", label: "Activity", w: "150px" }, { key: "power", label: "Power", w: "90px" },
      { key: "unit", label: "Unit", w: "70px" }, { key: "rate", label: "Rate per Unit", w: "110px", num: true } ] },
    machine_mord: { name: "Machine Rate (MoRD)", cols: [
      { key: "sn", label: "क्रम", w: "54px", num: true }, { key: "desc", label: "Description of Machine" },
      { key: "activity", label: "Activity", w: "150px" }, { key: "power", label: "Power", w: "90px" },
      { key: "unit", label: "Unit", w: "70px" }, { key: "rate", label: "Rate per Unit", w: "110px", num: true } ] },
    labour: { name: "Labour Rate", cols: [
      { key: "sn", label: "क्रम", w: "54px", num: true }, { key: "desc", label: "Category of Labour" },
      { key: "unit", label: "Unit", w: "90px" }, { key: "rate", label: "Rate per Unit", w: "120px", num: true } ] },
    cartage: { name: "Cartage Rate", cols: [
      { key: "sn", label: "क्रम", w: "54px", num: true },
      { key: "from_km", label: "From (km)", w: "110px", num: true },
      { key: "to_km", label: "To (km)", w: "110px", num: true },
      { key: "rate_km", label: "Rate per km (₹)", w: "140px", num: true },
      { key: "cum_rate", label: "Cumulative Rate per Cum", w: "170px", num: true,   // इस To(km) तक कुल cartage (₹/Cum)
        calc: (r) => { const v = mrActiveVersion(); if (!v || r.to_km == null || String(r.to_km).trim() === "") return ""; return round2(cartageCompute(v.rows, mrNum(r.to_km)).total).toFixed(2); } } ] },
    material_query: { name: "Material Query Rate", cols: [
      { key: "sn", label: "क्रम", w: "54px", num: true }, { key: "desc", label: "Material Description" },
      { key: "query_name", label: "Query Name", w: "130px" },
      { key: "query_rate", label: "Query Rate", w: "100px", num: true }, { key: "royalty", label: "Royality", w: "90px", num: true },
      { key: "loading", label: "Loading/Unloading", w: "130px", num: true }, { key: "unit", label: "Unit", w: "72px" },
      { key: "final_rate", label: "Final Rate", w: "100px", num: true,
        calc: (r) => { if (r.query_rate == null || String(r.query_rate).trim() === "") return ""; return (mrNum(r.query_rate) - mrNum(r.royalty) - mrNum(r.loading)).toFixed(2); } } ] },   // Final = Query − Royality − Loading/Unloading
    material_sor: { name: "Material SOR Rate", cols: [
      { key: "sn", label: "क्रम", w: "54px", num: true }, { key: "desc", label: "Material Description" },
      { key: "unit", label: "Unit", w: "90px" }, { key: "rate", label: "SOR Rate", w: "120px", num: true } ] },
    item_sor: { name: "Item SOR Rate", cols: [
      { key: "sn", label: "क्रम", w: "54px", num: true }, { key: "itemno", label: "Item No", w: "90px" },
      { key: "desc", label: "Description" }, { key: "unit", label: "Unit", w: "80px" },
      { key: "rate", label: "SOR Rate", w: "110px", num: true } ] },
    bitumen_rate: { name: "Bitumen Rate", cols: [
      { key: "sn", label: "क्रम", w: "54px", num: true },
      { key: "type", label: "Bitumen का प्रकार" },
      { key: "refinery", label: "Refinery", w: "160px" },
      { key: "unit", label: "Unit", w: "80px" },
      { key: "rate", label: "Rate per Unit", w: "120px", num: true } ] },
  };
  // Bitumen Rate — प्रकार व फ़िल्टर (Bitumen / Emulsion)
  const BITUMEN_TYPES = ["Bitumen (VG-40)", "Bitumen 60-70 (VG-30)", "Bitumen 80-100 (VG-10)", "Emulsion (SS-1) Bulk", "Emulsion (SS-2) Bulk"];
  function isEmulsionType(t) { return /emulsion/i.test(String(t || "")); }
  let mrBitFilter = "all";   // "all" | "bitumen" | "emulsion"
  function catDef(cat) { return MASTER_CATS[cat] || MASTER_CATS.machine; }
  function mrNum(x) { const n = parseFloat(x); return isFinite(n) ? n : 0; } // गणना के लिए सुरक्षित संख्या
  function nf(n) { n = mrNum(n); return Number.isInteger(n) ? String(n) : n.toFixed(2); }

  // Range/slab से किसी दूरी (km) का कुल cartage — खंड-दर-खंड cumulative
  //  slabs के To-मानों को सीमाएँ मानकर: खंड [पिछला-To, यह-To] पर यह दर लगती है।
  //  उदा: 0-10@5, 11-25@12 → 13 km = 10×5 + 3×12 = 86
  function cartageCompute(rows, km) {
    const slabs = (rows || [])
      .map((r) => ({ to: mrNum(r.to_km), rate: mrNum(r.rate_km) }))
      .filter((s) => s.to > 0)
      .sort((a, b) => a.to - b.to);
    const parts = []; let total = 0, lower = 0;
    for (const s of slabs) {
      if (km <= lower) break;
      const upper = Math.min(km, s.to);
      const seg = upper - lower;
      if (seg > 0) { const amt = seg * s.rate; parts.push({ lower, upper, len: seg, rate: s.rate, amt }); total += amt; }
      lower = s.to;
      if (km <= s.to) break;
    }
    if (km > lower && slabs.length) { // आख़िरी slab की दर आगे भी लागू
      const s = slabs[slabs.length - 1], seg = km - lower, amt = seg * s.rate;
      parts.push({ lower, upper: km, len: seg, rate: s.rate, amt, extend: true }); total += amt;
    }
    return { total, parts };
  }
  function ensureCat(cat) {
    if (!state.master[cat]) state.master[cat] = { id: cat, name: catDef(cat).name, activeVersion: null, loadedVersion: null, versions: [] };
    return state.master[cat];
  }
  function saveCat(cat) { db.put("master", state.master[cat]); scheduleReRate(); }

  let mrCat = "machine";             // अभी खुली श्रेणी
  let mrEditAll = false;             // "सभी Edit" मोड
  const mrRowEdit = new Set();       // किन row-id को अलग से (single line) edit किया जा रहा
  let mrUndo = null, mrUndoTimer = null;
  let mrSearch = "";                 // इस श्रेणी में खोज

  // सामान्य choice-dialog (कई बटन; chosen value resolve करता है)
  // styled confirm dialog (native confirm की जगह) — Promise<boolean>
  // opts: {icon, tone:'danger'|'info', title, chip, body(html), note(html), noteTone:'warn'|'safe'|'', list:[], ok, okCls, cancel}
  function askConfirm(opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const ov = document.createElement("div");
      ov.className = "modal-overlay";
      ov.innerHTML =
        "<div class='modal confirm'>" +
        "<div class='cm-head'>" +
        "<div class='cm-ic " + (opts.tone || "danger") + "'>" + (opts.icon || "🗑") + "</div>" +
        "<div class='cm-hd'><h3>" + escapeHtml(opts.title || "पुष्टि") + "</h3>" +
        (opts.chip ? "<span class='cm-chip' title='" + escapeHtml(opts.chip) + "'>" + escapeHtml(opts.chip) + "</span>" : "") +
        "</div></div>" +
        (opts.body ? "<p class='sub cm-body'>" + opts.body + "</p>" : "") +
        (opts.note ? "<div class='cm-note " + (opts.noteTone || "") + "'>" + opts.note + "</div>" : "") +
        (opts.list && opts.list.length
          ? "<div class='cm-list'>" + opts.list.map((x) => "<div class='cm-li'>" + escapeHtml(x) + "</div>").join("") + "</div>"
          : "") +
        "<div class='row'>" +
        "<button class='btn' id='cmCancel'>" + escapeHtml(opts.cancel || "रद्द") + "</button>" +
        "<button class='btn " + (opts.okCls || "danger") + "' id='cmOk'>" + escapeHtml(opts.ok || "हटाएँ") + "</button>" +
        "</div></div>";
      document.body.appendChild(ov);
      const close = (v) => { ov.remove(); resolve(v); };
      ov.querySelector("#cmCancel").addEventListener("click", () => close(false));
      ov.querySelector("#cmOk").addEventListener("click", () => close(true));
      ov.addEventListener("mousedown", (e) => { if (e.target === ov) close(false); });
      ov.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { e.preventDefault(); close(false); }
        else if (e.key === "Enter") { e.preventDefault(); close(true); }
      });
      setTimeout(() => { const b = ov.querySelector("#cmOk"); if (b) b.focus(); }, 0);
    });
  }

  function askChoice(message, buttons) {
    return new Promise((resolve) => {
      const ov = document.createElement("div");
      ov.className = "modal-overlay";
      const bh = buttons.map((b) => "<button class='btn " + (b.cls || "") + "' data-val='" + b.value + "'>" + escapeHtml(b.label) + "</button>").join("");
      ov.innerHTML = "<div class='modal'><h3>पुष्टि</h3><p class='sub'>" + escapeHtml(message).replace(/\n/g, "<br>") + "</p><div class='row wrap'>" + bh + "</div></div>";
      document.body.appendChild(ov);
      const done = (val) => { ov.remove(); resolve(val); };
      ov.querySelectorAll("[data-val]").forEach((b) => b.addEventListener("click", () => done(b.dataset.val)));
      ov.addEventListener("mousedown", (e) => { if (e.target === ov) done(null); });
    });
  }

  // styled text-input popup (native prompt की जगह) — Promise<string|null>
  function askText(opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const ov = document.createElement("div");
      ov.className = "modal-overlay";
      ov.innerHTML =
        "<div class='modal'>" +
        "<h3>" + escapeHtml(opts.title || "") + "</h3>" +
        (opts.sub ? "<p class='sub'>" + escapeHtml(opts.sub) + "</p>" : "") +
        "<label class='ns-fld'>" + escapeHtml(opts.label || "") +
        "<input id='atInput' type='text' autocomplete='off' placeholder='" + escapeHtml(opts.placeholder || "") + "' /></label>" +
        "<div class='row'><button class='btn' id='atCancel'>रद्द</button><button class='btn primary' id='atOk'>" + escapeHtml(opts.ok || "ठीक") + "</button></div>" +
        "</div>";
      document.body.appendChild(ov);
      const inp = ov.querySelector("#atInput");
      inp.value = opts.value || "";
      const close = (val) => { ov.remove(); resolve(val); };
      const submit = () => { const v = inp.value.trim(); if (!v) { inp.style.borderColor = "var(--red)"; inp.focus(); return; } close(v); };
      ov.querySelector("#atCancel").addEventListener("click", () => close(null));
      ov.querySelector("#atOk").addEventListener("click", submit);
      ov.addEventListener("mousedown", (e) => { if (e.target === ov) close(null); });
      ov.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { e.preventDefault(); close(null); }
        else if (e.key === "Enter") { e.preventDefault(); submit(); }
      });
      inp.focus(); inp.select();
    });
  }

  function ensureMachine() { return ensureCat(mrCat); }
  function mrActiveVersion() {
    const m = ensureCat(mrCat);
    if (!m.versions.length) return null;
    return m.versions.find((v) => v.date === m.activeVersion) || m.versions[0];
  }
  function saveMachine() { saveCat(mrCat); }
  // Cartage की slabwise पंक्तियाँ (active version) पैनल में दिखाओ — Edit मोड में यहीं संपादन (From/To/Rate + पंक्ति जोड़ें/हटाएँ), ऊपर की मुख्य तालिका से sync
  function renderCartageSlabView() {
    const box = document.getElementById("cgSlabView"); if (!box) return;
    const ver = mrActiveVersion();
    const rows = (ver && ver.rows) ? ver.rows : [];
    const editing = mrEditAll;
    if (!rows.length && !editing) { box.innerHTML = "<div class='muted' style='font-size:12.5px'>इस version में कोई slabwise पंक्ति नहीं — '🔁 DB से…' दबाकर पुनः लोड करें, या ऊपर की तालिका में भरें।</div>"; return; }
    const cumStr = (r, rws) => (r.to_km != null && String(r.to_km).trim() !== "") ? round2(cartageCompute(rws, mrNum(r.to_km)).total).toFixed(2) : "";
    let h = "<table class='calc-table cg-slab'><thead><tr><th>क्रम</th><th>From (km)</th><th>To (km)</th><th>Rate per km (₹)</th><th>Cumulative Rate per Cum</th>" + (editing ? "<th>क्रिया</th>" : "") + "</tr></thead><tbody>";
    rows.forEach((r, i) => {
      const g = (k) => escapeHtml(r[k] == null ? "" : String(r[k]));
      if (editing) {
        h += "<tr>" +
          "<td>" + (i + 1) + "</td>" +
          "<td><input class='num cg-in' data-i='" + i + "' data-f='from_km' value=\"" + g("from_km") + "\" /></td>" +
          "<td><input class='num cg-in' data-i='" + i + "' data-f='to_km' value=\"" + g("to_km") + "\" /></td>" +
          "<td><input class='num cg-in' data-i='" + i + "' data-f='rate_km' value=\"" + g("rate_km") + "\" /></td>" +
          "<td class='cg-cum'>" + cumStr(r, rows) + "</td>" +
          "<td class='cg-act'><button class='mini' data-cgact='ins' data-i='" + i + "' title='नीचे पंक्ति डालें'>⊕</button><button class='mini danger' data-cgact='del' data-i='" + i + "' title='हटाएँ'>🗑</button></td>" +
          "</tr>";
      } else {
        h += "<tr><td>" + (r.sn != null && String(r.sn).trim() !== "" ? escapeHtml(String(r.sn)) : (i + 1)) + "</td><td>" + g("from_km") + "</td><td>" + g("to_km") + "</td><td>" + g("rate_km") + "</td><td>" + cumStr(r, rows) + "</td></tr>";
      }
    });
    h += "</tbody></table>";
    h += editing
      ? "<div style='margin-top:8px; display:flex; gap:8px; align-items:center; flex-wrap:wrap'><button class='btn sm primary' id='cgSlabAdd'>+ पंक्ति जोड़ें</button><span class='view-sub' style='margin:0'>बदलाव अपने-आप सुरक्षित; ऊपर की मुख्य तालिका से जुड़े</span></div>"
      : "<div class='view-sub' style='margin-top:6px'>कुल " + rows.length + " पंक्ति · संपादन के लिए ऊपर <b>✎ सभी Edit करें</b> दबाएँ।</div>";
    box.innerHTML = h;
    if (!editing) return;
    const recomputeCum = () => {
      const v = mrActiveVersion(); if (!v) return;
      box.querySelectorAll("td.cg-cum").forEach((td, idx) => { const r2 = v.rows[idx]; td.textContent = r2 ? cumStr(r2, v.rows) : ""; });
      const mt = document.getElementById("mrTable");
      if (mt) mt.querySelectorAll("input[data-field='cum_rate']").forEach((ci) => { const r2 = v.rows[+ci.dataset.i]; if (r2) ci.value = cumStr(r2, v.rows); });
    };
    box.querySelectorAll("input.cg-in").forEach((inp) => {
      inp.addEventListener("input", () => {
        const v = mrActiveVersion(); if (!v) return;
        const r2 = v.rows[+inp.dataset.i]; if (!r2) return;
        r2[inp.dataset.f] = inp.value;
        const mt = document.getElementById("mrTable");   // मुख्य तालिका का वही cell भी sync
        if (mt) { const mi = mt.querySelector("input[data-i='" + inp.dataset.i + "'][data-field='" + inp.dataset.f + "']"); if (mi) mi.value = inp.value; }
        recomputeCum();
        saveMachine();
      });
    });
    box.querySelectorAll("button[data-cgact]").forEach((b) => b.addEventListener("click", () => {
      const v = mrActiveVersion(); if (!v) return;
      const i = +b.dataset.i;
      if (b.dataset.cgact === "ins") v.rows.splice(i + 1, 0, mrNewRow());
      else if (b.dataset.cgact === "del") { if (!confirm("यह slab पंक्ति हटाएँ?")) return; v.rows.splice(i, 1); }
      saveMachine(); renderMachineRate();
    }));
    const add = document.getElementById("cgSlabAdd");
    if (add) add.addEventListener("click", () => { const v = mrActiveVersion(); if (!v) return; v.rows.push(mrNewRow()); saveMachine(); renderMachineRate(); });
  }
  // Cartage की slabwise पंक्तियाँ स्थानीय DB से पुनः लोड करो (तालिका खाली दिखने पर recovery + diagnostic)
  function reloadCartageFromDB() {
    if (!db.getAll) { alert("DB उपलब्ध नहीं।"); return; }
    db.getAll("master").then((all) => {
      const stored = (all || []).find((x) => x && x.id === "cartage");
      const vers = stored ? (stored.versions || []) : [];
      const rowCount = vers.reduce((n, v) => n + ((v.rows || []).length), 0);
      if (stored && rowCount > 0) {
        // memory के नए meta बचाकर stored (rows सहित) restore करो
        const memMeta = state.master["cartage"] || {};
        if (memMeta.description && !stored.description) stored.description = memMeta.description;
        if (memMeta.bitumenCartage && !stored.bitumenCartage) stored.bitumenCartage = memMeta.bitumenCartage;
        state.master["cartage"] = stored;
        db.put("master", stored);
        if (mrCat === "cartage") renderMachineRate();
        alert("✅ Cartage पुनः लोड — " + vers.length + " version, कुल " + rowCount + " slabwise पंक्तियाँ मिलीं। ऊपर तालिका में दिखनी चाहिए।");
      } else {
        alert("⚠ स्थानीय DB में Cartage की slabwise पंक्तियाँ नहीं मिलीं (" + vers.length + " version, 0 पंक्ति)।\n\nयदि यह cloud पर सुरक्षित है तो पेज reload करें; वरना Master Data → Restore (बैकअप) से लाएँ।");
      }
    }).catch((e) => alert("पढ़ने में समस्या: " + (e && e.message)));
  }
  // Cartage के meta (description / bitumenCartage) को सुरक्षित सहेजो — यदि memory में slabwise versions
  //  न हों (लोड-चूक) तो पहले DB का मौजूदा record पढ़कर उसकी versions/rows सुरक्षित रखो (क्लोबर न हो; recover भी)
  function saveCartageMeta() {
    const cm = ensureCat("cartage");
    if ((cm.versions && cm.versions.length) || !db.getAll) { saveCat("cartage"); return; }
    db.getAll("master").then((all) => {
      const stored = (all || []).find((x) => x && x.id === "cartage");
      if (stored && stored.versions && stored.versions.length) {
        stored.description = cm.description; stored.bitumenCartage = cm.bitumenCartage; stored.loadingUnloading = cm.loadingUnloading;
        stored.activeVersion = stored.activeVersion || cm.activeVersion;
        stored.loadedVersion = stored.loadedVersion || cm.loadedVersion;
        state.master["cartage"] = stored; db.put("master", stored);
        if (mrCat === "cartage") renderMachineRate();
        status("Cartage data DB से पुनः लोड — meta सहेजा (slabwise rows सुरक्षित)");
      } else { saveCat("cartage"); }
    }).catch(() => saveCat("cartage"));
  }
  function mrNewRow() { const r = { id: uid("mrow") }; for (const c of catDef(mrCat).cols) r[c.key] = ""; return r; }
  function mrRowEditable(rowId) { return mrEditAll || mrRowEdit.has(rowId); }

  // Effective date (DD/MM/YYYY) पूछकर version बनाओ/चुनो; copy=true तो मौजूदा की नकल (id बरकरार → slip-proof)
  function mrEnsureVersion(promptText, copyCurrent) {
    const m = ensureCat(mrCat);
    const cur = mrActiveVersion();
    const def = (cur && cur.date) || dateDMY();
    const raw = prompt(promptText + "\nEffective date (लागू-दिनांक) — DD/MM/YYYY:", def);
    if (raw === null) return null;
    const date = raw.trim() || def;
    let ver = m.versions.find((v) => v.date === date);
    if (!ver) {
      ver = { date, rows: copyCurrent && cur ? cur.rows.map((r) => Object.assign({}, r)) : [] }; // id बरकरार
      m.versions.push(ver);
      m.versions.sort((a, b) => dmyNum(b.date) - dmyNum(a.date)); // नया सबसे ऊपर
    }
    m.activeVersion = date;
    if (!m.loadedVersion) m.loadedVersion = date;
    return ver;
  }

  function openCategory(cat) { mrCat = cat; mrEditAll = false; mrRowEdit.clear(); mrSearch = ""; mrBitFilter = "all"; const si = document.getElementById("mrSearch"); if (si) si.value = ""; setActiveView("master-cat"); }
  function renderCat() { renderMachineRate(); } // setActiveView इसे call करता है

  // पंक्ति ऊपर/नीचे (sequence बदलें — id वही रहता, इसलिए link safe)
  function mrMoveRow(i, dir) {
    const v = mrActiveVersion(); if (!v) return;
    const j = i + dir;
    if (j < 0 || j >= v.rows.length) return;
    const t = v.rows[i]; v.rows[i] = v.rows[j]; v.rows[j] = t;
    saveMachine(); renderMachineRate();
  }

  function renderMachineRate() {
    const def = catDef(mrCat), m = ensureCat(mrCat);
    const tEl = document.getElementById("mrCatTitle"); if (tEl) tEl.textContent = def.name;
    const sEl = document.getElementById("mrCatSub"); if (sEl) sEl.textContent = def.name + " — Effective date अनुसार version; Rate Analysis 'Loaded' version से दर लेगा।";
    const secEl = document.getElementById("tbSection"); if (secEl) secEl.textContent = "Master Data › " + def.name;
    // Bitumen Rate — पूरी तरह custom UI (date-समूह; प्रकार+Refinery+Rate; add/remove/reorder; 2 reference)
    const isBit = (mrCat === "bitumen_rate");
    const gShow = (sel, on) => { const el = document.querySelector(sel); if (el) el.style.display = on ? "" : "none"; };
    const topHost = document.getElementById("mrExtraTop"); if (topHost && mrCat !== "material_query") topHost.innerHTML = "";   // Query Names सिर्फ़ Material Query में; अन्य श्रेणी में हटाओ
    ["#mrToolbar", "#mrVersions", "#mrExtra"].forEach((s) => gShow(s, !isBit));
    gShow("#view-master-cat .mr-searchbar", !isBit);
    gShow("#view-master-cat .data-table-wrap", !isBit);
    const dtw = document.querySelector("#view-master-cat .data-table-wrap"); if (dtw) dtw.classList.toggle("mr-full", mrCat === "material_query");   // Material Query — पूरी तालिका एक साथ (inner scroll हटाओ)
    const brHost = document.getElementById("bitRateHost"); if (brHost) brHost.style.display = isBit ? "" : "none";
    if (isBit) { const hb = document.getElementById("mrHint"); if (hb) hb.innerHTML = "हर <b>प्रभावी Date</b> = एक समूह; उसमें सभी Bitumen प्रकार + Refinery + Rate, और अंत में Bitumen व Emulsion के 2 Reference। Estimate बनाते समय चुनी Date की दरें लोड होती हैं।"; renderBitumenRateCat(); return; }
    const hEl = document.getElementById("mrHint");
    if (hEl) hEl.innerHTML = "Excel कॉलम-क्रम: <b>" + def.cols.map((c) => c.label).join(" · ") + "</b>. <b>📋 Excel से कई पंक्तियाँ copy करके किसी cell पर सीधे paste</b> कर सकते हैं (edit मोड में) — अपने-आप भर जाएँगी। हर पंक्ति का स्थायी ID होता है, इसलिए link slip नहीं होगा।";
    buildMrToolbar(m);
    buildMrVersions(m);
    const si = document.getElementById("mrSearch"); if (si && si.value !== mrSearch) si.value = mrSearch;
    const ver = mrActiveVersion();
    const tb = document.getElementById("mrTable");
    if (!tb) return;
    const q = (mrSearch || "").trim().toLowerCase();
    let html = "<thead><tr>";
    for (const c of def.cols) html += "<th" + (c.w ? " style='width:" + c.w + "'" : "") + ">" + c.label + "</th>";
    html += "<th style='width:" + (q ? "78px" : "150px") + "'>क्रिया</th></tr></thead><tbody>";
    let shown = 0;
    if (ver && ver.rows.length) {
      ver.rows.forEach((r, i) => {
        if (q && !def.cols.some((c) => String(r[c.key] == null ? "" : r[c.key]).toLowerCase().includes(q))) return; // खोज-filter
        if (mrCat === "bitumen_rate" && mrBitFilter !== "all") {   // Bitumen / Emulsion फ़िल्टर
          const isE = isEmulsionType(r.type);
          if ((mrBitFilter === "emulsion") !== isE) return;
        }
        shown++;
        const ed = mrRowEditable(r.id);
        html += "<tr" + (ed ? " class='row-edit'" : "") + ">";
        for (const c of def.cols) {
          const isCalc = !!c.calc;
          const val = isCalc ? c.calc(r) : (r[c.key] == null ? "" : String(r[c.key]));
          const cls = ((c.num ? "num" : "") + (isCalc ? " calc" : "")).trim();
          const ro = (isCalc || !ed) ? " readonly" : "";
          const optList = (arr, extra) => {   // val सहित dropdown विकल्प
            let o = "<option value=''>—</option>"; let has = false;
            (arr || []).forEach((nm) => { if (nm === val) has = true; o += "<option value=\"" + escapeHtml(nm) + "\"" + (nm === val ? " selected" : "") + ">" + escapeHtml(nm) + "</option>"; });
            if (val && !has) o += "<option value=\"" + escapeHtml(val) + "\" selected>" + escapeHtml(val) + (extra || " (सूची में नहीं)") + "</option>";
            return o;
          };
          // Material Query Rate का "Query Name" — edit मोड में Dropdown
          if (mrCat === "material_query" && c.key === "query_name" && ed) {
            html += "<td><select data-i='" + i + "' data-field='" + c.key + "' class='mr-qsel'>" + optList(m.queryNames || []) + "</select></td>";
          } else if (mrCat === "bitumen_rate" && c.key === "type" && ed) {   // Bitumen का प्रकार — Dropdown
            html += "<td><select data-i='" + i + "' data-field='" + c.key + "' class='mr-qsel'>" + optList(BITUMEN_TYPES) + "</select></td>";
          } else if (mrCat === "bitumen_rate" && c.key === "refinery" && ed) {   // Refinery — Dropdown (Cartage › Refinery Names)
            html += "<td><select data-i='" + i + "' data-field='" + c.key + "' class='mr-qsel'>" + optList(refineryNameList()) + "</select></td>";
          } else if (c.key === "desc" && ro) {   // Material Description (view मोड) — पूरा नाम wrap करके दिखाओ, कटे नहीं
            html += "<td class='mr-desc-cell'><div class='mr-desc-wrap'>" + escapeHtml(val) + "</div></td>";
          } else if (c.key === "desc") {   // Material Description (edit मोड) — wrap textarea (auto-height)
            html += "<td class='mr-desc-cell'><textarea data-i='" + i + "' data-field='" + c.key + "' class='mr-desc-edit' rows='1'>" + escapeHtml(val) + "</textarea></td>";
          } else {
            html += "<td><input data-i='" + i + "' data-field='" + c.key + "'" + (cls ? " class='" + cls + "'" : "") + ro +
              " value=\"" + escapeHtml(val) + "\" /></td>";
          }
        }
        html += "<td class='dt-act'>" + mrRowActions(r, i) + "</td></tr>";
      });
    }
    if (!ver || !ver.rows.length) html += "<tr><td colspan='" + (def.cols.length + 1) + "' class='dt-empty'>कोई data नहीं — <b>⬆ Excel से Insert</b> या <b>✚ मैनुअल</b> से भरें।</td></tr>";
    else if (!shown) html += "<tr><td colspan='" + (def.cols.length + 1) + "' class='dt-empty'>\"" + escapeHtml(mrSearch) + "\" से कोई मेल नहीं मिला।</td></tr>";
    html += "</tbody>";
    tb.innerHTML = html;
    wireMrTable(tb);
    buildMrExtra();
  }

  // श्रेणी-विशेष अतिरिक्त UI (Cartage Calculator, Material Query → Query Names सूची)
  function buildMrExtra() {
    const ex = document.getElementById("mrExtra"); if (!ex) return;
    const top = document.getElementById("mrExtraTop"); if (top) top.innerHTML = "";   // सिर्फ़ material_query में भरता है
    if (mrCat === "material_query") { ex.innerHTML = ""; if (top) buildQueryNamesPanel(top); return; }   // Query Names — तालिका के ऊपर
    if (mrCat === "bitumen_rate") { buildBitumenRatePanel(ex); return; }
    if (mrCat === "bitumen_rate") { buildBitumenRatePanel(ex); return; }
    if (mrCat !== "cartage") { ex.innerHTML = ""; return; }
    const cm = ensureCat("cartage");
    const cdesc = cm.description || "";
    const rnames = Array.isArray(cm.refineryNames) ? cm.refineryNames : [];
    const bc = cm.bitumenCartage || { desc: "Bitumen Cartage" };
    const lu = cm.loadingUnloading || {};
    const luDesc = lu.desc || "";
    const luLoad = (lu.loadRate != null && lu.loadRate !== "") ? String(lu.loadRate) : "";
    const luUnload = (lu.unloadRate != null && lu.unloadRate !== "") ? String(lu.unloadRate) : "";
    const av = mrActiveVersion();   // Bitumen Cartage दर इसी (देखी जा रही) version में सहेजी जाती है
    // Including (user भरता है): पहले इस version से, वरना पुराना category-level; Excluding = Including ÷ 1.10 अपने-आप
    const bcIncl = (av && av.bitInclRate != null && String(av.bitInclRate).trim() !== "") ? String(av.bitInclRate)
      : (bc.rateIncl != null && String(bc.rateIncl).trim() !== "" ? String(bc.rateIncl)
        : (bc.rate != null && String(bc.rate).trim() !== "" ? nf(round2(mrNum(bc.rate) * 1.10)) : ""));
    const bcExcl = (mrNum(bcIncl) > 0) ? round2(mrNum(bcIncl) / 1.10).toFixed(2) : "";
    const bcVerNote = av
      ? ("दर version <b>" + escapeHtml(av.date) + "</b> में सहेजी जाएगी" + (cm.loadedVersion === av.date ? " · यही Loaded है ✓ (Bitumen Analysis इसी को लेता है)" : (cm.loadedVersion ? " ⚠ Bitumen Analysis <b>Loaded (" + escapeHtml(cm.loadedVersion) + ")</b> version की दर लेता है — इसे Load करें" : " — इसे 📥 Load करें ताकि Bitumen Analysis इसे ले")))
      : "कोई version नहीं — पहले एक Cartage version बनाएँ/Load करें।";
    ex.innerHTML =
      // (1) slabwise आइटम का Description — एक ही बार
      "<div class='panel-card pc-slab'>" +
        "<h3>📝 Cartage आइटम (slabwise) — Description</h3>" +
        "<p class='view-sub' style='margin:0 0 8px'>slabwise दरें (From/To/Rate per km) <b>ऊपर की तालिका</b> में हैं — यह बॉक्स सिर्फ़ उस एक आइटम का नाम है (जैसे: Aggregate and Coarse Sand)।</p>" +
        "<input type='text' id='cgDesc' class='mr-item-desc' placeholder='जैसे: Aggregate and Coarse Sand' value=\"" + escapeHtml(cdesc) + "\" />" +
        "<div style='margin-top:8px; display:flex; gap:8px; flex-wrap:wrap'>" +
          "<button class='btn sm' id='cgShowSlab'>📋 Slabwise डाटा दिखाएं</button>" +
        "</div>" +
        "<div id='cgSlabView' style='display:none; margin-top:10px'></div>" +
      "</div>" +
      // (1b) Loading/Unloading Charges — केवल आइटम का Description
      "<div class='panel-card pc-loadunload'>" +
        "<h3>🏗️ Loading/Unloading Charges</h3>" +
        "<p class='view-sub' style='margin:0 0 8px'>इस आइटम का नाम/विवरण, और प्रति-Cum <b>Loading</b> व <b>Unloading</b> दरें भरें। Rate Analysis में यही दरें ली जा सकती हैं।</p>" +
        "<div class='bc-row'>" +
          "<label class='bc-grow'>Description<input type='text' id='luDesc' placeholder='जैसे: Loading and Unloading of Material' value=\"" + escapeHtml(luDesc) + "\" /></label>" +
        "</div>" +
        "<div class='lu-rates'>" +
          "<div class='lu-row'><span class='lu-lbl'>Loading Charges per Cum</span><input type='text' id='luLoad' class='num' placeholder='₹ / Cum' value=\"" + escapeHtml(luLoad) + "\" /></div>" +
          "<div class='lu-row'><span class='lu-lbl'>Unloading Charges per Cum</span><input type='text' id='luUnload' class='num' placeholder='₹ / Cum' value=\"" + escapeHtml(luUnload) + "\" /></div>" +
        "</div>" +
      "</div>" +
      // (2) Bitumen Cartage — अलग आइटम, प्रति-km दर
      "<div class='panel-card pc-bitcartage'>" +
        "<h3>🛢️ Bitumen Cartage — प्रति-km दर</h3>" +
        "<p class='view-sub' style='margin:0 0 8px'>“Rate Including Contractor Profit” भरें — “Excluding” = Including ÷ 1.10 (2 दशमलव) अपने-आप। यही <b>Excluding</b> मान <b>Bitumen Rate Analysis</b> की Cartage Rate में जाता है (Primary Rate की <b>Loaded</b> version से live-linked)।</p>" +
        "<div class='bc-row'>" +
          "<label class='bc-grow'>Description<input type='text' id='bcDesc' value=\"" + escapeHtml(bc.desc || "Bitumen Cartage") + "\" /></label>" +
          "<label>Rate Including Contractor Profit (₹/km)<input type='text' id='bcRateIncl' placeholder='जैसे 2.09' value=\"" + escapeHtml(bcIncl) + "\" /></label>" +
          "<label>Rate Excluding Contractor Profit (₹/km)<input type='text' id='bcRateExcl' class='num' readonly title='Including ÷ 1.10' value=\"" + escapeHtml(bcExcl) + "\" /></label>" +
        "</div>" +
        "<p class='view-sub' style='margin:6px 0 0'>" + bcVerNote + "</p>" +
      "</div>" +
      // (Refinery Names अब Master › Bitumen Rate सेक्शन के सबसे ऊपर है)
      // (3) Cartage Calculator (slabwise)
      "<div class='panel-card mr-calc'>" +
      "<h3>🚚 Cartage Calculator — इस version के Range से</h3>" +
      "<div class='calc-row'><label>दूरी (km)<input type='text' id='cgKm' placeholder='जैसे 13' /></label>" +
      "<button class='btn sm primary' id='cgCalc'>गणना करें</button></div>" +
      "<div id='cgResult' class='calc-result muted'>दूरी (km) डालकर ‘गणना करें’ दबाएँ।</div></div>";
    // Description व Bitumen Cartage दर — बदलते ही सुरक्षित रूप से save (slabwise rows कभी न मिटें)
    const cgD = document.getElementById("cgDesc");
    if (cgD) cgD.addEventListener("change", () => { cm.description = cgD.value.trim(); saveCartageMeta(); status("Cartage Description सहेजा"); });
    const luD = document.getElementById("luDesc");
    if (luD) luD.addEventListener("change", () => { cm.loadingUnloading = Object.assign({}, cm.loadingUnloading, { desc: luD.value.trim() }); saveCartageMeta(); status("Loading/Unloading Description सहेजा"); });
    const luLoadEl = document.getElementById("luLoad");
    if (luLoadEl) luLoadEl.addEventListener("change", () => { const v = mrNum(luLoadEl.value); cm.loadingUnloading = Object.assign({}, cm.loadingUnloading, { loadRate: v > 0 ? v : "" }); saveCartageMeta(); status("Loading Charges सहेजा: ₹" + nf(v) + "/Cum"); });
    const luUnloadEl = document.getElementById("luUnload");
    if (luUnloadEl) luUnloadEl.addEventListener("change", () => { const v = mrNum(luUnloadEl.value); cm.loadingUnloading = Object.assign({}, cm.loadingUnloading, { unloadRate: v > 0 ? v : "" }); saveCartageMeta(); status("Unloading Charges सहेजा: ₹" + nf(v) + "/Cum"); });
    const bcInclEl = document.getElementById("bcRateIncl"), bcExclEl = document.getElementById("bcRateExcl");
    const recompute = () => { const v = mrNum(bcInclEl.value); if (bcExclEl) bcExclEl.value = v > 0 ? round2(v / 1.10).toFixed(2) : ""; };
    const saveBc = () => {
      const v = mrNum(bcInclEl.value);
      // Description category-level; Including दर उसी version में जिसे देख रहे हैं (Primary Rate → loaded से link)
      cm.bitumenCartage = Object.assign({}, cm.bitumenCartage, { desc: (document.getElementById("bcDesc").value || "").trim() || "Bitumen Cartage" });
      const cv = mrActiveVersion();
      if (cv) { cv.bitInclRate = v > 0 ? v : ""; }
      else { cm.bitumenCartage.rateIncl = v > 0 ? v : ""; cm.bitumenCartage.rateExcl = v > 0 ? round2(v / 1.10) : ""; }
      saveCartageMeta();
      status("Bitumen Cartage दर सहेजी" + (cv ? " (version " + cv.date + ")" : "") + " · Excl = " + (v > 0 ? round2(v / 1.10).toFixed(2) : "—"));
    };
    const bcD = document.getElementById("bcDesc"); if (bcD) bcD.addEventListener("change", saveBc);
    if (bcInclEl) { bcInclEl.addEventListener("input", recompute); bcInclEl.addEventListener("change", saveBc); }
    const cgShow = document.getElementById("cgShowSlab");
    if (cgShow) cgShow.addEventListener("click", () => {
      const box = document.getElementById("cgSlabView"); if (!box) return;
      if (box.style.display === "none") { box.style.display = "block"; renderCartageSlabView(); cgShow.textContent = "🔽 Slabwise डाटा छिपाएं"; }
      else { box.style.display = "none"; cgShow.textContent = "📋 Slabwise डाटा दिखाएं"; }
    });
    // ✎ सभी Edit on होते ही Slabwise डाटा अपने-आप खुल जाए (संपादन ऊपर की तालिका में on रहता है)
    if (mrEditAll) { const box = document.getElementById("cgSlabView"); if (box) { box.style.display = "block"; renderCartageSlabView(); if (cgShow) cgShow.textContent = "🔽 Slabwise डाटा छिपाएं"; } }
    const run = () => {
      const ver = mrActiveVersion();
      const res = document.getElementById("cgResult");
      const km = mrNum(document.getElementById("cgKm").value);
      if (!ver || !ver.rows.length) { res.className = "calc-result muted"; res.textContent = "पहले Range data भरें।"; return; }
      if (km <= 0) { res.className = "calc-result muted"; res.textContent = "सही दूरी (km) डालें।"; return; }
      // RMR वाले Cartage कार्ड जैसा ही पूरा विवरण (compact slab + Cartage Kachha + Net Total without CP)
      const bd = cartageBreakdown(km);
      res.className = "calc-result";
      res.innerHTML = "<div class='cbk-cards'>" + cartageBreakHTML({ query: "गणना", distance: km, bd: bd }) + "</div>";
    };
    const btn = document.getElementById("cgCalc"); if (btn) btn.addEventListener("click", run);
    const inp = document.getElementById("cgKm"); if (inp) inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); run(); } });
  }

  // Bitumen Rate — View फ़िल्टर (Bitumen / Emulsion) + मदद
  function buildBitumenRatePanel(ex) {
    const mk = (key, label) => "<button class='btn sm" + (mrBitFilter === key ? " primary" : "") + "' data-bf='" + key + "'>" + label + "</button>";
    ex.innerHTML =
      "<div class='panel-card'>" +
        "<h3>👁 View — Bitumen / Emulsion</h3>" +
        "<p class='view-sub' style='margin:0 0 8px'>प्रभावी <b>Date = version</b> (ऊपर version चुनें/बनाएँ)। हर प्रकार के आगे उसका Refinery, Unit व Rate भरें। नीचे से केवल Bitumen या केवल Emulsion देखें।</p>" +
        "<div style='display:flex; gap:8px; flex-wrap:wrap'>" + mk("all", "सभी") + mk("bitumen", "🛢️ Bitumen Rate") + mk("emulsion", "🧴 Emulsion Rate") + "</div>" +
        "<p class='view-sub' style='margin:8px 0 0'>Refinery की सूची <b>Cartage Rate › Refinery Names</b> से आती है। यही दरें Estimate बनाते समय (चुनी Date की) लोड की जा सकती हैं।</p>" +
      "</div>";
    ex.querySelectorAll("[data-bf]").forEach((b) => b.addEventListener("click", () => { mrBitFilter = b.dataset.bf; renderMachineRate(); }));
  }
  /* ── Bitumen Rate — custom editor (Date-समूह; प्रकार+Refinery+Rate; Lock; Filter; 2 Reference) ── */
  function bitVer(date) { const m = ensureCat("bitumen_rate"); return (m.versions || []).find((v) => v.date === date); }
  function saveBitRate() { saveCat("bitumen_rate"); renderMasterOverview(); }
  // Refinery Names (global — cartage.refineryNames में) जोड़ें/सुनिश्चित करें
  function addRefineryName(nm) { nm = (nm || "").trim(); if (!nm) return false; const m = ensureCat("cartage"); if (!Array.isArray(m.refineryNames)) m.refineryNames = []; if (m.refineryNames.some((x) => x.toLowerCase() === nm.toLowerCase())) return false; m.refineryNames.push(nm); saveCat("cartage"); return true; }
  function ensureRefineryName(nm) { nm = (nm || "").trim(); if (nm && !refineryNameList().some((x) => x === nm)) addRefineryName(nm); }
  // Bitumen→Mathura, Emulsion→Panipat — पर केवल तभी जब वह नाम सूची में मौजूद हो (वरना खाली; कोई phantom नहीं)
  function defaultRefineryFor(type) { const want = isEmulsionType(type) ? "Panipat" : "Mathura"; return refineryNameList().some((x) => x === want) ? want : ""; }
  // कोई Refinery नाम कहाँ-कहाँ उपयोग में है — मानव-पठनीय विवरण (न हो तो ""; तभी delete की अनुमति)
  //  केवल *मौजूदा* प्रकारों की data देखी जाती है (मिटाए प्रकार की orphan data नहीं)
  function refineryUseWhere(name) {
    if (!name) return "";
    const where = [];
    const m = state.master["bitumen_rate"];
    if (m && Array.isArray(m.versions)) {
      const liveIds = Array.isArray(m.bitTypes) ? m.bitTypes.map((t) => t.id) : [];
      const dates = [];
      for (const v of m.versions) { const data = v.data || {}; if (liveIds.some((id) => data[id] && data[id].refinery === name)) dates.push(v.date); }
      if (dates.length) where.push("Bitumen Rate की तारीख़ें — " + dates.join(", "));
    }
    const ests = [];
    for (const id in state.estimates) { const e = state.estimates[id]; if (e && Array.isArray(e.bitumenCartage) && e.bitumenCartage.some((x) => x.refinery === name)) ests.push(e.name || id); }
    if (ests.length) where.push("Estimate — " + ests.join(", "));
    return where.join("  ·  ");
  }
  // Bitumen प्रकार (category) साझा — सभी तारीखों में एक ही सूची; हर तारीख में सिर्फ़ Rate अलग (rates{typeId:rate})
  //  पुराने per-version rows को इस मॉडल में migrate करता है
  //  मॉडल: m.bitTypes = [{id,type}] (केवल प्रकार साझा) · हर version.data = {typeId:{refinery,unit,rate,side}} (per-date)
  function ensureBitTypes(m) {
    const versions = m.versions || [];
    // (A) बहुत पुराना: versions में .rows → साझा प्रकार + per-version data
    if (!Array.isArray(m.bitTypes)) {
      const src = versions.find((v) => Array.isArray(v.rows) && v.rows.length);
      const baseRows = src ? src.rows : BITUMEN_TYPES.map((t) => ({ type: t, unit: "Per Mt", refinery: defaultRefineryFor(t), side: "Both Side" }));
      m.bitTypes = baseRows.map((r) => ({ id: uid("btype"), type: r.type || "" }));
      versions.forEach((v) => {
        const data = {};
        (v.rows || []).forEach((r, i) => { if (m.bitTypes[i]) data[m.bitTypes[i].id] = { refinery: r.refinery || "", unit: (r.unit && String(r.unit).trim()) ? r.unit : "Per Mt", rate: r.rate != null ? r.rate : "", side: r.side || "Both Side" }; });
        v.data = data; delete v.rows; delete v.rates;
      });
    }
    // (B) पुराना "साझा refinery/unit/side": उन्हें हर version के data में कॉपी करो, bitTypes में सिर्फ़ type रखो
    else if (m.bitTypes.some((t) => t.refinery !== undefined || t.unit !== undefined || t.side !== undefined)) {
      versions.forEach((v) => {
        const data = v.data || {};
        m.bitTypes.forEach((bt) => {
          const d = data[bt.id] || (data[bt.id] = {});
          if (d.refinery == null) d.refinery = bt.refinery || "";
          if (d.unit == null || String(d.unit).trim() === "") d.unit = bt.unit || "Per Mt";
          if (d.side == null || String(d.side).trim() === "") d.side = bt.side || "Both Side";
          if (d.rate == null) d.rate = (v.rates || {})[bt.id] != null ? v.rates[bt.id] : "";
        });
        v.data = data; delete v.rates;
      });
      m.bitTypes = m.bitTypes.map((bt) => ({ id: bt.id, type: bt.type || "" }));
    }
    // (C) सुनिश्चित करो: हर version के data में हर प्रकार मौजूद; और मिटाए-गए प्रकारों की orphan data हटाओ
    const liveIds = {}; m.bitTypes.forEach((bt) => { liveIds[bt.id] = true; });
    versions.forEach((v) => {
      if (!v.data) v.data = {};
      m.bitTypes.forEach((bt) => { if (!v.data[bt.id]) v.data[bt.id] = { refinery: "", unit: "Per Mt", rate: "", side: "Both Side" }; });
      for (const id in v.data) { if (!liveIds[id]) delete v.data[id]; }   // orphan (मिटाए प्रकार की बची data) साफ़ करो
      if (v.rates) delete v.rates; if (v.rows) delete v.rows;
    });
    return m.bitTypes;
  }
  function bitData(v, bid) { return (v && v.data && v.data[bid]) ? v.data[bid] : {}; }
  // Year → Month → Date filter (देखने के लिए)
  let bitF = { year: "", month: "", date: "" };
  function parseDMY(s) { const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s || ""); return m ? { d: +m[1], mo: +m[2], y: +m[3] } : null; }
  function bitPassesFilter(date) { const p = parseDMY(date); if (!p) return true; if (bitF.year && String(p.y) !== bitF.year) return false; if (bitF.month && String(p.mo) !== bitF.month) return false; if (bitF.date && date !== bitF.date) return false; return true; }
  const MONTH_NM = ["", "जनवरी", "फ़रवरी", "मार्च", "अप्रैल", "मई", "जून", "जुलाई", "अगस्त", "सितंबर", "अक्टूबर", "नवंबर", "दिसंबर"];
  // प्रभावी Date चुनने का styled popup — तारीख/महीना/वर्ष के 3 dropdown (डिफ़ॉल्ट: आज)
  function openBitDatePicker(defaultDMY, title, onOk) {
    const now = new Date();
    const p = parseDMY(defaultDMY) || { d: now.getDate(), mo: now.getMonth() + 1, y: now.getFullYear() };
    const nowY = now.getFullYear();
    const dayOpts = Array.from({ length: 31 }, (_, i) => i + 1).map((n) => "<option value='" + n + "'" + (n === p.d ? " selected" : "") + ">" + String(n).padStart(2, "0") + "</option>").join("");
    const moOpts = Array.from({ length: 12 }, (_, i) => i + 1).map((n) => "<option value='" + n + "'" + (n === p.mo ? " selected" : "") + ">" + MONTH_NM[n] + "</option>").join("");
    let yrOpts = ""; for (let y = nowY + 2; y >= nowY - 8; y--) yrOpts += "<option value='" + y + "'" + (y === p.y ? " selected" : "") + ">" + y + "</option>";
    const ov = document.createElement("div"); ov.className = "modal-overlay";
    ov.innerHTML = "<div class='modal'><h3>📅 " + escapeHtml(title || "प्रभावी Date") + "</h3>" +
      "<p class='sub'>तारीख · महीना · वर्ष चुनें — डिफ़ॉल्ट में आज की तारीख है, बदल सकते हैं।</p>" +
      "<div class='bit-dp-row'>" +
        "<label>तारीख<select id='dpDay'>" + dayOpts + "</select></label>" +
        "<label>महीना<select id='dpMonth'>" + moOpts + "</select></label>" +
        "<label>वर्ष<select id='dpYear'>" + yrOpts + "</select></label>" +
      "</div>" +
      "<div class='row'><button class='btn' id='dpCancel'>रद्द</button><button class='btn primary' id='dpOk'>बनाएँ</button></div></div>";
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.querySelector("#dpCancel").addEventListener("click", close);
    ov.addEventListener("mousedown", (e) => { if (e.target === ov) close(); });
    ov.querySelector("#dpOk").addEventListener("click", () => {
      const dd = String(ov.querySelector("#dpDay").value).padStart(2, "0");
      const mm = String(ov.querySelector("#dpMonth").value).padStart(2, "0");
      const yy = ov.querySelector("#dpYear").value;
      close(); onOk(dd + "/" + mm + "/" + yy);
    });
  }

  //  bt = साझा प्रकार {id,type}; vd = इस तारीख का per-type data {refinery,unit,rate,side}
  function bitRowHtml(date, bt, ri, vd, locked) {
    vd = vd || {};
    const d = escapeHtml(date), bid = escapeHtml(bt.id);
    const unit = (vd.unit != null && String(vd.unit).trim() !== "") ? vd.unit : "Per Mt";
    const side = vd.side || "Both Side"; const refinery = vd.refinery || ""; const rate = vd.rate;
    if (locked) {
      return "<tr><td class='bit-sn'>" + (ri + 1) + "</td><td>" + escapeHtml(bt.type || "—") + "</td><td>" + escapeHtml(unit) + "</td><td>" + escapeHtml(refinery || "—") + "</td><td>" + escapeHtml(side) + "</td><td class='num'>" + (rate != null && String(rate).trim() !== "" ? escapeHtml(String(rate)) : "0") + "</td><td class='dt-act'>🔒</td></tr>";
    }
    const rl = refineryNameList();
    let ropts = "<option value=''>— Refinery —</option>" + rl.map((nm) => "<option value=\"" + escapeHtml(nm) + "\"" + (nm === refinery ? " selected" : "") + ">" + escapeHtml(nm) + "</option>").join("");
    if (refinery && !rl.some((nm) => nm === refinery)) ropts += "<option value=\"" + escapeHtml(refinery) + "\" selected>" + escapeHtml(refinery) + "</option>";
    return "<tr>" +
      "<td class='bit-sn'>" + (ri + 1) + "</td>" +
      "<td><input class='bit-rtype' data-bid='" + bid + "' value=\"" + escapeHtml(bt.type || "") + "\" placeholder='प्रकार लिखें' title='प्रकार सभी तारीखों में साझा' /></td>" +
      "<td><input class='bit-runit' data-d=\"" + d + "\" data-bid='" + bid + "' value=\"" + escapeHtml(unit) + "\" placeholder='Per Mt' /></td>" +
      "<td><select class='mr-qsel bit-rref' data-d=\"" + d + "\" data-bid='" + bid + "'>" + ropts + "</select></td>" +
      "<td><select class='mr-qsel bit-rside' data-d=\"" + d + "\" data-bid='" + bid + "'><option value='Both Side'" + (side === "Both Side" ? " selected" : "") + ">Both Side</option><option value='One Side'" + (side === "One Side" ? " selected" : "") + ">One Side</option></select></td>" +
      "<td><input class='num bit-rrate' data-d=\"" + d + "\" data-bid='" + bid + "' value=\"" + escapeHtml(rate != null ? String(rate) : "") + "\" placeholder='0' /></td>" +
      "<td class='dt-act'><button class='mini bit-rup' data-bid='" + bid + "' title='सभी तारीखों में ऊपर'>▲</button><button class='mini bit-rdown' data-bid='" + bid + "' title='सभी तारीखों में नीचे'>▼</button><button class='mini danger bit-rdel' data-bid='" + bid + "' title='सभी तारीखों से हटाएँ'>🗑</button></td>" +
      "</tr>";
  }
  function bitRefHtml(v, kind, locked) {
    const ref = kind === "bit" ? v.bitRef : v.emuRef;
    if (ref && ref.data) return "📎 " + escapeHtml(ref.name || "reference") +
      " <button class='btn xs bit-refview' data-d=\"" + escapeHtml(v.date) + "\" data-kind='" + kind + "'>👁 देखें</button>" +
      " <a class='btn xs' href=\"" + ref.data + "\" download=\"" + escapeHtml(ref.name || "reference") + "\">⬇</a>" +
      (locked ? "" : " <button class='btn xs danger bit-refdel' data-d=\"" + escapeHtml(v.date) + "\" data-kind='" + kind + "'>✕</button>");
    return locked ? "<span class='muted'>—</span>" : "<label class='btn xs bit-refup'>⬆ Upload<input type='file' class='bit-reffile' data-d=\"" + escapeHtml(v.date) + "\" data-kind='" + kind + "' hidden /></label>";
  }
  function bitGroupHtml(v) {
    const d = escapeHtml(v.date), locked = !!v.locked;
    const m = ensureCat("bitumen_rate"); const bts = ensureBitTypes(m);
    const rows = bts.map((bt, ri) => bitRowHtml(v.date, bt, ri, bitData(v, bt.id), locked)).join("");
    const acts = locked
      ? "<button class='btn xs primary bit-lock' data-d=\"" + d + "\">🔓 बदलें (Unlock)</button>"
      : "<button class='btn xs bit-lock' data-d=\"" + d + "\" title='सुरक्षित करें — गलती से बदलाव न हो'>🔒 Save/Lock</button>" +
        "<button class='btn xs bit-addtype' data-d=\"" + d + "\">➕ Bitumen जोड़ें</button>" +
        "<button class='btn xs bit-editdate' data-d=\"" + d + "\">✎ Date</button>" +
        "<button class='btn xs danger bit-delgroup' data-d=\"" + d + "\">🗑 समूह</button>";
    return "<div class='bit-group" + (locked ? " locked" : "") + "'>" +
      "<div class='bit-group-head'><b>📅 प्रभावी Date: " + d + (locked ? " <span class='bit-lockbadge'>🔒 Locked</span>" : "") + "</b><span class='bit-group-acts'>" + acts + "</span></div>" +
      "<table class='data-table bit-group-table'><thead><tr><th style='width:52px'>क्रम</th><th>Bitumen का प्रकार</th><th style='width:90px'>इकाई (Unit)</th><th style='width:160px'>Refinery</th><th style='width:120px'>Both/One Side</th><th style='width:120px'>Rate per Unit (₹)</th><th style='width:110px'>क्रिया</th></tr></thead><tbody>" +
        (rows || "<tr><td colspan='7' class='dt-empty'>कोई प्रकार नहीं — ➕ Bitumen जोड़ें</td></tr>") + "</tbody></table>" +
      "<div class='bit-refs'><div class='bit-ref-item'><b>Bitumen Reference:</b> " + bitRefHtml(v, "bit", locked) + "</div>" +
        "<div class='bit-ref-item'><b>Emulsion Reference:</b> " + bitRefHtml(v, "emu", locked) + "</div></div>" +
      "</div>";
  }
  function renderBitumenRateCat() {
    const host = document.getElementById("bitRateHost"); if (!host) return;
    const m = ensureCat("bitumen_rate");
    const versions = (m.versions || []);
    // (सबसे ऊपर) Refinery Names — जोड़ें/हटाएँ (Cartage से यहाँ स्थानांतरित)
    const rl = refineryNameList();
    let h = "<div class='panel-card qn-panel'><div class='qn-top'><h3>🏭 Refinery Names</h3>" +
      "<input type='text' id='rfNew' placeholder='नया Refinery Name… (जैसे Mathura, Panipat)' />" +
      "<button class='btn sm primary' id='rfAdd'>➕ जोड़ें</button></div>" +
      "<div class='qn-list'>" + (rl.length ? rl.map((nm, idx) => "<span class='qn-item'>" + escapeHtml(nm) + "<button class='qn-del' data-rf='" + idx + "' title='हटाएँ'>×</button></span>").join("") : "<span class='muted' style='font-size:12px'>अभी कोई Refinery Name नहीं।</span>") + "</div>" +
      "<p class='view-sub' style='margin:6px 0 0'>ये नाम नीचे प्रकार-वार Refinery dropdown व Estimate के Bitumen Cartage विवरण में उपयोग होते हैं।</p></div>";
    // Filter (Year → Month → Date)
    const parsed = versions.map((v) => ({ date: v.date, p: parseDMY(v.date) })).filter((x) => x.p);
    const years = Array.from(new Set(parsed.map((x) => x.p.y))).sort((a, b) => b - a);
    const months = Array.from(new Set(parsed.filter((x) => !bitF.year || String(x.p.y) === bitF.year).map((x) => x.p.mo))).sort((a, b) => a - b);
    const dates = parsed.filter((x) => (!bitF.year || String(x.p.y) === bitF.year) && (!bitF.month || String(x.p.mo) === bitF.month))
      .sort((a, b) => dmyNum(a.date) - dmyNum(b.date)).map((x) => x.date);   // सबसे पुरानी पहले, नई बाद में
    h += "<div class='panel-card bit-filter'><h3>🔎 Filter (देखने के लिए)</h3><div class='bit-filter-row'>" +
      "<label>वर्ष<select id='bfYear'><option value=''>सभी</option>" + years.map((y) => "<option value='" + y + "'" + (bitF.year === String(y) ? " selected" : "") + ">" + y + "</option>").join("") + "</select></label>" +
      "<label>महीना<select id='bfMonth'><option value=''>सभी</option>" + months.map((mo) => "<option value='" + mo + "'" + (bitF.month === String(mo) ? " selected" : "") + ">" + MONTH_NM[mo] + "</option>").join("") + "</select></label>" +
      "<label>तारीख<select id='bfDate'><option value=''>सभी</option>" + dates.map((dt) => "<option value=\"" + escapeHtml(dt) + "\"" + (bitF.date === dt ? " selected" : "") + ">" + escapeHtml(dt) + "</option>").join("") + "</select></label>" +
      "<button class='btn xs' id='bfClear'>साफ़</button></div></div>";
    // Toolbar + groups
    h += "<div class='master-toolbar'><button class='btn primary' id='brNew'>➕ नया Rate भरें</button>" +
      "<span class='view-sub' style='align-self:center'>हर 'नया Rate' = एक प्रभावी Date का समूह। भरने के बाद 🔒 Save/Lock करें।</span></div>";
    const shown = versions.filter((v) => bitPassesFilter(v.date));
    h += shown.length ? shown.map(bitGroupHtml).join("") : (versions.length ? "<div class='muted-row'>इस फ़िल्टर में कोई Rate नहीं — 'साफ़' दबाएँ।</div>" : "<div class='muted-row'>अभी कोई Rate नहीं — '➕ नया Rate भरें' से पहली प्रभावी Date जोड़ें।</div>");
    host.innerHTML = h;
    wireBitumenRateCat(host);
  }
  function wireBitumenRateCat(host) {
    // Refinery Names
    const rfAddBtn = host.querySelector("#rfAdd"), rfNew = host.querySelector("#rfNew");
    const doRfAdd = () => { const nm = (rfNew.value || "").trim(); if (!nm) return; if (addRefineryName(nm)) { renderBitumenRateCat(); status("Refinery जुड़ा: " + nm); } else status("यह Refinery पहले से है"); };
    if (rfAddBtn) rfAddBtn.addEventListener("click", doRfAdd);
    if (rfNew) rfNew.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doRfAdd(); } });
    host.querySelectorAll("[data-rf]").forEach((b) => b.addEventListener("click", () => {
      const m = ensureCat("cartage"); const name = (m.refineryNames || [])[+b.dataset.rf];
      const where = refineryUseWhere(name);
      if (where) { alert("Refinery '" + name + "' अभी यहाँ उपयोग में है —\n" + where + "\n\nपहले वहाँ से हटाएँ/बदलें, तभी यह delete होगी।"); return; }
      (m.refineryNames || []).splice(+b.dataset.rf, 1); saveCat("cartage"); renderBitumenRateCat(); status("Refinery हटाया: " + (name || ""));
    }));
    // Filter
    const bfY = host.querySelector("#bfYear"), bfM = host.querySelector("#bfMonth"), bfD = host.querySelector("#bfDate"), bfC = host.querySelector("#bfClear");
    if (bfY) bfY.addEventListener("change", () => { bitF.year = bfY.value; bitF.month = ""; bitF.date = ""; renderBitumenRateCat(); });
    if (bfM) bfM.addEventListener("change", () => { bitF.month = bfM.value; bitF.date = ""; renderBitumenRateCat(); });
    if (bfD) bfD.addEventListener("change", () => { bitF.date = bfD.value; renderBitumenRateCat(); });
    if (bfC) bfC.addEventListener("click", () => { bitF = { year: "", month: "", date: "" }; renderBitumenRateCat(); });
    // नया Rate — styled date-picker; default Refinery: Bitumen→Mathura, Emulsion→Panipat; Unit "Per Mt"
    const brNew = host.querySelector("#brNew");
    if (brNew) brNew.addEventListener("click", () => openBitDatePicker(dateDMY(), "नया Rate — प्रभावी Date", (date) => {
      const m = ensureCat("bitumen_rate"); const bts = ensureBitTypes(m);
      if ((m.versions || []).some((v) => v.date === date)) { alert("इस Date का समूह पहले से है।"); return; }
      if (!Array.isArray(m.versions)) m.versions = [];
      const prev = m.versions.slice().sort((a, b) => dmyNum(b.date) - dmyNum(a.date))[0];   // नवीनतम मौजूदा तारीख से refinery/unit/side कॉपी
      const data = {}; bts.forEach((t) => { const pd = prev ? bitData(prev, t.id) : {}; data[t.id] = { refinery: pd.refinery || defaultRefineryFor(t.type), unit: pd.unit || "Per Mt", side: pd.side || "Both Side", rate: "" }; });
      m.versions.push({ date: date, data: data, bitRef: null, emuRef: null, locked: false });   // प्रकार साझा; इस तारीख का data अलग (Rate खाली)
      m.versions.sort((a, b) => dmyNum(b.date) - dmyNum(a.date));
      m.activeVersion = date; m.loadedVersion = date;
      saveBitRate(); renderBitumenRateCat(); status("नई प्रभावी Date जोड़ी: " + date);
    }));
    // Lock / Unlock
    host.querySelectorAll(".bit-lock").forEach((b) => b.addEventListener("click", () => { const v = bitVer(b.dataset.d); if (!v) return; v.locked = !v.locked; saveBitRate(); renderBitumenRateCat(); status(v.locked ? "समूह Lock हुआ (सुरक्षित)" : "समूह बदलाव हेतु खुला"); }));
    // ➕ Bitumen जोड़ें — नया प्रकार नाम लिखकर जोड़ें; साझा सूची में जुड़ता है → सभी तारीखों में (Rate खाली)
    host.querySelectorAll(".bit-addtype").forEach((b) => b.addEventListener("click", () => {
      const v = bitVer(b.dataset.d); if (v && v.locked) return;
      const nm = prompt("नया Bitumen/Emulsion प्रकार का नाम लिखें:", ""); if (nm === null) return; const name = nm.trim(); if (!name) return;
      const m = ensureCat("bitumen_rate"); const bts = ensureBitTypes(m);
      if (bts.some((t) => (t.type || "").trim().toLowerCase() === name.toLowerCase())) { alert("यह प्रकार पहले से है।"); return; }
      const nid = uid("btype"); bts.push({ id: nid, type: name });
      (m.versions || []).forEach((vv) => { if (!vv.data) vv.data = {}; vv.data[nid] = { refinery: defaultRefineryFor(name), unit: "Per Mt", rate: "", side: "Both Side" }; });
      saveBitRate(); renderBitumenRateCat(); status("प्रकार जुड़ा (सभी तारीखों में; Refinery/Rate हर तारीख अलग): " + name);
    }));
    host.querySelectorAll(".bit-editdate").forEach((b) => b.addEventListener("click", () => {
      const v = bitVer(b.dataset.d); if (!v || v.locked) return;
      openBitDatePicker(v.date, "Date बदलें", (nd) => {
        const m = ensureCat("bitumen_rate"); if (!nd || nd === v.date) return;
        if (m.versions.some((x) => x.date === nd)) { alert("यह Date पहले से है।"); return; }
        if (m.activeVersion === v.date) m.activeVersion = nd; if (m.loadedVersion === v.date) m.loadedVersion = nd;
        v.date = nd; m.versions.sort((a, c) => dmyNum(c.date) - dmyNum(a.date)); saveBitRate(); renderBitumenRateCat();
      });
    }));
    host.querySelectorAll(".bit-delgroup").forEach((b) => b.addEventListener("click", () => {
      const m = ensureCat("bitumen_rate"), v = bitVer(b.dataset.d); if (v && v.locked) return; if (!confirm("इस Date (" + b.dataset.d + ") का पूरा समूह हटाएँ?")) return;
      m.versions = (m.versions || []).filter((x) => x.date !== b.dataset.d);
      if (m.loadedVersion === b.dataset.d) m.loadedVersion = m.versions[0] ? m.versions[0].date : null;
      if (m.activeVersion === b.dataset.d) m.activeVersion = m.loadedVersion;
      saveBitRate(); renderBitumenRateCat();
    }));
    // प्रकार (Type) — साझा (m.bitTypes); बदलने पर सभी तारीखों में बदलता है
    const bt = (bid) => { const m = ensureCat("bitumen_rate"); return ensureBitTypes(m).find((x) => x.id === bid); };
    const vd = (date, bid) => { const v = bitVer(date); if (!v) return null; if (!v.data) v.data = {}; if (!v.data[bid]) v.data[bid] = { refinery: "", unit: "Per Mt", rate: "", side: "Both Side" }; return v.data[bid]; };
    host.querySelectorAll(".bit-rtype").forEach((inp) => inp.addEventListener("change", () => { const t = bt(inp.dataset.bid); if (!t) return; t.type = inp.value.trim(); saveBitRate(); renderBitumenRateCat(); }));
    // Refinery/Unit/Side/Rate — केवल इसी तारीख (per-date; दूसरे Card पर असर नहीं)
    host.querySelectorAll(".bit-rref").forEach((sel) => sel.addEventListener("change", () => { const d = vd(sel.dataset.d, sel.dataset.bid); if (d) { d.refinery = sel.value; saveBitRate(); } }));
    host.querySelectorAll(".bit-rside").forEach((sel) => sel.addEventListener("change", () => { const d = vd(sel.dataset.d, sel.dataset.bid); if (d) { d.side = sel.value; saveBitRate(); } }));
    host.querySelectorAll(".bit-runit").forEach((inp) => inp.addEventListener("input", () => { const d = vd(inp.dataset.d, inp.dataset.bid); if (d) { d.unit = inp.value; saveBitRate(); } }));
    host.querySelectorAll(".bit-rrate").forEach((inp) => inp.addEventListener("input", () => { const d = vd(inp.dataset.d, inp.dataset.bid); if (d) { d.rate = inp.value; saveBitRate(); } }));
    // ऊपर/नीचे व हटाएँ — प्रकार-सूची (साझा) पर, सभी तारीखों में
    host.querySelectorAll(".bit-rup, .bit-rdown").forEach((b) => b.addEventListener("click", () => { const v = bitVer(b.dataset.d); if (v && v.locked) return; const m = ensureCat("bitumen_rate"), bts = ensureBitTypes(m); const i = bts.findIndex((x) => x.id === b.dataset.bid), j = i + (b.classList.contains("bit-rup") ? -1 : 1); if (i < 0 || j < 0 || j >= bts.length) return; const t = bts[i]; bts[i] = bts[j]; bts[j] = t; saveBitRate(); renderBitumenRateCat(); }));
    host.querySelectorAll(".bit-rdel").forEach((b) => b.addEventListener("click", () => {
      const m = ensureCat("bitumen_rate"); const t = ensureBitTypes(m).find((x) => x.id === b.dataset.bid); const tname = (t && t.type) ? t.type : "यह प्रकार";
      if (!confirm("⚠ प्रकार साझा है — '" + tname + "' हटाने पर यह सभी तारीखों (हर Date Card) से हट जाएगा, उनके Refinery/Rate/Both-One-Side सहित।\n\nक्या हटाना है?")) return;
      m.bitTypes = ensureBitTypes(m).filter((x) => x.id !== b.dataset.bid); (m.versions || []).forEach((vv) => { if (vv.data) delete vv.data[b.dataset.bid]; }); saveBitRate(); renderBitumenRateCat();
    }));
    host.querySelectorAll(".bit-reffile").forEach((f) => f.addEventListener("change", () => {
      const v = bitVer(f.dataset.d); if (!v || !f.files || !f.files[0]) return; const file = f.files[0];
      if (file.size > 5 * 1024 * 1024) { alert("फ़ाइल बहुत बड़ी — 5MB से कम रखें।"); return; }
      const rd = new FileReader();
      rd.onload = () => { const ref = { name: file.name, data: rd.result }; if (f.dataset.kind === "bit") v.bitRef = ref; else v.emuRef = ref; saveBitRate(); renderBitumenRateCat(); status("Reference जुड़ा: " + file.name); };
      rd.readAsDataURL(file);
    }));
    host.querySelectorAll(".bit-refdel").forEach((b) => b.addEventListener("click", () => { const v = bitVer(b.dataset.d); if (!v || v.locked) return; if (b.dataset.kind === "bit") v.bitRef = null; else v.emuRef = null; saveBitRate(); renderBitumenRateCat(); }));
    // 👁 देखें — data-URL को Blob बनाकर नए tab में खोलो (view; download नहीं)
    host.querySelectorAll(".bit-refview").forEach((b) => b.addEventListener("click", () => {
      const v = bitVer(b.dataset.d); if (!v) return; const ref = b.dataset.kind === "bit" ? v.bitRef : v.emuRef; if (!ref || !ref.data) return;
      try { fetch(ref.data).then((r) => r.blob()).then((blob) => { const u = URL.createObjectURL(blob); window.open(u, "_blank"); setTimeout(() => URL.revokeObjectURL(u), 60000); }).catch(() => window.open(ref.data, "_blank")); }
      catch (e) { window.open(ref.data, "_blank"); }
    }));
  }
  // Material Query Rate — Query Names की master सूची (row में Dropdown बनकर आती है)
  function buildQueryNamesPanel(ex) {
    const m = ensureCat("material_query");
    const names = m.queryNames || [];
    ex.innerHTML =
      "<div class='panel-card qn-panel'>" +
      "<div class='qn-top'>" +
        "<h3>🏷️ Query Names</h3>" +
        "<input type='text' id='qnNew' placeholder='नया Query Name…' />" +
        "<button class='btn sm primary' id='qnAdd'>➕ जोड़ें</button>" +
      "</div>" +
      "<div id='qnList' class='qn-list'>" +
        (names.length
          ? names.map((nm, idx) => "<span class='qn-item'>" + escapeHtml(nm) + "<button class='qn-del' data-qn='" + idx + "' title='हटाएँ'>×</button></span>").join("")
          : "<span class='muted' style='font-size:12px'>अभी कोई Query Name नहीं।</span>") +
      "</div></div>";
    const addName = () => {
      const inp = document.getElementById("qnNew"); const nm = (inp.value || "").trim();
      if (!nm) return;
      if (!m.queryNames) m.queryNames = [];
      if (m.queryNames.some((x) => x.toLowerCase() === nm.toLowerCase())) { status("यह Query Name पहले से सूची में है"); return; }
      m.queryNames.push(nm); saveMachine(); renderMachineRate(); status("Query Name जुड़ा: " + nm);
    };
    const ab = document.getElementById("qnAdd"); if (ab) ab.addEventListener("click", addName);
    const ni = document.getElementById("qnNew"); if (ni) ni.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addName(); } });
    ex.querySelectorAll(".qn-del").forEach((b) => b.addEventListener("click", () => {
      const idx = +b.dataset.qn; const removed = (m.queryNames || [])[idx];
      m.queryNames.splice(idx, 1); saveMachine(); renderMachineRate(); status("Query Name हटाया: " + (removed || ""));
    }));
  }

  function mrBtn(act, i, ic, title, cls) {
    return "<button class='mini" + (cls ? " " + cls : "") + "' data-act='" + act + "' data-i='" + i + "' title='" + title + "'>" + ic + "</button>";
  }
  function mrRowActions(r, i) {
    // खोज चालू हो तो reorder न दिखाएँ (दिखती पंक्तियाँ क्रम में नहीं होतीं)
    const ord = mrSearch ? "" : mrBtn("up", i, "▲", "ऊपर") + mrBtn("down", i, "▼", "नीचे");
    if (mrEditAll) return ord + mrBtn("ins", i, "⊕", "नीचे पंक्ति डालें") + mrBtn("del", i, "🗑", "हटाएँ", "danger");
    if (mrRowEdit.has(r.id)) return mrBtn("done", i, "✓", "इस पंक्ति का edit बंद करें", "ok") + ord + mrBtn("ins", i, "⊕", "नीचे पंक्ति डालें") + mrBtn("del", i, "🗑", "हटाएँ", "danger");
    return mrBtn("editline", i, "✎", "इस पंक्ति को edit करें") + mrBtn("del", i, "🗑", "हटाएँ", "danger");
  }

  // Excel/शीट से copy किया block (tab+newline) cell पर paste → कई पंक्तियाँ/कॉलम भर दो
  function mrPasteBlock(inp, e) {
    const text = (e.clipboardData || window.clipboardData).getData("text");
    if (!text) return;
    const rows = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n").map((r) => r.split("\t"));
    if (rows.length === 1 && rows[0].length === 1) return; // एकल मान → सामान्य paste
    e.preventDefault();
    const v = mrActiveVersion(); if (!v) return;
    const def = catDef(mrCat);
    const startI = +inp.dataset.i;
    const startC = def.cols.findIndex((c) => c.key === inp.dataset.field);
    if (startC < 0) return;
    mrUndoSnapshot(rows.length + " पंक्तियाँ paste हुईं — गलत हो तो Undo"); // paste से पहले snapshot
    rows.forEach((cells, ri) => {
      const ti = startI + ri;
      while (v.rows.length <= ti) v.rows.push(mrNewRow()); // ज़रूरत पड़े तो नई पंक्ति
      const row = v.rows[ti];
      cells.forEach((val, ci) => { const col = def.cols[startC + ci]; if (col) row[col.key] = String(val).trim(); });
    });
    mrSearch = ""; const si = document.getElementById("mrSearch"); if (si) si.value = ""; // पूरा result दिखे
    mrEditAll = true; // paste के बाद जाँच के लिए edit मोड
    saveMachine();
    renderMachineRate();
    status(rows.length + " पंक्तियाँ paste हुईं — जाँचकर 💾 Save करें");
  }

  // तीर से cell-से-cell जाना (दिखती पंक्तियों में; readonly में भी चलता है)
  function mrNav(inp, dRow, dCol, caret) {
    const td = inp.closest("td"), tr = inp.closest("tr");
    if (!td || !tr) return;
    const idx = Array.prototype.indexOf.call(tr.children, td);
    let ti = null;
    if (dRow !== 0) {
      let row = dRow < 0 ? tr.previousElementSibling : tr.nextElementSibling;
      while (row) { const cell = row.children[idx]; const x = cell && cell.querySelector("input[data-field], textarea[data-field]"); if (x) { ti = x; break; } row = dRow < 0 ? row.previousElementSibling : row.nextElementSibling; }
    } else {
      let cell = dCol < 0 ? td.previousElementSibling : td.nextElementSibling;
      while (cell) { const x = cell.querySelector ? cell.querySelector("input[data-field], textarea[data-field]") : null; if (x) { ti = x; break; } cell = dCol < 0 ? cell.previousElementSibling : cell.nextElementSibling; }
    }
    if (ti) { ti.focus(); const pos = caret === "start" ? 0 : ti.value.length; try { ti.setSelectionRange(pos, pos); } catch (e) {} }
  }

  function wireMrTable(tb) {
    // Query Name जैसे dropdown (select) — बदलने पर पंक्ति में सेट + save
    tb.querySelectorAll("select[data-field]").forEach((sel) => {
      sel.addEventListener("change", () => {
        const v = mrActiveVersion(); if (!v) return;
        const row = v.rows[+sel.dataset.i];
        row[sel.dataset.field] = sel.value;
        saveMachine();
      });
    });
    const autoSizeTA = (t) => { t.style.height = "auto"; t.style.height = (t.scrollHeight + 2) + "px"; };
    tb.querySelectorAll("input[data-field], textarea[data-field]").forEach((inp) => {
      const isTA = inp.tagName === "TEXTAREA";
      if (isTA) autoSizeTA(inp);
      inp.addEventListener("input", () => {
        const v = mrActiveVersion(); if (!v) return;
        const i = +inp.dataset.i, row = v.rows[i];
        row[inp.dataset.field] = inp.value;
        if (isTA) autoSizeTA(inp);   // लिखते ही ऊँचाई content अनुसार
        // computed (calc) columns तुरंत अपडेट — cumulative जैसे cross-row calc के लिए सभी पंक्तियाँ फिर से
        const def = catDef(mrCat);
        def.cols.forEach((c) => { if (!c.calc) return;
          tb.querySelectorAll("input[data-field='" + c.key + "']").forEach((ci) => { const rr = v.rows[+ci.dataset.i]; if (rr) ci.value = c.calc(rr); });
        });
        saveMachine();
      });
      inp.addEventListener("paste", (e) => mrPasteBlock(inp, e));
      if (isTA) return;   // multiline desc — तीर/Enter से cell-nav नहीं (text में caret चले)
      inp.addEventListener("keydown", (e) => {
        const k = e.key, L = inp.value.length;
        if (k === "ArrowUp") { e.preventDefault(); mrNav(inp, -1, 0, "end"); }
        else if (k === "ArrowDown" || k === "Enter") { e.preventDefault(); mrNav(inp, 1, 0, "end"); }
        else if (k === "ArrowLeft") { if (inp.selectionStart === 0 && inp.selectionEnd === 0) { e.preventDefault(); mrNav(inp, 0, -1, "end"); } }
        else if (k === "ArrowRight") { if (inp.selectionStart === L && inp.selectionEnd === L) { e.preventDefault(); mrNav(inp, 0, 1, "start"); } }
      });
    });
    tb.querySelectorAll("button[data-act]").forEach((b) => b.addEventListener("click", () => {
      const i = +b.dataset.i, act = b.dataset.act, v = mrActiveVersion(); if (!v) return;
      const row = v.rows[i];
      if (act === "editline") { mrRowEdit.add(row.id); renderMachineRate(); }
      else if (act === "done") { mrRowEdit.delete(row.id); saveMachine(); renderMachineRate(); }
      else if (act === "up") mrMoveRow(i, -1);
      else if (act === "down") mrMoveRow(i, 1);
      else if (act === "ins") {
        const nr = mrNewRow(); v.rows.splice(i + 1, 0, nr);
        if (!mrEditAll) mrRowEdit.add(nr.id); // नई पंक्ति तुरंत editable
        saveMachine(); renderMachineRate();
      }
      else if (act === "del") mrDeleteRow(i);
    }));
  }

  function mrDeleteRow(i) {
    const v = mrActiveVersion(); if (!v) return;
    const row = v.rows[i];
    if (!confirm("यह पंक्ति हटाएँ?\n" + (row.desc || ("क्रम " + (i + 1))) + "\n\n(गलती से हटे तो थोड़ी देर तक Undo कर सकते हैं।)")) return;
    mrUndoSnapshot("पंक्ति हटाई — " + (row.desc || "क्रम " + (i + 1)).slice(0, 36)); // बदलाव से पहले snapshot
    v.rows.splice(i, 1);
    saveMachine(); renderMachineRate();
  }

  // किसी भी bulk बदलाव से ठीक पहले इसे बुलाओ — पूरी version-स्थिति सुरक्षित रखकर Undo toast दिखाता है
  function mrUndoSnapshot(label) {
    const v = mrActiveVersion(); if (!v) return;
    clearTimeout(mrUndoTimer);
    mrUndo = { cat: mrCat, date: ensureCat(mrCat).activeVersion, rows: v.rows.map((r) => Object.assign({}, r)) };
    let toast = document.getElementById("mrUndoToast");
    if (!toast) { toast = document.createElement("div"); toast.id = "mrUndoToast"; toast.className = "undo-toast"; document.body.appendChild(toast); }
    toast.innerHTML = "<span>" + escapeHtml(label) + "</span><button id='mrUndoBtn'>↶ Undo</button>";
    toast.classList.add("show");
    document.getElementById("mrUndoBtn").addEventListener("click", mrDoUndo);
    mrUndoTimer = setTimeout(() => { toast.classList.remove("show"); mrUndo = null; }, 12000);
  }
  function mrDoUndo() {
    if (!mrUndo) return;
    const m = ensureCat(mrUndo.cat);
    const v = m.versions.find((x) => x.date === mrUndo.date);
    if (v) {
      v.rows = mrUndo.rows;
      m.activeVersion = mrUndo.date;
      saveCat(mrUndo.cat);
      mrCat = mrUndo.cat; mrEditAll = false; mrRowEdit.clear();
      mrSearch = ""; const si = document.getElementById("mrSearch"); if (si) si.value = "";
      renderMachineRate();
    }
    clearTimeout(mrUndoTimer); mrUndo = null;
    const toast = document.getElementById("mrUndoToast"); if (toast) toast.classList.remove("show");
    status("पूर्ववत (Undo) हो गया");
  }

  function buildMrToolbar(m) {
    const tb = document.getElementById("mrToolbar"); if (!tb) return;
    const ver = mrActiveVersion();
    let h = "";
    if (mrEditAll) {
      h += "<button class='btn sm primary' data-mr='save'>💾 Save (lock)</button>";
      h += "<button class='btn sm' data-mr='addrow'>+ पंक्ति</button>";
      h += "<span class='mr-hint'>edit मोड — बदलाव अपने-आप सुरक्षित; Save से lock</span>";
    } else {
      h += "<button class='btn sm' data-mr='editall'" + (ver ? "" : " disabled") + ">✎ सभी Edit करें</button>";
      h += "<button class='btn sm primary' data-mr='import'>⬆ Excel से Insert</button>";
      h += "<button class='btn sm' data-mr='manual'>✚ मैनुअल (नया Version)</button>";
      h += "<button class='btn sm' data-mr='copyver'" + (ver ? "" : " disabled") + ">📑 Copy → नया Version</button>";
    }
    h += "<span class='mr-count'>" + (ver ? (ver.rows.length + " पंक्तियाँ · देख रहे: " + ver.date + (m.loadedVersion === ver.date ? "  ✓Loaded" : "")) : "कोई version नहीं") + "</span>";
    tb.innerHTML = h;
    tb.querySelectorAll("button[data-mr]").forEach((b) => b.addEventListener("click", () => {
      const a = b.dataset.mr;
      if (a === "editall") { mrEditAll = true; renderMachineRate(); }
      else if (a === "save") { mrEditAll = false; mrRowEdit.clear(); saveMachine(); renderMachineRate(); status(catDef(mrCat).name + " सेव व lock — दोबारा बदलने के लिए ✎ दबाएँ"); }
      else if (a === "addrow") { const v = mrActiveVersion(); if (v) { v.rows.push(mrNewRow()); saveMachine(); renderMachineRate(); } }
      else if (a === "import") document.getElementById("mrFile").click();
      else if (a === "manual") {
        const v = mrEnsureVersion("नया खाली Version बनाएँ — फिर + पंक्ति से मैनुअल भरें।", false);
        if (v) { mrEditAll = true; if (!v.rows.length) v.rows.push(mrNewRow()); saveMachine(); renderMachineRate(); status("नया Version बना: " + v.date + " — मैनुअल भरकर Save करें"); }
      }
      else if (a === "copyver") {
        const v = mrEnsureVersion("नया Version बनाएँ — मौजूदा की copy बनेगी, फिर नई दरें भरकर Save करें।", true);
        if (v) { mrEditAll = true; saveMachine(); renderMachineRate(); status("नया Version बना: " + v.date + " — दरें बदलकर Save करें"); }
      }
    }));
  }

  // किसी version की Effective date बदलें (पुराने YYYY-MM-DD को DD/MM/YYYY में भी)
  function mrRenameVersion(oldDate) {
    const m = ensureCat(mrCat);
    const ver = m.versions.find((v) => v.date === oldDate);
    if (!ver) return;
    const raw = prompt("इस Version की Effective date बदलें — DD/MM/YYYY:", oldDate);
    if (raw === null) return;
    const nd = raw.trim();
    if (!nd || nd === oldDate) return;
    if (m.versions.some((v) => v !== ver && v.date === nd)) { alert("इस दिनांक का Version पहले से मौजूद है।"); return; }
    ver.date = nd;
    if (m.activeVersion === oldDate) m.activeVersion = nd;
    if (m.loadedVersion === oldDate) m.loadedVersion = nd;
    m.versions.sort((a, b) => dmyNum(b.date) - dmyNum(a.date));
    saveCat(mrCat);
    renderMachineRate();
    status("Effective date बदली: " + nd);
  }
  function mrDeleteVersion(date) {
    const m = ensureCat(mrCat);
    const ver = m.versions.find((v) => v.date === date);
    if (!ver) return;
    if (!confirm("यह पूरा Version हटाएँ?\n" + date + " · " + ver.rows.length + " पंक्तियाँ\n(यह पूर्ववत नहीं होगा)")) return;
    m.versions = m.versions.filter((v) => v !== ver);
    if (m.activeVersion === date) m.activeVersion = m.versions[0] ? m.versions[0].date : null;
    if (m.loadedVersion === date) m.loadedVersion = null;
    saveCat(mrCat);
    renderMachineRate();
    status("Version हटाया: " + date);
  }

  function buildMrVersions(m) {
    const box = document.getElementById("mrVersions"); if (!box) return;
    if (!m.versions.length) { box.innerHTML = ""; return; }
    let h = "<div class='mrv-title'>Versions <span class='muted'>— जो <b>Load</b> होगा, Rate Analysis उसी की दर लेगा</span></div><div class='mrv-list'>";
    for (const v of m.versions) {
      const loaded = m.loadedVersion === v.date, active = m.activeVersion === v.date;
      h += "<div class='mrv-item" + (active ? " active" : "") + (loaded ? " loaded" : "") + "'>";
      h += "<button class='mrv-open' data-view='" + v.date + "'>📅 " + v.date + " <span class='muted'>· " + v.rows.length + "</span></button>";
      h += "<button class='mini' data-editver='" + v.date + "' title='Effective date बदलें'>✎</button>";
      h += loaded ? "<span class='mrv-badge'>✓ Loaded</span>" : "<button class='btn xs' data-load='" + v.date + "'>📥 Load</button>";
      h += "<button class='mini danger' data-delver='" + v.date + "' title='यह Version हटाएँ'>🗑</button>";
      h += "</div>";
    }
    h += "</div>";
    box.innerHTML = h;
    box.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => { m.activeVersion = b.dataset.view; mrEditAll = false; mrRowEdit.clear(); renderMachineRate(); }));
    box.querySelectorAll("[data-editver]").forEach((b) => b.addEventListener("click", () => mrRenameVersion(b.dataset.editver)));
    box.querySelectorAll("[data-delver]").forEach((b) => b.addEventListener("click", () => mrDeleteVersion(b.dataset.delver)));
    box.querySelectorAll("[data-load]").forEach((b) => b.addEventListener("click", () => {
      m.loadedVersion = b.dataset.load; m.activeVersion = b.dataset.load; mrEditAll = false; mrRowEdit.clear();
      saveMachine(); renderMachineRate(); renderMasterOverview();  // overview कार्ड का Effective badge भी तुरंत ताज़ा
      status("Version Load हुआ: " + b.dataset.load + " — Rate Analysis अब इसी की दर लेगा");
    }));
  }

  // Excel से insert — कॉलम position से श्रेणी के columns में map; पहले Effective date पूछता है
  async function importMachineExcel(file) {
    const ok = await window.__sheetjsReady;
    if (!ok || typeof XLSX === "undefined") { alert("Excel engine load नहीं हुआ — internet जाँचें।"); return; }
    const def = catDef(mrCat);
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) { alert("शीट नहीं मिली।"); return; }
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });
    const parsed = [];
    aoa.forEach((r, i) => {
      if (!r) return;
      const joined = r.map((x) => String(x == null ? "" : x)).join(" ").toLowerCase();
      if (i === 0 && /(description|machine|rate|activity|power|unit|lead|item|category|material|sor|query|क्रम)/.test(joined)) return; // header छोड़ो
      const row = { id: uid("mrow") };
      let any = false;
      def.cols.forEach((c, ci) => { const val = r[ci] != null ? String(r[ci]).trim() : ""; row[c.key] = val; if (val !== "") any = true; });
      if (any) parsed.push(row);
    });
    if (!parsed.length) { alert("कोई पंक्ति नहीं मिली। कॉलम-क्रम: " + def.cols.map((c) => c.label).join(" · ")); return; }

    const ver = mrEnsureVersion(parsed.length + " पंक्तियाँ insert होंगी।", false);
    if (!ver) return;
    if (ver.rows.length) {
      const ch = await askChoice(
        "Version " + ver.date + " में पहले से " + ver.rows.length + " पंक्तियाँ हैं।\nनई " + parsed.length + " पंक्तियों का क्या करें?",
        [{ label: "पुराने के आगे जोड़ें (Append)", value: "append", cls: "primary" },
         { label: "पुराने को बदलें (Replace)", value: "replace", cls: "danger" },
         { label: "रद्द", value: "cancel" }]);
      if (ch === null || ch === "cancel") return;
      mrUndoSnapshot((ch === "append" ? "Append" : "Replace") + " से " + parsed.length + " पंक्तियाँ — गलत हो तो Undo");
      ver.rows = (ch === "append") ? ver.rows.concat(parsed) : parsed;
    } else {
      ver.rows = parsed;
    }
    mrEditAll = true; // insert के बाद review/edit, फिर Save से lock
    saveMachine();
    renderMachineRate();
    status(parsed.length + " पंक्तियाँ insert हुईं · " + def.name + " · Version " + ver.date + " — जाँचकर Save करें");
  }

  function wireMaster() {
    document.querySelectorAll("[data-cat]").forEach((b) => b.addEventListener("click", () => openCategory(b.dataset.cat)));
    const back = document.getElementById("mrBack");
    if (back) back.addEventListener("click", () => setActiveView("master"));
    const mf = document.getElementById("mrFile");
    if (mf) mf.addEventListener("change", (e) => { if (e.target.files[0]) importMachineExcel(e.target.files[0]); e.target.value = ""; });
    const si = document.getElementById("mrSearch");
    if (si) si.addEventListener("input", () => { mrSearch = si.value; renderMachineRate(); });

    // Master Data के तीन खंड (tab): Primary Rate | MoRTH | MoRD
    document.querySelectorAll("#masterTabs .mtab").forEach((t) => t.addEventListener("click", () => activateMasterTab(t.dataset.mtab)));
    // Master-edit (अपना editor) — back + size-variant chips
    const meBack = document.getElementById("meBack");
    if (meBack) meBack.addEventListener("click", () => { setActiveView("master"); activateMasterTab(masterEditReturnTab || "morth"); });
    const meChips = document.getElementById("meChips");
    if (meChips) meChips.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.meedit) openMasterForEdit(b.dataset.meedit);
      else if (b.dataset.meadd) addMorthVariant(b.dataset.meadd, b.dataset.size);
    });
    // नया MoRTH / MoRD analysis
    const nMorth = document.getElementById("btnNewMorth");
    if (nMorth) nMorth.addEventListener("click", () => newSheet({ kind: "master", source: "morth", size: projectSize, group: defaultChapterKey("morth") }));
    const nMord = document.getElementById("btnNewMord");
    if (nMord) nMord.addEventListener("click", () => newSheet({ kind: "master", source: "mord", group: defaultChapterKey("mord") }));
    // नया Chapter (हर tab का अपना source)
    document.querySelectorAll("[data-newchapter]").forEach((b) => b.addEventListener("click", () => addChapter(b.dataset.newchapter)));
    // खोज
    const moS = document.getElementById("morthSearch");
    if (moS) moS.addEventListener("input", () => { morthSearchQ = moS.value; renderMorthAnalysis(); });
    const mdS = document.getElementById("mordSearch");
    if (mdS) mdS.addEventListener("input", () => { mordSearchQ = mdS.value; renderMordAnalysis(); });
    // MoRTH container — item/variant action बटन (delegation)
    const mo = document.getElementById("morthAnalysisGroups");
    if (mo) mo.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.chaptoggle) toggleChapterOpen(morthOpen, b.dataset.chaptoggle, renderMorthAnalysis);
      else if (b.dataset.chapedit) renameChapter("morth", b.dataset.chapedit);
      else if (b.dataset.chapdel) deleteChapter("morth", b.dataset.chapdel);
      else if (b.dataset.medit) editMasterAnalysis(b.dataset.medit);
      else if (b.dataset.madd) addMorthVariant(b.dataset.madd, b.dataset.size);
      else if (b.dataset.mcheck) toggleAnalysisChecked(b.dataset.mcheck);
      else if (b.dataset.mload) loadMorthItem(b.dataset.mload);
      else if (b.dataset.mchap) changeMorthChapter(b.dataset.mchap);
      else if (b.dataset.mren) openAnalysisEditModal("morth", b.dataset.mren);
      else if (b.dataset.mdel) deleteMorthItem(b.dataset.mdel);
    });
    // MoRD container — per-sheet action बटन (delegation)
    const md = document.getElementById("mordAnalysisGroups");
    if (md) md.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.chaptoggle) toggleChapterOpen(mordOpen, b.dataset.chaptoggle, renderMordAnalysis);
      else if (b.dataset.chapedit) renameChapter("mord", b.dataset.chapedit);
      else if (b.dataset.chapdel) deleteChapter("mord", b.dataset.chapdel);
      else if (b.dataset.dcheck) toggleAnalysisChecked(b.dataset.dcheck);
      else if (b.dataset.dload) loadAnalysisToWorkspace(b.dataset.dload);
      else if (b.dataset.dedit) editMasterAnalysis(b.dataset.dedit);
      else if (b.dataset.dchap) changeMordChapter(b.dataset.dchap);
      else if (b.dataset.dren) openAnalysisEditModal("mord", b.dataset.dren);
      else if (b.dataset.ddel) deleteMordSheet(b.dataset.ddel);
    });
  }

  /* ============== BASIC ANALYSIS — RMR (Carted Rate of Material) ==============
     हर estimate के अपने RMR (RMR1, RMR2…). नया RMR loaded "Material Query Rate" के सभी
     material+query से बनता है; user सिर्फ़ दूरी भरता है। Cartage (loaded Cartage Range से),
     Total = Material Rate + Cartage — दोनों अपने-आप।
  */
  let rmrActiveId = null;

  function loadedVersionRows(cat) {
    if (cat === "material_loading") cat = "material_query";   // Loading/Unloading — वही Material Query Rate की loaded rows
    const m = state.master[cat];
    if (!m || !m.loadedVersion) return null;
    const v = m.versions.find((x) => x.date === m.loadedVersion);
    return v ? v.rows : null;
  }
  // ── Cartage Rate (RMR) — slabwise + Cartage Kachha + Net Total without CP ──
  const CART_KACHHA_PCT = 33.33;   // Cartage Kachha अंश
  const CART_CP_DIV = 1.10;        // Contractor Profit हटाने हेतु (÷1.10)
  // Aggregate का पहले किमी का Cartage Rate (loaded Cartage Range से 1 km हेतु)
  function cartageFirstKmRate() { const rows = loadedVersionRows("cartage"); return (rows && rows.length) ? round2(cartageCompute(rows, 1).total) : 0; }
  // Loading व Unloading (प्रति-Cum) — Cartage Rate के "Loading/Unloading Charges" card से
  function cartageLoadUnload() { const cm = state.master["cartage"]; const lu = (cm && cm.loadingUnloading) || {}; return { load: mrNum(lu.loadRate), unload: mrNum(lu.unloadRate), desc: (lu.desc || "").trim() }; }
  // किसी दूरी (km) का पूरा Cartage विवरण (attach किए प्रारूप अनुसार)
  function cartageBreakdown(distance) {
    const km = mrNum(distance);
    const rows = loadedVersionRows("cartage") || [];
    const cc = cartageCompute(rows, km);
    const slabTotal = round2(cc.total);
    const firstKm = cartageFirstKmRate();
    const lu = cartageLoadUnload();
    const kachhaBase = round2(firstKm - lu.load - lu.unload);
    const kachha = firstKm > 0 ? round2(kachhaBase * CART_KACHHA_PCT / 100) : 0;
    const total = round2(slabTotal + kachha);
    const netWithoutCP = round2(total / CART_CP_DIV);
    // compact slab lines — हर किमी0 न दिखाकर: अंतिम पूर्ण boundary तक cumulative (एक लाइन) + बचा हुआ किमी0
    const bounds = rows.map((r) => mrNum(r.to_km)).filter((t) => t > 0).sort((a, b) => a - b);
    let lastB = 0;
    for (const b of bounds) { if (b <= km) lastB = b; else break; }
    const cumAtLastB = round2(cartageCompute(rows, lastB).total);
    const remKm = round2(km - lastB);
    const remAmt = round2(slabTotal - cumAtLastB);
    const compactParts = [];
    if (lastB > 0) compactParts.push({ from: 1, to: lastB, amt: cumAtLastB, cumulative: true });
    if (remKm > 0) compactParts.push({ from: (lastB > 0 ? lastB + 1 : 1), to: km, km: remKm, rate: round2(remAmt / remKm), amt: remAmt, cumulative: false });
    if (!compactParts.length && slabTotal !== 0) compactParts.push({ from: 1, to: km, amt: slabTotal, cumulative: true });
    return { km, parts: cc.parts, compactParts, slabTotal, firstKm, load: lu.load, unload: lu.unload, kachhaBase, kachhaPct: CART_KACHHA_PCT, kachha, total, netWithoutCP };
  }
  // RMR की Cartage Rate = Net Total without CP (attach किए calculation से)
  function rmrCartage(distance) {
    const km = mrNum(distance);
    if (km <= 0) return 0;
    if (!(loadedVersionRows("cartage") || []).length) return 0;
    return cartageBreakdown(distance).netWithoutCP;
  }
  // RMR पंक्ति के material का ताज़ा डाटा loaded Material Query Rate से (matId द्वारा); न मिले तो snapshot
  function rmrMaterial(row) {
    const matRows = loadedVersionRows("material_query");
    const m = matRows ? matRows.find((x) => x.id === row.matId) : null;
    if (m) return {
      material: m.desc || "", query: m.query_name || "",
      matRate: mrNum(m.query_rate) - mrNum(m.loading), royalty: mrNum(m.royalty), live: true,
    };
    return { material: row.material || "", query: row.query || "", matRate: mrNum(row.matRate), royalty: mrNum(row.royalty), live: false };
  }

  function openRMRView() {
    const est = state.estimates[state.activeEstimateId];
    rmrActiveId = (est && est.rmrs && est.rmrs[0]) ? est.rmrs[0].id : null;
    setActiveView("rmr");
  }

  /* ============== DOM — Detail of Measurement ==============
     मुख्य कार्य-समूह के हर Analysis का item व दर अपने-आप; N1·N2·L·W·D → Quantity, ×Rate → Amount */
  let _domWgId = null;    // समूह-मोड में कौन-सा समूह
  let _domSubId = null;   // कोई sub-estimate खुला हो तो उसका id (वरना null = समूह-मोड)
  function openDOMView(wgId) { _domSubId = null; if (wgId !== undefined) _domWgId = wgId; setActiveView("dom"); }
  function openDOMSub(subId) { _domSubId = subId; setActiveView("dom"); }
  function openBOQSub(subId) { _domSubId = subId; setActiveView("boq"); }
  // किसी analysis (working sheet) से output दर व unit निकालो — "say" पंक्ति से
  function analysisRateUnit(sheet) {
    let rate = "", unit = "";
    if (!sheet || !sheet.cells) return { rate, unit };
    const R = sheet.rows || 0, C = sheet.cols || 0;
    const disp = (r, c) => { const cell = sheet.cells[addr(r, c)]; if (!cell) return ""; const raw = (cell.f != null ? cell.f : cell.v); return raw == null ? "" : String(raw); };
    const numAt = (r, c) => { const v = computedValue(sheet, r, c).val; return (typeof v === "number" && isFinite(v)) ? v : (isNumeric(v) ? Number(v) : null); };
    // unit — "Unit = cum" जैसा कहीं भी
    for (let r = 0; r < R && !unit; r++) for (let c = 0; c < C; c++) { const m = /unit\s*[:=]\s*([A-Za-z%]+)/i.exec(disp(r, c)); if (m) { unit = m[1]; break; } }
    // rate — "say" पंक्ति का सबसे दायाँ संख्या-मान; न मिले तो "Rate per"; न मिले तो अंतिम संख्या
    const rowNum = (r) => { for (let c = C - 1; c >= 0; c--) { const n = numAt(r, c); if (n != null && n !== 0) return n; } return null; };
    const findByText = (re) => { for (let r = R - 1; r >= 0; r--) { for (let c = 0; c < C; c++) { if (re.test(disp(r, c))) { const n = rowNum(r); if (n != null) return n; } } } return null; };
    let rt = findByText(/\bsay\b/i);
    if (rt == null) rt = findByText(/rate\s*per/i);
    if (rt == null) { for (let r = R - 1; r >= 0 && rt == null; r--) rt = rowNum(r); }
    if (rt != null) rate = Math.floor(rt * 10) / 10;   // फाइनल Say — FLOOR(value, 0.10)
    return { rate, unit };
  }
  // DOM/BOQ views अभी जिस कार्य-समूह के लिए हैं (default: मुख्य)
  function domActiveWg(est) {
    const wgs = est ? estWorkGroups(est) : [];
    return wgs.find((w) => w.id === _domWgId) || wgs.find((w) => w.isMain) || wgs[0] || null;
  }
  // किसी कार्य-समूह के सभी loaded (working) analysis
  function domGroupSheets(est, wg) {
    const out = [];
    if (wg) {
      const key = (wg.rmrId || "") + "|" + (wg.ohGroupId || "");
      for (const id of state.order) {
        const s = state.sheets[id];
        if (s.kind === "working" && ((s.rmrId || "") + "|" + (s.ohGroupId || "")) === key) out.push(s);
      }
    }
    return { main: wg || null, sheets: out };
  }
  // पीछे-अनुकूलता: पुराने कॉल active समूह पर काम करें
  function domMainGroupSheets(est) { return domGroupSheets(est, domActiveWg(est)); }

  /* ---- DOM असली spreadsheet — वही Rate Analysis editor (formula bar, multi-select, सभी Excel फार्मूला) ---- */
  const DOM_HEADERS = ["SN", "Item Detail", "N1", "N2", "Length", "Width", "Depth", "Quantity", "Unit"];
  function domColWidths() { return [40, 380, 60, 60, 68, 68, 68, 90, 66]; }
  // analysis के column C (Description) की Excel Row 2 व Row 3 को " - " से जोड़ो → Item Detail
  function analysisItemDetail(sheet) {
    const disp = (r, c) => { const cell = sheet && sheet.cells && sheet.cells[addr(r, c)]; const raw = cell ? (cell.f != null ? cell.f : cell.v) : ""; return raw == null ? "" : String(raw).trim(); };
    const parts = [disp(1, 2), disp(2, 2)].filter(Boolean);   // C2, C3
    return parts.join(" - ");
  }
  function domSetSheetCell(sheet, r, c, raw) {
    const a = addr(r, c);
    raw = (raw == null ? "" : String(raw)).trim();
    if (raw === "") delete sheet.cells[a];
    else if (raw[0] === "=") sheet.cells[a] = { f: raw };
    else if (isNumeric(raw)) sheet.cells[a] = { v: Number(raw) };
    else sheet.cells[a] = { v: raw };
    if (r + 1 > sheet.rows) sheet.rows = r + 1;
  }
  function domCellRawSheet(sheet, r, c) { const cell = sheet.cells[addr(r, c)]; return cell ? (cell.f != null ? cell.f : (cell.v == null ? "" : String(cell.v))) : ""; }
  // नई DOM शीट (generic)
  function newDomSheet(titleName) {
    const cells = {}; DOM_HEADERS.forEach((h, c) => { cells[addr(0, c)] = { v: h }; });
    const base = uniqueName(safeName("DOM_" + String(titleName || "").replace(/\s+/g, "_").slice(0, 12)) || "DOM");
    const sheet = { id: uid("sht"), name: base, rows: 1, cols: DOM_HEADERS.length, cells: cells, merges: [], colWidths: domColWidths(), title: "DOM — " + (titleName || ""), lockTop: 1, lockBottom: 0, updatedAt: Date.now(), kind: "dom", group: "misc", masterId: null, source: "morth", serial: "" };
    state.sheets[sheet.id] = sheet; state.order.push(sheet.id); db.put("sheets", sheet);
    return sheet;
  }
  // हर कार्य-समूह की अपनी (मुख्य) DOM शीट
  function domEnsureSheet(est, wg) {
    wg = wg || domActiveWg(est); if (!wg) return null;
    if (!est.domSheets) est.domSheets = {};
    if (est.domSheetId && state.sheets[est.domSheetId]) {   // पुराना single → मुख्य समूह में migrate
      const m = estWorkGroups(est).find((w) => w.isMain) || estWorkGroups(est)[0];
      if (m && !est.domSheets[m.id]) est.domSheets[m.id] = est.domSheetId;
      est.domSheetId = null; db.put("estimates", est);
    }
    const ex = est.domSheets[wg.id];
    if (ex && state.sheets[ex]) return state.sheets[ex];
    const sheet = newDomSheet(wg.name);
    est.domSheets[wg.id] = sheet.id; db.put("estimates", est);
    return sheet;
  }
  // ── Sub-Estimate: किसी समूह के अंदर कई नामित उपकार्य; हर का अपना DOM+BOQ (समूह के सभी analysis से भरा, prunable) ──
  function estSubs(est) { if (!Array.isArray(est.subEstimates)) est.subEstimates = []; return est.subEstimates; }
  function findSub(est, id) { return estSubs(est).find((x) => x.id === id) || null; }
  function createSubEstimate(est, wg, name, unit, description) {
    const items = domGroupSheets(est, wg).sheets.map((s) => s.id);   // शुरू में समूह के सभी analysis
    const sub = { id: uid("sub"), wgId: wg.id, name: name, unit: unit || "", description: description || "", itemIds: items, domSheetId: null, boqSheetId: null };
    estSubs(est).push(sub); db.put("estimates", est);
    return sub;
  }
  // sub का पूरा विवरण — "short name - Description"
  function subFullText(sub) { return sub ? (sub.name + (sub.description ? " - " + sub.description : "")) : "Sub-Estimate"; }
  function subLinkedInMain(est, subId) { return estMainExtras(est).some((x) => x.type === "sub" && x.subId === subId); }
  function deleteSubEstimate(est, subId) {
    const subs = estSubs(est); const i = subs.findIndex((x) => x.id === subId); if (i < 0) return;
    const sub = subs[i];
    [sub.domSheetId, sub.boqSheetId].forEach((sid) => { if (sid && state.sheets[sid]) { delete state.sheets[sid]; const k = state.order.indexOf(sid); if (k >= 0) state.order.splice(k, 1); db.del && db.del("sheets", sid); } });
    est.mainExtras = estMainExtras(est).filter((x) => !(x.type === "sub" && x.subId === subId));   // मुख्य DOM/BOQ से भी हटाओ
    subs.splice(i, 1); db.put("estimates", est);
  }
  function subDomSheet(est, sub) {
    if (sub.domSheetId && state.sheets[sub.domSheetId]) return state.sheets[sub.domSheetId];
    const sheet = newDomSheet(sub.name); sub.domSheetId = sheet.id; db.put("estimates", est); return sheet;
  }
  function domStyle(sheet, r, c, st) { const a = addr(r, c); if (!sheet.cells[a]) sheet.cells[a] = { v: "" }; sheet.cells[a].s = Object.assign({}, st); }
  function domMarkRole(sheet, r, role) { const a = addr(r, 2); if (!sheet.cells[a]) sheet.cells[a] = { v: "" }; sheet.cells[a].role = role; }
  function domFindRole(sheet, role) { for (let r = 1; r < sheet.rows; r++) { const c = sheet.cells[addr(r, 2)]; if (c && c.role === role) return r; } return -1; }
  // ── समूह-वार item क्रम (Rate Analysis · DOM · BOQ तीनों साझा) ──
  function domGroupKey(s) { return (s.rmrId || "") + "|" + (s.ohGroupId || ""); }
  function estGroupOrder(est, gk, sheetIds) {
    if (!est.groupOrders) est.groupOrders = {};
    let order = Array.isArray(est.groupOrders[gk]) ? est.groupOrders[gk].filter((id) => sheetIds.indexOf(id) >= 0) : [];
    sheetIds.forEach((id) => { if (order.indexOf(id) < 0) order.push(id); });   // नई items अंत में
    est.groupOrders[gk] = order;
    return order;
  }
  // मुख्य समूह के items canonical क्रम में (DOM/BOQ इससे)
  function estItemSheets(est) {
    const gi = domMainGroupSheets(est);
    if (!gi.main) return [];
    const gk = domGroupKey({ rmrId: gi.main.rmrId, ohGroupId: gi.main.ohGroupId });
    const ids = gi.sheets.map((s) => s.id);
    return estGroupOrder(est, gk, ids).map((id) => state.sheets[id]).filter(Boolean);
  }
  // किसी item को उसके समूह में ऊपर/नीचे (तीनों जगह असर)
  function moveEstimateItem(est, itemId, dir) {
    const s = state.sheets[itemId]; if (!s) return false;
    const gk = domGroupKey(s);
    const ids = state.order.filter((id) => { const x = state.sheets[id]; return x && x.kind === "working" && domGroupKey(x) === gk; });
    const order = estGroupOrder(est, gk, ids);
    const i = order.indexOf(itemId), j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return false;
    const t = order[i]; order[i] = order[j]; order[j] = t;
    est.groupOrders[gk] = order; db.put("estimates", est);
    return true;
  }
  // DOM sheet से हर item की माप-पंक्तियाँ — itemId व नाम (detail) दोनों से key (rebuild/reorder पर सुरक्षित)
  function domParseItems(sheet) {
    const byId = {}, byDetail = {};
    for (let r = 1; r < sheet.rows; r++) {
      const hc = sheet.cells[addr(r, 2)];
      if (hc && hc.role === "domhdr") {
        let sr = -1;
        for (let rr = r + 1; rr < sheet.rows; rr++) { const c = sheet.cells[addr(rr, 2)]; if (c && c.role === "domsub") { sr = rr; break; } if (c && c.role === "domhdr") break; }
        const end = sr > 0 ? sr : r + 1, meas = [];
        let any = false;
        for (let rr = r + 1; rr < end; rr++) { const vals = []; for (let cc = 0; cc < 5; cc++) { const v = domCellRawSheet(sheet, rr, 2 + cc); vals.push(v); if (v !== "") any = true; } meas.push(vals); }
        if (hc.itemId) byId[hc.itemId] = meas;
        const det = domCellRawSheet(sheet, r, 1); if (det) byDetail[det] = meas;   // नाम से भी (fallback)
      }
    }
    return { byId, byDetail };
  }
  // एक item का block: header + N माप-पंक्तियाँ (सुरक्षित मान) + Quantity sub-total; अगली block-start लौटाता है
  function domSeedItemBlock(sheet, r, itemNo, s, savedMeas) {
    const info = analysisRateUnit(s);
    const detail = analysisItemDetail(s) || s.itemName || s.name;   // C2 - C3
    const meas = (Array.isArray(savedMeas) && savedMeas.length) ? savedMeas : [null, null];   // डिफ़ॉल्ट 2 माप-पंक्तियाँ
    const hr = r, firstMeas = r + 1, lastMeas = firstMeas + meas.length - 1, sub = lastMeas + 1;
    const e = (x) => x + 1;
    // header — सिर्फ़ नाम (bold नहीं); itemId marker (reorder/link के लिए)
    domSetSheetCell(sheet, hr, 0, itemNo);
    domSetSheetCell(sheet, hr, 1, detail); domStyle(sheet, hr, 1, { bg: "EAF1F8", al: "left" });
    domMarkRole(sheet, hr, "domhdr");
    sheet.cells[addr(hr, 2)].itemId = s.id;
    // माप-पंक्तियाँ (सुरक्षित मान भरो) — हर की Quantity = N1·N2·L·W·D
    meas.forEach((vals, k) => {
      const mr = firstMeas + k;
      if (Array.isArray(vals)) for (let cc = 0; cc < 5; cc++) { if (vals[cc] != null && vals[cc] !== "") domSetSheetCell(sheet, mr, 2 + cc, vals[cc]); }
      domSetSheetCell(sheet, mr, 7, "=IF(COUNT(C" + e(mr) + ":G" + e(mr) + ")=0,\"\",PRODUCT(C" + e(mr) + ":G" + e(mr) + "))");
    });
    // Sub Total — label Depth में; Quantity योग + Unit
    domSetSheetCell(sheet, sub, 6, "Sub Total"); domStyle(sheet, sub, 6, SECTOT_STYLE);
    domSetSheetCell(sheet, sub, 7, "=ROUND(SUM(H" + e(firstMeas) + ":H" + e(lastMeas) + "),3)"); domStyle(sheet, sub, 7, SECTOT_STYLE);
    domSetSheetCell(sheet, sub, 8, info.unit || ""); domStyle(sheet, sub, 8, SECTOT_STYLE);
    domMarkRole(sheet, sub, "domsub");
    return sub + 1;
  }
  // DOM को canonical क्रम में फिर से बनाओ — माप-मान सुरक्षित (add/remove/reorder सब यहीं)
  //  extras (सिर्फ़ मुख्य कार्य): main analyses के बाद separator + Sub-Estimate/Item SOR items
  function domSyncSheet(est, sheet, items, extras) {
    if (!items) items = estItemSheets(est);  // default: मुख्य समूह canonical क्रम
    const saved = domParseItems(sheet);      // पुराने से माप सुरक्षित (itemId व नाम दोनों से)
    // extra items का user-edited नाम (भाषा) x.desc में सुरक्षित — rebuild पर बना रहे, BOQ भी दिखाए
    if (extras && extras.length) {
      for (let r = 1; r < sheet.rows; r++) {
        const c = sheet.cells[addr(r, 2)];
        if (c && c.role === "domhdr" && c.itemId && String(c.itemId).indexOf("xtr:") === 0) {
          const x = extras.find((e) => e.id === String(c.itemId).slice(4));
          const txt = domCellRawSheet(sheet, r, 1);
          if (x && txt) x.desc = txt;
        }
      }
      db.put("estimates", est);
    }
    sheet.cols = DOM_HEADERS.length; sheet.colWidths = sheet.colWidths && sheet.colWidths.length === DOM_HEADERS.length ? sheet.colWidths : domColWidths();
    sheet.cells = {}; DOM_HEADERS.forEach((h, c) => { sheet.cells[addr(0, c)] = { v: h }; });
    sheet.rows = 1;
    let r = 1, no = 1;
    items.forEach((s) => {
      const det = analysisItemDetail(s) || s.itemName || s.name;
      const meas = saved.byId[s.id] || saved.byDetail[det];   // पहले id, फिर नाम से
      r = domSeedItemBlock(sheet, r, no++, s, meas);
    });
    if (extras && extras.length) {
      EXTRA_CATS.forEach((cat) => {
        const catItems = extras.filter((x) => x.type === cat.type);
        if (!catItems.length) return;
        domSetSheetCell(sheet, r, 1, cat.label); domStyle(sheet, r, 1, { bg: "F3E8FF", al: "center", b: 1 }); domMarkRole(sheet, r, "domsep"); r++;
        catItems.forEach((x) => { r = domSeedExtraBlock(sheet, r, no++, est, x, saved); });
      });
    }
    sheet._domSeeded = true; sheet._domV = 5;
    ensureLock(sheet); persistSheet(sheet, true); if (hfReady) buildEngine();
  }
  // अभी DOM/BOQ किस लक्ष्य के लिए — sub-estimate या समूह
  function domCurrentItems(est) {
    if (_domSubId) { const sub = findSub(est, _domSubId); return sub ? (sub.itemIds || []).map((id) => state.sheets[id]).filter((s) => s && s.kind === "working") : []; }
    return estItemSheets(est);
  }
  function domCurrentTitle(est) {
    if (_domSubId) { const sub = findSub(est, _domSubId); return sub ? ("उपकार्य: " + sub.name) : ""; }
    const wg = domActiveWg(est); return wg ? wg.name : "";
  }
  function renderDOM() {
    const est = state.estimates[state.activeEstimateId];
    const ttl = document.querySelector("#view-dom .dom-head-title");
    if (ttl) ttl.textContent = "DOM — Detail of Measurement" + (est ? " · " + domCurrentTitle(est) : "");
    const mainCtx = est && domIsMainCtx(est);
    const addBtns = document.getElementById("domAddBtns");
    if (addBtns) addBtns.style.display = mainCtx ? "" : "none";   // Sub-Estimate/Item SOR जोड़ना सिर्फ़ मुख्य DOM में
    let sheet = null;
    if (est) { if (_domSubId) { const sub = findSub(est, _domSubId); if (sub) sheet = subDomSheet(est, sub); } else if (domActiveWg(est)) sheet = domEnsureSheet(est, domActiveWg(est)); }
    if (!sheet) { state.activeSheetId = null; renderGrid(); return; }
    domSyncSheet(est, sheet, domCurrentItems(est), mainCtx ? estMainExtras(est) : null);
    openSheet(sheet.id);
  }

  /* ============== BOQ — Bill of Quantity (DOM से item+Quantity linked; Rate व Amount यहाँ) ============== */
  const BOQ_HEADERS = ["SN", "Item Detail", "Quantity", "Unit", "Rate", "Amount"];
  function boqColWidths() { return [40, 380, 96, 66, 96, 112]; }
  function openBOQView(wgId) { _domSubId = null; if (wgId !== undefined) _domWgId = wgId; setActiveView("boq"); }
  function newBoqSheet(titleName) {
    const cells = {}; BOQ_HEADERS.forEach((h, c) => { cells[addr(0, c)] = { v: h }; });
    const base = uniqueName(safeName("BOQ_" + String(titleName || "").replace(/\s+/g, "_").slice(0, 12)) || "BOQ");
    const sheet = { id: uid("sht"), name: base, rows: 1, cols: BOQ_HEADERS.length, cells: cells, merges: [], colWidths: boqColWidths(), title: "BOQ — " + (titleName || ""), lockTop: 1, lockBottom: 0, updatedAt: Date.now(), kind: "boq", group: "misc", masterId: null, source: "morth", serial: "" };
    state.sheets[sheet.id] = sheet; state.order.push(sheet.id); db.put("sheets", sheet);
    return sheet;
  }
  function boqEnsureSheet(est, wg) {
    wg = wg || domActiveWg(est); if (!wg) return null;
    if (!est.boqSheets) est.boqSheets = {};
    if (est.boqSheetId && state.sheets[est.boqSheetId]) {
      const m = estWorkGroups(est).find((w) => w.isMain) || estWorkGroups(est)[0];
      if (m && !est.boqSheets[m.id]) est.boqSheets[m.id] = est.boqSheetId;
      est.boqSheetId = null; db.put("estimates", est);
    }
    const ex = est.boqSheets[wg.id];
    if (ex && state.sheets[ex]) return state.sheets[ex];
    const sheet = newBoqSheet(wg.name);
    est.boqSheets[wg.id] = sheet.id; db.put("estimates", est);
    return sheet;
  }
  // BOQ को DOM से बनाओ — Item Detail व Quantity DOM से linked; Rate analysis से; Amount = Qty×Rate
  //  forceRate=true → दरें analysis से फिर से (🔄); वरना user का बदला Rate सुरक्षित
  function subBoqSheet(est, sub) {
    if (sub.boqSheetId && state.sheets[sub.boqSheetId]) return state.sheets[sub.boqSheetId];
    const sheet = newBoqSheet(sub.name); sub.boqSheetId = sheet.id; db.put("estimates", est); return sheet;
  }
  function boqSync(est, boq, dom, forceRate, srcItems, extrasById) {
    const domName = dom.name;
    const rateBy = {};
    (srcItems || estItemSheets(est)).forEach((s) => { rateBy[analysisItemDetail(s) || s.itemName || s.name] = analysisRateUnit(s).rate; });
    // कोई separator है? (मुख्य कार्य में extra sections) → तब section-wise Total
    let hasSep = false; for (let dr = 1; dr < dom.rows; dr++) { const c = dom.cells[addr(dr, 2)]; if (c && c.role === "domsep") { hasSep = true; break; } }
    boq.cells = {}; BOQ_HEADERS.forEach((h, c) => { boq.cells[addr(0, c)] = { v: h }; }); boq.rows = 1;
    let r = 1, no = 1;
    const secTotalRows = [];      // section-total की Excel पंक्तियाँ (Grand Total के लिए)
    let secLabel = "मुख्य कार्य", secStart = null;   // secStart = section की पहली item-पंक्ति (0-based)
    const closeSection = () => {
      if (hasSep && secStart != null && r > secStart) {
        const startE = secStart + 1, endE = r, trE = r + 1;   // items: secStart..r-1 → Excel (secStart+1)..r
        domSetSheetCell(boq, r, 4, secLabel + " — Total"); domStyle(boq, r, 4, SECTOT_STYLE);   // label कॉलम E में
        domSetSheetCell(boq, r, 5, "=ROUND(SUM(F" + startE + ":F" + endE + "),2)"); domStyle(boq, r, 5, SECTOT_STYLE);
        domMarkRole(boq, r, "sectot"); secTotalRows.push(trE); r++;
      }
      secStart = null;
    };
    for (let dr = 1; dr < dom.rows; dr++) {
      const c = dom.cells[addr(dr, 2)];
      if (c && c.role === "domsep") {   // section बदला
        closeSection();
        const lbl = domCellRawSheet(dom, dr, 1);
        domSetSheetCell(boq, r, 1, lbl); domStyle(boq, r, 1, { bg: "F3E8FF", al: "center", b: 1 }); domMarkRole(boq, r, "domsep"); r++;
        secLabel = lbl.replace(/^अतिरिक्त\s*-\s*/, "").trim() || "अतिरिक्त";
        continue;
      }
      if (!(c && c.role === "domhdr")) continue;
      if (secStart == null) secStart = r;
      let sr = -1;
      for (let rr = dr + 1; rr < dom.rows; rr++) { const cc = dom.cells[addr(rr, 2)]; if (cc && cc.role === "domsub") { sr = rr; break; } if (cc && (cc.role === "domhdr" || cc.role === "domsep")) break; }
      const hrE = dr + 1, srE = (sr > 0 ? sr : dr) + 1, n = r + 1;
      const iid = c.itemId || "", det = domCellRawSheet(dom, dr, 1);
      domSetSheetCell(boq, r, 0, no++);
      if (iid) boq.cells[addr(r, 0)].itemId = iid;   // BOQ पंक्ति ↔ item (delete/move के लिए)
      domSetSheetCell(boq, r, 1, "=" + domName + "!B" + hrE);
      domSetSheetCell(boq, r, 2, "=" + domName + "!H" + srE);
      domSetSheetCell(boq, r, 3, "=" + domName + "!I" + srE);
      let rt = "";
      if (iid.indexOf("xtr:") === 0 && extrasById) { const x = extrasById[iid.slice(4)]; if (x) rt = extraRate(est, x); }
      else rt = (rateBy[det] != null ? rateBy[det] : "");
      domSetSheetCell(boq, r, 4, rt === "" ? "" : rt);
      domSetSheetCell(boq, r, 5, "=IF(OR(C" + n + "=\"\",E" + n + "=\"\"),\"\",ROUND(C" + n + "*E" + n + ",2))");
      r++;
    }
    closeSection();   // अंतिम section
    domSetSheetCell(boq, r, 1, "Grand Total (कुल राशि)"); domStyle(boq, r, 1, TOTAL_STYLE);
    const gsum = (hasSep && secTotalRows.length) ? ("=ROUND(" + secTotalRows.map((n) => "F" + n).join("+") + ",2)") : ("=ROUND(SUM(F2:F" + r + "),2)");
    domSetSheetCell(boq, r, 5, gsum); domStyle(boq, r, 5, TOTAL_STYLE);
    domMarkRole(boq, r, "grandtot");
    boq._boqSeeded = true;
    ensureLock(boq); persistSheet(boq, true); buildEngine();
  }
  function renderBOQ(forceRate) {
    const est = state.estimates[state.activeEstimateId];
    const ttl = document.querySelector("#view-boq .dom-head-title");
    if (ttl) ttl.innerHTML = "BOQ — Bill of Quantity" + (est ? " · " + escapeHtml(domCurrentTitle(est)) : "") + " <span class='boq-hint'>(Item व Quantity DOM से linked)</span>";
    let dom = null, boq = null;
    if (est) {
      if (_domSubId) { const sub = findSub(est, _domSubId); if (sub) { dom = subDomSheet(est, sub); boq = subBoqSheet(est, sub); } }
      else if (domActiveWg(est)) { dom = domEnsureSheet(est, domActiveWg(est)); boq = boqEnsureSheet(est, domActiveWg(est)); }
    }
    if (!dom || !boq) { state.activeSheetId = null; renderGrid(); return; }
    const items = domCurrentItems(est);
    const mainCtx = domIsMainCtx(est);
    const extras = mainCtx ? estMainExtras(est) : null;
    const extrasById = {}; (extras || []).forEach((x) => { extrasById[x.id] = x; });
    domSyncSheet(est, dom, items, extras);          // DOM (source) पहले ताज़ा (extras सहित)
    boqSync(est, boq, dom, !!forceRate, items, extrasById);
    openSheet(boq.id);
  }
  /* ── मुख्य कार्य के extra items (Sub-Estimate ref + Item SOR) — main analyses के बाद, separator के नीचे ── */
  function estMainExtras(est) { if (!Array.isArray(est.mainExtras)) est.mainExtras = []; return est.mainExtras; }
  function domIsMainCtx(est) { const wg = domActiveWg(est); return !_domSubId && wg && wg.isMain; }
  const EXTRA_CATS = [{ type: "sub", label: "अतिरिक्त - Sub-Estimate" }, { type: "sor", label: "अतिरिक्त - Item-SOR" }, { type: "ana", label: "अतिरिक्त - अन्य कार्य" }];
  function extraDesc(est, x) {
    if (x.desc != null && x.desc !== "") return x.desc;
    if (x.type === "sor") { const rr = masterRowById("item_sor", x.sorRowId); return rr ? masterItemName("item_sor", rr) : "Item SOR"; }
    if (x.type === "sub") { return subFullText(findSub(est, x.subId)); }   // नाम - Description
    if (x.type === "ana") { const s = state.sheets[x.anaId]; return s ? (analysisItemDetail(s) || s.itemName || s.name) : "Analysis"; }
    return "Item";
  }
  function extraUnit(est, x) {
    if (x.type === "sub") { const s = findSub(est, x.subId); return (s && s.unit) ? s.unit : (x.unit || "job"); }
    if (x.unit != null && x.unit !== "") return x.unit;
    if (x.type === "sor") { const rr = masterRowById("item_sor", x.sorRowId); return rr ? (rr.unit || "") : ""; }
    if (x.type === "ana") { const s = state.sheets[x.anaId]; return s ? (analysisRateUnit(s).unit || "") : ""; }
    return "";
  }
  // sub-estimate का कुल (उसकी DOM+BOQ बनाकर grand total) — main BOQ में इसका rate
  function computeSubTotal(est, sub) {
    const items = (sub.itemIds || []).map((id) => state.sheets[id]).filter((s) => s && s.kind === "working");
    const dom = subDomSheet(est, sub); domSyncSheet(est, dom, items);
    const boq = subBoqSheet(est, sub); boqSync(est, boq, dom, false, items);
    let g = -1; for (let r = 1; r < boq.rows; r++) { const c = boq.cells[addr(r, 2)]; if (c && c.role === "grandtot") { g = r; break; } }
    if (g < 0) return 0;
    const v = computedValue(boq, g, 5).val;
    return (typeof v === "number" && isFinite(v)) ? round2(v) : 0;
  }
  // किसी कार्य-समूह का BOQ कुल (उसकी DOM+BOQ बनाकर grand total) — Summary के लिए
  function computeGroupTotal(est, wg) {
    const gk = (wg.rmrId || "") + "|" + (wg.ohGroupId || "");
    const ids = state.order.filter((id) => { const s = state.sheets[id]; return s && s.kind === "working" && ((s.rmrId || "") + "|" + (s.ohGroupId || "")) === gk; });
    const itemSheets = estGroupOrder(est, gk, ids).map((id) => state.sheets[id]).filter(Boolean);
    const extras = wg.isMain ? estMainExtras(est) : null;
    const extrasById = {}; (extras || []).forEach((x) => { extrasById[x.id] = x; });
    const dom = domEnsureSheet(est, wg); domSyncSheet(est, dom, itemSheets, extras);
    const boq = boqEnsureSheet(est, wg); boqSync(est, boq, dom, false, itemSheets, extrasById);
    let g = -1; for (let r = 1; r < boq.rows; r++) { const c = boq.cells[addr(r, 2)]; if (c && c.role === "grandtot") { g = r; break; } }
    if (g < 0) return 0;
    const v = computedValue(boq, g, 5).val;
    return (typeof v === "number" && isFinite(v)) ? v : 0;
  }
  /* ============== Summary of Estimated Cost — हर step पर S-reference, % का base stage चुनने योग्य ============== */
  // ══════════ Summary — स्वतंत्र (free-form) spreadsheet ══════════
  //  शुरू में पूरी default तालिका अपने-आप बनती है; उसके बाद यह सादा Excel शीट है —
  //  जैसे चाहें row जोड़ें/हटाएँ, label/%/formula बदलें। कोई auto-regeneration नहीं।
  //  Template = पूरी तालिका का स्वतंत्र snapshot (एक Template का दूसरे पर असर नहीं)।
  const SUM_HEADERS = ["SN", "Item Of Work", "%", "Cost in Rs.", "Cost in Lacs"];
  function sumColWidths() { return [46, 360, 62, 148, 122]; }
  const SUM_SUB_STYLE = { b: 1, bg: "EEF2FB" };
  const SUM_SAY_STYLE = { b: 1, bg: "E7EDFF" };
  function newSummarySheet() {
    const cells = {}; SUM_HEADERS.forEach((h, c) => { cells[addr(0, c)] = { v: h }; });
    const base = uniqueName(safeName("SUMMARY"));
    const sheet = { id: uid("sht"), name: base, rows: 1, cols: SUM_HEADERS.length, cells: cells, merges: [], colWidths: sumColWidths(), title: "Summary of Estimated Cost", lockTop: 1, lockBottom: 0, updatedAt: Date.now(), kind: "summary", group: "misc", masterId: null, source: "morth", serial: "" };
    state.sheets[sheet.id] = sheet; state.order.push(sheet.id); db.put("sheets", sheet);
    return sheet;
  }
  function summaryEnsureSheet(est) {
    if (est.summarySheetId && state.sheets[est.summarySheetId]) return state.sheets[est.summarySheetId];
    const sheet = newSummarySheet(); est.summarySheetId = sheet.id; db.put("estimates", est); return sheet;
  }
  // किसी BOQ शीट के Grand-Total सेल का cross-sheet reference (=Name!F<row>), वरना null
  function boqGrandRef(boq) { if (!boq) return null; const gr = domFindRole(boq, "grandtot"); return gr < 0 ? null : ("=" + boq.name + "!F" + (gr + 1)); }
  // मुख्य कार्य के BOQ में नहीं लिए गए Sub-Estimate (जो Summary में स्वतः जुड़ते हैं)
  function summaryLeftoverSubs(est) {
    const mainSubIds = new Set(estMainExtras(est).filter((x) => x.type === "sub").map((x) => x.subId));
    return estSubs(est).filter((sub) => !mainSubIds.has(sub.id));
  }
  // किसी कॉलम-A marker (sumkind) वाली पंक्ति ढूँढो
  function summaryFindMarker(sheet, kind) {
    for (let r = 1; r < sheet.rows; r++) { const c = sheet.cells[addr(r, 0)]; if (c && c.sumkind === kind) return r; }
    return -1;
  }
  // पुरानी (marker-रहित) शीट/Template में "Total (A)" पंक्ति ढूँढकर marker जोड़ो — ताकि reconcile चल सके
  function summaryEnsureMarkers(sheet) {
    if (summaryFindMarker(sheet, "totalA") >= 0) return true;
    for (let r = 1; r < sheet.rows; r++) {
      const c = sheet.cells[addr(r, 1)]; const v = c ? (c.f != null ? c.f : c.v) : "";
      if (typeof v === "string" && /total\s*\(\s*a\s*\)/i.test(v)) {
        const a = addr(r, 0); if (!sheet.cells[a]) sheet.cells[a] = { v: "" }; sheet.cells[a].sumkind = "totalA"; return true;
      }
    }
    return false;
  }
  // Data-zone (हमेशा live) — header + BOQ + शेष Sub-Estimate + Total(A); marker सहित। लौटाता है {aIdx, nextR}
  //  कॉलम: A=SN, B=Item, C=%, D=Cost in Rs., E=Cost in Lacs
  function summaryWriteDataZone(est, sheet) {
    const wgs = estWorkGroups(est); const mainWg = wgs.find((w) => w.isMain) || wgs[0];
    sheet.cells = {}; SUM_HEADERS.forEach((h, c) => { sheet.cells[addr(0, c)] = { v: h }; });
    sheet.cols = SUM_HEADERS.length;
    sheet.colWidths = (sheet.colWidths && sheet.colWidths.length === SUM_HEADERS.length) ? sheet.colWidths : sumColWidths();
    let r = 1, sn = 0;
    const setF = (rr, cc, raw) => domSetSheetCell(sheet, rr, cc, raw);
    const E = (rr) => rr + 1;
    const lacs = (rr) => "=IF(D" + E(rr) + "=\"\",\"\",ROUND(D" + E(rr) + "/100000,2))";
    const mark = (rr, kind) => { const a = addr(rr, 0); if (!sheet.cells[a]) sheet.cells[a] = { v: "" }; sheet.cells[a].sumkind = kind; };
    // BOQ (शीट बनी हो तो live-link, वरना गणना-मूल्य)
    const mainBoq = (mainWg && est.boqSheets) ? state.sheets[est.boqSheets[mainWg.id]] : null;
    const s1 = boqGrandRef(mainBoq); const boqTotal = mainWg ? computeGroupTotal(est, mainWg) : 0;
    setF(r, 0, ++sn); setF(r, 1, (mainWg ? mainWg.name : "Road Work") + " — Cost of work as per BOQ");
    setF(r, 3, s1 || boqTotal); setF(r, 4, lacs(r)); mark(r, "boq"); r++;
    // शेष Sub-Estimate
    const leftover = summaryLeftoverSubs(est);
    leftover.forEach((sub) => {
      const subBoq = sub.boqSheetId ? state.sheets[sub.boqSheetId] : null;
      setF(r, 0, ++sn); setF(r, 1, subFullText(sub) + " — अन्य कार्य-समूह (BOQ में नहीं लिया)");
      setF(r, 3, boqGrandRef(subBoq) || computeSubTotal(est, sub)); setF(r, 4, lacs(r)); mark(r, "sub"); r++;
    });
    // Total (A)
    const aIdx = r; setF(r, 1, "Total (A) ="); setF(r, 3, "=ROUND(SUM(D2:D" + r + "),2)"); setF(r, 4, lacs(r));
    for (let c = 0; c < SUM_HEADERS.length; c++) domStyle(sheet, r, c, TOTAL_STYLE); mark(r, "totalA"); r++;
    est.summary = est.summary || {}; est.summary.autoSubIds = leftover.map((s) => s.id);
    return { aIdx: aIdx, nextR: r, lastSn: sn };
  }
  // पूरी default तालिका — data-zone + (केवल GST, फिर Nett)
  function summaryBuildDefault(est, sheet) {
    const dz = summaryWriteDataZone(est, sheet);
    let r = dz.nextR; const aE = dz.aIdx + 1;
    const setF = (rr, cc, raw) => domSetSheetCell(sheet, rr, cc, raw);
    const E = (rr) => rr + 1;
    const lacs = (rr) => "=IF(D" + E(rr) + "=\"\",\"\",ROUND(D" + E(rr) + "/100000,2))";
    setF(r, 0, (dz.lastSn || 0) + 1); setF(r, 1, "Add for GST on civil work"); setF(r, 2, 18);
    setF(r, 3, "=ROUND(D" + aE + "*C" + E(r) + "/100,2)"); setF(r, 4, lacs(r)); domStyle(sheet, r, 2, { bg: "E7F5E9" });
    const gstE = E(r); r++;
    setF(r, 1, "Nett Amount ="); setF(r, 3, "=ROUND(D" + aE + "+D" + gstE + ",2)"); setF(r, 4, lacs(r));
    for (let c = 0; c < SUM_HEADERS.length; c++) domStyle(sheet, r, c, TOTAL_STYLE); r++;
    sheet.rows = r;
    ensureLock(sheet); persistSheet(sheet, true); db.put("estimates", est); buildEngine();
  }
  // सभी Utility पंक्तियाँ (col-0 marker sumkind='utility') — {r, name(Short)}
  function summaryUtilityRows(sheet) {
    const list = [];
    for (let r = 1; r < sheet.rows; r++) { const c0 = sheet.cells[addr(r, 0)]; if (c0 && c0.sumkind === "utility") list.push({ r: r, name: c0.utilShort || (sheet.cells[addr(r, 1)] || {}).v || "Utility" }); }
    return list;
  }
  // Nett Total = Total Road Cost + सभी Utility; Say Rs = round(Nett Total) — markers से पहचान
  function summaryRecalcNett(sheet) {
    const A1 = (r) => r + 1;
    const roadR = summaryFindMarker(sheet, "roadfinal");
    const nettR = summaryFindMarker(sheet, "netttotal");
    const sayR = summaryFindMarker(sheet, "finalsay");
    const utils = summaryUtilityRows(sheet).map((u) => u.r);
    if (nettR >= 0 && roadR >= 0) {
      const parts = ["D" + A1(roadR)].concat(utils.map((u) => "D" + A1(u)));
      domSetSheetCell(sheet, nettR, 3, "=ROUND(" + parts.join("+") + ",2)");
      domSetSheetCell(sheet, nettR, 4, "=ROUND(D" + A1(nettR) + "/100000,2)");
    }
    if (sayR >= 0 && nettR >= 0) {
      domSetSheetCell(sheet, sayR, 3, "=ROUND(D" + A1(nettR) + ",-3)");
      domSetSheetCell(sheet, sayR, 4, "=ROUND(D" + A1(sayR) + "/100000,2)");
    }
  }
  // Utility पंक्तियों की क्रम-संख्या (SN) — ठीक ऊपर वाली numbered पंक्ति से आगे, क्रमवार
  function summaryRenumberUtils(sheet) {
    const utils = summaryUtilityRows(sheet).map((u) => u.r).sort((a, b) => a - b);
    if (!utils.length) return;
    let base = 0;
    for (let r = utils[0] - 1; r >= 1; r--) { const v = (sheet.cells[addr(r, 0)] || {}).v; const n = (typeof v === "number") ? v : (typeof v === "string" && /^\d/.test(String(v).trim()) ? parseFloat(v) : NaN); if (isFinite(n)) { base = Math.round(n); break; } }
    utils.forEach((r, i) => { const a0 = addr(r, 0); const cell = sheet.cells[a0] || (sheet.cells[a0] = { v: "" }); cell.v = base + i + 1; });   // sumkind/utilShort बने रहते हैं
  }
  // Utility पंक्ति जोड़ें — पहली Utility पर Road Cost की आखिरी 'Say Rs' लाइन को 'Total Road Cost =' बनाकर
  //  नीचे [Utility…] → 'Nett Total =' → 'Say Rs. (in Lacs) =' section बनाता है; बाद की Utility उसी section में जुड़ती है
  function summaryAddUtility() {
    const est = state.estimates[state.activeEstimateId]; if (!est) return;
    const shortName = (prompt("Utility का Short Name — Cover पेज पर यही दिखेगा (Summary में detail कुछ भी लिख सकते हैं):", "") || "").trim();
    if (!shortName) return;
    const sheet = summaryEnsureSheet(est);
    if (state.activeSheetId !== sheet.id) openSheet(sheet.id);
    const A1 = (r) => r + 1;
    const lblOf = (r) => { const c = sheet.cells[addr(r, 1)]; return (c && typeof c.v === "string") ? c.v : ""; };
    const markCol0 = (r, kind, short) => { const a = addr(r, 0); if (!sheet.cells[a]) sheet.cells[a] = { v: "" }; sheet.cells[a].sumkind = kind; if (short != null) sheet.cells[a].utilShort = short; };
    const utilCells = (r) => {
      domSetSheetCell(sheet, r, 1, shortName);
      domSetSheetCell(sheet, r, 3, "0");
      domSetSheetCell(sheet, r, 4, "=IF(D" + A1(r) + "=\"\",\"\",ROUND(D" + A1(r) + "/100000,2))");
      markCol0(r, "utility", shortName);
    };

    let nettR = summaryFindMarker(sheet, "netttotal");
    if (nettR < 0) {
      // पहली Utility — Road Cost की अंतिम पंक्ति ढूँढो (Nett Amount / Say Rs → कोई भी labeled)
      let roadR = -1;
      for (let r = sheet.rows - 1; r >= 1; r--) { const l = lblOf(r); if (/Nett\s*Amount/i.test(l) || /Say\s*Rs/i.test(l)) { roadR = r; break; } }
      if (roadR < 0) for (let r = sheet.rows - 1; r >= 1; r--) { if (lblOf(r).trim()) { roadR = r; break; } }
      if (roadR < 0) { alert("Road Cost की अंतिम पंक्ति नहीं मिली।"); return; }
      // अंतिम पंक्ति → 'Total Road Cost =' (मान/formula वही रहते हैं) + roadfinal marker
      domSetSheetCell(sheet, roadR, 1, "Total Road Cost =");
      markCol0(roadR, "roadfinal");
      const sayStyles = []; for (let c = 0; c < SUM_HEADERS.length; c++) { const cc = sheet.cells[addr(roadR, c)]; sayStyles.push(cc && cc.s ? Object.assign({}, cc.s) : null); }
      persistSheet(sheet, true); buildEngine();
      if (!structuralBatch("insRow", roadR + 1, 3)) return;   // Utility, Nett Total, Nett Amount
      const uR = roadR + 1, nR = roadR + 2, sR = roadR + 3;
      utilCells(uR);
      domSetSheetCell(sheet, nR, 1, "Nett Total =");
      for (let c = 0; c < SUM_HEADERS.length; c++) domStyle(sheet, nR, c, TOTAL_STYLE);
      markCol0(nR, "netttotal");
      domSetSheetCell(sheet, sR, 1, "Nett Amount =");   // Summary की अंतिम पंक्ति हमेशा 'Nett Amount ='
      for (let c = 0; c < SUM_HEADERS.length; c++) domStyle(sheet, sR, c, sayStyles[c] || SUM_SAY_STYLE);
      markCol0(sR, "finalsay");
    } else {
      // बाद की Utility — मौजूदा section में, 'Nett Total =' से ठीक पहले
      if (!structuralBatch("insRow", nettR, 1)) return;
      utilCells(nettR);
    }
    persistSheet(sheet, true); buildEngine();
    summaryRecalcNett(sheet);      // Nett Total = Total Road Cost + Σ Utility; Say Rs = round(Nett Total)
    summaryRenumberUtils(sheet);   // क्रम-संख्या अपने-आप
    ensureLock(sheet); persistSheet(sheet, true); db.put("estimates", est); buildEngine(); renderGrid();
    status("Utility जुड़ी: " + shortName + " — 'Cost in Rs.' भरें; Nett Total/Say व Cover अपने-आप");
  }
  function summaryRemoveUtility() {
    const est = state.estimates[state.activeEstimateId]; if (!est) return;
    const sheet = summaryEnsureSheet(est);
    if (state.activeSheetId !== sheet.id) openSheet(sheet.id);
    const utils = summaryUtilityRows(sheet);
    if (!utils.length) { alert("कोई Utility पंक्ति नहीं है।"); return; }
    let target = utils[utils.length - 1];
    if (utils.length > 1) {
      const ans = prompt("कौन-सी Utility हटाएँ? नंबर लिखें:\n\n" + utils.map((u, i) => (i + 1) + ". " + u.name).join("\n"), String(utils.length));
      if (ans === null) return;
      const idx = parseInt(ans, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= utils.length) { alert("अमान्य नंबर।"); return; }
      target = utils[idx];
    } else if (!confirm("Utility '" + target.name + "' हटाएँ?")) return;
    if (!structuralBatch("delRow", target.r, 1, true)) return;
    persistSheet(sheet, true); buildEngine();
    if (summaryUtilityRows(sheet).length) {
      // अभी भी Utility बची — Nett Total/Say व क्रम-संख्या ठीक करो
      summaryRecalcNett(sheet); summaryRenumberUtils(sheet);
    } else {
      // सभी Utility हटीं — section हटाओ: 'Nett Total' व अंतिम पंक्ति delete, 'Total Road Cost' → 'Nett Amount ='
      let nR = summaryFindMarker(sheet, "netttotal");
      if (nR >= 0) { if (!structuralBatch("delRow", nR, 1, true)) return; persistSheet(sheet, true); buildEngine(); }
      let sR = summaryFindMarker(sheet, "finalsay");
      if (sR >= 0) { if (!structuralBatch("delRow", sR, 1, true)) return; persistSheet(sheet, true); buildEngine(); }
      const roadR = summaryFindMarker(sheet, "roadfinal");
      if (roadR >= 0) { domSetSheetCell(sheet, roadR, 1, "Nett Amount ="); const a = addr(roadR, 0); if (sheet.cells[a]) delete sheet.cells[a].sumkind; persistSheet(sheet, true); buildEngine(); }
    }
    ensureLock(sheet); persistSheet(sheet, true); db.put("estimates", est); buildEngine(); renderGrid();
    status("Utility हटाई: " + target.name);
  }
  // Data-zone (BOQ + शेष Sub-Estimate + Total A) को live रखो; calc-zone (Total A के नीचे) ज्यों-का-त्यों
  //  (formula-refs पंक्ति-shift के अनुसार अपने-आप adjust)। marker न हो तो false (छेड़ो मत)।
  function summaryReconcile(est, sheet) {
    const aIdx = summaryFindMarker(sheet, "totalA");
    if (aIdx < 0) return false;
    const calcRows = [];
    for (let rr = aIdx + 1; rr < sheet.rows; rr++) {
      const cells = {};
      for (let c = 0; c < sheet.cols; c++) { const cell = sheet.cells[addr(rr, c)]; if (cell) cells[c] = JSON.parse(JSON.stringify(cell)); }
      calcRows.push(cells);
    }
    const dz = summaryWriteDataZone(est, sheet);
    const delta = dz.aIdx - aIdx;                      // कितनी पंक्तियाँ खिसकीं
    let r = dz.nextR;
    calcRows.forEach((cells) => {
      for (const c in cells) { const cell = cells[c]; if (cell.f != null) cell.f = shiftFormula(cell.f, delta, 0); sheet.cells[addr(r, +c)] = cell; }
      r++;
    });
    sheet.rows = r;
    ensureLock(sheet); persistSheet(sheet, true); db.put("estimates", est); buildEngine();
    return true;
  }
  /* ══════════ Bitumen / Emulsion — Rate Analysis (पूरी Excel शीट) ══════════
     कॉलम: A=SN, B=Rate, C=Bitumen(VG-40), D=Bitumen 60-70(VG-30), E=Bitumen 80-100(VG-10),
            F=Emulsion(SS-1) Bulk, G=Emulsion(SS-2) Bulk */
  const BIT_FMT_VER = 4;   // Bitumen Analysis format-संस्करण — बढ़ाने पर पुरानी शीटें auto-rebuild (v4: Say = FLOOR 0.10)
  function bitColWidths() { return [40, 230, 110, 130, 130, 108, 120, 150, 130, 104]; }   // 10 कॉलम
  // Bitumen Cartage — Including Contractor Profit दर, हमेशा Primary Rate की LOADED cartage version से
  //  (loaded version में न हो तो category-level fallback, वरना default 2.09)
  function loadedBitumenIncl() {
    const m = state.master["cartage"];
    if (m && m.loadedVersion) {
      const v = (m.versions || []).find((x) => x.date === m.loadedVersion);
      if (v && v.bitInclRate != null && mrNum(v.bitInclRate) > 0) return mrNum(v.bitInclRate);
    }
    const bc = m && m.bitumenCartage;
    if (bc) {
      if (bc.rateIncl != null && mrNum(bc.rateIncl) > 0) return mrNum(bc.rateIncl);
      if (bc.rate != null && mrNum(bc.rate) > 0) return round2(mrNum(bc.rate) * 1.10);   // पुराना (excl→incl)
    }
    return 2.09;   // default Including (→ Excluding 1.90)
  }
  function bitumenCartageRate() { return round2(loadedBitumenIncl() / 1.10); }   // Excluding = Including ÷ 1.10
  function bitumenCartageIncl() { return round2(loadedBitumenIncl()); }
  // Estimate के Bitumen Cartage विवरण से प्रभावी डेट (पहली भरी) — Bitumen Analysis के शीर्षक हेतु
  function bitumenEffDate(est) {
    const list = (est && Array.isArray(est.bitumenCartage)) ? est.bitumenCartage : [];
    for (const e of list) { if (e && e.date && String(e.date).trim()) return String(e.date).trim(); }
    return "";
  }
  // entries का signature — बदलने पर Bitumen Analysis फिर से बने
  function bitumenEntriesSig(est) {
    const list = (est && Array.isArray(est.bitumenCartage)) ? est.bitumenCartage : [];
    return JSON.stringify(list.map((e) => [e.type || "", e.refinery || "", e.rate || "", e.date || "", e.dist || "", e.side || ""]));
  }
  // Bitumen शीट के Cartage Rate कॉलम (G) व शीर्षक-डेट को ताज़ा करो (live-link; बाकी edits सुरक्षित)
  function bitumenRelinkRate(est, sheet) {
    const bcRate = bitumenCartageRate(); let changed = false;
    // शीर्षक की प्रभावी डेट (Estimate विवरण से)
    const eff = bitumenEffDate(est);
    if (eff) { const tc = sheet.cells[addr(0, 0)]; const want = "ANALYSIS OF RATE FOR BITUMEN / EMULSION   (As per date " + eff + ")"; if (tc && tc.v !== want) { tc.v = want; changed = true; } }
    for (let r = (sheet.lockTop || 4); r < sheet.rows; r++) {
      const hc = sheet.cells[addr(r, 7)];                                  // material पंक्ति: H में Total-Cartage formula
      const isMat = hc && hc.f != null && /F\d+\s*\*\s*G\d+/.test(hc.f);
      if (!isMat) { const cc = sheet.cells[addr(r, 2)]; if (!(cc && typeof cc.v === "number")) continue; }
      const a = addr(r, 6), cur = sheet.cells[a];
      const curV = cur ? (cur.f != null ? null : cur.v) : null;
      if (curV !== bcRate) { sheet.cells[a] = { v: bcRate, s: (cur && cur.s) ? cur.s : { al: "center" } }; changed = true; }
    }
    if (changed) { persistSheet(sheet, true); buildEngine(); }
    return changed;
  }
  function newBitumenSheet() {
    const base = uniqueName(safeName("BITUMEN"));
    const sheet = { id: uid("sht"), name: base, rows: 1, cols: 10, cells: {}, merges: [], colWidths: bitColWidths(), title: "", lockTop: 4, lockBottom: 0, updatedAt: Date.now(), kind: "bitumen", group: "misc", masterId: null, source: "morth", serial: "" };
    state.sheets[sheet.id] = sheet; state.order.push(sheet.id); db.put("sheets", sheet);
    return sheet;
  }
  function bitumenEnsureSheet(est) {
    if (est.bitumenSheetId && state.sheets[est.bitumenSheetId]) return state.sheets[est.bitumenSheetId];
    const sheet = newBitumenSheet(); est.bitumenSheetId = sheet.id; db.put("estimates", est);
    bitumenBuildDefault(est, sheet);
    return sheet;
  }
  function bitumenBuildDefault(est, sheet) {
    const set = (r, c, val, st) => {
      const cell = {};
      if (val != null && val !== "") { if (typeof val === "string" && val[0] === "=") cell.f = val; else cell.v = val; }
      else cell.v = "";
      if (st) cell.s = Object.assign({}, st);
      sheet.cells[addr(r, c)] = cell;
    };
    const NC = 10;
    sheet.cells = {}; sheet.cols = NC; sheet.colWidths = bitColWidths();
    // professional palette — गहरा indigo शीर्षक/header (श्वेत text), हल्की उप-पंक्तियाँ (गहरा text)
    const TITLE = "2E3A73", HEAD = "46538F", SUB = "DCE3F5", WHITE = "FFFFFF", INK = "1E2A5A";
    const GREY = "F1F2F6", TOT = "E8F0FB", SAY = "D7E2F5";
    const proj = (est && est.name) ? est.name : "";
    const d = new Date(); const p2 = (n) => String(n).padStart(2, "0");
    const today = p2(d.getDate()) + "-" + p2(d.getMonth() + 1) + "-" + d.getFullYear();
    const dateStr = bitumenEffDate(est) || today;   // प्रभावी डेट Estimate के विवरण से
    // शीर्षक + उपशीर्षक + इकाई (merged पंक्तियाँ)
    set(0, 0, "ANALYSIS OF RATE FOR BITUMEN / EMULSION   (As per date " + dateStr + ")", { b: 1, al: "center", sz: 15, bg: TITLE, fc: WHITE });
    set(1, 0, proj, { b: 1, al: "center", sz: 12, bg: SUB, fc: INK });
    set(2, 0, "Taking Unit  —  1 M.T.", { b: 1, al: "left", bg: SUB, fc: INK });
    // header (row 3) — हर material एक पंक्ति; per-material Cartage विवरण कॉलम में
    ["SN", "Bitumen / Emulsion का प्रकार", "Basic Rate (₹)", "One Side / Both Side", "Refinery से दूरी (km)", "कुल दूरी (km)", "Cartage Rate (₹/km)", "Total Cartage Amount (₹)", "Total Amount (₹)", "Say Rs."]
      .forEach((h, c) => set(3, c, h, { b: 1, al: "center", bg: HEAD, fc: WHITE }));
    // Bitumen Cartage दर (Excluding Contractor Profit = Including ÷ 1.10) — Master से
    const bcRate = bitumenCartageRate();
    // materials — Estimate के Bitumen Cartage विवरण से (Refinery + Rate + दूरी + Side); न हों तो default 5
    const entries = (est && Array.isArray(est.bitumenCartage)) ? est.bitumenCartage.filter((x) => x && (String(x.type || "").trim() || String(x.refinery || "").trim() || String(x.rate || "").trim())) : [];
    const mats = entries.length
      ? entries.map((x) => ({ name: x.type || x.refinery || "Bitumen", basic: mrNum(x.rate), dist: mrNum(x.dist), side: x.side || "Both Side" }))
      : [
        { name: "Bitumen (VG-40)", basic: 49002, dist: 327, side: "Both Side" },
        { name: "Bitumen 60-70 (VG-30)", basic: 46532, dist: 327, side: "Both Side" },
        { name: "Bitumen 80-100 (VG-10)", basic: 44232, dist: 327, side: "Both Side" },
        { name: "Emulsion (SS-1) Bulk", basic: 47423, dist: 235, side: "Both Side" },
        { name: "Emulsion (SS-2) Bulk", basic: 45351, dist: 235, side: "Both Side" },
      ];
    let r = 4;
    mats.forEach((mm, i) => {
      const e = r + 1;   // Excel row
      set(r, 0, String(i + 1), { al: "center" });
      set(r, 1, mm.name, { al: "left", b: 1 });
      set(r, 2, mm.basic, { bg: GREY, al: "right" });                                    // C Basic Rate
      set(r, 3, mm.side || "Both Side", { al: "center" });                               // D One Side/Both Side
      set(r, 4, mm.dist, { al: "center" });                                              // E Refinery से दूरी (one-way)
      set(r, 5, "=IF(D" + e + "=\"Both Side\",E" + e + "*2,E" + e + ")", { al: "center" }); // F कुल दूरी
      set(r, 6, bcRate, { al: "center" });                                               // G Cartage Rate (₹/km)
      set(r, 7, "=ROUND(F" + e + "*G" + e + ",2)", { al: "right" });                     // H Total Cartage = कुल दूरी × दर
      set(r, 8, "=ROUND(C" + e + "+H" + e + ",2)", { b: 1, bg: TOT, al: "right" });       // I Total Amount = Basic + Cartage
      set(r, 9, "=FLOOR(I" + e + ",0.1)", { b: 1, bg: SAY, al: "right" });                 // J Say Rs. — FLOOR(value, 0.10)
      r++;
    });
    sheet.rows = r;
    sheet.merges = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: NC - 1 } },   // title
      { s: { r: 1, c: 0 }, e: { r: 1, c: NC - 1 } },   // subtitle
      { s: { r: 2, c: 0 }, e: { r: 2, c: NC - 1 } },   // Taking Unit
    ];
    sheet.lockTop = 4; sheet.lockBottom = 0;
    sheet.bitFmtVer = BIT_FMT_VER;                   // वर्तमान format-संस्करण (पुरानी शीट auto-upgrade हेतु)
    est.bitumenBuiltSig = bitumenEntriesSig(est);   // किन entries से बनी — बदलने पर फिर से बने
    ensureLock(sheet); persistSheet(sheet, true); db.put("estimates", est); buildEngine();
  }
  function renderBitumen() {
    const est = state.estimates[state.activeEstimateId];
    if (!est) { state.activeSheetId = null; renderGrid(); return; }
    const sheet = bitumenEnsureSheet(est);
    // पुराना/खाली, format पुराना, या Estimate के Bitumen Cartage विवरण (Rate/Date/दूरी/Side) बदले → फिर से बनाओ
    if (sheet.cols !== 10 || sheet.rows <= 1 || sheet.bitFmtVer !== BIT_FMT_VER || est.bitumenBuiltSig !== bitumenEntriesSig(est)) bitumenBuildDefault(est, sheet);
    else bitumenRelinkRate(est, sheet);   // सिर्फ़ Cartage Rate (master loaded) + शीर्षक-डेट ताज़ा
    openSheet(sheet.id);
  }
  function openBitumenView() { setActiveView("bitumen"); }

  /* ══════════ Basic Sheet › Cover Page — HTML दस्तावेज़ template ══════════
     Design A = "UP सरकार" — राज्य-emblem, शीर्षक, विवरण, लम्बाई, कुल लागत + breakdown।
     विवरण Estimate विवरण form से (est + est.cover); Template लोड = design + आगणन-प्रकार + कार्य-प्रकार। */
  // योजना का नाम — Dashboard › वार्षिक योजना (Supabase 'main' › 8_Work_Types) से live;
  // offline/local या न मिलने पर यह fallback सूची
  const YOJANA_TYPES = ["पैच मरम्मत", "विशेष मरम्मत", "नवीनीकरण", "चौड़ीकरण एवं सुदृढीकरण", "पुल/पुलिया/सेतु मरम्मत", "नव निर्माण", "अन्य"];
  let yojanaTypes = YOJANA_TYPES.slice();   // वर्तमान सूची (cloud से ताज़ा होती है)
  let _yojanaFetched = false;
  // Dashboard के 8_Work_Types (Supabase spreadsheet 'main') से कार्य-प्रकार पढ़ो (cloud mode में)
  async function fetchWorkTypesCloud() {
    if (!_cloudMode || !_cloudToken) return null;
    try {
      const all = await cloudCall("loadAll", { ss: "main" });
      const rows = all && all["8_Work_Types"];
      if (!Array.isArray(rows)) return null;
      const names = rows.slice(1).map((r) => String((r && r[0]) || "").trim()).filter(Boolean);
      return names.length ? names : null;
    } catch (e) { return null; }
  }
  // cloud सूची लो; मिले तो yojanaTypes ताज़ा करो (fallback के छूटे प्रकार अंत में जोड़ो), फिर callback
  async function loadYojanaTypes(onDone) {
    if (_yojanaFetched) return;
    _yojanaFetched = true;
    const names = await fetchWorkTypesCloud();
    if (names && names.length) {
      const merged = names.slice();
      YOJANA_TYPES.forEach((d) => { if (merged.indexOf(d) < 0) merged.push(d); });
      yojanaTypes = merged;
      if (onDone) { try { onDone(); } catch (e) {} }
    }
  }
  // <select> भरो — सूची + (सूची में न हो तो) वर्तमान मान
  function fillYojanaSelect(cur) {
    const sel = document.getElementById("neCovYojana"); if (!sel) return;
    const opts = yojanaTypes.slice();
    if (cur && opts.indexOf(cur) < 0) opts.unshift(cur);
    sel.innerHTML = "<option value=''>— योजना चुनें —</option>" +
      opts.map((o) => "<option value=\"" + escapeHtml(o) + "\"" + (o === cur ? " selected" : "") + ">" + escapeHtml(o) + "</option>").join("");
  }
  // क्षेत्र/वृत्त/खंड — डिफ़ॉल्ट (खाली होने पर हमेशा यही; form पर बदलने पर बदल जाएगा)
  const DEF_KSHETRA = "झांसी क्षेत्र, लो0नि0वि0, झांसी";
  const DEF_VRITT = "झांसी वृत्त, लो0नि0वि0, झांसी";
  const DEF_KHAND = "प्रांतीय खंड, लो0नि0वि0, उरई (जालौन)";
  function ensureCover(est) {
    if (!est.cover) est.cover = {};
    const c = est.cover;
    if (c.design == null) c.design = "up-sarkar";
    if (c.aagType == null) c.aagType = "प्रारम्भिक आगणन";
    if (c.workType == null) c.workType = "";
    if (!c.kshetra || c.kshetra === "झांसी") c.kshetra = DEF_KSHETRA;   // पुराना छोटा default upgrade
    if (!c.vritt) c.vritt = DEF_VRITT;
    if (!c.khand) c.khand = DEF_KHAND;
    ["vidhanSabha", "lokSabha", "block", "srishti", "yojana", "totalLen", "costRoad", "costPole", "costTree", "je", "ae", "ee", "se"].forEach((k) => { if (c[k] == null) c[k] = ""; });
    return c;
  }
  function covNum(v) { const n = mrNum(v); return isFinite(n) ? n : 0; }
  function fmtLakh(n) { return Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  // Summary पेज (Item Of Work=col1, Cost in Lacs=col4) से तीन लागतें पढ़ो — मिलें तो
  // Summary पंक्ति r का Amount (Cost in Lacs → या Cost in Rs.÷1,00,000) — जैसे भी भरा हो
  function summaryRowLacs(sheet, r) {
    let num = null;
    try { const cv = computedValue(sheet, r, 4).val; if (typeof cv === "number" && isFinite(cv)) num = cv; } catch (e) { }
    if (num == null) { const c4 = sheet.cells[addr(r, 4)]; if (c4 && typeof c4.v === "number" && isFinite(c4.v)) num = c4.v; }
    if (num == null) { try { const rs = computedValue(sheet, r, 3).val; if (typeof rs === "number" && isFinite(rs) && rs !== 0) num = round2(rs / 100000); } catch (e) { } }
    if (num == null) { const c3 = sheet.cells[addr(r, 3)]; if (c3 && typeof c3.v === "number" && c3.v) num = round2(c3.v / 100000); }
    return num;
  }
  // कवर का breakdown ठीक Summary जैसा — road(Construction Cost) + Utility पंक्तियाँ (जो Summary पर हैं वही)
  function coverCostsFromSummary(est) {
    const out = { road: null, utils: [] };   // utils: [{name(Short), amount}]
    const sheet = (est && est.summarySheetId) ? state.sheets[est.summarySheetId] : null;
    if (!sheet) return out;
    const has = (t, keys) => keys.some((k) => t.indexOf(k) >= 0);
    for (let r = 1; r < sheet.rows; r++) {
      const c0 = sheet.cells[addr(r, 0)];
      const lc = sheet.cells[addr(r, 1)];
      let label = lc ? (lc.f != null ? "" : lc.v) : "";
      label = String(label || "").replace(/\s+/g, " ").trim();
      if (c0 && c0.sumkind === "utility") {   // marked Utility → Short Name + amount (Summary का detail चाहे कुछ भी हो)
        out.utils.push({ name: (c0.utilShort || label || "Utility"), amount: summaryRowLacs(sheet, r) || 0 });
        continue;
      }
      if (c0 && c0.sumkind === "roadfinal") {   // 'Total Road Cost =' — Utility होने पर road यही
        const rn = summaryRowLacs(sheet, r); if (rn != null) out.road = rn;
        continue;
      }
      if (c0 && (c0.sumkind === "netttotal" || c0.sumkind === "finalsay")) continue;   // ये road/utility नहीं
      if (!label) continue;
      const num = summaryRowLacs(sheet, r);
      if (num == null) continue;
      // road = Construction Cost (base) — Total(A)/Nett/Say नहीं (roadfinal marker मिले तो वही जीतता है)
      if (out.road == null && (has(label, ["Construction Cost"]) || (has(label, ["मार्ग निर्माण"]) && !has(label, ["कुल"])))) { out.road = num; continue; }
      // पुरानी (बिना marker) provision पंक्तियाँ भी Utility की तरह दिखाओ (जो Summary पर हैं वही कवर पर)
      if (has(label, ["विधुत पोल", "विद्युत पोल", "पोल विस्थापन", "पेड़ पातन", "पेड़ कटान", "वृक्ष"])) out.utils.push({ name: label, amount: num });
    }
    return out;
  }
  // कवर की लागतें — Summary से (मिलें तो), वरना est.cover के पुराने मान (fallback)
  function coverCosts(est, c) {
    const s = coverCostsFromSummary(est);
    const utils = (s.utils || []).map((u) => ({ name: u.name, amount: round2(u.amount || 0) }));
    const utilTotal = utils.reduce((a, u) => a + u.amount, 0);
    const road = s.road != null ? s.road : covNum(c.costRoad);
    return { road: round2(road), pole: round2(utilTotal), tree: 0, utils: utils, total: round2(road + utilTotal) };
  }
  // Design A — UP सरकार कवर (HTML)
  function coverRenderUP(est, c) {
    const esc = escapeHtml;
    const cost = coverCosts(est, c);
    const total = cost.total;
    const emblem = c.emblem
      ? "<img class='cov-emblem' src='" + c.emblem + "' alt='राज्य चिन्ह' />"
      : "<div class='cov-emblem cov-emblem-ph'>राज्य<br>चिन्ह<br><small>(अपलोड करें)</small></div>";
    return "" +
      "<div class='cov-gov'>लोक निर्माण विभाग</div>" +
      "<div class='cov-emblem-wrap'>" + emblem + "</div>" +
      "<div class='cov-title-box'>" + esc(c.aagType || "प्रारम्भिक आगणन") + "</div>" +
      "<div class='cov-year-box'>आगणन का वर्ष " + esc(est.year || "—") + "</div>" +
      "<div class='cov-fields'>" +
        "<div class='cov-row'><span class='cov-lbl'>मार्ग का नाम :&ndash;</span><span class='cov-val strong'>" + esc(est.name || "—") + "</span></div>" +
        "<div class='cov-row cov-row-2'><span class='cov-lbl'>मार्ग का यूनिक कोड :&ndash;</span><span class='cov-val'>" + esc(est.roadCode || "—") + "</span>" +
          "<span class='cov-lbl2'>मार्ग का सृष्टि कोड &ndash;</span><span class='cov-val strong'>" + esc(c.srishti || "—") + "</span></div>" +
        "<div class='cov-row'><span class='cov-lbl'>क्षेत्र का नाम :&ndash;</span><span class='cov-val'>" + esc(c.kshetra || "—") + "</span></div>" +
        "<div class='cov-row'><span class='cov-lbl'>वृत्त का नाम :&ndash;</span><span class='cov-val'>" + esc(c.vritt || "—") + "</span></div>" +
        "<div class='cov-row'><span class='cov-lbl'>खण्ड का नाम :&ndash;</span><span class='cov-val'>" + esc(c.khand || "—") + "</span></div>" +
        "<div class='cov-row'><span class='cov-lbl'>विधानसभा :&ndash;</span><span class='cov-val'>" + esc(c.vidhanSabha || "—") + "</span></div>" +
        "<div class='cov-row'><span class='cov-lbl'>लोकसभा :&ndash;</span><span class='cov-val'>" + esc(c.lokSabha || "—") + "</span></div>" +
        "<div class='cov-row'><span class='cov-lbl'>योजना का नाम :&ndash;</span><span class='cov-val'>" + esc(c.yojana || c.workType || "—") + "</span></div>" +
      "</div>" +
      "<div class='cov-len'>" +
        "<div class='cov-row'><span class='cov-lbl'>मार्ग की प्रस्तावित लम्बाई :&ndash;</span><span class='cov-val big'>" + esc(est.length || "—") + "</span><span class='cov-unit'>कि०मी०</span></div>" +
        "<div class='cov-row'><span class='cov-lbl'>मार्ग की कुल लम्बाई :&ndash;</span><span class='cov-val big2'>" + esc(c.totalLen || est.length || "—") + "</span><span class='cov-unit'>कि०मी०</span></div>" +
      "</div>" +
      "<div class='cov-cost'><span class='cov-lbl'>कुल लागत :&ndash; रू०</span><span class='cov-cost-val'>" + fmtLakh(total) + "</span><span class='cov-unit'>लाख</span></div>" +
      // Summary पर कोई Utility न हो → breakdown सेक्शन नहीं दिखेगा
      ((cost.utils && cost.utils.length) ?
        "<div class='cov-break'>" +
          "<div class='cb-row'><span>मार्ग निर्माण की लागत</span><span>" + fmtLakh(cost.road) + " लाख</span></div>" +
          cost.utils.map((u) => "<div class='cb-row'><span>" + esc(u.name) + " की लागत</span><span>" + fmtLakh(u.amount) + " लाख</span></div>").join("") +
          "<div class='cb-row cb-total'><span>मार्ग निर्माण की कुल लागत</span><span>" + fmtLakh(total) + " लाख</span></div>" +
        "</div>" : "");
  }
  function coverRender(est, c) { return coverRenderUP(est, c); }   // अभी एक ही design; आगे design-अनुसार switch
  function renderCover() {
    const est = state.estimates[state.activeEstimateId];
    const host = document.getElementById("coverDoc"); if (!host) return;
    if (!est) { host.innerHTML = "<div class='cover-empty muted'>पहले कोई Estimate खोलें/चुनें — फिर उसका कवर यहाँ बनेगा।</div>"; return; }
    const c = ensureCover(est);
    const at = document.getElementById("covAagType"); if (at) at.value = c.aagType;
    const yj = document.getElementById("covYojana");
    if (yj) {
      const cur = c.yojana || c.workType || "";
      const opts = yojanaTypes.slice(); if (cur && opts.indexOf(cur) < 0) opts.unshift(cur);
      yj.innerHTML = "<option value=''>— योजना चुनें —</option>" + opts.map((o) => "<option value=\"" + escapeHtml(o) + "\"" + (o === cur ? " selected" : "") + ">" + escapeHtml(o) + "</option>").join("");
    }
    loadYojanaTypes(() => renderCover());   // Dashboard की live कार्य-प्रकार सूची (cloud) — मिलते ही ताज़ा
    const dg = document.getElementById("covDesign"); if (dg) dg.value = c.design || "up-sarkar";
    host.innerHTML = coverRender(est, c);
  }
  function openCoverView() {
    if (!state.activeEstimateId) { alert("पहले कोई Estimate खोलें/चुनें (Load Estimate)।"); return; }
    setActiveView("cover");
  }
  function printCover(est) {
    const c = ensureCover(est);
    const area = document.getElementById("printArea"); if (!area) return;
    area.innerHTML = "<div class='cover-doc cover-print'>" + coverRender(est, c) + "</div>";
    window.print();
  }

  /* ══════════ Basic Sheet › Checklist — Checking Proforma (HTML दस्तावेज़) ══════════
     अंग्रेज़ी proforma + नीचे अधिकारियों की तालिका (est.cover के officer विवरण से) */
  const CHECKLIST_SECTIONS = [
    { t: "Report", items: [
      "Proper references have been quoted and attested copies attached to the estimate.",
      "In case of a revised estimate, the amount of excess has been given item-wise in the comparative statement with detailed reasons.",
      "Signatures of A.E., E.E. & S.E. exist.",
      "Details of forest land with name of village & chainage are attached or not.",
      "Required certificates are mentioned or not.",
      "Name of the J.E./A.E. who surveyed the work for preparation of the estimate.",
    ] },
    { t: "Physical / Financial Targets Sheet attached or not.", items: [] },
    { t: "Specifications", items: [
      "Detailed specifications for each item of work are included in the estimate.",
      "Signatures of A.E., E.E. & S.E. exist.",
    ] },
    { t: "Designs", items: [
      "Traffic census details are attached or not.",
      "C.B.R. value details are attached or not.",
      "Detailed design of overlay is attached or not.",
      "Each design has been signed by A.E., E.E. & S.E. at the end, and important designs by C.E. as well.",
    ] },
    { t: "Analysis of Rates", items: [
      "Analysis of the latest bitumen rates is attached or not.",
      "Required quantity of bitumen for this work has been worked out.",
      "Each analysis of rate has been signed by J.E., A.E., E.E. and approved by S.E.",
    ] },
    { t: "Details of Measurements", items: [
      "Each page has been signed by the J.E., A.E. and by E.E. at the end of each set.",
    ] },
    { t: "Bill of Quantity", items: [
      "Each page bears the signatures of J.E., A.E. and E.E. at the end of each set.",
    ] },
    { t: "Summary of Estimated Cost", items: [
      "This has been signed by A.E., E.E., S.E. & C.E.",
    ] },
    { t: "Plans", items: [
      "Line diagram on a 1 = 4 mile map with the road marked in red colour, duly signed by J.E., A.E. & countersigned by E.E.",
      "Plans have been signed by J.E., A.E. & E.E.",
    ] },
    { t: "General", items: [
      "Name and designation should exist below the signature.",
      "Each page of the designs, analysis of rates, details of measurements, bill of quantity and summary of estimated cost should be certified as \"Checked and corrected by JE(T) of the Divisional office and Circle office\" with their signatures at the end.",
      "The signature of the local head of the department should exist on the report, specification, summary of estimated cost and plans.",
    ] },
  ];
  const ALPHA = "abcdefghijklmnopqrstuvwxyz";
  // est.cover के officer विवरण → तालिका पंक्तियाँ (क्रम: JE · AE · Divisional JE(T) · EE · JE(T) Circle · SE)
  function checklistOfficers(est) {
    const c = ensureCover(est);
    const je = (Array.isArray(c.jeList) && c.jeList.length) ? c.jeList : (c.je ? [c.je] : []);
    const ae = (Array.isArray(c.aeList) && c.aeList.length) ? c.aeList : (c.ae ? [c.ae] : []);
    const rows = [];
    if (je.length) rows.push({ names: je, desig: je.length > 1 ? "Junior Engineers" : "Junior Engineer" });
    if (ae.length) rows.push({ names: ae, desig: ae.length > 1 ? "Assistant Engineers" : "Assistant Engineer" });
    if (c.jePraKhand) rows.push({ names: [c.jePraKhand], desig: "Divisional Junior Engineer (T)" });
    if (c.eeName || c.ee) rows.push({ names: [c.eeName || c.ee], desig: "Executive Engineer" });
    if (c.jePraVritt) rows.push({ names: [c.jePraVritt], desig: "Junior Engineer (T) — Circle" });
    if (c.seName || c.se) rows.push({ names: [c.seName || c.se], desig: "Superintending Engineer" });
    return rows;
  }
  function checklistRender(est) {
    const esc = escapeHtml;
    const work = (est && est.name) ? est.name : "";
    let body = "";
    CHECKLIST_SECTIONS.forEach((s, i) => {
      body += "<div class='chk-item'><span class='chk-n'>" + (i + 1) + ".</span><span class='chk-h'>" + esc(s.t) + (s.items.length ? " :-" : "") + "</span></div>";
      s.items.forEach((it, j) => {
        body += "<div class='chk-pt'><span class='chk-pn'>(" + ALPHA[j] + ")</span><span class='chk-tx'>" + esc(it) + "</span></div>";
      });
    });
    const rows = checklistOfficers(est);
    const offRows = rows.length ? rows.map((r, i) =>
      "<tr><td class='chk-sn'>" + (i + 1) + "</td><td class='chk-nm'>" + r.names.map((n) => esc(n)).join("<br>") + "</td><td class='chk-dg'>" + esc(r.desig) + "</td><td class='chk-sg'></td></tr>"
    ).join("") : "<tr><td class='chk-sn'></td><td class='chk-nm muted'>— Estimate विवरण में अधिकारी भरें —</td><td class='chk-dg'></td><td class='chk-sg'></td></tr>";
    return "" +
      "<div class='chk-hd'>CHECKING PROFORMA</div>" +
      "<div class='chk-sub'>Preliminary and Detailed Estimate</div>" +
      (work ? "<div class='chk-work'>" + esc(work) + "</div>" : "") +
      "<div class='chk-body'>" + body + "</div>" +
      "<table class='chk-off'><thead><tr><th style='width:44px'>S.No.</th><th>Name</th><th style='width:34%'>Designation</th><th style='width:24%'>Signature</th></tr></thead><tbody>" + offRows + "</tbody></table>";
  }
  function renderChecklist() {
    const est = state.estimates[state.activeEstimateId];
    const host = document.getElementById("checklistDoc"); if (!host) return;
    if (!est) { host.innerHTML = "<div class='cover-empty muted'>पहले कोई Estimate खोलें/चुनें — फिर उसका Checking Proforma यहाँ बनेगा।</div>"; return; }
    host.innerHTML = checklistRender(est);
  }
  function openChecklistView() {
    if (!state.activeEstimateId) { alert("पहले कोई Estimate खोलें/चुनें (Load Estimate)।"); return; }
    setActiveView("checklist");
  }
  function printChecklist(est) {
    const area = document.getElementById("printArea"); if (!area) return;
    area.innerHTML = "<div class='cover-doc chk-doc cover-print'>" + checklistRender(est) + "</div>";
    window.print();
  }

  /* ══════════ Basic Sheet › Index — विषय-सूची (HTML दस्तावेज़) ══════════ */
  const INDEX_ROWS = [
    "लोक निर्माण विभाग, उत्तर प्रदेश",
    "Index",
    "Checking Proforma",
    "Report",
    "Reference Letter",
    "Certificate",
    "Specifications",
    "Estimate Details",
    "Road Metal Rate (R.M.R)",
    "Rate Of Analysis",
    "Details of Measurements",
    "Bill of Quantity",
    "Abstract of cost",
    "District Map",
  ];
  function indexRender(est) {
    const esc = escapeHtml;
    const rows = INDEX_ROWS.map((c, i) =>
      "<tr><td class='idx-sn'>" + (i + 1) + "</td><td class='idx-ct'>" + esc(c) + "</td><td class='idx-pg'></td></tr>"
    ).join("");
    return "" +
      "<div class='idx-hd'>INDEX</div>" +
      "<table class='idx-tbl'><thead><tr><th style='width:16%'>S.No.</th><th>Content</th><th style='width:22%'>Page No.</th></tr></thead><tbody>" + rows + "</tbody></table>";
  }
  function renderIndex() {
    const est = state.estimates[state.activeEstimateId];
    const host = document.getElementById("indexDoc"); if (!host) return;
    if (!est) { host.innerHTML = "<div class='cover-empty muted'>पहले कोई Estimate खोलें/चुनें — फिर उसकी विषय-सूची यहाँ बनेगी।</div>"; return; }
    host.innerHTML = indexRender(est);
  }
  function openIndexView() {
    if (!state.activeEstimateId) { alert("पहले कोई Estimate खोलें/चुनें (Load Estimate)।"); return; }
    setActiveView("index");
  }
  function printIndex(est) {
    const area = document.getElementById("printArea"); if (!area) return;
    area.innerHTML = "<div class='cover-doc chk-doc idx-doc cover-print'>" + indexRender(est) + "</div>";
    window.print();
  }

  /* ══════════ Basic Sheet › Report — प्रतिवेदन (editable + linked fields) ══════════
     पूरा मैटर editable (contenteditable); कुछ span data-field से Estimate से live linked रहते हैं */
  function reportLinks(est) {
    const c = ensureCover(est);
    const cost = coverCosts(est, c);
    const ae = (Array.isArray(c.aeList) && c.aeList[0]) ? c.aeList[0] : (c.ae || "");
    return {
      workName: est.name || "",
      length: est.length || "",
      totalLen: c.totalLen || est.length || "",
      costRoad: fmtLakh(cost.road), costPole: fmtLakh(cost.pole), costTree: fmtLakh(cost.tree), costTotal: fmtLakh(cost.total),
      aeName: ae, eeName: c.eeName || c.ee || "", khand: c.khand || "", vritt: c.vritt || "",
      aagType: c.aagType || "प्रारम्भिक आगणन",
      approval: ((c.aagType || "").indexOf("विस्तृत") >= 0) ? "तकनीकी" : "प्रशासकीय एवं वित्तीय",
    };
  }
  // "प्रारम्भिक/विस्तृत आगणन" व स्वीकृति-प्रकार (प्रशासकीय-वित्तीय/तकनीकी) text → linked span (पुराने प्रतिवेदन में भी)
  function reportRelinkPhrases(host, est) {
    const c = ensureCover(est);
    const aag = c.aagType || "प्रारम्भिक आगणन";
    const approval = (aag.indexOf("विस्तृत") >= 0) ? "तकनीकी" : "प्रशासकीय एवं वित्तीय";
    const wrap = (splitRe, isMatch, field, val) => {
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, null);
      const targets = []; let n;
      while ((n = walker.nextNode())) { if (n.parentElement && n.parentElement.closest(".rpt-link")) continue; if (splitRe.test(n.nodeValue)) targets.push(n); }
      targets.forEach((tn) => {
        const frag = document.createDocumentFragment();
        tn.nodeValue.split(splitRe).forEach((p) => {
          if (isMatch(p)) { const s = document.createElement("span"); s.className = "rpt-link"; s.setAttribute("data-field", field); s.contentEditable = "false"; s.textContent = val; frag.appendChild(s); }
          else if (p) frag.appendChild(document.createTextNode(p));
        });
        tn.parentNode.replaceChild(frag, tn);
      });
    };
    wrap(/(प्रारम्भिक आगणन|विस्तृत आगणन)/, (p) => p === "प्रारम्भिक आगणन" || p === "विस्तृत आगणन", "aagType", aag);
    wrap(/(प्रशासकीय एवं वित्तीय|तकनीकी)(?=\s*स्वीकृति)/, (p) => p === "प्रशासकीय एवं वित्तीय" || p === "तकनीकी", "approval", approval);
  }
  function reportApplyLinks(host, est) {
    const links = reportLinks(est);
    host.querySelectorAll("[data-field]").forEach((el) => { const f = el.dataset.field; if (links[f] != null) el.textContent = links[f]; });
  }
  // ── Report तालिकाएँ: Row insert/delete + auto-Total ──
  function reportActionCell() {
    const td = document.createElement("td"); td.className = "rpt-act"; td.contentEditable = "false";
    td.innerHTML = "<button type='button' tabindex='-1' class='rpt-rowins' title='नीचे पंक्ति जोड़ें'>+</button><button type='button' tabindex='-1' class='rpt-rowdel' title='पंक्ति हटाएँ'>×</button>";
    return td;
  }
  function reportNum(td) { const n = parseFloat(String((td && td.textContent) || "").replace(/[^\d.\-]/g, "")); return isFinite(n) ? n : 0; }
  function reportFmtNum(n) { return Number.isInteger(n) ? String(n) : n.toFixed(2); }
  function reportRenumber(table) {
    const body = table.tBodies[0]; if (!body) return; let k = 0;
    Array.prototype.forEach.call(body.rows, (r) => { if (r.classList.contains("rpt-total-row")) return; const sn = r.querySelector(".rpt-sn"); if (sn) sn.textContent = String(++k); });
  }
  function reportRecalcCost(table) {
    const body = table.tBodies[0]; if (!body) return;
    const rows = Array.prototype.slice.call(body.rows);
    const totalRow = rows.filter((r) => r.classList.contains("rpt-total-row"))[0]; if (!totalRow) return;
    const dataRows = rows.filter((r) => !r.classList.contains("rpt-total-row"));
    [2, 3, 4].forEach((ci) => {
      let sum = 0; dataRows.forEach((r) => { if (r.cells[ci]) sum += reportNum(r.cells[ci]); });
      const tc = totalRow.querySelector(".rpt-tot[data-col='" + ci + "']"); if (tc) tc.textContent = sum ? reportFmtNum(sum) : "";
    });
  }
  function reportRecalcAll(host) { host.querySelectorAll(".rpt-cost").forEach((t) => reportRecalcCost(t)); }
  function reportInsertRow(btn) {
    const tr = btn.closest("tr"), table = btn.closest("table"); if (!tr || !table) return;
    const clone = tr.cloneNode(true);
    Array.prototype.forEach.call(clone.cells, (td) => { if (!td.classList.contains("rpt-act") && !td.classList.contains("rpt-sn")) td.innerHTML = ""; });
    tr.parentNode.insertBefore(clone, tr.nextSibling);
    reportRenumber(table); if (table.classList.contains("rpt-cost")) reportRecalcCost(table); saveReportNow();
  }
  function reportDeleteRow(btn) {
    const tr = btn.closest("tr"), table = btn.closest("table"); if (!tr || !table) return;
    const body = table.tBodies[0];
    const dataRows = Array.prototype.slice.call(body.rows).filter((r) => !r.classList.contains("rpt-total-row"));
    if (dataRows.length <= 1) { alert("कम से कम एक पंक्ति रहनी चाहिए।"); return; }
    tr.parentNode.removeChild(tr);
    reportRenumber(table); if (table.classList.contains("rpt-cost")) reportRecalcCost(table); saveReportNow();
  }
  // पुराने सहेजे प्रतिवेदन को नए format (action-column + total) में in-place upgrade (text सुरक्षित)
  function reportUpgrade(host) {
    const cost = host.querySelector(".rpt-tbl");
    if (cost && !cost.classList.contains("rpt-cost")) {
      cost.classList.add("rpt-cost");
      if (cost.tHead && cost.tHead.rows[0] && cost.tHead.rows[0].cells.length < 6) { const th = document.createElement("th"); th.className = "rpt-act"; th.contentEditable = "false"; cost.tHead.rows[0].appendChild(th); }
      const body = cost.tBodies[0];
      if (body) Array.prototype.forEach.call(body.rows, (r) => {
        const isTotal = r.classList.contains("rpt-total-row") || /total/i.test(r.textContent || "");
        if (isTotal) { r.classList.add("rpt-total-row"); [2, 3, 4].forEach((ci) => { if (r.cells[ci]) { r.cells[ci].classList.add("rpt-tot"); r.cells[ci].setAttribute("data-col", ci); } }); if (r.cells.length < 6) { const td = document.createElement("td"); td.className = "rpt-act"; td.contentEditable = "false"; r.appendChild(td); } }
        else { if (r.cells[0]) r.cells[0].classList.add("rpt-sn"); if (r.cells.length < 6) r.appendChild(reportActionCell()); }
      });
      reportRenumber(cost); reportRecalcCost(cost);
    }
    const prov = host.querySelector(".rpt-tbl2");
    if (prov && !prov.classList.contains("rpt-prov")) {
      prov.classList.add("rpt-prov");
      const body = prov.tBodies[0];
      if (body) Array.prototype.forEach.call(body.rows, (r) => { if (r.cells[0]) r.cells[0].classList.add("rpt-sn"); if (r.cells.length < 4) r.appendChild(reportActionCell()); });
      reportRenumber(prov);
    }
  }
  const REPORT_PROV = [
    ["Dismantling of Road", "डिवाइडर निर्माण हेतु पूर्व निर्मित मार्ग को तोड़ने का कार्य।"],
    ["Excavation", "मार्ग के चौड़ीकरण हेतु मिट्टी खुदाई का कार्य।"],
    ["GSB", "मार्ग के चौड़ीकरण भाग में वर्तमान क्रस्ट के अनुसार जी0एस0बी0 का कार्य।"],
    ["WMM", "मार्ग के चौड़ीकरण भाग में वर्तमान क्रस्ट के अनुसार डब्ल्यू0एम0एम0 का कार्य।"],
    ["DBM-Grade-1", "मार्ग के चौड़ीकरण भाग में वर्तमान बिटुमिनस क्रस्ट के अनुसार डी0बी0एम0 का कार्य।"],
    ["Primer", "चौड़ीकरण भाग में डी0बी0एम0 से पूर्व प्राइम कोट का कार्य।"],
    ["DBM", "मार्ग की पूरी लंबाई में डी0बी0एम0 का कार्य।"],
    ["Tack Coat", "मार्ग की पूरी लंबाई में बी0सी0 से पूर्व टैक कोट का कार्य।"],
    ["BC", "मार्ग की पूरी लंबाई में बी0सी0 का कार्य।"],
    ["Interlocking", "मार्ग के किनारे पैदल फुटपाथ पर इंटर लॉकिंग का कार्य।"],
    ["RCC Drain", "मार्ग के किनारे जल निकासी हेतु आवश्यकतानुसार नाली निर्माण का कार्य।"],
    ["New Jercy Type (Divider)", "मार्ग के मध्य में डिवाइडर का निर्माण।"],
    ["Thermoplastic Paint", "मार्ग की पूरी लंबाई पर थर्मोप्लास्टिक पेंट का कार्य।"],
    ["Road Furniture", "मार्ग पर अन्य सुरक्षात्मक कार्य।"],
    ["Other Work", "अन्य विविध कार्य — विद्युत पोल शिफ्टिंग का कार्य इत्यादि।"],
  ];
  function reportDefaultHTML(est) {
    const links = reportLinks(est);
    const L = (f) => "<span class='rpt-link' data-field='" + f + "' contenteditable='false'>" + escapeHtml(links[f] || "") + "</span>";
    const row = (lbl, html) => "<div class='rpt-row'><b class='rpt-lbl'>" + lbl + "</b><div class='rpt-val'>" + html + "</div></div>";
    const actCell = "<td class='rpt-act' contenteditable='false'><button type='button' tabindex='-1' class='rpt-rowins' title='नीचे पंक्ति जोड़ें'>+</button><button type='button' tabindex='-1' class='rpt-rowdel' title='पंक्ति हटाएँ'>×</button></td>";
    const costRows = ["GSB", "WMM", "DBM-G1 (VG-30)", "DBM-G2 (VG-40)", "BC"].map((n, i) =>
      "<tr><td class='rpt-sn'>" + (i + 1) + "</td><td>" + n + "</td><td></td><td></td><td></td>" + actCell + "</tr>").join("") +
      "<tr class='rpt-total-row'><td></td><td><b>Total =</b></td><td class='rpt-tot' data-col='2'></td><td class='rpt-tot' data-col='3'></td><td class='rpt-tot' data-col='4'></td><td class='rpt-act' contenteditable='false'></td></tr>";
    const provRows = REPORT_PROV.map((p, i) =>
      "<tr><td class='rpt-n rpt-sn'>" + (i + 1) + "</td><td class='rpt-it'><i>" + escapeHtml(p[0]) + "</i></td><td>" + escapeHtml(p[1]) + "</td>" + actCell + "</tr>").join("");
    return "" +
      "<div class='rpt-title'>प्रतिवेदन</div>" +
      row("कार्य का नाम :", L("workName")) +
      row("लम्बाई :", L("length") + " km") +
      row("अधिकारिता :", "उक्त आगणन का गठन मा0 सांसद श्री ______ जी एवं मा0 विधायक श्री ______ जी द्वारा दिये गये प्रस्ताव के क्रम में गठित किया गया है।") +
      row("आवश्यकता एवं महत्व :", "यह मार्ग " + L("workName") + " के अंतर्गत आता है। औद्योगिक एवं व्यापारिक दृष्टिकोण से यह मार्ग अत्यंत व्यस्त तथा महत्वपूर्ण है। भारी वाहनों के आवागमन एवं डिवाइडर न होने के कारण इस मार्ग पर आये दिन दुर्घटनाएं होती रहती हैं तथा जाम की स्थिति बनी रहती है। निर्विरोध वाहनों के आवागमन हेतु मार्ग का चौड़ीकरण एवं सुदृढीकरण का कार्य कराया जाना आवश्यक है। मार्ग निर्माण होने के उपरान्त क्षेत्र के विकास में महत्वपूर्ण योगदान होगा।") +
      row("डिजाइन / यातायात का विवरण :", "मार्ग पर यातायात गणना के अनुसार पी0सी0यू0 ______ तथा सी0वी0पी0डी0 ______ है, मार्ग के सी0बी0आर0 ______ के अनुसार यातायात घनत्व ______ के लिए मार्ग का कस्ट डिजाइन किया गया है। स्थल की उपलब्धता के अनुसार मार्ग का चौड़ीकरण ______ मी0 प्रस्तावित किया गया है। उक्त मार्ग की परिकल्पना आई0आर0सी0–37–2018 में निहित प्राविधानों के अनुसार यातायात हेतु डिजाइन किया गया है।") +
      "<table class='rpt-tbl rpt-cost'><thead><tr><th>क्र0</th><th>कस्ट विवरण</th><th>चौड़ीकरण</th><th>सुदृढीकरण</th><th>प्राविधानित कुल</th><th class='rpt-act' contenteditable='false'></th></tr></thead><tbody>" + costRows + "</tbody></table>" +
      row("प्राविधान :", "इस " + L("aagType") + " में निम्नलिखित कार्य का प्राविधान किया गया है –") +
      "<table class='rpt-tbl2 rpt-prov'><tbody>" + provRows + "</tbody></table>" +
      row("प्रयुक्त दरें :", "इस " + L("aagType") + " में लगायी गयी दरें अधीक्षण अभियन्ता " + L("vritt") + " द्वारा स्वीकृत एवं MoRTH डाटा बुक पर आधारित विश्लेषित दरें प्रयोग की गयी हैं।") +
      "<div class='rpt-para'>अतः मार्ग की कुल लम्बाई " + L("totalLen") + " कि0मी0 हेतु, विद्युत पोल शिफ्टिंग की अनुमानित लागत रू0 " + L("costPole") + " लाख, पेड़ पातन की अनुमानित लागत रू0 " + L("costTree") + " लाख व मार्ग निर्माण की लागत रू0 " + L("costRoad") + " लाख सम्मिलित करते हुए कुल निर्माण की लागत रू0 " + L("costTotal") + " लाख का " + L("aagType") + " गठित कर " + L("approval") + " स्वीकृति हेतु प्रेषित है।</div>" +
      "<div class='rpt-sign'>" +
        "<div class='rpt-sign-col'><div class='rpt-sign-nm'>(" + L("aeName") + ")</div><b>सहायक अभियन्ता</b><div>" + L("khand") + "</div></div>" +
        "<div class='rpt-sign-col'><div class='rpt-sign-nm'>(" + L("eeName") + ")</div><b>अधिशासी अभियन्ता</b><div>" + L("khand") + "</div></div>" +
      "</div>";
  }
  let _rptTimer = null;
  function saveReportNow() {
    const est = state.estimates[state.activeEstimateId]; const host = document.getElementById("reportDoc");
    if (!est || !host || host.contentEditable !== "true") return;
    est.report = est.report || {}; est.report.body = host.innerHTML; db.put("estimates", est);
  }
  function scheduleSaveReport() { clearTimeout(_rptTimer); _rptTimer = setTimeout(saveReportNow, 700); }
  function renderReport() {
    const est = state.estimates[state.activeEstimateId];
    const host = document.getElementById("reportDoc"); if (!host) return;
    if (!est) { host.contentEditable = "false"; host.innerHTML = "<div class='cover-empty muted'>पहले कोई Estimate खोलें/चुनें — फिर उसका प्रतिवेदन यहाँ बनेगा।</div>"; return; }
    host.contentEditable = "true";
    host.innerHTML = (est.report && est.report.body) ? est.report.body : reportDefaultHTML(est);
    reportRelinkPhrases(host, est);  // आगणन-प्रकार व स्वीकृति-प्रकार text → linked
    reportApplyLinks(host, est);   // linked span हमेशा Estimate से ताज़ा
    reportUpgrade(host);           // पुराना format → action-column/total जोड़ो
    reportRecalcAll(host);         // Total ताज़ा
    // सभी inserted-tables → top-level in-flow (floating/nested पुरानी को सामान्य करो; handle मिले)
    host.querySelectorAll(".rpt-usertbl").forEach((t) => {
      t.classList.remove("rpt-float"); t.style.position = ""; t.style.left = ""; t.style.top = ""; t.style.zIndex = "";
      if (t.parentElement !== host) host.appendChild(t);
    });
    requestAnimationFrame(() => { renderReportPageBreaks(); renderReportControls(); });   // पेज-ब्रेक + सेक्शन handles
  }
  // Report editor में A4 पेज-ब्रेक दर्शक रेखाएँ (लाल dotted) — छपाई में नहीं आतीं
  // Right-click formatting menu — helpers
  let _rptCtxRange = null;
  function rptHideCtx() { const m = document.getElementById("rptCtx"); if (m) m.style.display = "none"; }
  function rptRestoreSel() { if (_rptCtxRange) { const s = window.getSelection(); s.removeAllRanges(); s.addRange(_rptCtxRange); } const h = document.getElementById("reportDoc"); if (h) h.focus(); }
  let _rptPbTimer = null;
  function renderReportPageBreaks() {
    const host = document.getElementById("reportDoc"), ov = document.getElementById("rptPageBreaks");
    if (!host || !ov) return;
    if (host.contentEditable !== "true") { ov.innerHTML = ""; return; }
    const total = host.offsetHeight;
    const PAGE = 1062;   // ~A4 पेज की छपाई-ऊँचाई (approx, 96dpi)
    let y = PAGE, html = "", n = 1;
    while (y < total - 24) { html += "<div class='rpt-pb' style='top:" + Math.round(y) + "px'><span>पेज " + n + " समाप्त · पेज " + (n + 1) + " प्रारंभ</span></div>"; y += PAGE; n++; }
    ov.innerHTML = html;
  }
  function scheduleReportPageBreaks() { clearTimeout(_rptPbTimer); _rptPbTimer = setTimeout(renderReportPageBreaks, 220); }
  // सेक्शन-नियंत्रण (ऊपर/नीचे/हटाएँ) — बाएँ gutter में overlay handles (contenteditable के बाहर)
  function reportBlocks(host) { return Array.prototype.filter.call(host.children, (el) => el.nodeType === 1 && !el.classList.contains("rpt-title")); }
  function renderReportControls() {
    const host = document.getElementById("reportDoc"), ov = document.getElementById("rptSecCtrls");
    if (!host || !ov) return;
    if (host.contentEditable !== "true") { ov.innerHTML = ""; return; }
    const blocks = reportBlocks(host);
    ov.innerHTML = blocks.map((el, i) => {
      // इन्सर्ट की गई टेबल → केवल drag + delete; बाकी सेक्शन → ऊपर/नीचे + delete
      const isUserTbl = el.classList && el.classList.contains("rpt-usertbl");
      const btns = isUserTbl
        ? "<button type='button' class='rpt-drag' data-i='" + i + "' title='खींचकर सरकाएँ'>⠿</button>" +
          "<button type='button' class='rpt-secdel' data-i='" + i + "' title='टेबल हटाएँ'>✕</button>"
        : "<button type='button' class='rpt-moveup' data-i='" + i + "' title='ऊपर'" + (i === 0 ? " disabled" : "") + ">▲</button>" +
          "<button type='button' class='rpt-movedown' data-i='" + i + "' title='नीचे'" + (i === blocks.length - 1 ? " disabled" : "") + ">▼</button>" +
          "<button type='button' class='rpt-secdel' data-i='" + i + "' title='सेक्शन हटाएँ'>✕</button>";
      return "<div class='rpt-sec-h' style='top:" + el.offsetTop + "px'>" + btns + "</div>";
    }).join("");
  }
  let _rptCtlTimer = null;
  function scheduleReportControls() { clearTimeout(_rptCtlTimer); _rptCtlTimer = setTimeout(renderReportControls, 220); }
  function reportMoveSection(i, dir) {
    const host = document.getElementById("reportDoc"); if (!host) return;
    const blocks = reportBlocks(host); const el = blocks[i], other = blocks[i + dir];
    if (!el || !other) return;
    if (dir < 0) host.insertBefore(el, other); else host.insertBefore(other, el);
    saveReportNow(); renderReportControls(); scheduleReportPageBreaks();
  }
  function reportDelSection(i) {
    const host = document.getElementById("reportDoc"); if (!host) return;
    const el = reportBlocks(host)[i]; if (!el) return;
    if (!confirm("यह सेक्शन हटाएँ?")) return;
    el.remove(); saveReportNow(); renderReportControls(); scheduleReportPageBreaks();
  }
  // इन्सर्ट की गई टेबल को खींचें — ऊपर/नीचे (live reorder, text जगह बनाए) + दाएँ/बाएँ (margin-left)
  function reportStartDrag(el, startEv) {
    const host = document.getElementById("reportDoc"); if (!host || !el) return;
    document.body.classList.add("rpt-dragging-on"); el.classList.add("rpt-dragging");
    const sx = startEv.clientX, startML = parseFloat(el.style.marginLeft) || 0;
    const cs = getComputedStyle(host);
    const contentW = host.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    let raf = 0;
    const onMove = (ev) => {
      // ऊपर/नीचे — live DOM reorder
      const y = ev.clientY;
      const blks = reportBlocks(host).filter((b) => b !== el);
      let target = null;
      for (const b of blks) { const r = b.getBoundingClientRect(); if (y < r.top + r.height / 2) { target = b; break; } }
      if (target) { if (el !== target && el.nextSibling !== target) host.insertBefore(el, target); }
      else if (host.lastElementChild !== el) host.appendChild(el);
      // दाएँ/बाएँ — margin-left (content-width के अंदर)
      const avail = Math.max(0, contentW - el.offsetWidth);
      el.style.marginLeft = Math.max(0, Math.min(startML + (ev.clientX - sx), avail)) + "px";
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderReportControls(); });
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp);
      document.body.classList.remove("rpt-dragging-on"); el.classList.remove("rpt-dragging");
      saveReportNow(); renderReportControls(); scheduleReportPageBreaks();
    };
    document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp);
  }
  // cursor वाला top-level सेक्शन (host का सीधा child) — नया सेक्शन इसके ठीक बाद जोड़ने हेतु
  function reportCurrentBlock(host) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    let node = sel.anchorNode;
    if (!node || !host.contains(node)) return null;
    if (node.nodeType !== 1) node = node.parentElement;
    while (node && node.parentElement !== host) node = node.parentElement;
    return (node && node.parentElement === host && node.nodeType === 1 && !node.classList.contains("rpt-title")) ? node : null;
  }
  function reportAddSection() {
    const host = document.getElementById("reportDoc"); if (!host || host.contentEditable !== "true") return;
    const div = document.createElement("div"); div.className = "rpt-row";
    div.innerHTML = "<b class='rpt-lbl'>नया शीर्षक :</b><div class='rpt-val'>यहाँ विवरण लिखें…</div>";
    const cur = reportCurrentBlock(host);
    if (cur) host.insertBefore(div, cur.nextSibling);   // cursor वाले सेक्शन के ठीक बाद
    else { const sign = host.querySelector(".rpt-sign"); if (sign) host.insertBefore(div, sign); else host.appendChild(div); }
    const lbl = div.querySelector(".rpt-lbl");
    if (lbl) { host.focus(); const range = document.createRange(); range.selectNodeContents(lbl); const s = window.getSelection(); s.removeAllRanges(); s.addRange(range); }
    saveReportNow(); renderReportControls(); scheduleReportPageBreaks();
  }
  function reportInsertTable() {
    const host = document.getElementById("reportDoc"); if (!host || host.contentEditable !== "true") return;
    const spec = prompt("टेबल का आकार — पंक्ति x कॉलम (जैसे 3x4):", "3x4"); if (!spec) return;
    const m = /(\d+)\s*[x×*]\s*(\d+)/i.exec(spec.trim()); if (!m) { alert("आकार सही नहीं — जैसे 3x4 लिखें।"); return; }
    const rows = Math.max(1, Math.min(50, +m[1])), cols = Math.max(1, Math.min(20, +m[2]));
    let inner = "<tbody>";
    for (let r = 0; r < rows; r++) { inner += "<tr>"; for (let c = 0; c < cols; c++) inner += "<td></td>"; inner += "</tr>"; }
    inner += "</tbody>";
    const tbl = document.createElement("table"); tbl.className = "rpt-usertbl"; tbl.innerHTML = inner;
    const cur = reportCurrentBlock(host);   // in-flow top-level block (drag पर text जगह बनाता है)
    if (cur) host.insertBefore(tbl, cur.nextSibling);
    else { const sign = host.querySelector(".rpt-sign"); if (sign) host.insertBefore(tbl, sign); else host.appendChild(tbl); }
    const first = tbl.querySelector("td");
    if (first) { host.focus(); const range = document.createRange(); range.selectNodeContents(first); const s = window.getSelection(); s.removeAllRanges(); s.addRange(range); }
    saveReportNow(); renderReportControls(); scheduleReportPageBreaks();
  }
  // Tab — टेबल के अगले/पिछले (editable) cell में जाए (+/× बटन पर नहीं)
  function reportTabKey(e) {
    if (e.key !== "Tab") return;
    const sel = window.getSelection(); if (!sel || !sel.rangeCount) return;
    let node = sel.anchorNode; let td = node && (node.nodeType === 1 ? node : node.parentElement);
    td = td && td.closest ? td.closest("td") : null; if (!td) return;
    const table = td.closest("table"); if (!table) return;
    e.preventDefault();
    const cells = Array.prototype.filter.call(table.querySelectorAll("td"), (c) => !c.classList.contains("rpt-act") && c.isContentEditable !== false);
    const idx = cells.indexOf(td);
    const nx = e.shiftKey ? cells[idx - 1] : cells[idx + 1];
    if (nx) { const range = document.createRange(); range.selectNodeContents(nx); const s = window.getSelection(); s.removeAllRanges(); s.addRange(range); }
  }
  function openReportView() {
    if (!state.activeEstimateId) { alert("पहले कोई Estimate खोलें/चुनें (Load Estimate)।"); return; }
    setActiveView("report");
  }
  function printReport(est) {
    const host = document.getElementById("reportDoc"); const area = document.getElementById("printArea");
    if (!host || !area) return;
    area.innerHTML = "<div class='cover-doc rpt-doc rpt-print cover-print'>" + host.innerHTML + "</div>";
    window.print();
  }

  /* ══════════ Basic Sheet › Reference फाइलें (upload · note · view · reorder) ══════════ */
  function ensureReferences(est) { if (!Array.isArray(est.references)) est.references = []; return est.references; }
  function refSave(est) { db.put("estimates", est); }
  let _refTimer = null;
  function refSaveSoon(est) { clearTimeout(_refTimer); _refTimer = setTimeout(() => refSave(est), 600); }
  function refIcon(mime) { mime = String(mime || ""); if (mime.indexOf("image") === 0) return "🖼"; if (mime.indexOf("pdf") >= 0) return "📄"; if (mime.indexOf("sheet") >= 0 || mime.indexOf("excel") >= 0) return "📊"; if (mime.indexOf("word") >= 0) return "📝"; return "📎"; }
  function refView(r) {
    if (!r || !r.data) return;
    try { fetch(r.data).then((x) => x.blob()).then((blob) => { const u = URL.createObjectURL(blob); window.open(u, "_blank"); setTimeout(() => URL.revokeObjectURL(u), 60000); }).catch(() => window.open(r.data, "_blank")); }
    catch (e) { window.open(r.data, "_blank"); }
  }
  function refAddFiles(est, files) {
    const list = ensureReferences(est);
    const arr = Array.prototype.slice.call(files || []); if (!arr.length) return;
    let pending = arr.length;
    arr.forEach((f) => {
      const rd = new FileReader();
      rd.onload = () => { list.push({ id: uid("ref"), name: f.name || "file", mime: f.type || "", note: "", data: rd.result }); if (--pending === 0) { refSave(est); renderReference(); status(arr.length + " फाइल जोड़ी"); } };
      rd.onerror = () => { if (--pending === 0) { refSave(est); renderReference(); } };
      rd.readAsDataURL(f);
    });
  }
  function refDelete(est, id) {
    const list = ensureReferences(est); const r = list.find((x) => x.id === id); if (!r) return;
    if (!confirm("'" + (r.name || "फाइल") + "' हटाएँ?")) return;
    est.references = list.filter((x) => x.id !== id); refSave(est); renderReference(); status("फाइल हटाई");
  }
  function refMove(est, id, dir) {
    const list = ensureReferences(est); const i = list.findIndex((x) => x.id === id); const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    const t = list[i]; list[i] = list[j]; list[j] = t; refSave(est); renderReference();
  }
  function renderReference() {
    const est = state.estimates[state.activeEstimateId];
    const host = document.getElementById("refList"); if (!host) return;
    if (!est) { host.innerHTML = "<div class='cover-empty muted'>पहले कोई Estimate खोलें/चुनें।</div>"; return; }
    const list = ensureReferences(est);
    if (!list.length) { host.innerHTML = "<div class='ref-empty muted'>अभी कोई फाइल नहीं — ऊपर <b>फाइल अपलोड करें</b> दबाएँ।</div>"; return; }
    host.innerHTML = "<div class='ref-items'>" + list.map((r, i) =>
      "<div class='ref-item'>" +
        "<div class='ref-ord'><button class='ref-up' data-id='" + r.id + "' title='ऊपर'" + (i === 0 ? " disabled" : "") + ">▲</button><button class='ref-down' data-id='" + r.id + "' title='नीचे'" + (i === list.length - 1 ? " disabled" : "") + ">▼</button></div>" +
        "<div class='ref-ic'>" + refIcon(r.mime) + "</div>" +
        "<div class='ref-main'><div class='ref-nm'>" + (i + 1) + ". " + escapeHtml(r.name || "") + "</div>" +
          "<input type='text' class='ref-note' data-id='" + r.id + "' value=\"" + escapeHtml(r.note || "") + "\" placeholder='छोटा नोट (वैकल्पिक)' /></div>" +
        "<div class='ref-acts'><button class='btn xs ref-view' data-id='" + r.id + "'>👁 View</button><button class='btn xs ref-del' data-id='" + r.id + "'>🗑 Delete</button></div>" +
      "</div>"
    ).join("") + "</div>";
    host.querySelectorAll(".ref-note").forEach((inp) => inp.addEventListener("input", () => { const r = list.find((x) => x.id === inp.dataset.id); if (r) { r.note = inp.value; refSaveSoon(est); } }));
    host.querySelectorAll(".ref-view").forEach((b) => b.addEventListener("click", () => refView(list.find((x) => x.id === b.dataset.id))));
    host.querySelectorAll(".ref-del").forEach((b) => b.addEventListener("click", () => refDelete(est, b.dataset.id)));
    host.querySelectorAll(".ref-up").forEach((b) => b.addEventListener("click", () => refMove(est, b.dataset.id, -1)));
    host.querySelectorAll(".ref-down").forEach((b) => b.addEventListener("click", () => refMove(est, b.dataset.id, 1)));
  }
  function openReferenceView() {
    if (!state.activeEstimateId) { alert("पहले कोई Estimate खोलें/चुनें (Load Estimate)।"); return; }
    setActiveView("reference");
  }

  /* ══════════ Estimate Home — Actions (group PDF / Word / Excel / Print) ══════════ */
  // Report की छपाई-योग्य HTML (linked ताज़ा, edit-नियंत्रण हटाकर)
  function reportPrintHTML(est) {
    const tmp = document.createElement("div");
    tmp.innerHTML = (est.report && est.report.body) ? est.report.body : reportDefaultHTML(est);
    reportRelinkPhrases(tmp, est); reportApplyLinks(tmp, est);
    tmp.querySelectorAll(".rpt-act").forEach((el) => el.remove());   // row +/× बटन हटाएँ
    return tmp.innerHTML;
  }
  function referencePrintHTML(est) {
    const list = ensureReferences(est); if (!list.length) return "";
    const rows = list.map((r, i) => "<div class='refp-item'><b>" + (i + 1) + ". " + escapeHtml(r.name || "") + "</b>" +
      (r.note ? " — " + escapeHtml(r.note) : "") +
      ((r.mime || "").indexOf("image") === 0 ? "<br><img src='" + r.data + "' style='max-width:100%;max-height:230mm;margin-top:6px'>" : "") + "</div>").join("");
    return "<div class='chk-hd' style='margin-bottom:14px'>Reference फाइलें</div>" + rows;
  }
  // Basic Sheet — Cover · Checklist · Index · Report · Reference एक PDF में (Print → Save as PDF)
  function downloadBasicSheetPDF(est) {
    const area = document.getElementById("printArea"); if (!area) return;
    const c = ensureCover(est);
    const pg = (cls, inner) => "<div class='basic-pdf-page " + cls + " cover-print'>" + inner + "</div>";
    let html = "";
    html += pg("cover-doc", coverRender(est, c));
    html += pg("cover-doc chk-doc", checklistRender(est));
    html += pg("cover-doc chk-doc idx-doc", indexRender(est));
    html += pg("cover-doc rpt-doc rpt-print", reportPrintHTML(est));
    const refH = referencePrintHTML(est); if (refH) html += pg("cover-doc chk-doc", refH);
    area.innerHTML = html;
    window.print();
  }
  function downloadReportWord(est) {
    const body = reportPrintHTML(est);
    const css = "body{font-family:'Noto Sans Devanagari','Nirmala UI',sans-serif;font-size:15px;line-height:1.6}" +
      "table{border-collapse:collapse}td,th{border:1px solid #000;padding:4px 8px}" +
      ".rpt-title{text-align:center;font-size:20px;font-weight:bold;text-decoration:underline;margin-bottom:14px}" +
      ".rpt-row{margin-bottom:10px}.rpt-lbl{font-weight:bold}.rpt-sign{margin-top:40px}";
    const html = "<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'><head><meta charset='utf-8'><style>" + css + "</style></head><body>" + body + "</body></html>";
    const blob = new Blob(["﻿" + html], { type: "application/msword" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = safeName(est.name) + "_Report.doc"; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 8000);
    status("Report Word फाइल बनी");
  }
  // Estimate Home पर loaded estimate का Actions पैनल
  function renderEstActions() {
    const card = document.getElementById("estActionsCard"); if (!card) return;
    const est = state.estimates[state.activeEstimateId];
    if (!est) { card.style.display = "none"; return; }
    card.style.display = "";
    const nm = document.getElementById("estActName"); if (nm) nm.textContent = est.name || "Loaded Estimate";
  }

  function renderSummary() {
    mountEditor("summary");
    const est = state.estimates[state.activeEstimateId];
    const stat = document.getElementById("sumTplStatus");
    if (!est) { state.activeSheetId = null; renderGrid(); if (stat) stat.textContent = ""; return; }
    if (!est.summary) est.summary = {};
    const sheet = summaryEnsureSheet(est);
    const tplLoaded = !!(est.summary.tpl && String(est.summary.tpl).trim());
    if (sheet.cols !== SUM_HEADERS.length || sheet.rows <= 1) { summaryBuildDefault(est, sheet); }   // पहली बार / पुराना-format
    else {
      summaryEnsureMarkers(sheet);                                                                   // पुरानी शीट/Template में marker जोड़ो
      if (summaryFindMarker(sheet, "totalA") >= 0) summaryReconcile(est, sheet);                     // data-zone हमेशा live (Template हो या न हो)
      else if (!tplLoaded) summaryBuildDefault(est, sheet);                                          // Total(A) भी नहीं मिला → नई default
    }
    if (stat) stat.textContent = tplLoaded
      ? ("📋 Template: " + est.summary.tpl + " — ऊपर BOQ/Sub-Estimate स्वतः; बाकी editable")
      : "स्वतः तालिका — BOQ व शेष Sub-Estimate अपने-आप जुड़ते/हटते हैं; बाकी editable। '💾 सहेजें' से Template बनाएँ।";
    openSheet(sheet.id);
  }
  // ── Summary Templates — पूरी तालिका का स्वतंत्र snapshot ──
  function snapshotSummarySheet(sheet) {
    return { cells: JSON.parse(JSON.stringify(sheet.cells || {})), rows: sheet.rows, cols: sheet.cols, colWidths: (sheet.colWidths || []).slice(), merges: JSON.parse(JSON.stringify(sheet.merges || [])) };
  }
  function restoreSummarySnapshot(sheet, snap) {
    sheet.cells = JSON.parse(JSON.stringify(snap.cells || {}));
    sheet.rows = snap.rows || 1; sheet.cols = snap.cols || SUM_HEADERS.length;
    sheet.colWidths = (snap.colWidths && snap.colWidths.length) ? snap.colWidths.slice() : sumColWidths();
    sheet.merges = JSON.parse(JSON.stringify(snap.merges || []));
  }
  function applySummaryTemplate(est, tpl) {
    const sheet = summaryEnsureSheet(est);
    if (tpl.snapshot) restoreSummarySnapshot(sheet, tpl.snapshot);   // पूरी तालिका इसी Template की
    else summaryBuildDefault(est, sheet);                            // पुराना (snapshot-रहित) Template → default तालिका
    est.summary = est.summary || {}; est.summary.tpl = tpl.name || "";
    ensureLock(sheet); persistSheet(sheet); db.put("estimates", est); buildEngine();
    renderSummary();
    status("Template लगाया: " + (tpl.name || ""));
  }
  // नया Template — वर्तमान तालिका का snapshot; नाम पूछकर summaryTemplates में
  function addSummaryTemplateFrom(est, defName) {
    const sheet = summaryEnsureSheet(est);
    const nm = prompt("नए Template का नाम दें (जैसे: सड़क, चौड़ीकरण, भवन, पुल):", defName || "");
    if (nm === null) return null; const name = nm.trim(); if (!name) return null;
    const ex = summaryTemplates.find((t) => (t.name || "").trim().toLowerCase() === name.toLowerCase());
    let tpl;
    if (ex) { if (!confirm("'" + name + "' पहले से है — बदलें (replace)?")) return null; tpl = ex; }   // मौजूदा object ही (id स्थिर)
    else { tpl = { id: uid("stpl"), name: name }; summaryTemplates.push(tpl); }
    tpl.snapshot = snapshotSummarySheet(sheet);
    saveSummaryTemplatesCloud();
    status(ex ? ("Template '" + name + "' अद्यतन (replace) हुआ") : ("नया Template सहेजा: " + name));
    return tpl;
  }
  function saveSummaryTemplate() {
    const est = state.estimates[state.activeEstimateId]; if (!est) { alert("पहले कोई Estimate खोलें।"); return; }
    const sheet = summaryEnsureSheet(est);
    // कोई Template लोड है → उसी को (उसी नाम/id से) वर्तमान तालिका से अद्यतन करो
    const cur = (est.summary && est.summary.tpl) ? summaryTemplates.find((t) => (t.name || "").trim() === String(est.summary.tpl).trim()) : null;
    if (cur) {
      if (!confirm("Template '" + cur.name + "' को वर्तमान तालिका से अद्यतन (replace) करें?")) return;
      cur.snapshot = snapshotSummarySheet(sheet); saveSummaryTemplatesCloud();
      status("Template '" + cur.name + "' अद्यतन (replace) हुआ");
      return;
    }
    const t = addSummaryTemplateFrom(est, "");   // कोई लोड नहीं → नए नाम से
    if (t) { est.summary = est.summary || {}; est.summary.tpl = t.name; db.put("estimates", est); renderSummary(); }
  }
  // Template unload — तालिका फिर से default (auto) बनाओ
  function unloadSummaryTemplate(est) {
    const sheet = summaryEnsureSheet(est);
    summaryBuildDefault(est, sheet);
    est.summary = est.summary || {}; est.summary.tpl = "";
    db.put("estimates", est); renderSummary();
    status("तालिका फिर से बनाई (default) — कोई Template लोड नहीं");
  }
  // एकीकृत Template dialog — लोड / नाम बदलें / हटाएँ / नया जोड़ें  (हर Template स्वतंत्र snapshot)
  function openSummaryTemplateManager() {
    const est = state.estimates[state.activeEstimateId];
    const ov = document.createElement("div"); ov.className = "modal-overlay";
    const listHtml = () => summaryTemplates.length
      ? summaryTemplates.map((t) => "<div class='sub-est-row'><span class='se-name'>📋 " + escapeHtml(t.name) + (t.snapshot ? "" : " <span class='muted'>· पुराना</span>") + "</span><span class='se-actions'>" +
          "<button class='btn xs primary stpl-load' data-id='" + t.id + "'>लोड</button>" +
          "<button class='btn xs stpl-ren' data-id='" + t.id + "'>✎ नाम</button>" +
          "<button class='btn xs danger stpl-del' data-id='" + t.id + "'>🗑 हटाएँ</button></span></div>").join("")
      : "<div class='muted-row'>अभी कोई Template नहीं। तालिका को मनचाहा एडिट करके नीचे <b>➕ नया Template</b> से सहेजें।</div>";
    const loaded = !!(est && est.summary && est.summary.tpl && String(est.summary.tpl).trim());
    const footHtml = () => "<div class='se-tpl-foot'>" +
      "<button class='btn sm primary' id='tmAdd'>➕ वर्तमान तालिका से नया Template</button>" +
      (loaded ? "<button class='btn sm danger' id='tmUnload' title='तालिका फिर से default बनाओ'>⏏ Template unload (" + escapeHtml(est.summary.tpl) + ")</button>" : "") + "</div>";
    ov.innerHTML = "<div class='modal se-dialog'><div class='pk-head'><h3>📋 Summary Template</h3><button class='pk-x' id='tmX'>✕</button></div>" +
      "<p class='sub'>हर Template पूरी तालिका का स्वतंत्र snapshot है — <b>लोड</b> करने पर वही तालिका आती है; किसी एक का दूसरे पर असर नहीं। बदलने के लिए: लोड → तालिका एडिट → उसी नाम से <b>💾 सहेजें</b>।</p>" +
      "<div id='tmList' class='sub-est-list'></div><div id='tmFoot'></div></div>";
    document.body.appendChild(ov);
    const close = () => ov.remove();
    const render = () => { ov.querySelector("#tmList").innerHTML = listHtml(); ov.querySelector("#tmFoot").innerHTML = footHtml(); wire(); };
    function wire() {
      ov.querySelectorAll(".stpl-load").forEach((b) => b.addEventListener("click", () => { const t = summaryTemplates.find((x) => x.id === b.dataset.id); if (t && est) { close(); applySummaryTemplate(est, t); } }));
      ov.querySelectorAll(".stpl-ren").forEach((b) => b.addEventListener("click", () => { const t = summaryTemplates.find((x) => x.id === b.dataset.id); if (!t) return; const nm = prompt("नया नाम:", t.name); if (nm === null) return; const n = nm.trim(); if (n) { t.name = n; saveSummaryTemplatesCloud(); render(); } }));
      ov.querySelectorAll(".stpl-del").forEach((b) => b.addEventListener("click", () => { const t = summaryTemplates.find((x) => x.id === b.dataset.id); if (!t) return; if (confirm("Template '" + t.name + "' हटाएँ?")) { summaryTemplates = summaryTemplates.filter((x) => x.id !== t.id); saveSummaryTemplatesCloud(); render(); } }));
      const add = ov.querySelector("#tmAdd"); if (add) add.addEventListener("click", () => { if (!est) { alert("पहले कोई Estimate खोलें।"); return; } const t = addSummaryTemplateFrom(est, est.summary && est.summary.tpl || ""); if (t) { est.summary = est.summary || {}; est.summary.tpl = t.name; db.put("estimates", est); renderSummary(); render(); } });
      const unld = ov.querySelector("#tmUnload"); if (unld) unld.addEventListener("click", () => { if (est && confirm("Template unload करें? तालिका फिर से default (auto) बन जाएगी — वर्तमान बदलाव मिट जाएँगे।")) { close(); unloadSummaryTemplate(est); } });
    }
    ov.querySelector("#tmX").addEventListener("click", close);
    ov.addEventListener("mousedown", (e) => { if (e.target === ov) close(); });
    render();
  }
  // "📋 Template" — वही एकीकृत dialog (लोड + जोड़ें + हटाएँ)
  function openSummaryTemplatePicker() { openSummaryTemplateManager(); }
  function extraRate(est, x) {
    if (x.type === "sor") { const rr = masterRowById("item_sor", x.sorRowId); return rr ? round2(mrNum(masterItemRate("item_sor", rr))) : ""; }
    if (x.type === "sub") { const s = findSub(est, x.subId); return s ? computeSubTotal(est, s) : ""; }
    if (x.type === "ana") { const s = state.sheets[x.anaId]; const rt = s ? analysisRateUnit(s).rate : ""; return rt === "" ? "" : round2(mrNum(rt)); }
    return "";
  }
  // extra item का DOM block (desc user-editable; itemId = "xtr:"+id)
  function domSeedExtraBlock(sheet, r, itemNo, est, x, saved) {
    const eid = "xtr:" + x.id;
    // माप सिर्फ़ इसी extra के unique id से (नाम-fallback नहीं — वरना दूसरी category/मुख्य के same-analysis की माप नकल हो जाए)
    const savedMeas = (saved && saved.byId[eid]) || null;
    // sub-estimate lump-sum → डिफ़ॉल्ट Quantity 1 (Amount = sub का कुल); SOR → खाली 2 पंक्तियाँ
    const dflt = (x.type === "sub") ? [["1", "", "", "", ""], [null, null, null, null, null]] : [null, null];
    const meas = (Array.isArray(savedMeas) && savedMeas.length) ? savedMeas : dflt;
    const hr = r, firstMeas = r + 1, lastMeas = firstMeas + meas.length - 1, sub = lastMeas + 1, e = (v) => v + 1;
    domSetSheetCell(sheet, hr, 0, itemNo);
    domSetSheetCell(sheet, hr, 1, extraDesc(est, x)); domStyle(sheet, hr, 1, { bg: "F3E8FF", al: "left" });
    domMarkRole(sheet, hr, "domhdr"); sheet.cells[addr(hr, 2)].itemId = eid;
    meas.forEach((vals, k) => { const mr = firstMeas + k; if (Array.isArray(vals)) for (let cc = 0; cc < 5; cc++) { if (vals[cc] != null && vals[cc] !== "") domSetSheetCell(sheet, mr, 2 + cc, vals[cc]); } domSetSheetCell(sheet, mr, 7, "=IF(COUNT(C" + e(mr) + ":G" + e(mr) + ")=0,\"\",PRODUCT(C" + e(mr) + ":G" + e(mr) + "))"); });
    domSetSheetCell(sheet, sub, 6, "Sub Total"); domStyle(sheet, sub, 6, SECTOT_STYLE);
    domSetSheetCell(sheet, sub, 7, "=ROUND(SUM(H" + e(firstMeas) + ":H" + e(lastMeas) + "),3)"); domStyle(sheet, sub, 7, SECTOT_STYLE);
    domSetSheetCell(sheet, sub, 8, extraUnit(est, x)); domStyle(sheet, sub, 8, SECTOT_STYLE);
    domMarkRole(sheet, sub, "domsub");
    return sub + 1;
  }
  // DOM/BOQ में आइटम को move/delete — extra / sub-estimate / समूह
  function domBoqMoveItem(itemId, dir) {
    const est = state.estimates[state.activeEstimateId]; if (!est) return;
    let ok = false;
    if (String(itemId).indexOf("xtr:") === 0) {   // extra items — अपनी ही category में
      const id = String(itemId).slice(4), arr = estMainExtras(est), cur = arr.find((x) => x.id === id);
      if (cur) { const same = arr.filter((x) => x.type === cur.type); const p = same.indexOf(cur), np = p + dir; if (np >= 0 && np < same.length) { const other = same[np], ia = arr.indexOf(cur), ib = arr.indexOf(other); arr[ia] = other; arr[ib] = cur; db.put("estimates", est); ok = true; } }
    } else if (_domSubId) { const sub = findSub(est, _domSubId); if (sub) { const o = sub.itemIds || []; const i = o.indexOf(itemId), j = i + dir; if (i >= 0 && j >= 0 && j < o.length) { const t = o[i]; o[i] = o[j]; o[j] = t; sub.itemIds = o; db.put("estimates", est); ok = true; } } }
    else ok = moveEstimateItem(est, itemId, dir);
    if (!ok) return;
    const v = document.querySelector(".view.active");
    if (v && v.id === "view-boq") renderBOQ(); else renderDOM();
  }
  function domBoqDeleteItem(itemId) {
    const est = state.estimates[state.activeEstimateId]; if (!est) return;
    if (String(itemId).indexOf("xtr:") === 0) { const id = String(itemId).slice(4); est.mainExtras = estMainExtras(est).filter((x) => x.id !== id); db.put("estimates", est); }
    else if (_domSubId) { const sub = findSub(est, _domSubId); if (!sub) return; sub.itemIds = (sub.itemIds || []).filter((id) => id !== itemId); db.put("estimates", est); }
    else return;
    const v = document.querySelector(".view.active");
    if (v && v.id === "view-boq") renderBOQ(); else renderDOM();
  }
  // सरल सूची-picker
  function pickFromList(title, options, onPick) {
    const ov = document.createElement("div"); ov.className = "modal-overlay";
    const rows = options.map((o) => "<button class='lap-item' data-v='" + escapeHtml(String(o.value)) + "'><span class='lap-nm'>" + escapeHtml(o.label) + "</span>" + (o.sub ? "<span class='lap-tt'>" + escapeHtml(o.sub) + "</span>" : "") + "</button>").join("") || "<div class='ag-empty muted'>कोई विकल्प नहीं</div>";
    ov.innerHTML = "<div class='modal pick'><div class='pk-head'><h3>" + escapeHtml(title) + "</h3><button class='pk-x' id='pkX'>✕</button></div><input type='search' id='pkS' class='search' placeholder='🔍 खोजें…' /><div class='lap-list'>" + rows + "</div></div>";
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.querySelector("#pkX").addEventListener("click", close);
    ov.addEventListener("mousedown", (e) => { if (e.target === ov) close(); });
    const sEl = ov.querySelector("#pkS");
    sEl.addEventListener("input", () => { const q = sEl.value.trim().toLowerCase(); ov.querySelectorAll(".lap-item").forEach((b) => { b.style.display = (!q || b.querySelector(".lap-nm").textContent.toLowerCase().includes(q)) ? "" : "none"; }); });
    ov.querySelectorAll(".lap-item").forEach((b) => b.addEventListener("click", () => { close(); onPick(b.dataset.v); }));
    sEl.focus();
  }
  function domAddSubEstimate() {
    const est = state.estimates[state.activeEstimateId]; if (!est) return;
    const subs = estSubs(est);
    if (!subs.length) { alert("पहले कोई Sub-Estimate बनाएँ (DOM & BOQ › Sub-Estimate में)।"); return; }
    pickFromList("Sub-Estimate जोड़ें (मुख्य BOQ में)", subs.map((s) => ({ value: s.id, label: s.name, sub: (s.description ? s.description + " · " : "") + (s.itemIds || []).length + " item" })), (subId) => {
      const s = findSub(est, subId); estMainExtras(est).push({ id: uid("x"), type: "sub", subId: subId }); db.put("estimates", est); renderDOM();   // desc auto = नाम - Description
      status("Sub-Estimate जुड़ा: " + (s ? s.name : ""));
    });
  }
  function domAddSorItem() {
    const est = state.estimates[state.activeEstimateId]; if (!est) return;
    const rows = (loadedVersionRows("item_sor") || []).filter((r) => r.id && (r.desc || r.itemno));
    if (!rows.length) { alert("पहले Master Data › Primary Rate › Item SOR Rate में version Load करें।"); return; }
    pickFromList("Item SOR से आइटम जोड़ें", rows.map((r) => ({ value: r.id, label: masterItemName("item_sor", r), sub: (r.unit || "") + " · ₹" + round2(masterItemRate("item_sor", r)) })), (rowId) => {
      const rr = masterRowById("item_sor", rowId); estMainExtras(est).push({ id: uid("x"), type: "sor", sorRowId: rowId, desc: rr ? masterItemName("item_sor", rr) : "", unit: rr ? (rr.unit || "") : "" }); db.put("estimates", est); renderDOM();
      status("Item SOR आइटम जुड़ा");
    });
  }
  // "अन्य कार्य" — अब तक लोड किया गया कोई भी Analysis (search करके) जोड़ो
  function domAddAnaItem() {
    const est = state.estimates[state.activeEstimateId]; if (!est) return;
    const anas = state.order.map((id) => state.sheets[id]).filter((s) => s && s.kind === "working");
    if (!anas.length) { alert("अभी कोई Analysis load नहीं — पहले Rate Analysis में load करें।"); return; }
    pickFromList("अन्य कार्य — कोई Analysis जोड़ें", anas.map((s) => { const info = analysisRateUnit(s); return { value: s.id, label: analysisItemDetail(s) || s.itemName || s.name, sub: (info.unit || "") + (info.rate !== "" ? " · ₹" + info.rate : "") }; }), (anaId) => {
      estMainExtras(est).push({ id: uid("x"), type: "ana", anaId: anaId }); db.put("estimates", est); renderDOM();
      status("अन्य कार्य आइटम जुड़ा");
    });
  }
  // नया Sub-Estimate — नाम + इकाई एक ही dialog में
  function askSubEstimate(onOk) {
    const ov = document.createElement("div"); ov.className = "modal-overlay";
    ov.innerHTML =
      "<div class='modal se-dialog'>" +
        "<div class='pk-head'><h3>🗂️ नया Sub-Estimate</h3><button class='pk-x' id='seX'>✕</button></div>" +
        "<p class='sub'>इस समूह के सभी Analysis इसमें आ जाएँगे; काम करते समय अनचाहे को DOM/BOQ में delete कर दें।</p>" +
        "<label class='ns-fld'>Sub-Estimate का नाम <span class='muted'>(short name)</span><input id='seNm' type='text' placeholder='जैसे: नाली, डिवाइडर' autocomplete='off' /></label>" +
        "<label class='ns-fld'>विवरण (Description) <span class='muted'>— DOM/BOQ में नाम के आगे “ - विवरण” जुड़ेगा</span><textarea id='seDesc' rows='2' placeholder='पूरा विवरण…' autocomplete='off'></textarea></label>" +
        "<label class='ns-fld'>इकाई (यूनिट) <span class='muted'>— मुख्य कार्य में जुड़ने पर यही दिखेगी</span><input id='seUn' type='text' placeholder='जैसे: Rmt, Sqm, No, job' autocomplete='off' /></label>" +
        "<div class='row' style='margin-top:14px'><button class='btn' id='seCancel'>रद्द</button><button class='btn primary' id='seOk'>बनाएँ</button></div>" +
      "</div>";
    document.body.appendChild(ov);
    const nm = ov.querySelector("#seNm"), un = ov.querySelector("#seUn"), de = ov.querySelector("#seDesc");
    const close = () => ov.remove();
    const submit = () => { const name = nm.value.trim(); if (!name) { nm.style.borderColor = "var(--red)"; nm.focus(); return; } close(); onOk(name, un.value.trim(), de.value.trim()); };
    ov.querySelector("#seX").addEventListener("click", close);
    ov.querySelector("#seCancel").addEventListener("click", close);
    ov.querySelector("#seOk").addEventListener("click", submit);
    ov.addEventListener("mousedown", (e) => { if (e.target === ov) close(); });
    ov.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } else if (e.key === "Enter" && e.target !== de) { e.preventDefault(); submit(); } });
    nm.focus();
  }
  // DOM & BOQ पेज — मुख्य के अलावा हर कार्य-समूह के अंदर कई Sub-Estimate
  function renderSubEstimates() {
    const box = document.getElementById("subEstList"); if (!box) return;
    box.innerHTML = "";
    const est = state.estimates[state.activeEstimateId];
    if (!est) { box.innerHTML = "<div class='muted-row'>पहले कोई Estimate खोलें।</div>"; return; }
    const groups = estWorkGroups(est).filter((w) => !w.isMain);
    if (!groups.length) { box.innerHTML = "<div class='muted-row'>अभी कोई अन्य कार्य-समूह नहीं — Estimate में और कार्य-समूह जोड़ें।</div>"; return; }
    groups.forEach((w) => {
      const gBox = document.createElement("div"); gBox.className = "se-group";
      const cnt = domGroupSheets(est, w).sheets.length;
      const head = document.createElement("div"); head.className = "se-ghead";
      head.innerHTML = "<span class='se-gname'>🗂 " + escapeHtml(w.name) + "</span><span class='se-count'>" + cnt + " analysis</span><button class='btn xs primary se-add'>+ नया Sub-Estimate</button>";
      head.querySelector(".se-add").addEventListener("click", () => {
        askSubEstimate((name, unit, desc) => { const sub = createSubEstimate(est, w, name, unit, desc); renderSubEstimates(); openDOMSub(sub.id); });
      });
      gBox.appendChild(head);
      const list = document.createElement("div"); list.className = "se-sublist";
      const subs = estSubs(est).filter((x) => x.wgId === w.id);
      if (!subs.length) list.innerHTML = "<div class='se-empty muted'>अभी कोई Sub-Estimate नहीं — “+ नया” से बनाएँ (समूह के सभी analysis आ जाएँगे; अनचाहे को DOM/BOQ में delete कर दें)।</div>";
      subs.forEach((sub) => {
        const row = document.createElement("div"); row.className = "sub-est-row";
        // Remark — मुख्य कार्य के BOQ में जुड़ा है, या स्वतः Summary में
        const inBoq = subLinkedInMain(est, sub.id);
        const remark = inBoq
          ? "<span class='se-remark added' title='यह Sub-Estimate मुख्य कार्य के DOM/BOQ में जुड़ा है'>✔ Added in BOQ (Main Work)</span>"
          : "<span class='se-remark insum' title='यह Sub-Estimate स्वतः Summary पेज में जुड़ा है (मुख्य BOQ में नहीं)'>📋 Added in Summary</span>";
        row.innerHTML = "<span class='se-name'>📋 " + escapeHtml(sub.name) + "</span>" + remark + "<span class='se-count'>" + (sub.itemIds || []).length + " item</span>" +
          "<span class='se-actions'><button class='btn xs se-dom'>📐 DOM</button><button class='btn xs primary se-boq'>🧾 BOQ</button><button class='btn xs se-del danger' title='यह Sub-Estimate हटाएँ'>🗑</button></span>";
        row.querySelector(".se-dom").addEventListener("click", () => openDOMSub(sub.id));
        row.querySelector(".se-boq").addEventListener("click", () => openBOQSub(sub.id));
        row.querySelector(".se-del").addEventListener("click", () => {
          const linked = subLinkedInMain(est, sub.id);
          const msg = "Sub-Estimate '" + sub.name + "' हटाएँ?" + (linked ? "\n\n⚠ यह मुख्य कार्य के DOM/BOQ में भी जुड़ा है — वहाँ से भी हट जाएगा।" : "");
          if (confirm(msg)) { deleteSubEstimate(est, sub.id); renderSubEstimates(); }
        });
        list.appendChild(row);
      });
      gBox.appendChild(list); box.appendChild(gBox);
    });
  }

  // loaded Material Query Rate के सभी material से RMR की rows बनाओ (सब पर एक ही दूरी)
  function buildRmrRowsFromMaster(distance) {
    const matRows = loadedVersionRows("material_query");
    if (!matRows) return [];
    return matRows.map((m) => ({
      id: uid("rmrrow"), matId: m.id,
      material: m.desc || "", query: m.query_name || "",
      matRate: (mrNum(m.query_rate) - mrNum(m.loading)).toFixed(2),
      royalty: m.royalty != null ? String(m.royalty) : "",
      distance: distance == null ? "" : distance,
    }));
  }

  // Query नामों की सूची — मुख्यतः Master Data → Material Query Rate की "Query Names" सूची से
  //  (जितनी वहाँ जोड़ी गईं); साथ में loaded version में हर Query के material की गिनती।
  function rmrQueryList() {
    const cat = state.master["material_query"];
    const names = (cat && Array.isArray(cat.queryNames)) ? cat.queryNames : [];
    const matRows = loadedVersionRows("material_query") || [];
    const count = {};
    for (const r of matRows) { const qn = (r.query_name || "").trim() || "__noquery__"; count[qn] = (count[qn] || 0) + 1; }
    const seen = [], map = {};
    // 1) Master की Query Names सूची — जितनी वहाँ जोड़ी गई हैं
    for (const nm of names) {
      const qn = (nm || "").trim(); if (!qn || map[qn]) continue;
      map[qn] = { key: qn, name: qn, count: count[qn] || 0 }; seen.push(map[qn]);
    }
    // 2) loaded rows में कोई query_name जो सूची में नहीं (fallback — पुराना डेटा)
    for (const r of matRows) {
      const qn = (r.query_name || "").trim(), key = qn || "__noquery__";
      if (!map[key]) { map[key] = { key: key, name: qn || "(बिना Query नाम)", count: count[key] || 0 }; seen.push(map[key]); }
    }
    return seen;
  }
  // queryDist (Query→km) के अनुसार हर material की row बनाओ — उसकी Query की दूरी उसमें भर जाए
  function buildRmrRowsWithQueryDist(queryDist) {
    const matRows = loadedVersionRows("material_query");
    if (!matRows) return [];
    return matRows.map((m) => {
      const key = (m.query_name || "").trim() || "__noquery__";
      const d = queryDist ? queryDist[key] : "";
      return {
        id: uid("rmrrow"), matId: m.id, material: m.desc || "", query: m.query_name || "",
        matRate: (mrNum(m.query_rate) - mrNum(m.loading)).toFixed(2),
        royalty: m.royalty != null ? String(m.royalty) : "",
        distance: (d == null || d === "") ? "" : String(d),
      };
    });
  }
  // सभी Query की दूरी (km) पूछने का modal — साथ में RMR नाम
  function askQueryDistances(defName, existing, hideName) {
    return new Promise((resolve) => {
      const queries = rmrQueryList();
      if (!queries.length) { alert("पहले Master Data → Primary Rate → Material Query Rate में\n\"🏷️ Query Names\" सूची में कुछ Query नाम जोड़ें — वही यहाँ आएँगे।"); resolve(null); return; }
      existing = existing || {};
      const rowsH = queries.map((qz) =>
        "<label class='qd-row'><span class='qd-nm'>" + escapeHtml(qz.name) + "<small>" + qz.count + " material</small></span>" +
        "<input type='text' class='qd-km num' data-qk='" + escapeHtml(qz.key) + "' value=\"" + escapeHtml(existing[qz.key] == null ? "" : String(existing[qz.key])) + "\" placeholder='km' /></label>"
      ).join("");
      const titleSuffix = hideName && defName ? (" — " + defName) : "";
      const ov = document.createElement("div"); ov.className = "modal-overlay";
      ov.innerHTML =
        "<div class='modal qd-modal'><h3>📏 साइट से Query की दूरी (km)" + escapeHtml(titleSuffix) + "</h3>" +
        "<p class='sub'>हर Query (स्रोत/खदान) से साइट की दूरी किमी में भरें — यही दूरी RMR में उस Query के सभी material पर लग जाएगी।</p>" +
        (hideName ? "" : "<label class='qd-name'>RMR का नाम<input type='text' id='qdName' value=\"" + escapeHtml(defName || "") + "\" /></label>") +
        "<div class='qd-list'>" + rowsH + "</div>" +
        "<div class='row' style='margin-top:12px'><button class='btn' id='qdCancel'>रद्द</button><button class='btn primary' id='qdOk'>✓ ठीक है</button></div></div>";
      document.body.appendChild(ov);
      const done = (v) => { ov.remove(); resolve(v); };
      ov.querySelector("#qdCancel").addEventListener("click", () => done(null));
      ov.addEventListener("mousedown", (e) => { if (e.target === ov) done(null); });
      ov.querySelector("#qdOk").addEventListener("click", () => {
        const nmEl = ov.querySelector("#qdName");
        const name = (nmEl ? nmEl.value : "").trim() || defName;
        const queryDist = {};
        ov.querySelectorAll(".qd-km").forEach((inp) => { queryDist[inp.dataset.qk] = (inp.value || "").trim(); });
        done({ name: name, queryDist: queryDist });
      });
      const f = ov.querySelector(".qd-km"); if (f) f.focus();
    });
  }

  function createRMR() {
    const est = state.estimates[state.activeEstimateId];
    if (!est) { alert("पहले Load Estimate से कोई estimate खोलें/बनाएँ।"); return; }
    const matRows = loadedVersionRows("material_query");
    if (!matRows || !matRows.length) { alert("पहले Master Data → Material Query Rate में कोई version Load करें (उसी से material आएँगे)।"); return; }
    if (!est.rmrs) est.rmrs = [];
    askQueryDistances("RMR" + (est.rmrs.length + 1), null).then((res) => {
      if (!res) return;
      const rmr = { id: uid("rmr"), name: res.name, queryDist: res.queryDist, rows: buildRmrRowsWithQueryDist(res.queryDist), locked: false };
      est.rmrs.push(rmr); rmrActiveId = rmr.id;
      db.put("estimates", est);
      renderRMR();
      scheduleReRate();
      status(rmr.name + " बना — Query दूरियों से " + rmr.rows.length + " material की दूरी भर गई; जाँचकर 💾 Save करें");
    });
  }

  function renderRMR() {
    const est = state.estimates[state.activeEstimateId];
    const sub = document.getElementById("rmrSub");
    const tbar = document.getElementById("rmrToolbar");
    const tb = document.getElementById("rmrTable");
    if (!tb) return;
    const cbh = document.getElementById("rmrCartageBreak"); if (cbh) cbh.innerHTML = "";   // पुराना विवरण साफ़ (नीचे फिर भरेगा)
    if (!est) {
      if (sub) sub.textContent = "कोई estimate लोड नहीं";
      if (tbar) tbar.innerHTML = "";
      tb.innerHTML = "<tbody><tr><td class='dt-empty'>पहले बाएँ <b>Load Estimate</b> से कोई estimate खोलें/बनाएँ।</td></tr></tbody>";
      return;
    }
    if (!est.rmrs) est.rmrs = [];
    if (sub) sub.textContent = est.name;
    let rmr = est.rmrs.find((r) => r.id === rmrActiveId) || est.rmrs[0];
    if (rmr) rmrActiveId = rmr.id;
    // form (Load Estimate) से बना RMR — तब Material Query Rate load न था, rows खाली रहीं → अब भर दो
    if (rmr && (!rmr.rows || !rmr.rows.length)) {
      rmr.rows = rmr.queryDist ? buildRmrRowsWithQueryDist(rmr.queryDist)       // हर Query की अपनी दूरी
                               : buildRmrRowsFromMaster(rmr.siteDist == null ? "" : rmr.siteDist);  // पुराने (एकल-दूरी) RMR
      if (rmr.rows.length) db.put("estimates", est);
    }
    if (sub && rmr && rmr.remark) sub.textContent = est.name + " · " + rmr.name + ": " + rmr.remark;

    // toolbar — RMR chips + actions
    if (tbar) {
      let h = "<div class='rmr-list'>";
      est.rmrs.forEach((r) => { h += "<button class='rmr-chip" + (r.id === rmrActiveId ? " active" : "") + (r.locked ? " locked" : "") + "' data-rmr='" + r.id + "' title=\"" + escapeHtml(r.remark || "") + "\">" + (r.locked ? "🔒 " : "") + escapeHtml(r.name) + "</button>"; });
      h += "<button class='btn sm primary' id='rmrNew'>+ नया RMR</button>";
      if (rmr) {
        h += rmr.locked
          ? "<button class='btn sm' id='rmrEdit' title='दूरी बदलने के लिए edit चालू करें'>✎ Edit</button>"
          : "<button class='btn sm ok' id='rmrSave' title='दूरी भरने के बाद lock करें'>💾 Save</button>" +
            "<button class='btn sm' id='rmrQDist' title='सभी Query की साइट-दूरी दोबारा भरें'>📏 Query दूरी</button>";
        h += "<button class='btn sm' id='rmrRename'>✎ नाम</button><button class='btn sm danger' id='rmrDel'>🗑 हटाएँ</button>";
      }
      h += "</div>";
      tbar.innerHTML = h;
      tbar.querySelectorAll("[data-rmr]").forEach((b) => b.addEventListener("click", () => { rmrActiveId = b.dataset.rmr; renderRMR(); }));
      const nw = document.getElementById("rmrNew"); if (nw) nw.addEventListener("click", createRMR);
      const sv = document.getElementById("rmrSave"); if (sv) sv.addEventListener("click", () => { rmr.locked = true; db.put("estimates", est); renderRMR(); status(rmr.name + " Save/lock हुआ — Edit से दोबारा खोल सकते हैं"); });
      const ed = document.getElementById("rmrEdit"); if (ed) ed.addEventListener("click", () => { rmr.locked = false; db.put("estimates", est); renderRMR(); status(rmr.name + " edit चालू"); });
      const qd = document.getElementById("rmrQDist"); if (qd) qd.addEventListener("click", () => {
        askQueryDistances(rmr.name, rmr.queryDist || {}).then((res) => {
          if (!res) return;
          rmr.name = res.name; rmr.queryDist = res.queryDist;
          rmr.rows.forEach((row) => {
            const mat = rmrMaterial(row);                    // live Query (matId से) — पुरानी rows में भी सही मैच
            const key = (mat.query || "").trim() || "__noquery__";
            row.query = mat.query || row.query || "";         // stored query भी ताज़ा कर दो
            const d = res.queryDist[key];
            if (d != null && d !== "") row.distance = String(d);
          });
          db.put("estimates", est); renderRMR(); scheduleReRate(); status("Query दूरियाँ अपडेट — RMR व linked Rate Analysis ताज़ा");
        });
      });
      const rn = document.getElementById("rmrRename"); if (rn) rn.addEventListener("click", () => {
        const nm = prompt("RMR का नाम:", rmr.name); if (nm === null) return;
        rmr.name = nm.trim() || rmr.name; db.put("estimates", est); renderRMR();
      });
      const dl = document.getElementById("rmrDel"); if (dl) dl.addEventListener("click", () => {
        if (!confirm("यह " + rmr.name + " हटाएँ?")) return;
        est.rmrs = est.rmrs.filter((x) => x !== rmr); rmrActiveId = est.rmrs[0] ? est.rmrs[0].id : null;
        db.put("estimates", est); renderRMR(); status("RMR हटाया");
      });
    }

    if (!rmr) {
      tb.innerHTML = "<tbody><tr><td class='dt-empty'>इस estimate में कोई RMR नहीं — <b>+ नया RMR</b> दबाएँ (loaded Material Query Rate से सभी material आ जाएँगे)।</td></tr></tbody>";
      return;
    }

    const thead = "<thead><tr>" +
      "<th style='width:50px'>क्रम</th><th>Material का नाम</th><th style='width:130px'>Query का नाम</th>" +
      "<th style='width:96px'>दूरी (km)</th><th style='width:104px'>Material Rate</th>" +
      "<th style='width:104px'>Cartage Rate</th><th style='width:96px'>Royalty (−)</th>" +
      "<th style='width:150px'>Total Rate Incl. Cartage</th></tr></thead>";
    let body = "";
    (rmr.rows || []).forEach((row, i) => {
      try {
        const mat = rmrMaterial(row);
        const cartage = rmrCartage(row.distance);
        // Total बिल्कुल वही जो Rate Analysis को मिलता है (एक ही स्रोत — कभी अलग न हो)
        const total = rmrRateForMat(rmr.id, row.matId);
        body += "<tr>" +
          "<td><input class='num' readonly value='" + (i + 1) + "' /></td>" +
          "<td class='rmr-mat" + (row.wrapName ? " wrapped" : "") + "'>" +
            "<button class='rmr-wrapbtn' data-wrap='" + i + "' title='Material का नाम wrap ↔ एक-लाइन'>⤶</button>" +
            (row.wrapName
              ? "<div class='rmr-matname wrapname'>" + escapeHtml(mat.material) + "</div>"
              : "<input readonly class='rmr-matname' value=\"" + escapeHtml(mat.material) + "\" />") +
          "</td>" +
          "<td><input readonly value=\"" + escapeHtml(mat.query) + "\" /></td>" +
          "<td><input class='num' " + (rmr.locked ? "readonly " : "") + "data-i='" + i + "' value=\"" + escapeHtml(row.distance == null ? "" : String(row.distance)) + "\" /></td>" +
          "<td><input class='num' readonly value=\"" + nf(mat.matRate) + "\" /></td>" +
          "<td><input class='num calc' readonly value=\"" + (mrNum(row.distance) > 0 ? nf(cartage) : "") + "\" /></td>" +
          "<td><input class='num' readonly value=\"" + (mat.royalty ? nf(mat.royalty) : "") + "\" /></td>" +
          "<td><input class='num calc' readonly value=\"" + (total == null ? "" : nf(total)) + "\" /></td>" +
          "</tr>";
      } catch (e) {   // किसी एक पंक्ति में गड़बड़ हो तो भी बाकी तालिका बने
        body += "<tr><td><input class='num' readonly value='" + (i + 1) + "' /></td><td colspan='7' class='dt-empty'>इस material की गणना में त्रुटि (" + escapeHtml(String(e && e.message || e)) + ")</td></tr>";
      }
    });
    if (!body) body = "<tr><td colspan='8' class='dt-empty'>इस RMR में कोई material नहीं — <b>📏 Query दूरी</b> भरें या Material Query Rate Load करें।</td></tr>";
    tb.innerHTML = thead + "<tbody>" + body + "</tbody>";
    // Material का नाम — wrap ↔ एक-लाइन toggle (हर row अलग; est में सहेजा)
    tb.querySelectorAll("button[data-wrap]").forEach((b) => b.addEventListener("click", () => {
      const i = +b.dataset.wrap; rmr.rows[i].wrapName = !rmr.rows[i].wrapName;
      db.put("estimates", est); renderRMR();
    }));
    // दूरी edit → cartage+total live
    tb.querySelectorAll("input[data-i]").forEach((inp) => {
      inp.addEventListener("input", () => {
        const i = +inp.dataset.i; rmr.rows[i].distance = inp.value;
        const tr = inp.closest("tr"), cells = tr.querySelectorAll("input.calc");
        const cartage = rmrCartage(inp.value);
        const total = rmrRateForMat(rmr.id, rmr.rows[i].matId);   // वही रेट जो analysis को जाएगा
        if (cells[0]) cells[0].value = mrNum(inp.value) > 0 ? nf(cartage) : "";
        if (cells[1]) cells[1].value = (total == null ? "" : nf(total));
        db.put("estimates", est);
        scheduleReRate();   // इस RMR से linked analyses की दरें भी ताज़ा
      });
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === "ArrowDown") { e.preventDefault(); const n = tb.querySelector("input[data-i='" + (+inp.dataset.i + 1) + "']"); if (n) { n.focus(); n.select(); } } else if (e.key === "ArrowUp") { e.preventDefault(); const p = tb.querySelector("input[data-i='" + (+inp.dataset.i - 1) + "']"); if (p) { p.focus(); p.select(); } } });
    });
    try { renderRMRCartageBreak(rmr); } catch (e) { const h = document.getElementById("rmrCartageBreak"); if (h) h.innerHTML = ""; }   // तालिका के नीचे — Cartage Rate विवरण (त्रुटि हो तो तालिका पर असर न पड़े)
  }

  // RMR की सभी Query (हर की अपनी दूरी) — कार्य-समूह (Estimate विवरण) की सभी Query, फिर rows की बची Query
  function rmrUniqueQueries(rmr) {
    const seen = {}, out = [];
    const add = (q, d) => { const qn = (q == null ? "" : String(q)).trim(); if (!qn || qn === "__noquery__" || mrNum(d) <= 0) return; if (qn in seen) return; seen[qn] = true; out.push({ query: qn, distance: d }); };
    // 1) कार्य-समूह की सभी Query — queryDist से (चाहे उस Query का material हो या न हो)
    const qd = rmr && rmr.queryDist;
    if (qd && typeof qd === "object") Object.keys(qd).forEach((q) => add(q, qd[q]));
    // 2) rows में बची Query (queryDist में न हों)
    ((rmr && rmr.rows) || []).forEach((row) => { const mat = rmrMaterial(row); add(mat.query || row.query, row.distance); });
    return out;
  }
  // एक Query का Cartage विवरण — attach किए प्रारूप का HTML
  function cartageBreakHTML(block) {
    const bd = block.bd;
    const f2 = (n) => mrNum(n).toFixed(2);   // Amount कॉलम — हमेशा 2 दशमलव
    let rows = "";
    (bd.compactParts || []).forEach((p) => {
      const label = p.cumulative
        ? nf(p.from) + " to " + nf(p.to) + " तक (cumulative)"
        : nf(p.from) + " to " + nf(p.to) + " (" + nf(p.km) + " km &times; " + nf(p.rate) + ")";
      rows += "<tr><td>" + label + "</td><td class='r'>" + f2(p.amt) + "</td></tr>";
    });
    return "<div class='cbk-card'>" +
      "<div class='cbk-h2'>Cartage Rate (" + escapeHtml(block.query) + ")" +
        "<span class='cbk-km'>दूरी " + nf(bd.km) + " km</span></div>" +
      "<table class='cbk-t'>" + rows +
        "<tr class='cbk-tot'><td>Total</td><td class='r'>" + f2(bd.slabTotal) + "</td></tr>" +
      "</table>" +
      "<div class='cbk-h2'>Cartage Kachha</div>" +
      "<table class='cbk-t'>" +
        "<tr><td>(" + nf(bd.firstKm) + " - " + nf(bd.load) + " - " + nf(bd.unload) + ") &times; " + nf(bd.kachhaPct) + "%</td><td class='r'>" + f2(bd.kachha) + "</td></tr>" +
        "<tr class='cbk-tot'><td>Total</td><td class='r'>" + f2(bd.total) + "</td></tr>" +
        "<tr class='cbk-net'><td>Net Total without CP</td><td class='r'>" + f2(bd.netWithoutCP) + "</td></tr>" +
      "</table></div>";
  }
  function renderRMRCartageBreak(rmr) {
    const host = document.getElementById("rmrCartageBreak"); if (!host) return;
    const qs = rmr ? rmrUniqueQueries(rmr) : [];
    if (!qs.length) { host.innerHTML = ""; return; }
    const blocks = qs.map((q) => ({ query: q.query, distance: q.distance, bd: cartageBreakdown(q.distance) }));
    host.innerHTML =
      "<div class='cbk-bar'><h3>Cartage Rate — विवरण (Query अनुसार) · " + blocks.length + " Query</h3>" +
      "<div class='cbk-btns'><button class='btn sm' id='cbkPrint'>🖨 पूरा RMR Print</button><button class='btn sm' id='cbkXlsx'>⬇ Cartage Excel</button></div></div>" +
      "<div class='cbk-cards'>" + blocks.map(cartageBreakHTML).join("") + "</div>";
    const pb = document.getElementById("cbkPrint"); if (pb) pb.addEventListener("click", () => printCartageBreak(rmr, blocks));
    const xb = document.getElementById("cbkXlsx"); if (xb) xb.addEventListener("click", () => exportCartageBreakXlsx(rmr, blocks));
  }
  function printCartageBreak(rmr, blocks) {
    const est = state.estimates[state.activeEstimateId];
    // Material तालिका (पूरा RMR सेक्शन print में) — वही मान जो स्क्रीन पर
    let matRows = "";
    ((rmr && rmr.rows) || []).forEach((row, i) => {
      const mat = rmrMaterial(row);
      const cartage = rmrCartage(row.distance);
      const total = rmrRateForMat(rmr.id, row.matId);
      matRows += "<tr>" +
        "<td class='c'>" + (i + 1) + "</td>" +
        "<td>" + escapeHtml(mat.material) + "</td>" +
        "<td>" + escapeHtml(mat.query) + "</td>" +
        "<td class='r'>" + (row.distance == null ? "" : escapeHtml(String(row.distance))) + "</td>" +
        "<td class='r'>" + nf(mat.matRate) + "</td>" +
        "<td class='r'>" + (mrNum(row.distance) > 0 ? nf(cartage) : "") + "</td>" +
        "<td class='r'>" + (mat.royalty ? nf(mat.royalty) : "") + "</td>" +
        "<td class='r'><b>" + (total == null ? "" : nf(total)) + "</b></td>" +
        "</tr>";
    });
    const matTable = "<table class='mat'><thead><tr>" +
      "<th>क्रम</th><th>Material का नाम</th><th>Query</th><th>दूरी (km)</th><th>Material Rate</th><th>Cartage Rate</th><th>Royalty (−)</th><th>Total Rate Incl. Cartage</th>" +
      "</tr></thead><tbody>" + matRows + "</tbody></table>";
    const css =
      "*{font-family:Arial,'Segoe UI',sans-serif;box-sizing:border-box} body{margin:0;padding:16px}" +
      "h1{font-size:18px; text-align:center; margin:0 0 2px} h2{font-size:13px; text-align:center; margin:0 0 12px; color:#333; font-weight:600}" +
      "h3.sec{font-size:15px; margin:18px 0 10px; font-weight:800}" +
      "table.mat{width:100%; border-collapse:collapse; margin-bottom:6px}" +
      "table.mat th,table.mat td{border:1px solid #000; padding:4px 6px; font-size:12px}" +
      "table.mat th{background:#eee; text-align:center; font-size:11px}" +
      "table.mat td.c{text-align:center} table.mat td.r{text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap}" +
      ".cbk-cards{display:flex; flex-wrap:wrap; gap:16px; align-items:flex-start}" +
      ".cbk-card{border:2px solid #000; border-radius:6px; padding:12px 18px; width:320px}" +
      ".cbk-title{text-align:center; font-weight:800; font-size:15px; margin:0 0 4px}" +
      ".cbk-h2{text-align:center; font-weight:800; font-size:14px; margin:10px 0 4px}" +
      ".cbk-km{display:block; font-weight:600; font-size:11px; color:#333}" +
      ".cbk-t{width:100%; border-collapse:collapse} .cbk-t td{padding:3px 2px; font-size:13px}" +
      ".cbk-t td.r{text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap}" +
      ".cbk-tot td{font-weight:800; border-top:1px solid #999} .cbk-net td{font-weight:800; border-top:2px solid #000}";
    const body =
      "<h1>" + escapeHtml(est ? est.name : "") + "</h1>" +
      "<h2>RMR — Carted Rate of Material" + (rmr ? " · " + escapeHtml(rmr.name) : "") + "</h2>" +
      matTable +
      "<h3 class='sec'>Cartage Rate — विवरण (Query अनुसार)</h3>" +
      "<div class='cbk-cards'>" + blocks.map(cartageBreakHTML).join("") + "</div>";
    const w = window.open("", "_blank");
    if (!w) { alert("Popup रोक दिया गया — कृपया इस साइट के लिए popup अनुमति दें।"); return; }
    w.document.write("<html><head><title>RMR — " + escapeHtml((est ? est.name + " · " : "") + (rmr ? rmr.name : "")) + "</title><style>" + css + "</style></head><body>" + body + "</body></html>");
    w.document.close(); w.focus(); setTimeout(() => { try { w.print(); } catch (e) {} }, 350);
  }
  async function exportCartageBreakXlsx(rmr, blocks) {
    const ok = await window.__sheetjsReady;
    if (!ok || typeof XLSX === "undefined") { alert("Excel engine (SheetJS) load नहीं हुआ — internet जाँचें।"); return; }
    const XS = await loadXlsxStyle(); const lib = XS || XLSX;
    const aoa = [], meta = [];
    aoa.push(["(Cartage Rate as per UPPWD SOR)", ""]); meta.push("title");
    blocks.forEach((b) => {
      const bd = b.bd;
      aoa.push(["Cartage (" + b.query + ")", ""]); meta.push("h2");
      (bd.compactParts || []).forEach((p) => {
        const label = p.cumulative ? (nf(p.from) + " to " + nf(p.to) + " (cumulative)") : (nf(p.from) + " to " + nf(p.to) + " (" + nf(p.km) + " km x " + nf(p.rate) + ")");
        aoa.push([label, round2(p.amt)]); meta.push("row");
      });
      aoa.push(["Total", bd.slabTotal]); meta.push("tot");
      aoa.push(["Cartage Kachha", ""]); meta.push("h2");
      aoa.push(["(" + nf(bd.firstKm) + " - " + nf(bd.load) + " - " + nf(bd.unload) + ") × " + nf(bd.kachhaPct) + "%", bd.kachha]); meta.push("row");
      aoa.push(["Total", bd.total]); meta.push("tot");
      aoa.push(["Net Total without CP", bd.netWithoutCP]); meta.push("net");
    });
    const NR = aoa.length, NC = 2;
    const cen = { alignment: { horizontal: "center" }, font: { bold: true, sz: 13 } };
    const cenBig = { alignment: { horizontal: "center" }, font: { bold: true, sz: 14 } };
    const base = { font: { sz: 12 } };
    const numR = { alignment: { horizontal: "right" }, font: { sz: 12 } };
    const bold = { font: { bold: true, sz: 12 } };
    const boldR = { alignment: { horizontal: "right" }, font: { bold: true, sz: 12 } };
    const styleFor = (r, c) => {
      const t = meta[r];
      if (t === "title") return cenBig;
      if (t === "h2") return cen;
      if (t === "tot" || t === "net") return c === 1 ? boldR : bold;
      return c === 1 ? numR : base;
    };
    const ws = {};
    for (let r = 0; r < NR; r++) for (let c = 0; c < NC; c++) {
      const val = aoa[r][c]; const ref = lib.utils.encode_cell({ r, c });
      let cell = (typeof val === "number") ? { t: "n", v: val } : { t: "s", v: val == null ? "" : String(val) };
      if (XS) cell.s = styleFor(r, c);
      ws[ref] = cell;
    }
    ws["!ref"] = lib.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: NR - 1, c: NC - 1 } });
    ws["!cols"] = [{ wpx: 300 }, { wpx: 110 }];
    ws["!merges"] = meta.map((t, r) => (t === "title" || t === "h2") ? { s: { r, c: 0 }, e: { r, c: 1 } } : null).filter(Boolean);
    const wb = lib.utils.book_new();
    lib.utils.book_append_sheet(wb, ws, "Cartage Rate");
    const safe = ((est) => (est ? est.name + "_" : ""))(state.estimates[state.activeEstimateId]) + (rmr ? rmr.name : "RMR");
    lib.writeFile(wb, "Cartage_Rate_" + safe.replace(/[^\wऀ-ॿ.-]+/g, "_") + ".xlsx", { bookType: "xlsx" });
    status("Cartage Rate विवरण Excel download हुआ");
  }

  function wireRMR() {
    const open = document.getElementById("openRMR");
    if (open) open.addEventListener("click", openRMRView);
    const back = document.getElementById("rmrBack");
    if (back) back.addEventListener("click", () => setActiveView("basic-analysis"));
    // Bitumen / Emulsion Rate Analysis
    const obit = document.getElementById("openBitumen");
    if (obit) obit.addEventListener("click", () => { if (!state.estimates[state.activeEstimateId]) { alert("पहले कोई Estimate खोलें।"); return; } openBitumenView(); });
    const bitBack = document.getElementById("bitumenBack");
    if (bitBack) bitBack.addEventListener("click", () => setActiveView("basic-analysis"));
    const bitReset = document.getElementById("bitumenReset");
    if (bitReset) bitReset.addEventListener("click", () => {
      const est = state.estimates[state.activeEstimateId]; if (!est) return;
      if (!confirm("Bitumen तालिका फिर से default बनाएँ? वर्तमान बदलाव मिट जाएँगे।")) return;
      bitumenBuildDefault(est, bitumenEnsureSheet(est)); renderBitumen(); status("Bitumen तालिका फिर से बनाई");
    });
    // Cover Page (Basic Sheet)
    const oCov = document.getElementById("openCover"); if (oCov) oCov.addEventListener("click", openCoverView);
    const covBack = document.getElementById("coverBack"); if (covBack) covBack.addEventListener("click", () => setActiveView("basic-sheet"));
    // Checklist — Checking Proforma (Basic Sheet)
    const oChk = document.getElementById("openChecklist"); if (oChk) oChk.addEventListener("click", openChecklistView);
    const chkBack = document.getElementById("chkBack"); if (chkBack) chkBack.addEventListener("click", () => setActiveView("basic-sheet"));
    const chkPrint = document.getElementById("chkPrint"); if (chkPrint) chkPrint.addEventListener("click", () => { const est = state.estimates[state.activeEstimateId]; if (est) printChecklist(est); });
    // Index — विषय-सूची (Basic Sheet)
    const oIdx = document.getElementById("openIndex"); if (oIdx) oIdx.addEventListener("click", openIndexView);
    const idxBack = document.getElementById("idxBack"); if (idxBack) idxBack.addEventListener("click", () => setActiveView("basic-sheet"));
    const idxPrint = document.getElementById("idxPrint"); if (idxPrint) idxPrint.addEventListener("click", () => { const est = state.estimates[state.activeEstimateId]; if (est) printIndex(est); });
    // Estimate Home — Actions (group PDF / Word / Excel / Print)
    const actEst = () => state.estimates[state.activeEstimateId];
    const aBP = document.getElementById("actBasicPdf"); if (aBP) aBP.addEventListener("click", () => { const e = actEst(); if (!e) return alert("पहले कोई Estimate खोलें।"); downloadBasicSheetPDF(e); });
    const aRW = document.getElementById("actReportWord"); if (aRW) aRW.addEventListener("click", () => { const e = actEst(); if (!e) return alert("पहले कोई Estimate खोलें।"); downloadReportWord(e); });
    const aXL = document.getElementById("actExcel"); if (aXL) aXL.addEventListener("click", () => { const e = actEst(); if (!e) return alert("पहले कोई Estimate खोलें।"); exportEstimateXlsx(e, estAllSheetIds(e)); });
    const aSP = document.getElementById("actSheetsPdf"); if (aSP) aSP.addEventListener("click", () => { const e = actEst(); if (!e) return alert("पहले कोई Estimate खोलें।"); printEstimate(e, estAllSheetIds(e)); });
    // Report — प्रतिवेदन (Basic Sheet)
    const oRpt = document.getElementById("openReport"); if (oRpt) oRpt.addEventListener("click", openReportView);
    const rptBack = document.getElementById("rptBack"); if (rptBack) rptBack.addEventListener("click", () => { saveReportNow(); setActiveView("basic-sheet"); });
    const rptDoc = document.getElementById("reportDoc");
    if (rptDoc) {
      rptDoc.addEventListener("input", () => { reportRecalcAll(rptDoc); scheduleSaveReport(); scheduleReportPageBreaks(); scheduleReportControls(); });
      rptDoc.addEventListener("keydown", reportTabKey);   // Tab → अगला cell
      // Right-click → सिलेक्ट टेक्स्ट पर Bold/Italic/Underline/आकार editor
      rptDoc.addEventListener("contextmenu", (e) => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !String(sel).trim()) { rptHideCtx(); return; }
        e.preventDefault();
        _rptCtxRange = sel.getRangeAt(0).cloneRange();
        const m = document.getElementById("rptCtx"); if (!m) return;
        m.style.display = "inline-flex";
        m.style.left = Math.max(6, Math.min(e.clientX, window.innerWidth - m.offsetWidth - 8)) + "px";
        m.style.top = Math.max(6, Math.min(e.clientY + 2, window.innerHeight - 44)) + "px";
      });
      rptDoc.addEventListener("click", (e) => {
        const ins = e.target.closest && e.target.closest(".rpt-rowins");
        const del = e.target.closest && e.target.closest(".rpt-rowdel");
        if (ins) { e.preventDefault(); reportInsertRow(ins); }
        else if (del) { e.preventDefault(); reportDeleteRow(del); }
      });
    }
    const rptAddSec = document.getElementById("rptAddSec"); if (rptAddSec) rptAddSec.addEventListener("click", reportAddSection);
    const rptAddTbl = document.getElementById("rptAddTbl"); if (rptAddTbl) rptAddTbl.addEventListener("click", reportInsertTable);
    const rptCtl = document.getElementById("rptSecCtrls");
    if (rptCtl) {
      rptCtl.addEventListener("click", (e) => {
        const up = e.target.closest(".rpt-moveup"), dn = e.target.closest(".rpt-movedown"), dl = e.target.closest(".rpt-secdel");
        if (up) reportMoveSection(+up.dataset.i, -1);
        else if (dn) reportMoveSection(+dn.dataset.i, 1);
        else if (dl) reportDelSection(+dl.dataset.i);
      });
      rptCtl.addEventListener("mousedown", (e) => {
        const g = e.target.closest(".rpt-drag"); if (!g) return; e.preventDefault();
        const el = reportBlocks(document.getElementById("reportDoc"))[+g.dataset.i];
        if (el && el.classList.contains("rpt-usertbl")) reportStartDrag(el, e);
      });
    }
    const rptCtx = document.getElementById("rptCtx");
    if (rptCtx) {
      rptCtx.querySelectorAll("button[data-cmd]").forEach((b) => b.addEventListener("mousedown", (e) => {
        e.preventDefault(); rptRestoreSel();
        try { document.execCommand(b.dataset.cmd, false, null); } catch (er) {}
        const s = window.getSelection(); if (s.rangeCount) _rptCtxRange = s.getRangeAt(0).cloneRange();
        scheduleSaveReport();
      }));
      const szSel = document.getElementById("rptCtxSize");
      if (szSel) szSel.addEventListener("change", () => {
        if (szSel.value) { rptRestoreSel(); try { document.execCommand("styleWithCSS", false, true); } catch (er) {} document.execCommand("fontSize", false, szSel.value); scheduleSaveReport(); }
        szSel.value = ""; rptHideCtx();
      });
      document.addEventListener("mousedown", (e) => { if (rptCtx.style.display !== "none" && !rptCtx.contains(e.target)) rptHideCtx(); });
    }
    const rptSave = document.getElementById("rptSave"); if (rptSave) rptSave.addEventListener("click", () => { saveReportNow(); status("प्रतिवेदन सहेजा"); });
    const rptReset = document.getElementById("rptReset"); if (rptReset) rptReset.addEventListener("click", () => {
      const est = state.estimates[state.activeEstimateId]; if (!est) return;
      if (!confirm("प्रतिवेदन फिर से default बनाएँ? आपके सभी edits मिट जाएँगे।")) return;
      est.report = est.report || {}; est.report.body = reportDefaultHTML(est); db.put("estimates", est); renderReport(); status("प्रतिवेदन फिर से बनाया");
    });
    const rptPrint = document.getElementById("rptPrint"); if (rptPrint) rptPrint.addEventListener("click", () => { const est = state.estimates[state.activeEstimateId]; if (est) { saveReportNow(); printReport(est); } });
    // Reference फाइलें (Basic Sheet)
    const oRef = document.getElementById("openReference"); if (oRef) oRef.addEventListener("click", openReferenceView);
    const refBack = document.getElementById("refBack"); if (refBack) refBack.addEventListener("click", () => setActiveView("basic-sheet"));
    const refUp = document.getElementById("refUpload"); const refFile = document.getElementById("refFile");
    if (refUp && refFile) refUp.addEventListener("click", () => refFile.click());
    if (refFile) refFile.addEventListener("change", () => { const est = state.estimates[state.activeEstimateId]; if (est) refAddFiles(est, refFile.files); refFile.value = ""; });
    const covSaveField = (key, val) => { const est = state.estimates[state.activeEstimateId]; if (!est) return; const c = ensureCover(est); c[key] = val; db.put("estimates", est); renderCover(); };
    const covAT = document.getElementById("covAagType"); if (covAT) covAT.addEventListener("change", () => covSaveField("aagType", covAT.value));
    const covYJ = document.getElementById("covYojana"); if (covYJ) covYJ.addEventListener("change", () => covSaveField("yojana", covYJ.value));
    const covDG = document.getElementById("covDesign"); if (covDG) covDG.addEventListener("change", () => covSaveField("design", covDG.value));
    const covPr = document.getElementById("covPrint"); if (covPr) covPr.addEventListener("click", () => { const est = state.estimates[state.activeEstimateId]; if (est) printCover(est); });
    const covEmb = document.getElementById("covEmblem"); const covEmbF = document.getElementById("covEmblemFile");
    if (covEmb && covEmbF) covEmb.addEventListener("click", () => covEmbF.click());
    if (covEmbF) covEmbF.addEventListener("change", () => {
      const f = covEmbF.files && covEmbF.files[0]; if (!f) return;
      const rd = new FileReader(); rd.onload = () => covSaveField("emblem", rd.result); rd.readAsDataURL(f); covEmbF.value = "";
    });
    const covEmbX = document.getElementById("covEmblemClear"); if (covEmbX) covEmbX.addEventListener("click", () => covSaveField("emblem", null));
    // DOM (Detail of Measurement)
    const mainWgId = () => { const est = state.estimates[state.activeEstimateId]; if (!est) return null; const m = estWorkGroups(est).find((w) => w.isMain) || estWorkGroups(est)[0]; return m ? m.id : null; };
    const odom = document.getElementById("btnOpenDOM");
    if (odom) odom.addEventListener("click", () => openDOMView(mainWgId()));   // मुख्य कार्य
    const dback = document.getElementById("domBack");
    if (dback) dback.addEventListener("click", () => setActiveView("dom-boq"));
    const dAddSub = document.getElementById("domAddSub"); if (dAddSub) dAddSub.addEventListener("click", domAddSubEstimate);
    const dAddSor = document.getElementById("domAddSor"); if (dAddSor) dAddSor.addEventListener("click", domAddSorItem);
    const dAddAna = document.getElementById("domAddAna"); if (dAddAna) dAddAna.addEventListener("click", domAddAnaItem);
    // Summary (free-form spreadsheet)
    const sRef = document.getElementById("sumRefresh"); if (sRef) sRef.addEventListener("click", () => {
      const est = state.estimates[state.activeEstimateId]; if (!est) return;
      if (!confirm("तालिका फिर से default (auto) बनाएँ? वर्तमान बदलाव मिट जाएँगे (BOQ/Sub-Estimate से ताज़ा मान आएँगे)।")) return;
      try { reRateAllAnalyses(); } catch (e) { }
      summaryBuildDefault(est, summaryEnsureSheet(est));
      est.summary = est.summary || {}; est.summary.tpl = ""; db.put("estimates", est);
      renderSummary(); status("तालिका फिर से बनाई (default)");
    });
    const sUtil = document.getElementById("sumUtility"); if (sUtil) sUtil.addEventListener("click", summaryAddUtility);
    const sUtilD = document.getElementById("sumUtilityDel"); if (sUtilD) sUtilD.addEventListener("click", summaryRemoveUtility);
    const sTpl = document.getElementById("sumTemplate"); if (sTpl) sTpl.addEventListener("click", openSummaryTemplatePicker);
    const sSave = document.getElementById("sumSaveTpl"); if (sSave) sSave.addEventListener("click", saveSummaryTemplate);
    const dref = document.getElementById("domRefresh");
    if (dref) dref.addEventListener("click", () => {
      if (!state.estimates[state.activeEstimateId]) return;
      try { reRateAllAnalyses(); } catch (e) { }   // पहले analysis की दरें ताज़ा
      renderDOM();
      status("DOM ताज़ा — मुख्य समूह के items व Quantity दोबारा ली गईं");
    });
    // BOQ
    const obq = document.getElementById("btnOpenBOQ");
    if (obq) obq.addEventListener("click", () => openBOQView(mainWgId()));   // मुख्य कार्य
    const bqback = document.getElementById("boqBack");
    if (bqback) bqback.addEventListener("click", () => setActiveView("dom-boq"));
    const bqref = document.getElementById("boqRefresh");
    if (bqref) bqref.addEventListener("click", () => {
      if (!state.estimates[state.activeEstimateId]) return;
      try { reRateAllAnalyses(); } catch (e) { }
      renderBOQ(true);   // दरें analysis से फिर से
      status("BOQ ताज़ा — दरें Analysis से दोबारा; Amount अद्यतन");
    });
  }

  function wireShell() {
    // ── मोबाइल/टैबलेट: sidebar को off-canvas खोलें/बंद करें ──
    (function () {
      const shell = document.querySelector(".app-shell");
      const toggle = document.getElementById("btnSidebarToggle");
      if (!shell || !toggle) return;
      let backdrop = document.getElementById("sidebarBackdrop");
      if (!backdrop) {
        backdrop = document.createElement("div");
        backdrop.id = "sidebarBackdrop";
        backdrop.className = "sidebar-backdrop";
        shell.appendChild(backdrop);
      }
      const closeNav = () => shell.classList.remove("nav-open");
      toggle.addEventListener("click", (e) => { e.stopPropagation(); shell.classList.toggle("nav-open"); });
      backdrop.addEventListener("click", closeNav);
      // छोटी screen पर कोई भी nav-item चुनने पर menu अपने-आप बंद
      const sb = document.getElementById("sidebar");
      if (sb) sb.addEventListener("click", (e) => { if (e.target.closest(".nav-item")) closeNav(); });
    })();
    // ── Rate Analysis: Analysis-सूची पैनल collapse (ग्रिड को पूरी जगह) ──
    (function () {
      const layout = document.getElementById("raLayout"); if (!layout) return;
      const col = document.getElementById("asideCollapse"), exp = document.getElementById("asideExpand");
      const setA = (on) => { layout.classList.toggle("ra-aside-collapsed", on); try { localStorage.setItem("re_ra_aside", on ? "1" : "0"); } catch (e) {} };
      if (col) col.addEventListener("click", () => setA(true));
      if (exp) exp.addEventListener("click", () => setA(false));
      try { if (localStorage.getItem("re_ra_aside") === "1") layout.classList.add("ra-aside-collapsed"); } catch (e) {}
    })();
    // ── मुख्य मेनू mini (icon-only) toggle — और जगह ──
    (function () {
      const shell = document.querySelector(".app-shell"); const t = document.getElementById("navMiniToggle");
      if (!shell || !t) return;
      t.addEventListener("click", () => { const on = shell.classList.toggle("nav-mini"); try { localStorage.setItem("re_nav_mini", on ? "1" : "0"); } catch (e) {} });
      try { if (localStorage.getItem("re_nav_mini") === "1") shell.classList.add("nav-mini"); } catch (e) {}
    })();
    document.querySelectorAll(".nav-item").forEach((n) => n.addEventListener("click", () => setActiveView(n.dataset.view)));
    document.querySelectorAll("[data-todo]").forEach((b) =>
      b.addEventListener("click", () => status("\"" + b.getAttribute("data-todo") + "\" — यह हिस्सा अगली बार बनाएँगे (frame तैयार है)।")));
    const show = (on) => { document.getElementById("newEstimateForm").style.display = on ? "block" : "none"; };
    const cardNew = document.getElementById("cardNewEstimate");
    if (cardNew) cardNew.addEventListener("click", () => openEstimateForm(null));
    const cardEdit = document.getElementById("cardEditEstimate");
    if (cardEdit) cardEdit.addEventListener("click", openEditEstimatePicker);
    const neCancel = document.getElementById("neCancel");
    if (neCancel) neCancel.addEventListener("click", () => { editingEstimateId = null; show(false); });
    // "+ समूह जोड़ें" — "सड़क निर्माण कार्य" समूह का सारा डेटा (दूरियाँ + Overhead) copy करके नया
    const wgAdd = document.getElementById("neWgAdd");
    if (wgAdd) wgAdd.addEventListener("click", () => {
      const box = document.getElementById("neWgRows");
      const cards = Array.prototype.filter.call(box.querySelectorAll(".wg-card"), (c) => c.style.display !== "none");
      const src = cards.find((c) => wgCardName(c) === "सड़क निर्माण कार्य") || cards[0];
      const base = src ? readWgCard(src) : {};
      const used = new Set(cards.map(wgCardName));
      const nextName = WG_PRESETS.find((p) => !used.has(p)) || "";   // पहला अनुपयोगी preset नाम
      box.appendChild(neWgRow({
        name: nextName, isMain: false,
        queryDist: Object.assign({}, base.queryDist || {}),
        sep: base.sep, ohPct: base.ohPct, cpPct: base.cpPct, combPct: base.combPct,
      }));
    });
    const neCreate = document.getElementById("neCreate");
    if (neCreate) neCreate.addEventListener("click", saveEstimateForm);
    // मशीनरी Leading की दूरी व मार्ग की कुल लम्बाई — प्रस्तावित लंबाई से auto-भरें (जब तक user खुद न भरे)
    const neLenEl = document.getElementById("neLength"), neMachEl = document.getElementById("neMachLead"), neTotEl = document.getElementById("neCovTotalLen");
    const mirrorFrom = (el) => { if (el && (el.value.trim() === "" || el.dataset.auto === "1")) { el.value = neLenEl.value; el.dataset.auto = "1"; } };
    if (neLenEl) neLenEl.addEventListener("input", () => { mirrorFrom(neMachEl); mirrorFrom(neTotEl); });
    if (neMachEl) neMachEl.addEventListener("input", () => { neMachEl.dataset.auto = ""; });
    if (neTotEl) neTotEl.addEventListener("input", () => { neTotEl.dataset.auto = ""; });
    // लंबाई/दूरी वाले फ़ील्ड — छोड़ते ही 2 दशमलव तक format (जैसे 8.5 → 8.50)
    LEN_FIELDS.forEach((id) => { const el = document.getElementById(id); if (el) el.addEventListener("blur", () => { const v = el.value.trim(); if (v === "") return; const n = mrNum(v); if (isFinite(n)) el.value = n.toFixed(2); }); });
    // खंड/वृत्त नाम बदलने पर विभागीय अधिकारी के drop-down उसी कार्यालय के नामों से ताज़ा
    ["neCovKhand", "neCovVritt"].forEach((id) => { const el = document.getElementById(id); if (el) el.addEventListener("change", () => { if (document.getElementById("newEstimateForm").style.display !== "none") renderOfficerSection(); }); });
    const neBitLock = document.getElementById("neBitLock");
    if (neBitLock) neBitLock.addEventListener("click", () => {
      neBitLocked = !neBitLocked;
      refreshNeBit();
      status(neBitLocked ? "Locked — Refinery/Side/Rate सुरक्षित (Master से)। दूरी फिर भी भर सकते हैं।" : "Unlocked — Refinery/Side/Rate मैनुअल भर/बदल सकते हैं।");
    });
    const neBitDate = document.getElementById("neBitDate");
    // प्रभावी Date बदलने पर हमेशा Master से फिर लोड (locked हो तब भी — पुष्टि माँगकर overwrite)
    if (neBitDate) neBitDate.addEventListener("change", () => loadBitumenDate(neBitDate.value));
    setActiveView("rate-analysis"); // default view
  }

  let editingEstimateId = null;
  // लंबाई/दूरी वाले फ़ील्ड — सब 2 दशमलव तक (km)
  const LEN_FIELDS = ["neLength", "neCovTotalLen", "neMachLead", "neEwLead"];
  function formatLenFields() {
    LEN_FIELDS.forEach((id) => { const el = document.getElementById(id); if (!el) return; const v = (el.value || "").trim(); if (v === "") return; const n = mrNum(v); if (isFinite(n)) el.value = n.toFixed(2); });
  }
  /* --- विभागीय अधिकारी (Estimate form) — खंड-कार्यालय व वृत्त-कार्यालय संरचना --- */
  //  खंड: अधिशासी(1) · सहायक(≥1) · अवर(≥1) · अवर प्रा0(1);  वृत्त: अवर प्रा0(1) · अधीक्षण(1)
  let neOff = { ee: "", ae: [""], je: [""], jePraK: "", jePraV: "", se: "" };
  function loadNeOff(cov) {
    cov = cov || {};
    neOff = {
      ee: cov.eeName || cov.ee || "",
      ae: (Array.isArray(cov.aeList) && cov.aeList.length) ? cov.aeList.slice() : [cov.ae || ""],
      je: (Array.isArray(cov.jeList) && cov.jeList.length) ? cov.jeList.slice() : [cov.je || ""],
      jePraK: cov.jePraKhand || "",
      jePraV: cov.jePraVritt || "",
      se: cov.seName || cov.se || "",
    };
    if (!neOff.ae.length) neOff.ae = [""];
    if (!neOff.je.length) neOff.je = [""];
  }
  function readNeOff() {
    const clean = (a) => (a || []).map((s) => String(s || "").trim()).filter(Boolean);
    return {
      eeName: (neOff.ee || "").trim(), aeList: clean(neOff.ae), jeList: clean(neOff.je),
      jePraKhand: (neOff.jePraK || "").trim(), jePraVritt: (neOff.jePraV || "").trim(), seName: (neOff.se || "").trim(),
    };
  }
  function fillDatalist(id, names) { const dl = document.getElementById(id); if (dl) dl.innerHTML = names.map((n) => "<option value=\"" + escapeHtml(n) + "\"></option>").join(""); }
  function renderOfficerSection() {
    const box = document.getElementById("neOfficers"); if (!box) return;
    const khand = (document.getElementById("neCovKhand") || {}).value || "";
    const vritt = (document.getElementById("neCovVritt") || {}).value || "";
    // कार्यालय+पद अनुसार drop-down सूचियाँ
    fillDatalist("offEE", officerNames(khand, "ee"));
    fillDatalist("offAE", officerNames(khand, "ae"));
    fillDatalist("offJE", officerNames(khand, "je"));
    fillDatalist("offJEPraK", officerNames(khand, "jePra"));
    fillDatalist("offJEPraV", officerNames(vritt, "jePra"));
    fillDatalist("offSE", officerNames(vritt, "se"));
    const esc = escapeHtml;
    const one = (lbl, cls, list, val) => "<label>" + lbl + "<input type='text' class='" + cls + "' list='" + list + "' value=\"" + esc(val || "") + "\" placeholder='नाम' /></label>";
    const multi = (title, cls, list, arr, addBtn) => {
      const rows = arr.map((v, i) => "<div class='off-row'><input type='text' class='" + cls + "' data-i='" + i + "' list='" + list + "' value=\"" + esc(v || "") + "\" placeholder='नाम' />" +
        (arr.length > 1 ? "<button type='button' class='off-del' data-cls='" + cls + "' data-i='" + i + "' title='हटाएँ'>✕</button>" : "") + "</div>").join("");
      return "<div class='off-multi'><div class='off-multi-h'>" + title + " <button type='button' class='off-add' data-add='" + addBtn + "'>+ जोड़ें</button></div>" + rows + "</div>";
    };
    box.innerHTML =
      "<div class='off-grp'><div class='off-grp-h'>🏢 खंड कार्यालय <small>" + esc(khand || "— खंड नाम भरें —") + "</small></div>" +
        "<div class='form-grid'>" + one("अधिशासी अभियंता", "off-ee", "offEE", neOff.ee) + one("अवर अभियंता (प्रा0)", "off-jePraK", "offJEPraK", neOff.jePraK) + "</div>" +
        multi("सहायक अभियंता", "off-ae", "offAE", neOff.ae, "ae") +
        multi("अवर अभियंता", "off-je", "offJE", neOff.je, "je") +
      "</div>" +
      "<div class='off-grp'><div class='off-grp-h'>🏛 वृत्त कार्यालय <small>" + esc(vritt || "— वृत्त नाम भरें —") + "</small></div>" +
        "<div class='form-grid'>" + one("अवर अभियंता (प्रा0)", "off-jePraV", "offJEPraV", neOff.jePraV) + one("अधीक्षण अभियंता", "off-se", "offSE", neOff.se) + "</div>" +
      "</div>";
    // wiring
    const bind = (sel, fn) => box.querySelectorAll(sel).forEach((el) => el.addEventListener("input", () => fn(el)));
    bind(".off-ee", (el) => neOff.ee = el.value);
    bind(".off-jePraK", (el) => neOff.jePraK = el.value);
    bind(".off-jePraV", (el) => neOff.jePraV = el.value);
    bind(".off-se", (el) => neOff.se = el.value);
    bind(".off-ae", (el) => neOff.ae[+el.dataset.i] = el.value);
    bind(".off-je", (el) => neOff.je[+el.dataset.i] = el.value);
    box.querySelectorAll(".off-add").forEach((b) => b.addEventListener("click", () => { neOff[b.dataset.add].push(""); renderOfficerSection(); }));
    box.querySelectorAll(".off-del").forEach((b) => b.addEventListener("click", () => { const arr = b.dataset.cls === "off-ae" ? neOff.ae : neOff.je; arr.splice(+b.dataset.i, 1); if (!arr.length) arr.push(""); renderOfficerSection(); }));
  }
  // form खोलो — estId दिया तो edit (pre-fill), वरना नया
  function openEstimateForm(estId) {
    editingEstimateId = estId || null;
    const est = estId ? state.estimates[estId] : null;
    const setV = (id, v) => { const el = document.getElementById(id); if (el) el.value = v == null ? "" : String(v); };
    setV("neWorkName", est ? est.name : "");
    setV("neRoadCode", est ? est.roadCode : "");
    setV("neLength", est ? est.length : "");
    // मशीनरी Leading की दूरी — default प्रस्तावित लंबाई
    setV("neMachLead", est ? (est.machineryLead != null && est.machineryLead !== "" ? est.machineryLead : (est.length != null ? est.length : "")) : "");
    setV("neEwLead", est ? (est.ewLead != null ? est.ewLead : 5) : "5.00");
    setV("neYear", est ? est.year : "");
    // Cover (कवर) विवरण — est.cover से
    const cov = est ? ensureCover(est) : {};
    setV("neCovAagType", cov.aagType || "प्रारम्भिक आगणन");
    setV("neCovKshetra", cov.kshetra || DEF_KSHETRA);
    setV("neCovVritt", cov.vritt || DEF_VRITT);
    setV("neCovKhand", cov.khand || DEF_KHAND);
    setV("neCovVidhan", cov.vidhanSabha || "");
    setV("neCovLok", cov.lokSabha || "");
    setV("neCovBlock", cov.block || "");
    setV("neCovSrishti", cov.srishti || "");
    fillYojanaSelect(cov.yojana || cov.workType || "");   // योजना का नाम — drop-down
    loadYojanaTypes(() => { const s = document.getElementById("neCovYojana"); if (s && document.getElementById("newEstimateForm").style.display !== "none") fillYojanaSelect(s.value || cov.yojana || ""); });
    // मार्ग की कुल लम्बाई — default प्रस्तावित लंबाई
    setV("neCovTotalLen", (cov.totalLen != null && cov.totalLen !== "") ? cov.totalLen : (est && est.length != null ? est.length : ""));
    loadNeOff(cov);
    renderOfficerSection();
    formatLenFields();   // प्रस्तावित/कुल लंबाई, मशीनरी व EW दूरी — 2 दशमलव तक
    renderNeWgRows(est);
    renderNeBitRows(est);
    populateNeBitDateSelect(bitumenEffDate(est));
    const h = document.querySelector("#newEstimateForm h3"); if (h) h.textContent = est ? ("Estimate सुधारें — " + est.name) : "नए Estimate का विवरण";
    const okb = document.getElementById("neCreate"); if (okb) okb.textContent = est ? "सुधार सहेजें" : "Estimate बनाएँ";
    document.getElementById("newEstimateForm").style.display = "block";
    document.getElementById("neWorkName").focus();
  }
  /* --- Estimate form: Bitumen Cartage विवरण (Refinery + दूरी + Both/One Side) --- */
  function refineryNameList() { const m = state.master["cartage"]; return (m && Array.isArray(m.refineryNames)) ? m.refineryNames : []; }
  // सभी Bitumen प्रकार नाम — Master › Bitumen Rate की साझा सूची से (न हों तो कुछ नहीं)
  function allBitumenTypeNames() { const m = state.master["bitumen_rate"]; const names = (m && Array.isArray(m.bitTypes)) ? m.bitTypes.map((t) => (t.type || "").trim()).filter(Boolean) : []; return Array.from(new Set(names)); }
  // प्रकार (Master से — locked), दूरी (प्रति-Refinery, user भरे)
  let neBitTypes = [];       // [{type, refinery, rate, side}] — Master › Bitumen Rate की चुनी Date से (locked)
  let neBitRefMap = {};      // refinery → दूरी (km) — एक बार भरो, उस Refinery के सभी प्रकार पर लगे
  let neBitLocked = false;   // दूरी भी Save/Lock (गलती से न बदले)
  let neBitLoadedDate = "";  // वर्तमान लोड की गई प्रभावी-Date — cancel पर dropdown यहीं वापस लौटे
  // प्रकार-सूची — Locked: read-only (Master से); Unlock: Refinery/Side/Rate मैनुअल editable
  function renderNeBitTypes() {
    const box = document.getElementById("neBitRows"); if (!box) return;
    if (!neBitTypes.length) { box.innerHTML = "<div class='wg-qd-empty muted' style='margin-top:6px'>ऊपर <b>प्रभावी Date</b> चुनें — Master › Bitumen Rate से प्रकार · Refinery · Both/One Side · Rate आएँगे।</div>"; return; }
    let h = "<table class='data-table bit-type-table'><thead><tr><th style='width:44px'>क्रम</th><th>Bitumen का प्रकार</th><th>Refinery</th><th style='width:120px'>Both/One Side</th><th style='width:120px'>Rate (₹/MT)</th></tr></thead><tbody>";
    if (neBitLocked) {
      neBitTypes.forEach((t, i) => {
        h += "<tr><td class='bit-sn'>" + (i + 1) + "</td><td>" + escapeHtml(t.type || "—") + "</td><td>" + escapeHtml(t.refinery || "—") + "</td><td>" + escapeHtml(t.side || "Both Side") + "</td><td class='num'>" + (t.rate != null && String(t.rate).trim() !== "" ? escapeHtml(String(t.rate)) : "—") + "</td></tr>";
      });
    } else {
      const refs = refineryNameList();
      neBitTypes.forEach((t, i) => {
        const opts = ["<option value=''>— Refinery चुनें —</option>"].concat(
          (refs.indexOf(t.refinery) < 0 && t.refinery ? [t.refinery] : []).concat(refs).map((r) =>
            "<option value=\"" + escapeHtml(r) + "\"" + (r === t.refinery ? " selected" : "") + ">" + escapeHtml(r) + "</option>")).join("");
        const sideSel = (s) => "<option value='Both Side'" + (s === "One Side" ? "" : " selected") + ">Both Side</option><option value='One Side'" + (s === "One Side" ? " selected" : "") + ">One Side</option>";
        h += "<tr><td class='bit-sn'>" + (i + 1) + "</td><td>" + escapeHtml(t.type || "—") + "</td>" +
          "<td><select class='ne-bt-ref' data-i='" + i + "'>" + opts + "</select></td>" +
          "<td><select class='ne-bt-side' data-i='" + i + "'>" + sideSel(t.side) + "</select></td>" +
          "<td><input type='text' class='num ne-bt-rate' data-i='" + i + "' value=\"" + escapeHtml(t.rate != null ? String(t.rate) : "") + "\" placeholder='₹/MT' /></td></tr>";
      });
    }
    h += "</tbody></table><div class='view-sub' style='margin:5px 2px 0'>" + (neBitLocked
      ? "🔒 प्रकार · Refinery · Both/One Side · Rate — Master › Bitumen Rate से (locked)। मैनुअल बदलने हेतु ऊपर <b>Unlock</b> दबाएँ।"
      : "🔓 Unlocked — Refinery · Both/One Side · Rate मैनुअल भरें। Refinery बदलने पर नीचे दूरी-सूची अपडेट होगी। दोबारा <b>प्रभावी Date</b> चुनने पर Master से फिर लोड होगा।") + "</div>";
    box.innerHTML = h;
    if (!neBitLocked) {
      box.querySelectorAll(".ne-bt-ref").forEach((sel) => sel.addEventListener("change", () => { neBitTypes[+sel.dataset.i].refinery = sel.value; renderNeBitRefDist(); }));
      box.querySelectorAll(".ne-bt-side").forEach((sel) => sel.addEventListener("change", () => { neBitTypes[+sel.dataset.i].side = sel.value; }));
      box.querySelectorAll(".ne-bt-rate").forEach((inp) => inp.addEventListener("input", () => { neBitTypes[+inp.dataset.i].rate = inp.value.trim(); }));
    }
  }
  // प्रति-Refinery दूरी-grid (RMR-शैली) — Master Date की सभी Refinery, हर के लिए एक दूरी (Side नहीं)
  // कुछ Refinery की default दूरी (km) — भरी न हो तो यही; user बदले तो बदल जाए
  function defaultRefineryDist(name) {
    const n = String(name || "").trim().toLowerCase();
    if (n === "mathura" || n === "मथुरा") return "297";
    if (n === "jhansi" || n === "झांसी" || n === "झाँसी") return "126";
    return "";
  }
  function renderNeBitRefDist() {
    const host = document.getElementById("neBitRefDist"); if (!host) return;
    const order = [], cnt = {}, seen = new Set();
    neBitTypes.forEach((t) => { if (t.refinery) { cnt[t.refinery] = (cnt[t.refinery] || 0) + 1; if (!seen.has(t.refinery)) { seen.add(t.refinery); order.push(t.refinery); } } });
    if (!order.length) { host.innerHTML = "<div class='wg-qd-empty muted'>ऊपर Date चुनें — फिर हर Refinery से site की दूरी भरें।</div>"; return; }
    host.innerHTML = "<div class='wg-qd-head'>📏 Refinery से site की दूरी (km) <span class='wg-qd-sub'>— हर Refinery के लिए एक बार भरें; उस Refinery के सभी प्रकार पर लगेगी</span></div>" +
      "<div class='wg-qd-grid'>" + order.map((r) => {
        // भरी न हो तो default दूरी (Mathura 297 / Jhansi 126) map में डालो — ताकि सहेजी भी जाए
        if (neBitRefMap[r] == null || String(neBitRefMap[r]).trim() === "") { const dd = defaultRefineryDist(r); if (dd) neBitRefMap[r] = dd; }
        const dist = neBitRefMap[r] != null ? neBitRefMap[r] : "";
        return "<label class='wg-qd-item bit-rd-item'><span class='wg-qd-nm'>" + escapeHtml(r) + "<small>" + cnt[r] + " प्रकार</small></span>" +
          "<input type='text' class='wg-qd-km num bit-rd-km' data-ref=\"" + escapeHtml(r) + "\" value=\"" + escapeHtml(String(dist)) + "\" placeholder='km' /></label>";
      }).join("") + "</div>";
    host.querySelectorAll(".bit-rd-km").forEach((inp) => inp.addEventListener("input", () => { neBitRefMap[inp.dataset.ref] = inp.value.trim(); }));
  }
  function refreshNeBit() {
    renderNeBitRefDist(); renderNeBitTypes();
    const lb = document.getElementById("neBitLock"); if (lb) { lb.textContent = neBitLocked ? "🔓 Unlock (Refinery/Side/Rate बदलें)" : "🔒 Save/Lock"; lb.classList.toggle("primary", neBitLocked); }
  }
  function renderNeBitRows(est) {
    neBitLocked = true;   // Estimate विवरण खुलते ही By-Default Locked — बदलने हेतु Unlock दबाएँ
    neBitLoadedDate = bitumenEffDate(est) || "";   // form खुलते ही वर्तमान Date दर्ज
    const list = (est && Array.isArray(est.bitumenCartage)) ? est.bitumenCartage : [];
    neBitTypes = list.map((d) => ({ type: d.type || "", refinery: d.refinery || "", rate: d.rate != null ? d.rate : "", side: d.side || "Both Side" }));
    neBitRefMap = {};
    list.forEach((d) => { if (d.refinery && neBitRefMap[d.refinery] == null) neBitRefMap[d.refinery] = d.dist != null ? d.dist : ""; });
    refreshNeBit();
  }
  // सहेजने हेतु — हर प्रकार (Master से locked) + उसकी Refinery की (एक बार भरी) दूरी
  function readNeBitRows() {
    const date = (document.getElementById("neBitDate") || {}).value || "";
    return neBitTypes.filter((t) => t.type || t.refinery).map((t) => ({ type: t.type, refinery: t.refinery, rate: t.rate, side: t.side || "Both Side", dist: (neBitRefMap[t.refinery] != null ? String(neBitRefMap[t.refinery]) : ""), date: date }));
  }
  // Master › Bitumen Rate की चुनी प्रभावी-Date (version) की दरें Estimate विवरण में लोड करो
  // Bitumen Rate की तारीखों से #neBitDate dropdown भरो (वर्तमान चयन बचाकर)
  function populateNeBitDateSelect(selDate) {
    const sel = document.getElementById("neBitDate"); if (!sel) return;
    const m = state.master["bitumen_rate"];
    const versions = (m && Array.isArray(m.versions)) ? m.versions.slice().sort((a, b) => dmyNum(b.date) - dmyNum(a.date)) : [];
    const cur = selDate != null ? selDate : sel.value;
    sel.innerHTML = "<option value=''>— Master से Date चुनें —</option>" + versions.map((v) => "<option value=\"" + escapeHtml(v.date) + "\"" + (v.date === cur ? " selected" : "") + ">" + escapeHtml(v.date) + "</option>").join("");
  }
  // चुनी Date की Bitumen दरें (प्रकार+Refinery+Rate) Estimate विवरण में लोड करो — दूरी/Side user भरे
  function loadBitumenDate(date) {
    const m = state.master["bitumen_rate"];
    if (!date) { populateNeBitDateSelect(neBitLoadedDate); return; }
    const versions = (m && Array.isArray(m.versions)) ? m.versions : [];
    const ver = versions.find((v) => v.date === date); if (!ver) { alert("इस Date की दरें नहीं मिलीं।"); return; }
    const bts = ensureBitTypes(m);
    // बदलाव की पुष्टि — Cancel पर कुछ न बदले, dropdown पिछली लोड-की-गई Date पर लौटे
    if (date === neBitLoadedDate) { populateNeBitDateSelect(neBitLoadedDate); return; }
    if (neBitTypes.length && !confirm("मौजूदा प्रकार बदलकर इस Date (" + date + ") के Master rate लोड करें?")) { populateNeBitDateSelect(neBitLoadedDate); return; }
    // प्रकार (साझा) + इस Date का per-type data (Refinery · Unit · Rate · Side) — सब Master से (locked)
    neBitTypes = bts.filter((t) => t.type && String(t.type).trim()).map((t) => { const d = (ver.data || {})[t.id] || {}; return {
      type: t.type || "", refinery: d.refinery || "", rate: d.rate != null ? d.rate : "", side: d.side || "Both Side",
    }; });
    neBitLoadedDate = date;   // सफल लोड — यही अब वर्तमान Date
    neBitLocked = true;   // Master से लोड होते ही Locked — बदलने हेतु Unlock दबाएँ
    refreshNeBit();
    status("Bitumen दरें लोड (" + date + ") — प्रकार/Refinery/Side/Rate locked; अब हर Refinery से site की दूरी भरें");
  }
  /* --- Estimate form: कार्य-समूह (हर समूह = नाम + मुख्य? + अपना RMR + अपने Overhead) --- */
  const WG_PRESETS = ["सड़क निर्माण कार्य", "नाली/डिवाइडर का कार्य", "पुल/पुलिया का कार्य", "अन्य कार्य"];
  // card का चुना नाम (dropdown या custom)
  function wgCardName(card) {
    const sel = card.querySelector(".wg-nm-sel"); if (!sel) return "";
    return sel.value === "__custom__" ? (card.querySelector(".wg-nm-custom").value || "").trim() : sel.value;
  }
  // card के मौजूदा (DOM) मान — copy/save के लिए
  function readWgCard(card) {
    const qd = {};
    card.querySelectorAll(".wg-qd-km").forEach((inp) => { qd[inp.dataset.qk] = (inp.value || "").trim(); });
    const comb = card.querySelector(".wg-mode").value === "comb";
    return {
      name: wgCardName(card), isMain: card.querySelector(".wg-ismain").checked, queryDist: qd, sep: !comb,
      ohPct: mrNum(card.querySelector(".wg-ohpct").value),
      cpPct: mrNum(card.querySelector(".wg-cppct").value),
      combPct: mrNum(card.querySelector(".wg-combpct").value),
    };
  }
  function neWgRow(data) {
    data = data || {};
    const row = document.createElement("div");
    row.className = "wg-card";
    if (data.id) row.dataset.id = data.id;
    if (data.rmrId) row.dataset.rmrId = data.rmrId;
    if (data.ohGroupId) row.dataset.ohId = data.ohGroupId;
    const qd0 = data.queryDist || {};   // पहले से भरी दूरियाँ
    // Query सूची — Master Data → Material Query Rate की Query Names से; हर के सामने km box (inline)
    const queries = rmrQueryList();
    const qdItems = queries.length
      ? queries.map((qz) =>
          "<label class='wg-qd-item'><span class='wg-qd-nm'>" + escapeHtml(qz.name) +
          (qz.count ? "<small>" + qz.count + " material</small>" : "") + "</span>" +
          "<span class='wg-qd-plus' title='1 किमी lead + आपकी दूरी'>1+</span>" +
          "<input type='text' class='wg-qd-km num' data-qk='" + escapeHtml(qz.key) + "' value=\"" +
          escapeHtml(qd0[qz.key] == null ? "" : String(qd0[qz.key])) + "\" placeholder='km' /></label>"
        ).join("")
      : "<div class='wg-qd-empty muted'>Master Data → Primary Rate → Material Query Rate → 🏷️ Query Names में नाम जोड़ें — वे यहाँ आएँगे।</div>";
    row.innerHTML =
      "<div class='wg-top'>" +
        "<label class='wg-name'>कार्य-समूह का नाम" +
          "<div class='wg-nm-wrap'>" +
            "<select class='wg-nm-sel'>" +
              WG_PRESETS.map((p) => "<option value='" + escapeHtml(p) + "'>" + escapeHtml(p) + "</option>").join("") +
              "<option value='__custom__'>✏️ अन्य नाम (खुद लिखें)…</option>" +
            "</select>" +
            "<input class='wg-nm-custom' placeholder='समूह का नाम लिखें' style='display:none' />" +
          "</div>" +
        "</label>" +
        "<label class='wg-main' title='इस estimate का मुख्य कार्य'><input type='radio' name='wgMain' class='wg-ismain' /> मुख्य कार्य</label>" +
        "<button type='button' class='lr-x wg-x' title='यह समूह हटाएँ'>✕</button>" +
      "</div>" +
      "<div class='wg-body'>" +
        "<div class='wg-qd'>" +
          "<div class='wg-qd-head'>📏 साइट से Query की दूरी (km) <span class='wg-qd-sub'>— हर Query के सभी material पर वही दूरी लगेगी</span></div>" +
          "<div class='wg-qd-grid'>" + qdItems + "</div>" +
        "</div>" +
        "<div class='wg-oh'>" +
          "<span class='wg-oh-label'>Overhead व Contractor Profit</span>" +
          "<label class='wg-f'>प्रकार<select class='wg-mode'><option value='sep'>अलग-अलग</option><option value='comb'>एक साथ</option></select></label>" +
          "<label class='wg-f wg-f-oh'>Overhead %<input class='wg-ohpct' /></label>" +
          "<label class='wg-f wg-f-cp'>Contractor Profit %<input class='wg-cppct' /></label>" +
          "<label class='wg-f wg-f-comb'>Overhead+Profit %<input class='wg-combpct' /></label>" +
        "</div>" +
      "</div>";
    // नाम — preset चुना हो तो dropdown; custom हो तो "अन्य नाम" + text box
    const nmSel = row.querySelector(".wg-nm-sel"), nmCustom = row.querySelector(".wg-nm-custom");
    const nm0 = data.name || "";
    if (nm0 && WG_PRESETS.indexOf(nm0) === -1) { nmSel.value = "__custom__"; nmCustom.value = nm0; nmCustom.style.display = ""; }
    else { nmSel.value = nm0 || WG_PRESETS[0]; }
    nmSel.addEventListener("change", () => {
      const c = nmSel.value === "__custom__";
      nmCustom.style.display = c ? "" : "none";
      if (c) nmCustom.focus();
    });
    row.querySelector(".wg-ismain").checked = !!data.isMain;
    row.querySelector(".wg-mode").value = data.sep === false ? "comb" : "sep";
    row.querySelector(".wg-ohpct").value = data.ohPct != null ? data.ohPct : OH_DEFAULTS.ohPct;
    row.querySelector(".wg-cppct").value = data.cpPct != null ? data.cpPct : OH_DEFAULTS.cpPct;
    row.querySelector(".wg-combpct").value = data.combPct != null ? data.combPct : OH_DEFAULTS.combPct;
    // Overhead mode → कौन-से % दिखें
    const syncMode = () => {
      const comb = row.querySelector(".wg-mode").value === "comb";
      row.querySelector(".wg-f-oh").style.display = comb ? "none" : "";
      row.querySelector(".wg-f-cp").style.display = comb ? "none" : "";
      row.querySelector(".wg-f-comb").style.display = comb ? "" : "none";
    };
    row.querySelector(".wg-mode").addEventListener("change", syncMode); syncMode();
    // हटाओ
    row.querySelector(".wg-x").addEventListener("click", () => {
      const box = document.getElementById("neWgRows");
      const visible = Array.prototype.filter.call(box.querySelectorAll(".wg-card"), (x) => x.style.display !== "none");
      if (visible.length <= 1) { alert("कम-से-कम एक कार्य-समूह ज़रूरी है।"); return; }
      const wasMain = row.querySelector(".wg-ismain").checked;
      if (row.dataset.id) { row.dataset.removed = "1"; row.style.display = "none"; }
      else row.remove();
      if (wasMain) {   // मुख्य हटा तो पहला बचा समूह मुख्य बना दो
        const first = Array.prototype.find.call(box.querySelectorAll(".wg-card"), (x) => x.style.display !== "none");
        if (first) first.querySelector(".wg-ismain").checked = true;
      }
    });
    return row;
  }
  function renderNeWgRows(est) {
    const box = document.getElementById("neWgRows"); if (!box) return;
    box.innerHTML = "";
    const wgs = est ? neWgData(est) : [];
    if (wgs.length) wgs.forEach((w) => box.appendChild(neWgRow(w)));
    else box.appendChild(neWgRow({ name: "", isMain: true }));   // नया estimate → एक खाली समूह (मुख्य)
  }
  // form के कार्य-समूह cards → est.workGroups + est.rmrs + est.ohGroups
  function applyNeWgRows(est) {
    const cards = Array.prototype.filter.call(document.querySelectorAll("#neWgRows .wg-card"), (c) => !c.dataset.removed);
    const prevRmrs = est.rmrs || [];
    const rmrs = [], ohGroups = [], workGroups = [];
    let anyMain = false;
    cards.forEach((card, i) => {
      const name = wgCardName(card) || ("समूह " + (i + 1));
      const isMain = card.querySelector(".wg-ismain").checked; if (isMain) anyMain = true;
      // inline Query दूरी boxes से qd बनाओ (Query key → km)
      const qd = {};
      card.querySelectorAll(".wg-qd-km").forEach((inp) => { qd[inp.dataset.qk] = (inp.value || "").trim(); });
      const comb = card.querySelector(".wg-mode").value === "comb";
      const rmrId = card.dataset.rmrId || uid("rmr");
      const ohId = card.dataset.ohId || uid("ohg");
      // RMR — मौजूदा rows रखो, दूरियाँ qd से ताज़ा करो; नई हों तो बनाओ
      const prev = prevRmrs.find((r) => r.id === rmrId);
      let rows;
      if (prev && prev.rows && prev.rows.length) {
        rows = prev.rows;
        rows.forEach((r) => {
          const mat = rmrMaterial(r);
          const key = (mat.query || "").trim() || "__noquery__";
          r.query = mat.query || r.query || "";
          const d = qd[key];
          if (d != null && String(d).trim() !== "") r.distance = String(d).trim();
        });
      } else {
        rows = buildRmrRowsWithQueryDist(qd);   // Material Query Rate load न हो तो खाली — RMR view में भरेंगी
      }
      rmrs.push({ id: rmrId, name: name, remark: name, queryDist: qd, rows: rows, locked: prev ? !!prev.locked : false });
      ohGroups.push({
        id: ohId, remark: name, sep: !comb,
        ohPct: mrNum(card.querySelector(".wg-ohpct").value) || 0,
        cpPct: mrNum(card.querySelector(".wg-cppct").value) || 0,
        combPct: mrNum(card.querySelector(".wg-combpct").value) || 0,
      });
      workGroups.push({ id: card.dataset.id || uid("wg"), name: name, isMain: isMain, rmrId: rmrId, ohGroupId: ohId });
    });
    if (!anyMain && workGroups.length) workGroups[0].isMain = true;
    est.rmrs = rmrs;
    est.ohGroups = ohGroups.length ? ohGroups : [Object.assign({ id: uid("ohg"), remark: "" }, OH_DEFAULTS)];
    est.workGroups = workGroups;
  }

  function saveEstimateForm() {
    const wn = document.getElementById("neWorkName").value.trim();
    if (!wn) { alert("कार्य का नाम ज़रूरी है।"); return; }
    // ── कार्य-समूह: Overhead भरा हो, और Query दूरी की जाँच (खाली/0 पर पूछो) ──
    const wgCards = Array.prototype.filter.call(document.querySelectorAll("#neWgRows .wg-card"), (c) => !c.dataset.removed);
    let ohMissing = false, anyDistBox = false, distEmptyOrZero = false;
    for (const card of wgCards) {
      const comb = card.querySelector(".wg-mode").value === "comb";
      const ohSel = comb ? [".wg-combpct"] : [".wg-ohpct", ".wg-cppct"];
      ohSel.forEach((s) => { if ((card.querySelector(s).value || "").trim() === "") ohMissing = true; });
      card.querySelectorAll(".wg-qd-km").forEach((inp) => {
        anyDistBox = true;
        const v = (inp.value || "").trim();
        if (v === "" || mrNum(v) === 0) distEmptyOrZero = true;
      });
    }
    if (ohMissing) { alert("हर कार्य-समूह में Overhead / Contractor Profit % भरें।"); return; }
    if (anyDistBox && distEmptyOrZero &&
        !confirm("कुछ Query की साइट-दूरी खाली या 0 किमी है।\nक्या 0 किमी मानकर estimate बनाना है?")) return;
    const ewRaw = document.getElementById("neEwLead").value.trim();
    const ewN = mrNum(ewRaw);
    const lenVal = document.getElementById("neLength").value.trim();
    const machRaw = document.getElementById("neMachLead").value.trim();
    const fields = {
      name: wn,
      roadCode: document.getElementById("neRoadCode").value.trim(),
      length: lenVal,
      machineryLead: machRaw !== "" ? machRaw : lenVal,   // खाली हो तो प्रस्तावित लंबाई
      year: document.getElementById("neYear").value.trim(),
      ewLead: (ewRaw !== "" && isFinite(ewN) && ewN > 0) ? ewN : 5,
    };
    let est, isNew = false;
    if (editingEstimateId && state.estimates[editingEstimateId]) {
      est = state.estimates[editingEstimateId];
      Object.assign(est, fields);
    } else {
      est = Object.assign({ id: uid("est"), sheetIds: [], createdAt: Date.now() }, fields);
      state.estimates[est.id] = est; state.estOrder.push(est.id); isNew = true;
    }
    setActiveEstimateId(est.id);
    est.bitumenCartage = readNeBitRows();   // Bitumen Cartage विवरण (Refinery + दूरी + Both/One Side)
    est.bitumenLocked = neBitLocked;        // Save/Lock स्थिति सुरक्षित
    // Cover (कवर) विवरण — emblem/design सुरक्षित रखते हुए form-मान merge
    const gvC = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ""; };
    const off = readNeOff();
    est.cover = Object.assign(ensureCover(est), {
      aagType: gvC("neCovAagType") || "प्रारम्भिक आगणन",
      kshetra: gvC("neCovKshetra") || DEF_KSHETRA, vritt: gvC("neCovVritt") || DEF_VRITT, khand: gvC("neCovKhand") || DEF_KHAND,
      vidhanSabha: gvC("neCovVidhan"), lokSabha: gvC("neCovLok"), block: gvC("neCovBlock"),
      srishti: gvC("neCovSrishti"), yojana: gvC("neCovYojana"), totalLen: gvC("neCovTotalLen") || lenVal,
      eeName: off.eeName, aeList: off.aeList, jeList: off.jeList,
      jePraKhand: off.jePraKhand, jePraVritt: off.jePraVritt, seName: off.seName,
    });
    // अधिकारी नाम कार्यालय (खंड/वृत्त) + पद अनुसार Master में सुरक्षित (drop-down हेतु)
    const khOff = est.cover.khand, vrOff = est.cover.vritt;
    addOfficer(khOff, "ee", off.eeName);
    off.aeList.forEach((n) => addOfficer(khOff, "ae", n));
    off.jeList.forEach((n) => addOfficer(khOff, "je", n));
    addOfficer(khOff, "jePra", off.jePraKhand);
    addOfficer(vrOff, "jePra", off.jePraVritt);
    addOfficer(vrOff, "se", off.seName);
    applyNeWgRows(est);   // कार्य-समूह → est.workGroups + est.rmrs + est.ohGroups
    // पहले group के % पुराने single-fields में भी (backward compatibility)
    const g0 = est.ohGroups[0];
    est.ohSep = g0.sep; est.ohPct = g0.ohPct; est.cpPct = g0.cpPct; est.combPct = g0.combPct;
    editingEstimateId = null;
    db.put("estimates", est);
    document.getElementById("newEstimateForm").style.display = "none";
    applyOverheadAll();   // सभी analysis में अपने-अपने group के % से overhead/profit
    scheduleReRate();     // RMR की दूरी बदली हो तो linked analyses की दरें ताज़ा
    renderEstimateSelect(); renderEstimate(); updateTopbarEstimate(); renderEstimateProjectList();
    if (isNew) {
      setActiveView("basic-sheet");   // नया Estimate — Basic Sheet पर
      status("नया Estimate बना: " + est.name + " · Overhead/Profit लागू");
    } else {
      // सुधार — कहीं jump न करें, सिर्फ़ पुष्टि popup
      status("Estimate सुधरा: " + est.name + " · Overhead/Profit लागू");
      alert("✔ सुधार हो गया व सहेज लिया गया है।");
    }
  }
  // सभी estimate की सूची — चुनकर विवरण सुधारें
  function openEditEstimatePicker() {
    if (!state.estOrder.length) { openEstimateForm(null); return; }   // कोई नहीं → नया
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const items = state.estOrder.map((id) => {
      const e = state.estimates[id];
      const meta = [e.roadCode, e.length ? e.length + " km" : "", e.year].filter(Boolean).join(" · ");
      return "<button class='lap-item' data-eid='" + id + "'><span class='lap-nm'>" + escapeHtml(e.name) + "</span>" + (meta ? "<span class='lap-tt'>" + escapeHtml(meta) + "</span>" : "") + "</button>";
    }).join("");
    overlay.innerHTML =
      "<div class='modal pick'>" +
      "<div class='pk-head'><h3>🗂 Estimate चुनें — सुधारने के लिए</h3><button class='pk-x' id='eeClose'>✕</button></div>" +
      "<div class='lap-list'>" + items + "</div></div>";
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelectorAll(".lap-item").forEach((b) => b.addEventListener("click", () => { close(); openEstimateForm(b.dataset.eid); }));
    overlay.querySelector("#eeClose").addEventListener("click", close);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  }

  /* ============== EVENT WIRING ============== */
  function wireGlobal() {
    wireShell();
    wireMaster();
    wireRMR();
    const bns = document.getElementById("btnNewSheet");   // Rate Analysis से "+नई" हटा दिया (केवल Master से Load)
    if (bns) bns.addEventListener("click", () => newSheet({ kind: "working" }));
    const bla = document.getElementById("btnLoadAnalysis");
    if (bla) bla.addEventListener("click", openLoadAnalysisPicker);
    // Project size switcher (Large/Medium/Small) — सभी loaded MoRTH analysis बदलता है
    document.querySelectorAll("#projSizeBar .psb-btn").forEach((b) => b.addEventListener("click", () => setProjectSize(b.dataset.size)));
    updateProjectSizeUI();
    document.getElementById("btnAddRow").addEventListener("click", addRow);
    document.getElementById("btnDelRow").addEventListener("click", delActiveRow);
    document.getElementById("btnAddSubhead").addEventListener("click", addSubhead);
    document.getElementById("btnDelSubhead").addEventListener("click", deleteActiveSubhead);
    { const brl = document.getElementById("btnAddRoyalty"); if (brl) brl.addEventListener("click", toggleRoyaltySection); }
    document.getElementById("btnDelSheet").addEventListener("click", deleteActiveSheet);
    document.getElementById("sheetSearch").addEventListener("input", renderSheetList);

    document.getElementById("sheetNameInput").addEventListener("change", (e) => renameActiveSheet(e.target.value));
    document.getElementById("btnLinkRef").addEventListener("click", openLinkPicker);
    { const b = document.getElementById("btnMasterItem"); if (b) b.addEventListener("click", openMasterPicker); }
    document.getElementById("sheetTitleInput").addEventListener("input", (e) => {
      const s = state.sheets[state.activeSheetId];
      if (s) { s.title = e.target.value; persistSheet(s); }
    });

    // Excel बटन (editor-tools में) → छोटा menu: अपलोड / नमूना डाउनलोड
    document.getElementById("btnSheetExcel").addEventListener("click", (e) => {
      e.stopPropagation();
      const rect = e.currentTarget.getBoundingClientRect();
      showMenu(rect.left, rect.bottom + 4, [
        { label: "⬆  Excel फाइल अपलोड (import)", action: () => document.getElementById("fileXlsx").click() },
        { label: "⬇  नमूना Excel डाउनलोड", action: () => downloadSampleXlsx() },
      ]);
    });

    // Estimate panel अभी हटा है (बाद में सेट होगा) — null-safe wiring
    const estSel = document.getElementById("estimateSelect");
    if (estSel) estSel.addEventListener("change", (e) => { setActiveEstimateId(e.target.value); renderEstimate(); });
    const btnNewEst = document.getElementById("btnNewEstimate");
    if (btnNewEst) btnNewEst.addEventListener("click", newEstimate);

    // formula bar commit
    const fi = document.getElementById("formulaInput");
    fi.addEventListener("focus", () => { const s = state.sheets[state.activeSheetId]; if (s) showRefHL(s, fi.value); }); // editing में links highlight
    fi.addEventListener("input", () => { if (armed && armed.surface === "bar") armed.pointMode = false; const s = state.sheets[state.activeSheetId]; if (s) showRefHL(s, fi.value); }); // हाथ से टाइप → point रुके + links highlight
    fi.addEventListener("blur", () => clearRefHL());
    fi.addEventListener("keydown", (e) => {
      if (armed && armed.surface === "bar") { // cross-sheet edit चल रहा
        if (e.key === "Enter") { e.preventDefault(); commitArmed("down"); }
        else if (e.key === "Escape") { e.preventDefault(); cancelArmed(); }
        return;
      }
      if (e.key === "Enter") {
        const sheet = state.sheets[state.activeSheetId]; if (!sheet) return;
        const { r, c } = state.activeCell;
        userSetCell(sheet, r, c, fi.value);
        renderGrid(); selectCell(r + 1, c); grid.focus();
      }
    });
    // bar-editing में कहीं और focus गया तो formula पक्का कर दो (safety net)
    fi.addEventListener("blur", () => {
      setTimeout(() => {
        if (armed && armed.surface === "bar" && document.activeElement !== fi) commitArmed("stay");
      }, 150);
    });

    // header tools (Excel अपलोड अब editor-tools के ⬆ Excel ▾ menu से)
    document.getElementById("fileXlsx").addEventListener("change", (e) => { if (e.target.files[0]) importXlsx(e.target.files[0]); e.target.value = ""; });
    document.getElementById("btnBackup").addEventListener("click", backupJson);
    document.getElementById("btnRestore").addEventListener("click", () => document.getElementById("fileJson").click());
    const brf = document.getElementById("btnRateRefresh");
    if (brf) brf.addEventListener("click", () => { const res = relinkAnalysisRates(); alert("दर-refresh पूरा:\n" + res.linked + " नए रेट Primary Rate से जुड़े।\n" + res.rerated + " शीट की दरें ताज़ा हुईं।"); });
    const bff = document.getElementById("btnFormatFix");
    if (bff) bff.addEventListener("click", runFormatFix);
    const bce = document.getElementById("btnCloseEstimate");
    if (bce) bce.addEventListener("click", closeActiveEstimate);
    document.getElementById("fileJson").addEventListener("change", (e) => { if (e.target.files[0]) restoreJson(e.target.files[0]); e.target.value = ""; });

    // grid interactions (event delegation)
    grid.setAttribute("tabindex", "0");
    // mouse-drag से range select (और reference-mode में focus न छूटे)
    let dragging = false, dragMoved = false;
    grid.addEventListener("mousedown", (e) => {
      const td = e.target.closest("td[data-r]"); if (!td) return;
      if (e.button !== 0) return;       // right/middle click — मौजूदा चयन न बदलें (context menu संभालेगा)
      if (armed && armed.refExpected()) { e.preventDefault(); return; } // click handler reference डालेगा
      if (armed && armed.surface === "bar") return;                      // click commit करेगा
      const r = +td.dataset.r, c = +td.dataset.c;
      selectCell(r, c);                 // single-cell से शुरू (anchor यहीं)
      dragging = true; dragMoved = false;
    });
    grid.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const td = e.target.closest("td[data-r]"); if (!td) return;
      const r = +td.dataset.r, c = +td.dataset.c;
      if (r !== state.activeCell.r || c !== state.activeCell.c) { extendSelTo(r, c); dragMoved = true; }
    });
    document.addEventListener("mouseup", () => { dragging = false; });
    grid.addEventListener("click", (e) => {
      const td = e.target.closest("td[data-r]"); if (!td) return;
      const r = +td.dataset.r, c = +td.dataset.c;
      if (armed) {
        if (armed.refExpected()) { armedPoint(state.activeSheetId, r, c); return; } // click से reference डालो
        if (armed.surface === "bar") { commitArmed("stay"); return; }                 // अधूरा edit पक्का
      }
      if (dragMoved) { dragMoved = false; return; } // drag-select के बाद click से single न हो
      // सामान्य click पर selection mousedown में हो चुकी
    });
    grid.addEventListener("dblclick", (e) => { const td = e.target.closest("td[data-r]"); if (td) startEdit(+td.dataset.r, +td.dataset.c); });

    // Ctrl+C — चुने cell(s) copy (internal formula-सहित + OS-clipboard TSV)
    grid.addEventListener("copy", (e) => {
      if (!state.activeSheetId) return;
      if (e.target && e.target.tagName === "INPUT") return;   // cell-edit input खुद संभाले
      copyRangeToClip(state.sheets[state.activeSheetId], selRange(), false, e);
    });
    // Ctrl+X — Cut (copy + paste के बाद source साफ़)
    grid.addEventListener("cut", (e) => {
      if (!state.activeSheetId) return;
      if (e.target && e.target.tagName === "INPUT") return;
      copyRangeToClip(state.sheets[state.activeSheetId], selRange(), true, e);
    });
    // Ctrl+V — internal clip हो (App में copy किया) तो formula-सहित; वरना Excel-text plain paste
    grid.addEventListener("paste", (e) => {
      if (!state.activeSheetId) return;
      if (e.target && e.target.tagName === "INPUT") return; // cell-edit input खुद संभाले
      const text = (e.clipboardData || window.clipboardData).getData("text");
      // App के भीतर copy किया block (OS-clipboard वही text) → formula-aware internal paste
      const norm = (t) => String(t == null ? "" : t).replace(/\r\n?/g, "\n").replace(/\n+$/, "");
      if (_clip && (!text || norm(text) === norm(_clip.tsv))) { e.preventDefault(); pasteInternalClip(state.sheets[state.activeSheetId]); return; }
      if (!text) return;
      e.preventDefault();
      pushUndo("sheet");
      const rows = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n").map((rr) => rr.split("\t"));
      const sheet = state.sheets[state.activeSheetId];
      const sr = state.activeCell.r, sc = state.activeCell.c;
      let maxC = sc;
      rows.forEach((cells) => { maxC = Math.max(maxC, sc + cells.length - 1); });
      if (sr + rows.length > sheet.rows) sheet.rows = sr + rows.length;
      if (maxC + 1 > sheet.cols) sheet.cols = maxC + 1;
      rows.forEach((cells, ri) => {
        cells.forEach((raw, ci) => {
          const a = addr(sr + ri, sc + ci), val = String(raw).trim();
          if (val === "") delete sheet.cells[a];
          else if (val[0] === "=") sheet.cells[a] = { f: val };
          else if (isNumeric(val)) sheet.cells[a] = { v: Number(val) };
          else sheet.cells[a] = { v: val };
        });
      });
      ensureLock(sheet);
      persistSheet(sheet);
      buildEngine();
      renderGrid();
      status(rows.length + " पंक्तियाँ paste हुईं");
    });
    setupContextMenu();
    const navDirs = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    grid.addEventListener("keydown", (e) => {
      if (!state.activeSheetId) return;
      const sheet = state.sheets[state.activeSheetId];
      const { r, c } = state.activeCell;
      const ctrl = e.ctrlKey || e.metaKey;

      if (ctrl && (e.key === "z" || e.key === "Z") && !e.shiftKey) { e.preventDefault(); undo(); }        // Ctrl+Z — Undo
      else if (ctrl && ((e.key === "y" || e.key === "Y") || (e.shiftKey && (e.key === "z" || e.key === "Z")))) { e.preventDefault(); redo(); } // Ctrl+Y / Ctrl+Shift+Z — Redo
      else if (ctrl && (e.key === "d" || e.key === "D")) { e.preventDefault(); fillDown(); }  // Ctrl+D — ऊपर वाला नीचे भरो
      else if (e.key in navDirs) {
        e.preventDefault();
        const [dr, dc] = navDirs[e.key];
        if (e.shiftKey) { extendSelTo(r + dr, c + dc); }                                 // Shift+Arrow — चयन बढ़ाओ
        else if (ctrl) { const j = ctrlJump(sheet, r, c, dr, dc); selectCell(j.r, j.c); } // Ctrl+Arrow छलांग
        else selectCell(r + dr, c + dc);
        scrollToActive();
      }
      else if (e.key === "Tab") { e.preventDefault(); selectCell(r, c + (e.shiftKey ? -1 : 1)); scrollToActive(); }
      else if (e.key === "F2") { e.preventDefault(); startEdit(r, c, null, "edit"); }     // F2 = cell के अंदर edit
      else if (e.key === "Enter") { e.preventDefault(); selectCell(r + (e.shiftKey ? -1 : 1), c); scrollToActive(); } // Enter = नीचे
      else if (ctrl && e.key === "Home") { e.preventDefault(); selectCell(0, 0); scrollToActive(); }
      else if (ctrl && e.key === "End") { e.preventDefault(); const lc = lastDataCell(sheet); selectCell(lc.r, lc.c); scrollToActive(); }
      else if (e.key === "Home") { e.preventDefault(); selectCell(r, 0); scrollToActive(); }      // पंक्ति की शुरुआत
      else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        if (hasSelRange()) { clearRange(sheet, selRange()); maybeSyncToMaster(sheet); renderGrid(); }
        else { userSetCell(sheet, r, c, ""); renderGrid(); }
      }
      else if (e.key.length === 1 && !ctrl && !e.altKey) { e.preventDefault(); startEdit(r, c, e.key, "enter"); } // टाइप करते ही edit
    });
  }

  /* ============== BOOT ============== */
  const bootP = (p, s) => { try { if (window.__boot) window.__boot.set(p, s); } catch (e) {} };
  async function boot() {
    wireGlobal();
    bootP(8, "डाटा लोड हो रहा है…");
    await db.open();
    const sheets = await db.getAll("sheets");
    const estimates = await db.getAll("estimates");
    const masterRecs = await db.getAll("master");
    bootP(28, "डाटा लोड हो रहा है…");
    sheets.sort((a, b) => (a.createdOrder || 0) - (b.createdOrder || 0));
    for (const s of sheets) { ensureLock(s); const had = typeof s.kind === "string" && typeof s.group === "string" && typeof s.source === "string"; ensureSheetMeta(s); if (!had) db.put("sheets", s); state.sheets[s.id] = s; state.order.push(s.id); }
    // working copies की source/size/itemKey उनके master से मिला दो (विरासत data के लिए)
    for (const id of state.order) {
      const c = state.sheets[id];
      if (c.kind === "working" && c.masterId && state.sheets[c.masterId]) {
        const m = state.sheets[c.masterId];
        if (c.source !== m.source || c.itemKey !== m.itemKey) { c.source = m.source; c.size = m.size; c.itemKey = m.itemKey; c.itemName = m.itemName; db.put("sheets", c); }
      }
    }
    migrateTakingOutput();   // पुराने Analysis के row 5 (Taking output) में C5 label + D5/E5 format
    for (const e of estimates) { state.estimates[e.id] = e; state.estOrder.push(e.id); }
    // Chapters का cloud-record अलग है — उसे state.master में न डालें, CHAPTERS में लागू करें
    let _chaptersFromCloud = false;
    for (const m of masterRecs) {
      if (m && m.id === CHAPTERS_META_ID) { if (applyChaptersRecord(m)) _chaptersFromCloud = true; continue; }
      if (m && m.id === SETS_META_ID) { if (Array.isArray(m.sets)) analysisSets = m.sets; continue; }
      if (m && m.id === SUMTPL_META_ID) { if (Array.isArray(m.templates)) summaryTemplates = m.templates; continue; }
      if (m && m.id === OFFICERS_META_ID) { if (m.officers) { deptOfficers = m.officers; ensureOfficersStore(); } continue; }
      state.master[m.id] = m;
    }
    // cloud में chapters न हों तो इस browser के localStorage वाले cloud पर seed कर दो
    if (!_chaptersFromCloud) persistChaptersCloud();
    // पुरानी सभी श्रेणियों की rows को स्थायी id दे दो (slip-proof linking के लिए)
    for (const cat in state.master) {
      const m = state.master[cat]; let fixed = false;
      (m.versions || []).forEach((v) => (v.rows || []).forEach((r) => { if (!r.id) { r.id = uid("mrow"); fixed = true; } }));
      if (fixed) db.put("master", m);
    }

    // ── Calculation engine का इंतज़ार — तब तक loading-strip धीरे-धीरे बढ़े (slow download में भी चलता रहे) ──
    const _yield = () => new Promise((res) => setTimeout(res, 20));
    bootP(40, "Calculation engine लोड हो रहा है…");
    let _creep = 40;
    const _creepTimer = setInterval(() => { _creep = Math.min(80, _creep + 0.32); bootP(_creep); }, 200);
    try { await window.__hfReady; } catch (e) {}
    clearInterval(_creepTimer);

    // ── engine तैयार — गणनाएँ (proven क्रम में; overlay के पीछे) ──
    bootP(84, "गणना-मॉडल बन रहा है…"); await _yield();
    buildEngine();
    setEngineStatus();
    migrateFinalRateRows(); // पुराने Analysis में "Rate per Unit" + "Say Rs." (final rate) पंक्तियाँ
    autoLinkMasterRates();  // पुराने analyses के master-रेट cells link (पीला हटे)
    reRateAllAnalyses();    // Primary/RMR दरें cell में भर दो
    bootP(92, "Overhead/Profit व Total अपडेट हो रहे हैं…"); await _yield();
    renderSheetList();
    renderEstimateSelect();
    renderMasterOverview();
    restoreActiveEstimateId();
    updateTopbarEstimate();
    applyOverheadAll();     // Overhead/Profit — active estimate/समूह अनुसार
    renderEstimate();

    // ── सब render — 100% पर overlay हटते ही पूरा डाटा दिखेगा ──
    bootP(97, "तैयार हो रहा है…"); await _yield();
    const firstWorking = state.order.find((id) => state.sheets[id] && state.sheets[id].kind === "working");
    if (firstWorking) { openSheet(firstWorking); } else { clearGrid(); }
    status("तैयार · " + masterSheets().length + " master analysis लोड");
    try { if (window.__boot) window.__boot.done(); } catch (e) {}   // 100% → overlay fade out
  }

  // SheetJS load होने पर engine status दुबारा नहीं चाहिए, पर HF status set कर दें
  window.addEventListener("DOMContentLoaded", () => {
    boot().catch((e) => { console.error(e); status("शुरू करने में दिक्कत: " + e.message); try { if (window.__boot) window.__boot.done(); } catch (x) {} });
  });

})();
