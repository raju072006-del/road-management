// ═══════════════════════════════════════════════════════════════
//  Road Management — single-file app builder
//  चलाएँ:  node build\build-local.js   (या deploy.bat double-click)
//
//  क्या करता है:
//  1. Dashboard.html + Payment.html + Code.gs + build\*.js को जोड़कर
//     "Road Management.html" (एक-फ़ाइल app) बनाता है
//  2. deploy\ फ़ोल्डर ताज़ा करता है (index.html + Road Estimater)
//     — यही फ़ोल्डर hosting (Netlify/cPanel) पर जाता है
// ═══════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

const PROJ = path.join(__dirname, '..');     // प्रोजेक्ट root
const HERE = __dirname;                       // build folder

const dash     = fs.readFileSync(path.join(PROJ, 'Dashboard.html'), 'utf8');
const pay      = fs.readFileSync(path.join(PROJ, 'Payment.html'), 'utf8');
const codegs   = fs.readFileSync(path.join(PROJ, 'Code.gs'), 'utf8');
const platform = fs.readFileSync(path.join(HERE, 'platform-server.js'), 'utf8');
const bridge   = fs.readFileSync(path.join(HERE, 'payment-bridge.js'), 'utf8');
const boot     = fs.readFileSync(path.join(HERE, 'boot-client.js'), 'utf8');

// JS-string escape जो <script> block में 100% सुरक्षित हो
const LS = String.fromCharCode(8232);  // U+2028
const PS = String.fromCharCode(8233);  // U+2029
const esc = (s) => JSON.stringify(s)
  .split('<').join('\\u003c')
  .split(LS).join('\\u2028')
  .split(PS).join('\\u2029');

for (const [name, src] of [['bridge', bridge], ['boot', boot], ['platform', platform], ['Code.gs', codegs]]) {
  if (src.toLowerCase().indexOf('</' + 'script') !== -1) throw new Error(name + ' में raw close-tag है!');
}

const SO = '<' + 'script>';
const SC = '<' + '/script>';

// Payment.html में bridge inject (page-scripts से पहले)
const payLocal = pay.replace(/<head>/i, '<head>\n' + SO + '\n' + bridge + '\n' + SC);

// मुख्य पेज में boot inject (<body> के तुरंत बाद)
const injected =
  '\n' + SO + '\n' +
  'window.__SRC_PLATFORM__ = ' + esc(platform) + ';\n' +
  'window.__SRC_CODEGS__ = ' + esc(codegs) + ';\n' +
  'window.__PAYMENT_HTML__ = ' + esc(payLocal) + ';\n' +
  'window._BUILD_TS = ' + JSON.stringify(new Date().toLocaleString('en-IN')) + ';\n' +
  boot + '\n' +
  SC + '\n';

let out = dash.replace(/<body>/i, '<body>' + injected);
if (out === dash) throw new Error('Dashboard.html में <body> नहीं मिला!');

const outFile = path.join(PROJ, 'Road Management.html');
fs.writeFileSync(outFile, out, 'utf8');
console.log('[1/2] Road Management.html —', (out.length / 1024 / 1024).toFixed(2), 'MB');

// deploy फ़ोल्डर ताज़ा करें
const dep = path.join(PROJ, 'deploy');
fs.mkdirSync(dep, { recursive: true });
fs.copyFileSync(outFile, path.join(dep, 'index.html'));
fs.cpSync(path.join(PROJ, 'Road Estimater'), path.join(dep, 'Road Estimater'), { recursive: true });
console.log('[2/2] deploy\\ ताज़ा — index.html + Road Estimater');
console.log('OK ✔');
