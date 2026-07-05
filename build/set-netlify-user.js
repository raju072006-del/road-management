// ═══════════════════════════════════════════════════════════════
//  Netlify APP_USERS में नया user जोड़ता है — बिना admin को छुए।
//  (मौजूदा APP_USERS पढ़कर उसके आगे नया user जोड़ता है, फिर rebuild)
//
//  ज़रूरत: project root में `.env.local` (git में नहीं जाती) —
//    NETLIFY_AUTH_TOKEN=nfp_xxxxxxxx   (Personal access token)
//    NETLIFY_SITE_ID=xxxxxxxx-xxxx-...  (Netlify: Site configuration → Site ID / API ID)
//    NEW_USER=dataentry:DataPass@123:user:Data Entry   (रूप: username:password:role:नाम)
//
//  Token कहाँ से: https://app.netlify.com/user/applications  (New access token)
//  Site ID कहाँ से: Netlify → आपकी site → Site configuration → General → "Site ID"
//
//  role: admin = सब कुछ (Analysis Check भी); user = Data भर सकता है, Check नहीं।
//  .env.local अधूरा हो तो यह step चुपचाप SKIP हो जाता है।
// ═══════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const PROJ = path.join(__dirname, '..');

function readEnvLocal() {
  const p = path.join(PROJ, '.env.local');
  if (!fs.existsSync(p)) return null;
  const o = {};
  fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m && m[2] && !m[2].startsWith('#')) o[m[1]] = m[2];
  });
  return o;
}

const env = readEnvLocal();
if (!env || !env.NETLIFY_AUTH_TOKEN || !env.NETLIFY_SITE_ID || !env.NEW_USER ||
    env.NETLIFY_AUTH_TOKEN.includes('xxxx')) {
  console.log('[users] .env.local me NETLIFY_AUTH_TOKEN / NETLIFY_SITE_ID / NEW_USER chahiye — SKIP');
  console.log('[users] token: https://app.netlify.com/user/applications  |  NEW_USER roop: username:password:user:Naam');
  process.exit(0);
}

const TOKEN = env.NETLIFY_AUTH_TOKEN, SITE = env.NETLIFY_SITE_ID, NEW = env.NEW_USER.trim();
const H = { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
const API = 'https://api.netlify.com/api/v1';

async function j(url, opt) {
  const r = await fetch(url, opt || { headers: H });
  const t = await r.text();
  let d = null; try { d = t ? JSON.parse(t) : null; } catch (e) {}
  if (!r.ok) { const err = new Error(r.status + ' — ' + t.slice(0, 300)); err.status = r.status; throw err; }
  return d;
}

(async () => {
  const uname = NEW.split(':')[0].toLowerCase();
  const role = NEW.split(':')[2] || 'user';

  // 1. site → account (env vars account-स्तर पर होते हैं)
  const site = await j(API + '/sites/' + SITE, { headers: H });
  const acct = site.account_slug || site.account_id;
  if (!acct) throw new Error('site ka account nahi mila — NETLIFY_SITE_ID jaanchein');

  // 2. मौजूदा APP_USERS पढ़ो (न हो तो खाली)
  let cur = '', exists = false;
  try {
    const ev = await j(API + '/accounts/' + acct + '/env/APP_USERS?site_id=' + SITE, { headers: H });
    const v = (ev.values || []).find((x) => x.context === 'all') || (ev.values || [])[0];
    cur = v ? (v.value || '') : ''; exists = true;
  } catch (e) { if (e.status !== 404) throw e; cur = ''; exists = false; }

  // 3. पहले से हो तो कुछ मत करो
  if (cur.split(';').some((x) => x.trim().toLowerCase().startsWith(uname + ':'))) {
    console.log('[users] "' + uname + '" pehle se APP_USERS me hai — kuch nahi badla');
    return;
  }
  const updated = cur ? (cur.replace(/;+\s*$/, '') + ';' + NEW) : NEW;

  // 4. env सेट/अपडेट करो (admin वाला हिस्सा ज्यों-का-त्यों रहेगा)
  const body = { key: 'APP_USERS', values: [{ value: updated, context: 'all' }] };
  if (exists) {
    await j(API + '/accounts/' + acct + '/env/APP_USERS?site_id=' + SITE, { method: 'PUT', headers: H, body: JSON.stringify(body) });
  } else {
    await j(API + '/accounts/' + acct + '/env?site_id=' + SITE, {
      method: 'POST', headers: H,
      body: JSON.stringify([{ key: 'APP_USERS', scopes: ['builds', 'functions', 'runtime', 'post_processing'], values: [{ value: updated, context: 'all' }] }]),
    });
  }
  console.log('[users] APP_USERS update OK — "' + uname + '" (role: ' + role + ') jud gaya');

  // 5. rebuild — taaki naya env live ho
  try {
    await j(API + '/sites/' + SITE + '/builds', { method: 'POST', headers: H, body: '{}' });
    console.log('[users] Netlify rebuild trigger ho gaya — 1-2 min me live');
  } catch (e) {
    console.log('[users] env set ho gaya; rebuild trigger nahi hua — Netlify pe "Deploys → Trigger deploy" ya git push karein (' + e.message + ')');
  }
})().catch((e) => { console.error('[users] FAIL: ' + e.message); process.exit(1); });
