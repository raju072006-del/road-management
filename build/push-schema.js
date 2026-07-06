// ═══════════════════════════════════════════════════════════════
//  Supabase schema push — supabase_schema.sql को database पर चलाता है
//  (push.bat इसे अपने-आप चलाता है)
//
//  ज़रूरत: प्रोजेक्ट root में `.env.local` फ़ाइल (git में नहीं जाती) —
//    SUPABASE_ACCESS_TOKEN=sbp_xxxxxxxxxxxxx
//    SUPABASE_PROJECT_REF=abcdefghijklmnop
//
//  Token कहाँ से: https://supabase.com/dashboard/account/tokens
//  Project ref कहाँ से: Supabase dashboard के URL में —
//    https://supabase.com/dashboard/project/<यही-ref>  (Settings → General में भी)
//
//  .env.local न हो तो यह step चुपचाप skip हो जाता है (सिर्फ़ website push होती है)।
//  नोट: schema idempotent है — बार-बार चलाना सुरक्षित है।
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
if (!env || !env.SUPABASE_ACCESS_TOKEN || !env.SUPABASE_PROJECT_REF ||
    env.SUPABASE_ACCESS_TOKEN.includes('xxxx')) {
  console.log('[schema] .env.local nahin mila ya adhura hai - schema push SKIP');
  console.log('[schema] (sirf website push hogi; setup: build\\push-schema.js ke upar ke notes dekhen)');
  process.exit(0);
}

const sql = fs.readFileSync(path.join(PROJ, 'supabase_schema.sql'), 'utf8');

fetch('https://api.supabase.com/v1/projects/' + env.SUPABASE_PROJECT_REF + '/database/query', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ' + env.SUPABASE_ACCESS_TOKEN,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ query: sql })
}).then(async (r) => {
  const t = await r.text();
  if (!r.ok) {
    console.warn('[schema] WARN (' + r.status + '): ' + t.slice(0, 400));
    console.warn('[schema] database structure update nahin hua - lekin site deploy JAARI rahega.');
    process.exit(0);   // schema optional/idempotent hai - deploy ko mat roko
  }
  console.log('[schema] Supabase database update OK');
}).catch((e) => {
  console.warn('[schema] network error: ' + e.message + ' - schema SKIP (site deploy JAARI rahega)');
  process.exit(0);     // network blip par bhi site live hona nahi rukna chahiye
});
