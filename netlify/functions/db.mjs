// ═══════════════════════════════════════════════════════════════
//  /api/db — Netlify Function
//  Browser-app और Supabase के बीच सुरक्षित पुल:
//   • login/session — passwords Netlify env में रहते हैं, code में नहीं
//   • data ops     — Supabase service_role key सिर्फ़ यहीं (server पर) रहती है
//
//  Netlify → Site configuration → Environment variables में सेट करें:
//   SUPABASE_URL          = https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY  = (service_role secret key)
//   APP_SECRET            = कोई भी लम्बा random वाक्य (token-signing के लिए)
//   APP_USERS             = admin:MeraNayaPass@123:admin:Administrator;user1:Pass1:user:User One
//                           (रूप: user:password:role:नाम — users ';' से अलग करें)
// ═══════════════════════════════════════════════════════════════
import crypto from 'node:crypto';

export const config = { path: '/api/db' };

const BUCKET = 'rms-files';
const env = (k) => process.env[k] || '';

// SUPABASE_URL चाहे कैसे भी paste हुआ हो (/rest/v1 आदि सहित) — सिर्फ़ origin लें
const baseUrl = () => {
  const raw = env('SUPABASE_URL').trim();
  try { return new URL(raw).origin; }
  catch (e) { return raw.replace(/\/+$/, ''); }
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

const envReady = () => !!(env('SUPABASE_URL') && env('SUPABASE_SERVICE_KEY') && env('APP_SECRET') && env('APP_USERS'));

// ── users (APP_USERS env से) ──
function users() {
  const map = {};
  env('APP_USERS').split(';').map(s => s.trim()).filter(Boolean).forEach(row => {
    const parts = row.split(':');
    const [u, p, role, name] = parts;
    if (u && p) map[u.toLowerCase()] = { p, role: role || 'user', name: name || u };
  });
  return map;
}

// ── stateless HMAC tokens ──
const sign = (data) => crypto.createHmac('sha256', env('APP_SECRET')).update(data).digest('base64url');
function makeToken(user, role, name) {
  const payload = Buffer.from(JSON.stringify({ u: user, r: role, n: name, e: Date.now() + 8 * 3600 * 1000 })).toString('base64url');
  return payload + '.' + sign(payload);
}
function checkToken(t) {
  t = String(t || '');
  const i = t.lastIndexOf('.');
  if (i < 1) return null;
  const payload = t.slice(0, i), sig = t.slice(i + 1);
  if (sig !== sign(payload)) return null;
  try {
    const o = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return Date.now() > o.e ? null : o;
  } catch (e) { return null; }
}

// ── Supabase helpers ──
async function sb(pathname, opts = {}) {
  const res = await fetch(baseUrl() + pathname, {
    ...opts,
    headers: {
      'apikey': env('SUPABASE_SERVICE_KEY'),
      'Authorization': 'Bearer ' + env('SUPABASE_SERVICE_KEY'),
      ...(opts.headers || {})
    }
  });
  const text = await res.text();
  if (!res.ok) throw new Error('Supabase ' + res.status + ': ' + text.slice(0, 300));
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { return text; }
}
const rpc = (fn, params) => sb('/rest/v1/rpc/' + fn, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(params || {})
});
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

// Road Estimator के stores — whitelist
const EST_STORES = new Set(['sheets', 'estimates', 'master']);
function estStore(s) {
  s = String(s || '');
  if (!EST_STORES.has(s)) throw new Error('अमान्य estimator store: ' + s);
  return s;
}
const publicUrl = (p) => baseUrl() + '/storage/v1/object/public/' + BUCKET + '/' + encPath(p);
const fileOut = (r) => r ? ({ id: r.id, name: r.name, mime: r.mime, folder: r.folder, created: r.created_at, url: publicUrl(r.path) }) : null;

