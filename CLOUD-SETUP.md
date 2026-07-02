# Cloud mode — Supabase से जोड़ना (आपके 4 काम)

App **अपने-आप mode चुनता है**:
- `Road Management.html` को PC पर double-click → **LOCAL mode** (डेटा उसी browser में) — पहले जैसा
- Netlify site खोलें और नीचे का setup हो चुका हो → **CLOUD mode** (सारा डेटा Supabase में, सभी users/devices को एक ही डेटा)

Setup तक site LOCAL mode में ही चलती रहेगी — कुछ टूटेगा नहीं।

---

## काम 1 — Supabase project बनाएँ

1. <https://supabase.com> → Sign up (Google से) → **New project**
2. नाम: `road-mgmt`, database password सेट करें, Region: **Mumbai (ap-south-1)** → Create

## काम 2 — Database बनाएँ

1. बाएँ menu **SQL Editor** → New query
2. अपने फ़ोल्डर की **`supabase_schema.sql`** की पूरी फ़ाइल paste करें → **RUN** → `Success` दिखे

## काम 3 — Storage bucket

1. बाएँ menu **Storage** → **New bucket**
2. नाम: **`rms-files`** (बिल्कुल यही) → **Public bucket = ON** → Create

## काम 4 — Netlify में 4 environment variables

Supabase में **Project Settings → API** से दो चीज़ें copy करें: **Project URL** और **service_role key**।

फिर Netlify में: **Site configuration → Environment variables → Add a variable** से ये चारों जोड़ें:

| Key | Value |
|---|---|
| `SUPABASE_URL` | `https://xxxx.supabase.co` (आपका Project URL) |
| `SUPABASE_SERVICE_KEY` | `eyJ...` (service_role secret key) |
| `APP_SECRET` | कोई भी लंबा मनगढ़ंत वाक्य (30+ अक्षर) — जैसे टूटी-फूटी कोई पंक्ति। यह token-signing की चाबी है |
| `APP_USERS` | `admin:नयाPassword@123:admin:Administrator` |

**APP_USERS का प्रारूप** — `user:password:role:नाम`, कई users हों तो `;` से जोड़ें:
```
admin:Str0ng@Pass:admin:Administrator;ramesh:Ram@2026:user:रमेश कुमार
```
⚠️ नया मज़बूत password रखें — पुराना `Admin@123` इस्तेमाल न करें।

फिर: **Deploys → Trigger deploy → Deploy project** (env बदलने पर एक बार ज़रूरी)।

---

## जाँच

1. Site खोलें → नए (env वाले) user/password से login करें
2. पहली बार login होते ही sample data अपने-आप Supabase में बन जाएगा
3. किसी दूसरे PC/mobile से site खोलकर login करें — **वही डेटा** दिखे तो cloud mode चालू है ✔
4. Supabase → Table Editor → `sheet_rows` में rows दिखेंगी

## अच्छे से समझ लें

- **Cloud mode में login** Netlify server से होता है — passwords सिर्फ़ env variables में हैं, code/HTML में नहीं। User बदलने/जोड़ने के लिए बस `APP_USERS` बदलकर redeploy करें।
- **फ़ाइलें** (PDF/फोटो/बिल) Supabase Storage में जाती हैं — कहीं से भी खुलती हैं।
- दूसरों के बदलाव आपकी screen पर ~1 मिनट के अंदर (या 🔄 रिफ्रेश दबाते ही) दिखते हैं।
- **Estimator** का डेटा अभी भी browser (IndexedDB) में ही है — उसका cloud बाद में, कहेंगे तब।
- पुराने local (browser) डेटा का cloud में migration चाहिए तो मुझे बताइए — मैं migrate-टूल चला दूँगा।

## समस्या-निवारण

| दिक्कत | उपाय |
|---|---|
| Site पर पुराना `admin/Admin@123` ही चलता है | Cloud mode ON नहीं हुआ — चारों env variables जाँचें, फिर Trigger deploy |
| Login पर "Server त्रुटि" | `APP_USERS` का format जाँचें (`user:pass:role:नाम`) |
| Data ops पर "Supabase 404" | `supabase_schema.sql` पूरा दोबारा RUN करें |
| File upload विफल | Storage में `rms-files` **public** bucket जाँचें |
