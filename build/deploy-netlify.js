// ═══════════════════════════════════════════════════════════════
//  Netlify direct deploy — तैयार deploy/ folder + /api/db function को
//  सीधे, तुरंत LIVE करता है (Git-build queue का इंतज़ार नहीं;
//  इसलिए site push.bat चलाते ही ~10-30 सेकंड में live हो जाती है)।
//
//  ज़रूरत: प्रोजेक्ट root में `.env.local` (git में नहीं जाती) —
//    NETLIFY_AUTH_TOKEN=nfp_xxxxxxxxxxxxxxxx
//    NETLIFY_SITE_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
//
//  NETLIFY_AUTH_TOKEN कहाँ से:
//    Netlify → अपना avatar (ऊपर-दाएँ) → User settings → Applications
//    → Personal access tokens → "New access token" → नाम दें → copy (nfp_ से शुरू)
//  NETLIFY_SITE_ID कहाँ से:
//    Netlify → अपनी site → Site configuration → General
//    → Site information → "Site ID" (या API ID) copy करें
//
//  दोनों में से कोई भी न हो तो यह step चुपचाप SKIP हो जाता है
//  (तब site सिर्फ़ git push → Netlify auto-deploy से update होगी)।
//
//  नोट: यह CLI deploy पहले से तैयार folder upload करता है — कोई "build" नहीं
//       चलता, इसलिए Netlify के build-minutes/credits बचते हैं।
// ═══════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

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
if (!env || !env.NETLIFY_AUTH_TOKEN || !env.NETLIFY_SITE_ID ||
    env.NETLIFY_AUTH_TOKEN.includes('xxxx') || env.NETLIFY_SITE_ID.includes('xxxx')) {
  console.log('[netlify] .env.local mein NETLIFY_AUTH_TOKEN / NETLIFY_SITE_ID nahin mila - direct deploy SKIP');
  console.log('[netlify] (site sirf git push -> Netlify auto-deploy se update hogi; setup: is file ke upar ke notes)');
  process.exit(0);
}

const ts = new Date().toLocaleString('en-IN');
// npx --yes: netlify-cli pehli baar khud download+cache ho jata hai (global install ki zarurat nahi)
const cmd = [
  'npx', '--yes', 'netlify-cli', 'deploy',
  '--prod',
  '--dir', 'deploy',
  '--functions', 'netlify/functions',
  '--site', env.NETLIFY_SITE_ID,
  '--message', JSON.stringify('push.bat ' + ts)
].join(' ');

console.log('[netlify] direct deploy shuru... (pehli baar netlify-cli download hoga - thoda samay)');
const res = spawnSync(cmd, {
  cwd: PROJ,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, NETLIFY_AUTH_TOKEN: env.NETLIFY_AUTH_TOKEN, NETLIFY_SITE_ID: env.NETLIFY_SITE_ID }
});

if (res.status !== 0) {
  console.error('[netlify] direct deploy FAIL - upar ka message dekhen');
  process.exit(1);
}
console.log('[netlify] Site LIVE ho gayi (direct deploy) ✔');