export default async (req) => {
  // GET = health/mode probe (app इससे local↔cloud mode तय करता है)
  if (req.method === 'GET') {
    return envReady() ? json({ ok: true, cloud: true })
                      : json({ ok: false, cloud: false, error: 'environment variables सेट नहीं हैं' }, 503);
  }
  if (req.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);
  if (!envReady()) return json({ ok: false, error: 'server configured नहीं है' }, 503);

  let body;
  try { body = await req.json(); } catch (e) { return json({ ok: false, error: 'bad json' }, 400); }
  const op = String(body.op || '');
  const a = body.args || {};

  try {
    // ── बिना token वाले ops ──
    if (op === 'login') {
      const u = users()[String(a.user || '').toLowerCase().trim()];
      if (!u || u.p !== String(a.pass || '')) {
        return json({ ok: true, result: { success: false, message: 'गलत यूजर ID या पासवर्ड।' } });
      }
      const uname = String(a.user).trim();
      return json({ ok: true, result: { success: true, token: makeToken(uname, u.role, u.name), role: u.role, name: u.name } });
    }
    if (op === 'session') {
      const o = checkToken(a.token);
      return json({ ok: true, result: o ? { valid: true, role: o.r, name: o.n } : { valid: false } });
    }

    // ── बाक़ी सबके लिए token अनिवार्य ──
    if (!checkToken(body.token)) return json({ ok: false, error: 'unauthorized — दोबारा login करें' }, 401);

    switch (op) {
      // workbook/sheet ops → schema के ss_* RPC functions
      case 'loadAll':     return json({ ok: true, result: (await rpc('ss_get_all', { p_ss: String(a.ss) })) || {} });
      case 'listSS':      return json({ ok: true, result: (await rpc('ss_list_spreadsheets', {})) || [] });
      case 'createSS':    await rpc('ss_create_spreadsheet', { p_id: String(a.id), p_name: String(a.name) }); return json({ ok: true, result: a.id });
      case 'renameSS':    await rpc('ss_rename_spreadsheet', { p_id: String(a.id), p_name: String(a.name) }); return json({ ok: true, result: true });
      case 'deleteSS':    await rpc('ss_delete_spreadsheet', { p_id: String(a.id) }); return json({ ok: true, result: true });
      case 'ensureSheet': await rpc('ss_ensure_sheet', { p_ss: String(a.ss), p_sheet: String(a.sheet) }); return json({ ok: true, result: true });
      case 'deleteSheet': await rpc('ss_delete_sheet', { p_ss: String(a.ss), p_sheet: String(a.sheet) }); return json({ ok: true, result: true });
      case 'renameSheet': await rpc('ss_rename_sheet', { p_ss: String(a.ss), p_old: String(a.old), p_new: String(a.neu) }); return json({ ok: true, result: true });
      case 'appendRow':   return json({ ok: true, result: await rpc('ss_append_row', { p_ss: String(a.ss), p_sheet: String(a.sheet), p_cells: a.cells || [] }) });
      case 'setCells':    await rpc('ss_set_cells', { p_ss: String(a.ss), p_sheet: String(a.sheet), p_row: a.row | 0, p_col: a.col | 0, p_values: a.values || [] }); return json({ ok: true, result: true });
      case 'deleteRow':   await rpc('ss_delete_row', { p_ss: String(a.ss), p_sheet: String(a.sheet), p_row: a.row | 0 }); return json({ ok: true, result: true });
      case 'clearRange':  await rpc('ss_clear_range', { p_ss: String(a.ss), p_sheet: String(a.sheet), p_row: a.row | 0, p_col: a.col | 0, p_nrows: a.nrows | 0, p_ncols: a.ncols | 0 }); return json({ ok: true, result: true });

      // file ops → Supabase Storage + files table
      case 'upload': {
        const id = crypto.randomUUID();
        const name = String(a.name || 'file');
        const mime = String(a.mime || 'application/octet-stream');
        const safe = name.replace(/[\/\\#?%]/g, '_');
        const p = 'f/' + id + '/' + safe;
        const bytes = Buffer.from(String(a.base64 || ''), 'base64');
        await sb('/storage/v1/object/' + BUCKET + '/' + encPath(p), {
          method: 'POST',
          headers: { 'content-type': mime, 'x-upsert': 'true' },
          body: bytes
        });
        await rpc('ss_register_file', { p_id: id, p_path: p, p_name: name, p_folder: String(a.folder || ''), p_mime: mime, p_size: bytes.length });
        return json({ ok: true, result: { id, name, mime, folder: String(a.folder || ''), created: new Date().toISOString(), url: publicUrl(p) } });
      }
      case 'fileRecord': {
        const r = await rpc('ss_file_by_id', { p_id: String(a.id) });
        return json({ ok: true, result: fileOut(r && r.id ? r : null) });
      }
      case 'listFolder': {
        const rows = await sb('/rest/v1/files?folder=eq.' + encodeURIComponent(String(a.folder || '')) + '&order=created_at.desc') || [];
        return json({ ok: true, result: rows.map(fileOut) });
      }
      case 'renameFile':  await rpc('ss_rename_file', { p_id: String(a.id), p_name: String(a.name) }); return json({ ok: true, result: true });
      case 'deleteFile': {
        const p = await rpc('ss_delete_file', { p_id: String(a.id) });
        if (p) await sb('/storage/v1/object/' + BUCKET + '/' + encPath(p), { method: 'DELETE' }).catch(() => {});
        return json({ ok: true, result: true });
      }
      case 'copyFile': {
        const src = await rpc('ss_file_by_id', { p_id: String(a.id) });
        if (!src || !src.id) return json({ ok: false, error: 'file नहीं मिली' }, 404);
        const nid = crypto.randomUUID();
        const name = String(a.name || src.name);
        const safe = name.replace(/[\/\\#?%]/g, '_');
        const dst = 'f/' + nid + '/' + safe;
        await sb('/storage/v1/object/copy', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ bucketId: BUCKET, sourceKey: src.path, destinationKey: dst })
        });
        await rpc('ss_register_file', { p_id: nid, p_path: dst, p_name: name, p_folder: String(a.folder !== undefined ? a.folder : src.folder), p_mime: src.mime || '', p_size: src.size || 0 });
        return json({ ok: true, result: { id: nid, name, mime: src.mime, folder: String(a.folder !== undefined ? a.folder : src.folder), created: new Date().toISOString(), url: publicUrl(dst) } });
      }

      // ── Road Estimator data (est_kv: store/id/data) ──────────
      case 'estAll': {
        const store = estStore(a.store);
        const rows = await sb('/rest/v1/est_kv?store=eq.' + encodeURIComponent(store) + '&select=id,data&order=id') || [];
        return json({ ok: true, result: rows });
      }
      case 'estPut': {
        const store = estStore(a.store);
        await sb('/rest/v1/est_kv', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
          body: JSON.stringify([{ store, id: String(a.id), data: a.data, updated_at: new Date().toISOString() }])
        });
        return json({ ok: true, result: true });
      }
      case 'estBulkPut': {
        const store = estStore(a.store);
        const now = new Date().toISOString();
        const rows = (a.rows || []).map(r => ({ store, id: String(r.id), data: r.data, updated_at: now }));
        if (rows.length) await sb('/rest/v1/est_kv', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
          body: JSON.stringify(rows)
        });
        return json({ ok: true, result: rows.length });
      }
      case 'estStamp':    return json({ ok: true, result: (await rpc('est_stamp', {})) || {} });
      case 'estFetchAll': return json({ ok: true, result: (await rpc('est_all', {})) || {} });
      case 'estDel': {
        const store = estStore(a.store);
        await sb('/rest/v1/est_kv?store=eq.' + encodeURIComponent(store) + '&id=eq.' + encodeURIComponent(String(a.id)), { method: 'DELETE' });
        return json({ ok: true, result: true });
      }
      case 'estClear': {
        const store = estStore(a.store);
        await sb('/rest/v1/est_kv?store=eq.' + encodeURIComponent(store), { method: 'DELETE' });
        return json({ ok: true, result: true });
      }

      default: return json({ ok: false, error: 'अज्ञात op: ' + op }, 400);
    }
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};
