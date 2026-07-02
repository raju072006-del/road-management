# Deploy गाइड — एक command से site update

रोज़ का काम बस इतना: कोड बदलें → **`deploy.bat` double-click** (या VS Code terminal में `.\deploy.bat`) → 1-2 मिनट में site update.

पर उसके लिए पहले यह **one-time setup** करना होगा:

---

## One-time setup (लगभग 15 मिनट)

### Step 1 — Git install करें
- <https://git-scm.com/download/win> से download करके install (सब defaults पर Next)
- जाँच: VS Code का terminal खोलकर `git --version` चलाएँ

### Step 2 — GitHub पर repo बनाएँ
1. <https://github.com> पर account बनाएँ/खोलें
2. **New repository** → नाम दें जैसे `road-management` → **Private** चुनें → Create
   (Private रखें — code में login passwords हैं)

### Step 3 — इस फ़ोल्डर को Git से जोड़ें
VS Code में यह फ़ोल्डर खोलकर terminal (`Ctrl + ~`) में एक-एक करके:

```bash
git init
git add .
git commit -m "first version"
git branch -M main
git remote add origin https://github.com/<आपका-username>/road-management.git
git push -u origin main
```

(पहली बार GitHub login window खुलेगी — sign in कर दें)

### Step 4 — Netlify को GitHub से जोड़ें (auto-deploy)
1. <https://netlify.com> → Sign up **GitHub से** करें
2. **Add new site → Import an existing project → GitHub** → अपनी `road-management` repo चुनें
3. Settings में:
   - **Build command**: ख़ाली छोड़ें
   - **Publish directory**: `deploy`
4. **Deploy** दबाएँ → site live (`कुछ-नाम.netlify.app`)
5. Subdomain जोड़ें: **Domain management → Add a domain** → `road.आपका-domain.com`
   और GoDaddy DNS में CNAME: Name `road`, Value `आपकी-site.netlify.app`

---

## रोज़ का workflow (setup के बाद)

1. VS Code में कोड बदलें (Dashboard.html / Payment.html / Code.gs / Road Estimater…)
2. **`deploy.bat` चलाएँ** — यह अपने-आप:
   - `Road Management.html` दोबारा build करता है
   - `deploy\` फ़ोल्डर ताज़ा करता है
   - `git add + commit + push` करता है
3. Push होते ही **Netlify अपने-आप** नई site publish कर देता है (~1 मिनट)

बस। कोई manual upload नहीं।

## फ़ाइलें क्या-क्या हैं

| फ़ाइल/फ़ोल्डर | काम |
|---|---|
| `Dashboard.html`, `Payment.html`, `Code.gs` | **source** — बदलाव यहीं करें |
| `Road Estimater\` | Estimator सॉफ्टवेयर (source) |
| `build\` | builder script + platform (छेड़ें नहीं) |
| `Road Management.html` | build का नतीजा — local में double-click करके चलाएँ |
| `deploy\` | hosting पर जाने वाला फ़ोल्डर (build अपने-आप भरता है) |
| `deploy.bat` | एक-command build + push |
| `supabase_schema.sql`, `SupabaseDB.gs`, `SETUP_SUPABASE.md` | भविष्य में central/cloud डेटा के लिए |

## ध्यान रखें

- `Road Management.html` और `deploy\index.html` को **हाथ से edit न करें** — ये build से बनते हैं; अगली build पर बदलाव मिट जाएगा। बदलाव हमेशा source (Dashboard.html आदि) में करें।
- GoDaddy hosting (cPanel) इस्तेमाल कर रहे हों तो auto-push का तरीक़ा अलग है — बताइए तो FTP-आधारित script बना दूँगा; पर Netlify वाला रास्ता ज़्यादा आसान और मुफ़्त है।
