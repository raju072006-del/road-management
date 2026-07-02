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

  /* cloud writes की serial queue — edits तुरंत local save होते हैं,
     cloud में पीछे-पीछे जाते हैं */
  let _cloudQueue = Promise.resolve();
  let _cloudPending = 0;
  let _stampTimer = null;
  function queueCloud(fn) {
    _cloudPending++;
    _cloudQueue = _cloudQueue
      .then(fn)
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
  window.addEventListener("beforeunload", (e) => {
    if (_cloudMode && _cloudPending > 0) {
      e.preventDefault();
      e.returnValue = "डेटा अभी cloud में save हो रहा है — कुछ सेकंड रुकें।";
    }
  });

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
        queueCloud(() => cloudCall("estPut", { store: store, id: String(obj.id), data: snap }));
      }
      return p;
    },
    del(store, id) {
      const p = idb.del(store, id);
      if (_cloudMode) queueCloud(() => cloudCall("estDel", { store: store, id: String(id) }));
      return p;
    },
    clear(store) {
      const p = idb.clear(store);
      if (_cloudMode) queueCloud(() => cloudCall("estClear", { store: store }));
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
    if (hfReady) {
      const sid = hfSheetId(sheet.name);
      if (sid !== undefined) {
        try {
          const v = hf.getCellValue({ sheet: sid, row: r, col: c });
          if (v != null && typeof v === "object" && "type" in v && v.type === "ERROR") return { err: true, val: v.value || "#ERR" };
          return { err: false, val: v == null ? "" : v };
        } catch (e) { /* fall through */ }
      }
    }
    const cell = sheet.cells[addr(r, c)];
    return { err: false, val: cell ? (cell.f != null ? cell.f : cell.v) : "" };
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
    return { cells, merges, rows: r, cols };
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
    const tag = (s.source === "mord" ? "MoRD" : "MoRTH") + ((s.source || "morth") === "morth" && isSize(s.size) ? " · " + sizeName(s.size) : "") + (s.rmrName ? " · RMR: " + s.rmrName : "");
    if (s.kind === "master") {
      el.className = "kind-banner master";
      el.innerHTML = "🗄️ <b>MASTER Analysis</b> [" + escapeHtml(tag) + "] — बदलाव सीधे master library में होंगे। (Chapter: " + escapeHtml(groupName(s.source, s.group)) + ")";
      el.style.display = "";
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

  function persistSheet(sheet) {
    sheet.updatedAt = Date.now();
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
      if (prevMref && raw.trim() !== "") sheet.cells[a].mref = prevMref; // खाली न हो तो link बना रहे
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
      for (const k of ["s", "role", "secName", "mref", "lead", "leadText"]) { if (cell[k] != null) { extra[k] = cell[k]; has = true; } }
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

  /* ===== Analysis subheads (Labour/Machinery/…) — add/delete + section totals ===== */
  // विशेष पंक्तियाँ scan करके ढाँचा लौटाओ
  function analysisScan(sheet) {
    const sections = []; let subRow = -1, grandRow = -1, ohRow = -1, cpRow = -1, ohcpRow = -1, cur = null;
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
    }
    if (cur) sections.push(cur);
    return { sections, subRow, grandRow, ohRow, cpRow, ohcpRow };
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
    if (info.subRow >= 0) {
      const parts = info.sections.filter((s) => s.tot >= 0).map((s) => addr(s.tot, 6));
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
    if (info.grandRow >= 0) {
      const gc = sheet.cells[addr(info.grandRow, 2)]; if (gc) { gc.v = "Total"; gc.role = "grandtot"; }
      putFormula(sheet, info.grandRow, 6, grandParts.length ? "=ROUND(" + grandParts.join("+") + ",2)" : "=0");
    }
    persistSheet(sheet);
    if (hfReady && !_suppressEngine) buildEngine();
  }

  // एक analysis में Overhead/Contractor Profit पंक्तियाँ (ohSettings अनुसार) बना/अपडेट करो
  function applyOverheadToSheet(sheet) {
    if (!sheet || !isStructuredAnalysis(sheet)) return false;
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
    _suppressEngine = true;
    try { for (const id of state.order.slice()) { if (applyOverheadToSheet(state.sheets[id])) n++; } }
    finally { _suppressEngine = false; }
    if (hfReady) buildEngine();
    if (state.activeSheetId) renderGrid();
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
    const host = where === "master" ? document.getElementById("masterEditHost") : rateLayout;
    if (host && editorPanel && editorPanel.parentNode !== host) host.appendChild(editorPanel);
    if (editorPanel) editorPanel.classList.toggle("master-mode", where === "master");
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
    ["sheetTitleInput", "sheetNameInput", "btnAddRow", "btnDelRow", "btnAddSubhead", "btnDelSubhead", "btnDelSheet", "btnSheetExcel", "btnMasterItem", "formulaInput", "btnLinkRef"].forEach((idn) => {
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
        // Rate column (F) में manually भरा (Primary Rate से link नहीं) → हल्का पीला
        if (c === 5 && r >= sheet.lockTop && cell && !cell.mref && (cell.f != null || (cell.v !== "" && cell.v != null))) {
          const dcell = sheet.cells[addr(r, 2)];
          if (!(dcell && dcell.role)) cls += " rate-manual";   // section/total पंक्ति नहीं
        }
        // Lead वाला Quantity cell — computed number की जगह 2-line expression (बिना space)
        let cellHtml = null;
        if (cell && cell.leadText != null) { cls += " lead-cell"; cellHtml = cell.lead ? leadHtml(cell.lead) : escapeHtml(cell.leadText); }
        const styleAttr = cell && cell.s ? " style=\"" + cellStyleCss(cell.s) + "\"" : "";
        const spanAttr = sp ? (sp.cs > 1 ? " colspan='" + sp.cs + "'" : "") + (sp.rs > 1 ? " rowspan='" + sp.rs + "'" : "") : "";
        html += "<td data-r='" + r + "' data-c='" + c + "' class='" + cls.trim() + "'" + spanAttr + styleAttr + ">" + (cellHtml != null ? cellHtml : escapeHtml(fmtCol(cv.val, c))) + "</td>";
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
    state.activeEstimateId = est.id;
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
      state.activeEstimateId = state.estOrder[0] || null;
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
  async function exportEstimateXlsx(est) {
    const ok = await window.__sheetjsReady;
    if (!ok || typeof XLSX === "undefined") { alert("Excel engine (SheetJS) load नहीं हुआ — internet जाँचें।"); return; }
    if (est.sheetIds.length === 0) { alert("पहले कुछ शीट जोड़ें।"); return; }

    const wb = XLSX.utils.book_new();
    const usedNames = {};
    for (const sid of est.sheetIds) {
      const sheet = state.sheets[sid];
      if (!sheet) continue;
      const ws = {};
      let maxR = 0, maxC = 0;
      for (let r = 0; r < sheet.rows; r++) {
        for (let c = 0; c < sheet.cols; c++) {
          const cell = sheet.cells[addr(r, c)];
          if (!cell) continue;
          const ref = XLSX.utils.encode_cell({ r, c });
          if (cell.f != null) {
            const cv = computedValue(sheet, r, c);
            const o = { f: cell.f.replace(/^=/, "") };
            if (cv && !cv.err && typeof cv.val === "number") { o.t = "n"; o.v = cv.val; }
            else if (cv && !cv.err && cv.val !== "") { o.t = "s"; o.v = String(cv.val); }
            else { o.t = "n"; }
            ws[ref] = o;
          } else if (typeof cell.v === "number") ws[ref] = { t: "n", v: cell.v };
          else ws[ref] = { t: "s", v: String(cell.v) };
          maxR = Math.max(maxR, r); maxC = Math.max(maxC, c);
        }
      }
      ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(maxR, 0), c: Math.max(maxC, 0) } });
      // xlsx sheet नाम: max 31 char, special char हटाओ
      let nm = sheet.name.replace(/[\[\]\*\?\/\\:]/g, "_").slice(0, 31);
      let base = nm, k = 2;
      while (usedNames[nm.toLowerCase()]) { nm = base.slice(0, 28) + "_" + k; k++; }
      usedNames[nm.toLowerCase()] = true;
      XLSX.utils.book_append_sheet(wb, ws, nm);
    }
    const fname = safeName(est.name) + "_" + dateStamp() + ".xlsx";
    XLSX.writeFile(wb, fname, { bookType: "xlsx" });
    status("Excel बना: " + fname + "  (शीट-लिंक workbook के अंदर बने रहेंगे)");
  }

  /* ============== 6b. PRINT सभी शीट ============== */
  function printEstimate(est) {
    if (est.sheetIds.length === 0) { alert("पहले कुछ शीट जोड़ें।"); return; }
    const area = document.getElementById("printArea");
    let html = "";
    est.sheetIds.forEach((sid, idx) => {
      const sheet = state.sheets[sid];
      if (!sheet) return;
      html += "<div class='print-sheet'>";
      const ptitle = (sheet.title && sheet.title.trim()) ? sheet.title.trim() : sheet.name;
      html += "<div class='print-title'>" + escapeHtml(ptitle) + "</div>";
      html += "<div class='print-head'><div class='pmeta'><span>आकलन: " + escapeHtml(est.name) + "</span><span>शीट " + (idx + 1) + "/" + est.sheetIds.length + " · " + dateStamp() + "</span></div></div>";
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
    state.activeEstimateId = state.estOrder[0] || null;
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
  function renderSheetList() {
    const list = document.getElementById("sheetList");
    const q = (document.getElementById("sheetSearch").value || "").toLowerCase();
    list.innerHTML = "";
    let shown = 0, working = 0;
    for (const id of state.order) {
      const s = state.sheets[id];
      const isWork = s.kind === "working";
      if (isWork) working++;
      if (!isWork && id !== state.activeSheetId) continue;   // master सिर्फ़ तभी जब वही खुला हो
      if (q && !s.name.toLowerCase().includes(q)) continue;
      const li = document.createElement("li");
      li.className = id === state.activeSheetId ? "active" : "";
      const tag = isWork
        ? (isWorkingCopy(s) ? "<span class='sl-tag copy' title='Master से जुड़ी copy'>🔗 copy</span>" : "")
        : "<span class='sl-tag master' title='Master Analysis — सीधा बदलाव'>🗄️ master</span>";
      const rmrTag = (isWork && s.rmrName) ? "<span class='sl-tag rmr' title='इस RMR से linked'>📦 " + escapeHtml(s.rmrName) + "</span>" : "";
      li.innerHTML = "<span class='dot'></span><span class='nm'>" + escapeHtml(s.name) + "</span>" + tag + rmrTag;
      // formula में reference डालते समय focus न छूटे
      li.addEventListener("mousedown", (e) => { if (armed && armed.refExpected()) e.preventDefault(); });
      li.addEventListener("click", () => {
        if (armed && armed.refExpected()) { handoffToBar(id); return; } // दूसरी शीट से link
        if (armed && armed.surface === "bar") { commitArmed("stay"); }   // अधूरा edit पक्का कर दो
        openSheet(id);
      });
      li.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [
          { label: "✎  नाम बदलें", action: () => renameSheetById(id) },
          { label: "🗑  शीट हटाएँ", action: () => { state.activeSheetId = id; renderSheetList(); renderGrid(); deleteActiveSheet(); }, cls: "danger" },
        ]);
      });
      list.appendChild(li);
      shown++;
    }
    if (shown === 0) {
      const li = document.createElement("li");
      li.className = "muted-row";
      li.innerHTML = q ? "कोई मेल नहीं।" : "अभी कोई Analysis load नहीं — ऊपर <b>📂 Load</b> से Master से लाएँ, या <b>+ नई</b> से खाली बनाएँ।";
      list.appendChild(li);
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
      selectCell(r, c);
      const sheet = state.sheets[state.activeSheetId];
      ensureLock(sheet);
      const items = [];
      items.push({ label: c === 5 ? "🔍  Master से केवल रेट भरें" : "🔍  Master से आइटम (नाम+रेट) जोड़ें", action: () => openMasterPicker() });
      if (c === 4 && !isLockedRow(sheet, r) && !(sheet.cells[addr(r, 2)] || {}).role) {
        items.push({ label: ((sheet.cells[addr(r, 4)] || {}).lead ? "🧮  Lead बदलें" : "🧮  Lead जोड़ें") + " (Value1 × Length/4 + Value2)", action: () => openLeadDialog() });
      }
      items.push({ sep: true });
      if (isLockedRow(sheet, r)) {
        items.push({ label: "🔒 लॉक पंक्ति (header/footer) — insert/delete नहीं", disabled: true });
      } else {
        if (!isSectionRow(sheet, r)) {
          items.push({ label: "⬆  आइटम ऊपर (इसी सेक्शन में)", action: () => moveAnalysisRow(r, -1) });
          items.push({ label: "⬇  आइटम नीचे (इसी सेक्शन में)", action: () => moveAnalysisRow(r, 1) });
          items.push({ sep: true });
        }
        items.push({ label: "⬆  ऊपर नई पंक्ति डालें", action: () => structuralEdit("insRow", r) });
        items.push({ label: "⬇  नीचे नई पंक्ति डालें", action: () => structuralEdit("insRow", r + 1) });
        items.push({ label: "🗑  पंक्ति " + (r + 1) + " हटाएँ", action: () => structuralEdit("delRow", r), cls: "danger" });
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
    ["material_query", "Material (Query)"], ["material_sor", "Material SOR"], ["item_sor", "Item SOR"],
  ];
  function masterItemName(cat, row) {
    if (cat === "item_sor") return (row.itemno ? row.itemno + " — " : "") + (row.desc || "");
    return row.desc || "";
  }
  function masterItemRate(cat, row) {
    if (cat === "material_query") return mrNum(row.query_rate) - mrNum(row.loading); // Final Rate
    return mrNum(row.rate);
  }
  function round2(n) { n = mrNum(n); return Math.round((n + Number.EPSILON) * 100) / 100; } // 2 दशमलव
  // mref का वर्तमान रेट — RMR से जुड़ा हो तो RMR का carted rate; वरना Primary Rate (single/औसत)
  function mrefRateNum(mref) {
    if (mref.rmr) return rmrRateForMat(mref.rmr, mref.matId);   // RMR (Material + Cartage) से
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
        if (cell.mref.field === "name") {
          const row = masterRowById(cell.mref.cat, cell.mref.rowId);
          if (!row) continue; // master row मौजूद नहीं → वैसा ही रहने दो
          const nm = masterItemName(cell.mref.cat, row);
          if (cell.v !== nm) { cell.v = nm; changed = true; }
        } else if (cell.mref.field === "rate") {
          const num = mrefRateNum(cell.mref);   // single या कई items का औसत (2 दशमलव)
          if (num == null) continue;
          if (mrNum(cell.v) !== num) { cell.v = num; changed = true; }
        }
      }
      if (changed) { persistSheet(sheet); touched++; }
    }
    if (touched) { if (hfReady) buildEngine(); if (state.activeSheetId) renderGrid(); }
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
      if (changed) persistSheet(sheet);
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
    const mode = (state.activeCell.c === 5) ? "rate" : "both";   // Rate कॉलम → केवल रेट
    // इस rate-cell में पहले से कोई (single/औसत) link हो तो उसी category + चुने items दिखाओ
    const rcell = sheet.cells[addr(r, 5)];
    const existing = (rcell && rcell.mref && rcell.mref.field === "rate") ? rcell.mref : null;
    const autoCat = existing ? existing.cat : pickerCatForRow(sheet, r);   // section अनुसार category
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const subTxt = mode === "rate"
      ? ("loaded version से item चुनें (एक या कई) — <b>केवल रेट</b> भरेगा (नाम अपरिवर्तित)। कई चुनने पर उनका <b>औसत रेट</b>। रेट Primary Rate से linked रहेगा।" +
         (existing ? "<br>✓ <b>पहले से चुने items (checked) का ही औसत इस cell में है</b> — बदलकर फिर भरें।" : ""))
      : "loaded version से item चुनें — <b>नाम+Unit+Rate</b> भर जाएँगे, Amount=मात्रा×Rate; आप मात्रा भरें।";
    const footer = mode === "rate"
      ? "<div class='pk-foot'><span id='pkSelInfo' class='pk-selinfo'>कोई item नहीं चुना</span><button class='btn' id='pkClose'>बंद</button><button class='btn primary' id='pkFill' disabled>✓ भरें</button></div>"
      : "<div class='row'><button class='btn' id='pkClose'>बंद करें</button></div>";
    overlay.innerHTML =
      "<div class='modal wide'>" +
      "<h3>🔍 Master से " + (mode === "rate" ? "रेट" : "जोड़ें") + " — पंक्ति " + (r + 1) + " में</h3>" +
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
      const rates = rows.map((x) => mrNum(masterItemRate(catEl.value, x)));
      const avg = round2(rates.reduce((a, b) => a + b, 0) / rates.length);
      info.innerHTML = rows.length === 1 ? ("1 चुना · रेट <b>₹" + nf(round2(rates[0])) + "</b>") : (rows.length + " चुने · औसत <b>₹" + nf(avg) + "</b>");
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
          "</span><span class='pk-meta'>" + escapeHtml(row.unit || "") + " · ₹" + nf(round2(masterItemRate(cat, row))) + "</span></label>").join("");
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
        if (rows.length === 1) insertMasterItem(cat, rows[0], "rate"); else insertMasterItemAvg(cat, rows);
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
    "load": "Load Estimate", "basic-sheet": "Basic Sheet", "basic-analysis": "Basic Analysis",
    "rate-analysis": "Rate Analysis", "dom-boq": "DOM & BOQ", "summary": "Summary",
    "master": "Master Data", "master-cat": "Master Data", "master-edit": "Master Data › Analysis Edit",
    "rmr": "Basic Analysis › RMR"
  };
  const VIEW_PARENT = { "master-cat": "master", "master-edit": "master", "rmr": "basic-analysis" }; // sub-page → कौन-सा nav highlight हो
  function setActiveView(name) {
    // editor-panel को सही जगह mount करो (Rate Analysis बनाम Master edit)
    if (name === "rate-analysis") mountEditor("rate");
    else if (name === "master-edit") mountEditor("master");
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + name));
    const navName = VIEW_PARENT[name] || name;
    document.querySelectorAll(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.view === navName));
    const sec = document.getElementById("tbSection");
    if (sec) sec.textContent = VIEW_LABELS[name] || name;
    if (name === "load") renderEstimateProjectList();
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
  function toggleChapterOpen(setObj, key, reRender) { if (setObj.has(key)) setObj.delete(key); else setObj.add(key); reRender(); }
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
          html += "<ul class='ag-list'>";
          for (const s of inG) {
            html += "<li><span class='agi-main'><span class='agi-nm'>" + (s.serial ? "<span class='agi-sn'>" + escapeHtml(s.serial) + "</span>" : "") + escapeHtml(s.name) + "</span>" + (s.title ? "<span class='agi-tt'>" + escapeHtml(s.title) + "</span>" : "") + "</span><span class='agi-acts'>";
            html += "<button class='btn xs primary' data-dload='" + s.id + "'>📂 Load</button>";
            html += "<button class='btn xs' data-dedit='" + s.id + "'>✎ Edit</button>";
            html += "<button class='btn xs' data-dchap='" + s.id + "'>📁 Chapter</button>";
            html += "<button class='btn xs' data-dren='" + s.id + "'>✏ नाम</button>";
            html += "<button class='btn xs danger' data-ddel='" + s.id + "'>🗑</button>";
            html += "</span></li>";
          }
          html += "</ul>";
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
      for (const s of inG) { if (!byKey[s.itemKey]) { byKey[s.itemKey] = { key: s.itemKey, name: s.itemName || s.name, desc: s.title || "", serial: s.serial || "", variants: {} }; items.push(byKey[s.itemKey]); } byKey[s.itemKey].variants[s.size] = s; if (!byKey[s.itemKey].serial && s.serial) byKey[s.itemKey].serial = s.serial; if (!byKey[s.itemKey].desc && s.title) byKey[s.itemKey].desc = s.title; }
      items.sort((a, b) => cmpSerial(a.serial, b.serial, a.name, b.name));
      if (q && items.length === 0) continue;
      const open = q ? true : morthOpen.has(g.key);   // खोज के समय सब खुले
      html += "<div class='analysis-group'>" + chapterHeadHtml(g, items.length, open);
      if (open) {
        if (items.length === 0) html += "<div class='ag-empty muted'>इस chapter में अभी कोई MoRTH item नहीं</div>";
        else {
          html += "<ul class='ag-list'>";
          for (const it of items) {
            html += "<li class='morth-item'><span class='agi-main'><span class='agi-nm'>" + (it.serial ? "<span class='agi-sn'>" + escapeHtml(it.serial) + "</span>" : "") + escapeHtml(it.name) + "</span>";
            if (it.desc && it.desc !== it.name) html += "<span class='agi-tt'>" + escapeHtml(it.desc) + "</span>";
            // size variants
            html += "<span class='size-chips'>";
            for (const sz of SIZES) {
              const v = it.variants[sz.key];
              if (v) html += "<button class='chip has' data-medit='" + v.id + "' title='" + sz.name + " variant edit करें'>✎ " + sz.name + "</button>";
              else html += "<button class='chip add' data-madd='" + it.key + "' data-size='" + sz.key + "' title='" + sz.name + " variant जोड़ें'>+ " + sz.name + "</button>";
            }
            html += "</span></span><span class='agi-acts'>";
            html += "<button class='btn xs primary' data-mload='" + it.key + "' title='मौजूदा project size (" + sizeName(projectSize) + ") में load करें'>📂 Load</button>";
            html += "<button class='btn xs' data-mchap='" + it.key + "'>📁 Chapter</button>";
            html += "<button class='btn xs' data-mren='" + it.key + "'>✏ नाम</button>";
            html += "<button class='btn xs danger' data-mdel='" + it.key + "'>🗑 item</button>";
            html += "</span></li>";
          }
          html += "</ul>";
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
    // MoRTH: इसी item के Large/Medium/Small में स्विच/जोड़ें
    if ((s.source || "morth") === "morth" && s.itemKey) {
      let h = "<span class='me-chips-label'>Size:</span>";
      for (const sz of SIZES) {
        const v = morthVariant(s.itemKey, sz.key);
        if (v) h += "<button class='me-chip" + (v.id === s.id ? " active" : "") + "' data-meedit='" + v.id + "'>" + sz.name + "</button>";
        else h += "<button class='me-chip add' data-meadd='" + s.itemKey + "' data-size='" + sz.key + "'>+ " + sz.name + "</button>";
      }
      chipsEl.innerHTML = h; chipsEl.style.display = "";
    } else { chipsEl.innerHTML = ""; chipsEl.style.display = "none"; }
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
    const base = tpl ? JSON.parse(JSON.stringify(tpl)) : null;
    const itemName = tpl ? (tpl.itemName || tpl.name) : "Item";
    const group = tpl ? chapterKeyOf(tpl) : defaultChapterKey("morth");
    const newName = uniqueName(safeName(itemName + "_" + size));
    let sheet;
    if (base) {
      sheet = base; sheet.id = uid("sht"); sheet.name = newName; sheet.kind = "master";
      sheet.source = "morth"; sheet.size = size; sheet.itemKey = itemKey; sheet.itemName = itemName; sheet.group = group;
      sheet.masterId = null; sheet.syncPref = null; sheet.updatedAt = Date.now();
      state.sheets[sheet.id] = sheet; state.order.push(sheet.id);
      if (hfReady) { try { hf.addSheet(sheet.name); hf.setSheetContent(hfSheetId(sheet.name), sheetMatrix(sheet)); } catch (e) { buildEngine(); } }
      db.put("sheets", sheet);
      renderMorthAnalysis(); openMasterForEdit(sheet.id);
      status(sizeName(size) + " variant जुड़ा (" + itemName + ") — अब इसमें बदलाव करें");
    } else {
      createSheet(newName, itemName, { kind: "master", source: "morth", size: size, itemKey: itemKey, itemName: itemName, group: group });
    }
  }

  // Rate Analysis में किसी master variant की working-copy बनाओ और खोलो
  // material (Query) से linked cells को RMR से link कर दो (carted rate उसी RMR से)
  function repointMaterialToRmr(copy, rmrId) {
    for (const a in copy.cells) {
      const cell = copy.cells[a];
      if (cell && cell.mref && cell.mref.field === "rate" && cell.mref.cat === "material_query" && !Array.isArray(cell.mref.rowIds)) {
        cell.mref = { rmr: rmrId, matId: cell.mref.rowId, field: "rate" };
      }
    }
  }
  function loadAnalysisToWorkspace(masterId) {
    const m = state.sheets[masterId]; if (!m) return;
    const est = state.estimates[state.activeEstimateId];
    const rmrs = (est && est.rmrs) ? est.rmrs : [];
    const groups = est ? estOhGroups(est) : [];
    // पहले RMR पूछो (हो तो), फिर Overhead group (एक से ज़्यादा हों तो)
    const pickRmr = rmrs.length
      ? askChoice("इस Analysis को किस RMR से link करें?\n(Material के carted रेट उसी RMR से आएँगे; RMR का नाम Analysis पर लिखा जाएगा)",
          rmrs.map((r) => ({ label: "🔗 " + r.name + (r.remark ? " — " + r.remark : ""), value: r.id, cls: "primary" })).concat([{ label: "बिना RMR", value: "__none" }]))
      : Promise.resolve("__none");
    pickRmr.then((v) => {
      if (v == null) return;
      const rmrId = v === "__none" ? null : v;
      if (groups.length > 1) {
        askChoice("Overhead व Contractor Profit किस group (Remark) से जोड़ें?",
          groups.map((g) => ({ label: "📊 " + (g.remark || "बिना नाम group") + " — " + ohGroupDesc(g), value: g.id, cls: "primary" }))
        ).then((gid) => { if (gid == null) return; doLoadAnalysis(masterId, rmrId, gid); });
      } else {
        doLoadAnalysis(masterId, rmrId, groups[0] ? groups[0].id : null);
      }
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
    if (rmrId) repointMaterialToRmr(copy, rmrId);
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
    status("Analysis load हुआ" + (rmr ? " · RMR: " + rmr.name : "") + (grp && grp.remark ? " · OH group: " + grp.remark : "") + " — " + copy.name);
  }
  // MoRTH item को मौजूदा project size में load करो (वह size न हो तो उपलब्ध से)
  function loadMorthItem(itemKey) {
    const v = morthVariant(itemKey, projectSize) || morthAnyVariant(itemKey);
    if (!v) return;
    if (v.size !== projectSize) status("इस item का " + sizeName(projectSize) + " variant नहीं — " + sizeName(v.size) + " load किया");
    loadAnalysisToWorkspace(v.id);
  }

  // Rate Analysis का "📂 Load" — पहले source (MoRTH/MoRD), फिर सूची
  function openLoadAnalysisPicker() {
    askChoice("कौन-सा Analysis load करना है?", [
      { label: "🛣️ MoRTH", value: "morth", cls: "primary" },
      { label: "🏘️ MoRD", value: "mord" },
    ]).then((src) => {
      if (!src) return;
      if (src === "mord") { showAnalysisListPicker("mord", null); return; }
      // MoRTH → project size पूछो (default वर्तमान)
      askChoice("कौन-सा project size?", SIZES.map((s) => ({ label: s.name, value: s.key, cls: s.key === projectSize ? "primary" : "" }))).then((sz) => {
        if (!sz) return;
        setProjectSize(sz);                 // global size सेट + पहले से loaded MoRTH भी इसी size में
        showAnalysisListPicker("morth", sz);
      });
    });
  }
  // source-वार सूची modal — चुनने पर copy load
  function showAnalysisListPicker(src, size) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    let listHtml = "";
    if (src === "mord") {
      const all = sourceMasters("mord");
      listHtml = buildPickerGroups(all.map((s) => ({ loadId: s.id, name: s.name, sub: s.title, group: chapterKeyOf(s) })), "mord");
    } else {
      // MoRTH — हर item का दिए size का variant (न हो तो उपलब्ध)
      const items = [];
      const byKey = {};
      for (const s of sourceMasters("morth")) { if (!byKey[s.itemKey]) { byKey[s.itemKey] = { group: chapterKeyOf(s), name: s.itemName || s.name, variants: {} }; } byKey[s.itemKey].variants[s.size] = s; }
      for (const k in byKey) { const it = byKey[k]; const v = it.variants[size] || it.variants.large || it.variants.medium || it.variants.small; if (v) items.push({ loadId: v.id, name: it.name, sub: sizeName(v.size) + (v.size !== size ? " (इस item का " + sizeName(size) + " नहीं)" : ""), group: it.group }); }
      listHtml = buildPickerGroups(items, "morth");
    }
    const title = src === "morth" ? "📂 MoRTH Analysis · " + sizeName(size) : "📂 MoRD Analysis";
    overlay.innerHTML =
      "<div class='modal pick'>" +
      "<div class='pk-head'><h3>" + title + "</h3><button class='pk-x' id='lapClose'>✕</button></div>" +
      "<p class='sub'>चुना हुआ Analysis यहाँ <b>copy</b> बनकर खुलेगा (Master सुरक्षित)। बदलाव पर पूछा जाएगा कि Master में भी डालें या नहीं।</p>" +
      "<input type='search' id='lapSearch' class='search' placeholder='🔍 खोजें…' />" +
      "<div class='lap-list' id='lapList'>" + (listHtml || "<div class='ag-empty muted'>अभी कोई master analysis नहीं — Master Data में बनाएँ।</div>") + "</div>" +
      "</div>";
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    const listEl = overlay.querySelector("#lapList");
    const searchEl = overlay.querySelector("#lapSearch");
    listEl.querySelectorAll(".lap-item").forEach((b) => b.addEventListener("click", () => { close(); loadAnalysisToWorkspace(b.dataset.load); }));
    searchEl.addEventListener("input", () => {
      const q = searchEl.value.trim().toLowerCase();
      listEl.querySelectorAll(".lap-item").forEach((b) => { const nm = b.querySelector(".lap-nm").textContent.toLowerCase(); b.style.display = (!q || nm.includes(q)) ? "" : "none"; });
    });
    overlay.querySelector("#lapClose").addEventListener("click", close);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } });
    searchEl.focus();
  }
  // entries: {loadId, name, sub, group?} — chapterwise समूह में HTML
  function buildPickerGroups(entries, src) {
    let html = "";
    for (const g of chaptersOf(src)) {
      const inG = entries.filter((e) => (e.group || defaultChapterKey(src)) === g.key);
      if (inG.length === 0) continue;
      html += "<div class='lap-group'><div class='lap-gname'>" + escapeHtml(g.name) + "</div>";
      for (const e of inG)
        html += "<button class='lap-item' data-load='" + e.loadId + "'><span class='lap-nm'>" + escapeHtml(e.name) + "</span>" + (e.sub ? "<span class='lap-tt'>" + escapeHtml(e.sub) + "</span>" : "") + "</button>";
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
  }
  function renderEstimateProjectList() {
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
        "</div><div class='ei-meta'>" + escapeHtml(meta || (e.sheetIds.length + " शीट")) + "</div></div><span class='btn xs'>खोलें</span>";
      li.addEventListener("click", () => {
        state.activeEstimateId = id;
        applyOverheadAll();   // इस estimate के Overhead/Profit % सभी analysis पर
        renderEstimateSelect(); renderEstimate(); updateTopbarEstimate();
        setActiveView("rate-analysis");
        status("Estimate खुला: " + e.name);
      });
      ul.appendChild(li);
    }
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
      { key: "rate_km", label: "Rate per km (₹)", w: "140px", num: true } ] },
    material_query: { name: "Material Query Rate", cols: [
      { key: "sn", label: "क्रम", w: "54px", num: true }, { key: "desc", label: "Material Description" },
      { key: "query_name", label: "Query Name", w: "130px" },
      { key: "query_rate", label: "Query Rate", w: "100px", num: true }, { key: "royalty", label: "Royality", w: "90px", num: true },
      { key: "loading", label: "Loading/Unloading", w: "130px", num: true }, { key: "unit", label: "Unit", w: "72px" },
      { key: "final_rate", label: "Final Rate", w: "100px", num: true,
        calc: (r) => { if (r.query_rate == null || String(r.query_rate).trim() === "") return ""; return (mrNum(r.query_rate) - mrNum(r.loading)).toFixed(2); } } ] },
    material_sor: { name: "Material SOR Rate", cols: [
      { key: "sn", label: "क्रम", w: "54px", num: true }, { key: "desc", label: "Material Description" },
      { key: "unit", label: "Unit", w: "90px" }, { key: "rate", label: "SOR Rate", w: "120px", num: true } ] },
    item_sor: { name: "Item SOR Rate", cols: [
      { key: "sn", label: "क्रम", w: "54px", num: true }, { key: "itemno", label: "Item No", w: "90px" },
      { key: "desc", label: "Description" }, { key: "unit", label: "Unit", w: "80px" },
      { key: "rate", label: "SOR Rate", w: "110px", num: true } ] },
  };
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

  function openCategory(cat) { mrCat = cat; mrEditAll = false; mrRowEdit.clear(); mrSearch = ""; const si = document.getElementById("mrSearch"); if (si) si.value = ""; setActiveView("master-cat"); }
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
        shown++;
        const ed = mrRowEditable(r.id);
        html += "<tr" + (ed ? " class='row-edit'" : "") + ">";
        for (const c of def.cols) {
          const isCalc = !!c.calc;
          const val = isCalc ? c.calc(r) : (r[c.key] == null ? "" : String(r[c.key]));
          const cls = ((c.num ? "num" : "") + (isCalc ? " calc" : "")).trim();
          const ro = (isCalc || !ed) ? " readonly" : "";
          html += "<td><input data-i='" + i + "' data-field='" + c.key + "'" + (cls ? " class='" + cls + "'" : "") + ro +
            " value=\"" + escapeHtml(val) + "\" /></td>";
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

  // श्रेणी-विशेष अतिरिक्त UI (अभी: Cartage Calculator)
  function buildMrExtra() {
    const ex = document.getElementById("mrExtra"); if (!ex) return;
    if (mrCat !== "cartage") { ex.innerHTML = ""; return; }
    ex.innerHTML =
      "<div class='panel-card mr-calc'>" +
      "<h3>🚚 Cartage Calculator — इस version के Range से</h3>" +
      "<div class='calc-row'><label>दूरी (km)<input type='text' id='cgKm' placeholder='जैसे 13' /></label>" +
      "<button class='btn sm primary' id='cgCalc'>गणना करें</button></div>" +
      "<div id='cgResult' class='calc-result muted'>दूरी (km) डालकर ‘गणना करें’ दबाएँ।</div></div>";
    const run = () => {
      const ver = mrActiveVersion();
      const res = document.getElementById("cgResult");
      const km = mrNum(document.getElementById("cgKm").value);
      if (!ver || !ver.rows.length) { res.className = "calc-result muted"; res.textContent = "पहले Range data भरें।"; return; }
      if (km <= 0) { res.className = "calc-result muted"; res.textContent = "सही दूरी (km) डालें।"; return; }
      const r = cartageCompute(ver.rows, km);
      let h = "<table class='calc-table'><thead><tr><th>खंड (km)</th><th>लंबाई</th><th>दर/km</th><th>राशि (₹)</th></tr></thead><tbody>";
      r.parts.forEach((p) => { h += "<tr><td>" + nf(p.lower) + "–" + nf(p.upper) + (p.extend ? " *" : "") + "</td><td>" + nf(p.len) + "</td><td>" + nf(p.rate) + "</td><td>" + nf(p.amt) + "</td></tr>"; });
      h += "</tbody></table><div class='calc-total'>कुल Cartage (" + nf(km) + " km) = <b>₹ " + nf(r.total) + "</b></div>";
      if (r.parts.some((p) => p.extend)) h += "<div class='calc-note'>* आख़िरी slab की दर इससे आगे भी लागू मानी गई।</div>";
      res.className = "calc-result"; res.innerHTML = h;
    };
    const btn = document.getElementById("cgCalc"); if (btn) btn.addEventListener("click", run);
    const inp = document.getElementById("cgKm"); if (inp) inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); run(); } });
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
      while (row) { const cell = row.children[idx]; const x = cell && cell.querySelector("input[data-field]"); if (x) { ti = x; break; } row = dRow < 0 ? row.previousElementSibling : row.nextElementSibling; }
    } else {
      let cell = dCol < 0 ? td.previousElementSibling : td.nextElementSibling;
      while (cell) { const x = cell.querySelector ? cell.querySelector("input[data-field]") : null; if (x) { ti = x; break; } cell = dCol < 0 ? cell.previousElementSibling : cell.nextElementSibling; }
    }
    if (ti) { ti.focus(); const pos = caret === "start" ? 0 : ti.value.length; try { ti.setSelectionRange(pos, pos); } catch (e) {} }
  }

  function wireMrTable(tb) {
    tb.querySelectorAll("input[data-field]").forEach((inp) => {
      inp.addEventListener("input", () => {
        const v = mrActiveVersion(); if (!v) return;
        const i = +inp.dataset.i, row = v.rows[i];
        row[inp.dataset.field] = inp.value;
        // computed (calc) columns उसी पंक्ति में तुरंत अपडेट
        const def = catDef(mrCat);
        if (def.cols.some((c) => c.calc)) {
          const tr = inp.closest("tr");
          def.cols.forEach((c) => { if (c.calc && tr) { const ci = tr.querySelector("input[data-field='" + c.key + "']"); if (ci) ci.value = c.calc(row); } });
        }
        saveMachine();
      });
      inp.addEventListener("paste", (e) => mrPasteBlock(inp, e));
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
      saveMachine(); renderMachineRate();
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
      else if (b.dataset.mload) loadMorthItem(b.dataset.mload);
      else if (b.dataset.mchap) changeMorthChapter(b.dataset.mchap);
      else if (b.dataset.mren) renameMorthItem(b.dataset.mren);
      else if (b.dataset.mdel) deleteMorthItem(b.dataset.mdel);
    });
    // MoRD container — per-sheet action बटन (delegation)
    const md = document.getElementById("mordAnalysisGroups");
    if (md) md.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.chaptoggle) toggleChapterOpen(mordOpen, b.dataset.chaptoggle, renderMordAnalysis);
      else if (b.dataset.chapedit) renameChapter("mord", b.dataset.chapedit);
      else if (b.dataset.chapdel) deleteChapter("mord", b.dataset.chapdel);
      else if (b.dataset.dload) loadAnalysisToWorkspace(b.dataset.dload);
      else if (b.dataset.dedit) editMasterAnalysis(b.dataset.dedit);
      else if (b.dataset.dchap) changeMordChapter(b.dataset.dchap);
      else if (b.dataset.dren) renameMordSheet(b.dataset.dren);
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
    const m = state.master[cat];
    if (!m || !m.loadedVersion) return null;
    const v = m.versions.find((x) => x.date === m.loadedVersion);
    return v ? v.rows : null;
  }
  function rmrCartage(distance) {
    const km = mrNum(distance);
    if (km <= 0) return 0;
    const rows = loadedVersionRows("cartage");
    return rows ? cartageCompute(rows, km).total : 0;
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

  function createRMR() {
    const est = state.estimates[state.activeEstimateId];
    if (!est) { alert("पहले Load Estimate से कोई estimate खोलें/बनाएँ।"); return; }
    const matRows = loadedVersionRows("material_query");
    if (!matRows || !matRows.length) { alert("पहले Master Data → Material Query Rate में कोई version Load करें (उसी से material आएँगे)।"); return; }
    if (!est.rmrs) est.rmrs = [];
    const rows = buildRmrRowsFromMaster("");
    let name = "RMR" + (est.rmrs.length + 1);
    if (est.rmrs.length >= 1) {   // एक से ज़्यादा → नाम पूछो
      const nm = prompt("नए RMR का नाम (जैसे किस source/खदान का):", name);
      if (nm === null) return;
      name = nm.trim() || name;
    }
    const rmr = { id: uid("rmr"), name: name, rows };
    est.rmrs.push(rmr); rmrActiveId = rmr.id;
    db.put("estimates", est);
    renderRMR();
    status(rmr.name + " बना — " + rows.length + " material; अब दूरी (km) भरें");
  }

  function renderRMR() {
    const est = state.estimates[state.activeEstimateId];
    const sub = document.getElementById("rmrSub");
    const tbar = document.getElementById("rmrToolbar");
    const tb = document.getElementById("rmrTable");
    if (!tb) return;
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
      rmr.rows = buildRmrRowsFromMaster(rmr.siteDist == null ? "" : rmr.siteDist);
      if (rmr.rows.length) db.put("estimates", est);
    }
    if (sub && rmr && rmr.remark) sub.textContent = est.name + " · " + rmr.name + ": " + rmr.remark;

    // toolbar — RMR chips + actions
    if (tbar) {
      let h = "<div class='rmr-list'>";
      est.rmrs.forEach((r) => { h += "<button class='rmr-chip" + (r.id === rmrActiveId ? " active" : "") + "' data-rmr='" + r.id + "' title=\"" + escapeHtml(r.remark || "") + "\">" + escapeHtml(r.name) + "</button>"; });
      h += "<button class='btn sm primary' id='rmrNew'>+ नया RMR</button>";
      if (rmr) h += "<button class='btn sm' id='rmrRename'>✎ नाम</button><button class='btn sm danger' id='rmrDel'>🗑 हटाएँ</button>";
      h += "</div>";
      tbar.innerHTML = h;
      tbar.querySelectorAll("[data-rmr]").forEach((b) => b.addEventListener("click", () => { rmrActiveId = b.dataset.rmr; renderRMR(); }));
      const nw = document.getElementById("rmrNew"); if (nw) nw.addEventListener("click", createRMR);
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

    let html = "<thead><tr>" +
      "<th style='width:50px'>क्रम</th><th>Material का नाम</th><th style='width:130px'>Query का नाम</th>" +
      "<th style='width:96px'>दूरी (km)</th><th style='width:104px'>Material Rate</th>" +
      "<th style='width:104px'>Cartage Rate</th><th style='width:96px'>Royalty (−)</th>" +
      "<th style='width:150px'>Total Rate Incl. Cartage</th></tr></thead><tbody>";
    rmr.rows.forEach((row, i) => {
      const mat = rmrMaterial(row);
      const cartage = rmrCartage(row.distance);
      const total = mat.matRate - mat.royalty + cartage; // Material Rate − Royalty + Cartage
      html += "<tr>" +
        "<td><input class='num' readonly value='" + (i + 1) + "' /></td>" +
        "<td><input readonly value=\"" + escapeHtml(mat.material) + "\" /></td>" +
        "<td><input readonly value=\"" + escapeHtml(mat.query) + "\" /></td>" +
        "<td><input class='num' data-i='" + i + "' value=\"" + escapeHtml(row.distance == null ? "" : String(row.distance)) + "\" /></td>" +
        "<td><input class='num' readonly value=\"" + nf(mat.matRate) + "\" /></td>" +
        "<td><input class='num calc' readonly value=\"" + (mrNum(row.distance) > 0 ? nf(cartage) : "") + "\" /></td>" +
        "<td><input class='num' readonly value=\"" + (mat.royalty ? nf(mat.royalty) : "") + "\" /></td>" +
        "<td><input class='num calc' readonly value=\"" + nf(total) + "\" /></td>" +
        "</tr>";
    });
    html += "</tbody>";
    tb.innerHTML = html;
    // दूरी edit → cartage+total live
    tb.querySelectorAll("input[data-i]").forEach((inp) => {
      inp.addEventListener("input", () => {
        const i = +inp.dataset.i; rmr.rows[i].distance = inp.value;
        const tr = inp.closest("tr"), cells = tr.querySelectorAll("input.calc");
        const mat = rmrMaterial(rmr.rows[i]);
        const cartage = rmrCartage(inp.value), total = mat.matRate - mat.royalty + cartage;
        if (cells[0]) cells[0].value = mrNum(inp.value) > 0 ? nf(cartage) : "";
        if (cells[1]) cells[1].value = nf(total);
        db.put("estimates", est);
        scheduleReRate();   // इस RMR से linked analyses की दरें भी ताज़ा
      });
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === "ArrowDown") { e.preventDefault(); const n = tb.querySelector("input[data-i='" + (+inp.dataset.i + 1) + "']"); if (n) { n.focus(); n.select(); } } else if (e.key === "ArrowUp") { e.preventDefault(); const p = tb.querySelector("input[data-i='" + (+inp.dataset.i - 1) + "']"); if (p) { p.focus(); p.select(); } } });
    });
  }

  function wireRMR() {
    const open = document.getElementById("openRMR");
    if (open) open.addEventListener("click", openRMRView);
    const back = document.getElementById("rmrBack");
    if (back) back.addEventListener("click", () => setActiveView("basic-analysis"));
  }

  function wireShell() {
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
    // "+ और RMR" / "+ group" — linear row जोड़ो
    const rmrAdd = document.getElementById("neRmrAdd");
    if (rmrAdd) rmrAdd.addEventListener("click", () => {
      const box = document.getElementById("neRmrRows");
      const n = box.querySelectorAll(".lin-row").length + 1;
      box.appendChild(neRmrRow({ name: "RMR" + n }));
    });
    const ohAdd = document.getElementById("neOhAdd");
    if (ohAdd) ohAdd.addEventListener("click", () => document.getElementById("neOhRows").appendChild(neOhRow(null)));
    const neCreate = document.getElementById("neCreate");
    if (neCreate) neCreate.addEventListener("click", saveEstimateForm);
    setActiveView("rate-analysis"); // डिफ़ॉल्ट view
  }

  let editingEstimateId = null;
  // form खोलो — estId दिया तो edit (pre-fill), वरना नया
  function openEstimateForm(estId) {
    editingEstimateId = estId || null;
    const est = estId ? state.estimates[estId] : null;
    const setV = (id, v) => { const el = document.getElementById(id); if (el) el.value = v == null ? "" : String(v); };
    setV("neWorkName", est ? est.name : "");
    setV("neRoadCode", est ? est.roadCode : "");
    setV("neLength", est ? est.length : "");
    setV("neEwLead", est ? (est.ewLead != null ? est.ewLead : 1) : "1.00");
    setV("neYear", est ? est.year : "");
    renderNeRmrRows(est);
    renderNeOhRows(est);
    const h = document.querySelector("#newEstimateForm h3"); if (h) h.textContent = est ? ("Estimate सुधारें — " + est.name) : "नए Estimate का विवरण";
    const okb = document.getElementById("neCreate"); if (okb) okb.textContent = est ? "सुधार सहेजें" : "Estimate बनाएँ";
    document.getElementById("newEstimateForm").style.display = "block";
    document.getElementById("neWorkName").focus();
  }
  /* --- Estimate form: RMR व Overhead-group की linear rows --- */
  function neRmrRow(data) {
    data = data || {};
    const row = document.createElement("div");
    row.className = "lin-row";
    if (data.id) row.dataset.id = data.id;
    row.innerHTML =
      "<label>RMR का नाम<input class='lr-name' placeholder='जैसे: RMR1' /></label>" +
      "<label>Site से Query की दूरी (km)<input class='lr-km' placeholder='जैसे: 12.5' /></label>" +
      "<label class='grow'>Remark (source/खदान)<input class='lr-remark' placeholder='जैसे: पत्थर खदान — ग्राम अमुक' /></label>" +
      "<button type='button' class='lr-x' title='यह RMR हटाएँ'>✕</button>";
    row.querySelector(".lr-name").value = data.name || "";
    row.querySelector(".lr-km").value = data.siteDist == null ? "" : data.siteDist;
    row.querySelector(".lr-remark").value = data.remark || "";
    row.querySelector(".lr-x").addEventListener("click", () => {
      // पहले से saved RMR → save पर हटेगा; नई row → तुरंत हटाओ
      if (row.dataset.id) { row.dataset.removed = "1"; row.style.display = "none"; }
      else row.remove();
    });
    return row;
  }
  function renderNeRmrRows(est) {
    const box = document.getElementById("neRmrRows"); if (!box) return;
    box.innerHTML = "";
    const rmrs = (est && est.rmrs) ? est.rmrs : [];
    rmrs.forEach((r) => box.appendChild(neRmrRow(r)));
    if (!rmrs.length) box.appendChild(neRmrRow({ name: "RMR1" }));
  }
  function neOhRow(g) {
    g = g || {};
    const row = document.createElement("div");
    row.className = "lin-row";
    if (g.id) row.dataset.gid = g.id;
    row.innerHTML =
      "<label class='grow'>Remark (group का नाम)<input class='lr-remark' placeholder='जैसे: Road Work' /></label>" +
      "<label>प्रकार<select class='lr-mode'><option value='sep'>अलग-अलग</option><option value='comb'>एक साथ</option></select></label>" +
      "<label class='lr-f-oh'>Overhead %<input class='lr-ohpct' /></label>" +
      "<label class='lr-f-cp'>Contractor Profit %<input class='lr-cppct' /></label>" +
      "<label class='lr-f-comb'>Overhead+Profit %<input class='lr-combpct' /></label>" +
      "<button type='button' class='lr-x' title='यह group हटाएँ'>✕</button>";
    row.querySelector(".lr-remark").value = g.remark || "";
    row.querySelector(".lr-mode").value = g.sep === false ? "comb" : "sep";
    row.querySelector(".lr-ohpct").value = g.ohPct != null ? g.ohPct : OH_DEFAULTS.ohPct;
    row.querySelector(".lr-cppct").value = g.cpPct != null ? g.cpPct : OH_DEFAULTS.cpPct;
    row.querySelector(".lr-combpct").value = g.combPct != null ? g.combPct : OH_DEFAULTS.combPct;
    const sync = () => {
      const comb = row.querySelector(".lr-mode").value === "comb";
      row.querySelector(".lr-f-oh").style.display = comb ? "none" : "";
      row.querySelector(".lr-f-cp").style.display = comb ? "none" : "";
      row.querySelector(".lr-f-comb").style.display = comb ? "" : "none";
    };
    row.querySelector(".lr-mode").addEventListener("change", sync);
    sync();
    row.querySelector(".lr-x").addEventListener("click", () => {
      const box = document.getElementById("neOhRows");
      const visible = Array.prototype.filter.call(box.querySelectorAll(".lin-row"), (x) => x.style.display !== "none");
      if (visible.length <= 1) { alert("कम-से-कम एक Overhead group ज़रूरी है।"); return; }
      row.remove();
    });
    return row;
  }
  function renderNeOhRows(est) {
    const box = document.getElementById("neOhRows"); if (!box) return;
    box.innerHTML = "";
    const gs = est ? estOhGroups(est) : [Object.assign({ remark: "" }, OH_DEFAULTS)];
    gs.forEach((g) => box.appendChild(neOhRow(g)));
  }
  // form की RMR rows → estimate के rmrs में बनाओ/सुधारो/हटाओ
  function applyNeRmrRows(est) {
    if (!est.rmrs) est.rmrs = [];
    const removed = new Set();
    document.querySelectorAll("#neRmrRows .lin-row").forEach((row) => {
      const id = row.dataset.id || "";
      if (row.dataset.removed) { if (id) removed.add(id); return; }
      const nm = row.querySelector(".lr-name").value.trim();
      const kmRaw = row.querySelector(".lr-km").value.trim();
      const remark = row.querySelector(".lr-remark").value.trim();
      if (id) {
        const rmr = est.rmrs.find((x) => x.id === id); if (!rmr) return;
        if (nm) rmr.name = nm;
        rmr.remark = remark;
        if (kmRaw !== "" && kmRaw !== String(rmr.siteDist == null ? "" : rmr.siteDist)) {
          rmr.siteDist = kmRaw;
          (rmr.rows || []).forEach((r) => { r.distance = kmRaw; });   // सभी material पर यही दूरी
        } else if (kmRaw !== "") {
          rmr.siteDist = kmRaw;
        }
      } else {
        if (kmRaw === "" && !remark) return;   // पूरी खाली row — कुछ नहीं बनाना
        est.rmrs.push({
          id: uid("rmr"),
          name: nm || ("RMR" + (est.rmrs.length + 1)),
          remark: remark, siteDist: kmRaw,
          rows: buildRmrRowsFromMaster(kmRaw),   // Material Query Rate load न हो तो खाली — RMR view में अपने-आप भरेंगी
        });
      }
    });
    if (removed.size) est.rmrs = est.rmrs.filter((r) => !removed.has(r.id));
  }

  function saveEstimateForm() {
    const wn = document.getElementById("neWorkName").value.trim();
    if (!wn) { alert("कार्य का नाम ज़रूरी है।"); return; }
    const ewRaw = document.getElementById("neEwLead").value.trim();
    const ewN = mrNum(ewRaw);
    // Overhead groups (linear rows) — कम-से-कम एक
    const groups = [];
    document.querySelectorAll("#neOhRows .lin-row").forEach((row) => {
      if (row.style.display === "none") return;
      const comb = row.querySelector(".lr-mode").value === "comb";
      groups.push({
        id: row.dataset.gid || uid("ohg"),
        remark: row.querySelector(".lr-remark").value.trim(),
        sep: !comb,
        ohPct: mrNum(row.querySelector(".lr-ohpct").value) || 0,
        cpPct: mrNum(row.querySelector(".lr-cppct").value) || 0,
        combPct: mrNum(row.querySelector(".lr-combpct").value) || 0,
      });
    });
    if (!groups.length) groups.push(Object.assign({ id: uid("ohg"), remark: "" }, OH_DEFAULTS));
    const fields = {
      name: wn,
      roadCode: document.getElementById("neRoadCode").value.trim(),
      length: document.getElementById("neLength").value.trim(),
      year: document.getElementById("neYear").value.trim(),
      ewLead: (ewRaw !== "" && isFinite(ewN) && ewN > 0) ? ewN : 1,
      ohGroups: groups,
      // पहले group के % पुराने single-fields में भी (backward compatibility)
      ohSep: groups[0].sep, ohPct: groups[0].ohPct, cpPct: groups[0].cpPct, combPct: groups[0].combPct,
    };
    let est, isNew = false;
    if (editingEstimateId && state.estimates[editingEstimateId]) {
      est = state.estimates[editingEstimateId];
      Object.assign(est, fields);
    } else {
      est = Object.assign({ id: uid("est"), sheetIds: [], createdAt: Date.now() }, fields);
      state.estimates[est.id] = est; state.estOrder.push(est.id); isNew = true;
    }
    state.activeEstimateId = est.id;
    applyNeRmrRows(est);   // form की RMR rows लागू करो
    editingEstimateId = null;
    db.put("estimates", est);
    document.getElementById("newEstimateForm").style.display = "none";
    applyOverheadAll();   // सभी analysis में अपने-अपने group के % से overhead/profit
    scheduleReRate();     // RMR की दूरी बदली हो तो linked analyses की दरें ताज़ा
    renderEstimateSelect(); renderEstimate(); updateTopbarEstimate(); renderEstimateProjectList();
    setActiveView("rate-analysis");
    status((isNew ? "नया Estimate बना: " : "Estimate सुधरा: ") + est.name + " · Overhead/Profit लागू");
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
    document.getElementById("btnNewSheet").addEventListener("click", () => newSheet({ kind: "working" }));
    const bla = document.getElementById("btnLoadAnalysis");
    if (bla) bla.addEventListener("click", openLoadAnalysisPicker);
    // Project size switcher (Large/Medium/Small) — सभी loaded MoRTH analysis बदलता है
    document.querySelectorAll("#projSizeBar .psb-btn").forEach((b) => b.addEventListener("click", () => setProjectSize(b.dataset.size)));
    updateProjectSizeUI();
    document.getElementById("btnAddRow").addEventListener("click", addRow);
    document.getElementById("btnDelRow").addEventListener("click", delActiveRow);
    document.getElementById("btnAddSubhead").addEventListener("click", addSubhead);
    document.getElementById("btnDelSubhead").addEventListener("click", deleteActiveSubhead);
    document.getElementById("btnDelSheet").addEventListener("click", deleteActiveSheet);
    document.getElementById("sheetSearch").addEventListener("input", renderSheetList);

    document.getElementById("sheetNameInput").addEventListener("change", (e) => renameActiveSheet(e.target.value));
    document.getElementById("btnLinkRef").addEventListener("click", openLinkPicker);
    document.getElementById("btnMasterItem").addEventListener("click", openMasterPicker);
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
    if (estSel) estSel.addEventListener("change", (e) => { state.activeEstimateId = e.target.value; renderEstimate(); });
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
    document.getElementById("fileJson").addEventListener("change", (e) => { if (e.target.files[0]) restoreJson(e.target.files[0]); e.target.value = ""; });

    // grid interactions (event delegation)
    grid.setAttribute("tabindex", "0");
    // mouse-drag से range select (और reference-mode में focus न छूटे)
    let dragging = false, dragMoved = false;
    grid.addEventListener("mousedown", (e) => {
      const td = e.target.closest("td[data-r]"); if (!td) return;
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

    // Excel से copy किया block (tab+newline) सेलेक्टेड cell से paste → कई पंक्तियाँ/कॉलम भर दो
    grid.addEventListener("paste", (e) => {
      if (!state.activeSheetId) return;
      if (e.target && e.target.tagName === "INPUT") return; // cell-edit input खुद संभाले
      const text = (e.clipboardData || window.clipboardData).getData("text");
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
  async function boot() {
    wireGlobal();
    await db.open();
    const sheets = await db.getAll("sheets");
    const estimates = await db.getAll("estimates");
    const masterRecs = await db.getAll("master");
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
    for (const e of estimates) { state.estimates[e.id] = e; state.estOrder.push(e.id); }
    // Chapters का cloud-record अलग है — उसे state.master में न डालें, CHAPTERS में लागू करें
    let _chaptersFromCloud = false;
    for (const m of masterRecs) {
      if (m && m.id === CHAPTERS_META_ID) { if (applyChaptersRecord(m)) _chaptersFromCloud = true; continue; }
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

    buildEngine();
    setEngineStatus();
    autoLinkMasterRates();  // पुराने analyses के correct master-रेट cells को link कर दो (पीला हटे)
    reRateAllAnalyses();    // Primary Rate से जुड़े analyses को loaded दरों पर ताज़ा कर दो

    renderSheetList();
    renderEstimateSelect();
    state.activeEstimateId = state.estOrder[0] || null;
    applyOverheadAll();     // active estimate (या default 10/10) के अनुसार Overhead/Profit — पुराने भी अपडेट
    renderEstimate();

    // Rate Analysis में पहले से load किया (working) analysis हो तो खोलो; वरना खाली रहने दो
    const firstWorking = state.order.find((id) => state.sheets[id] && state.sheets[id].kind === "working");
    if (firstWorking) { openSheet(firstWorking); }
    else { clearGrid(); }

    status("तैयार · " + masterSheets().length + " master analysis लोड");
  }

  // SheetJS load होने पर engine status दुबारा नहीं चाहिए, पर HF status set कर दें
  window.addEventListener("DOMContentLoaded", () => {
    boot().catch((e) => { console.error(e); status("शुरू करने में दिक्कत: " + e.message); });
  });

})();
