# सड़क परियोजना प्रबंधन प्रणाली — Supabase Setup गाइड

सॉफ्टवेयर का **सारा डेटा अब Supabase cloud** (PostgreSQL + JSONB + Storage) में रहता है।
Google Sheets/Drive में अब कुछ भी save नहीं होता — Apps Script सिर्फ़ app-server का काम करता है
(वेब-पेज serve करना और Supabase से बात करना)।

```
┌─────────────┐     google.script.run      ┌──────────────┐    REST (HTTPS)    ┌──────────────────┐
│  Browser    │ ─────────────────────────▶ │  Apps Script │ ─────────────────▶ │     Supabase     │
│  Dashboard/ │                            │  Code.gs +   │                    │  PostgreSQL (डेटा) │
│  Payment UI │ ◀───────────────────────── │ SupabaseDB.gs│ ◀───────────────── │  Storage (फ़ाइलें) │
└─────────────┘                            └──────────────┘                    └──────────────────┘
```

---

## फ़ाइलें

| फ़ाइल | काम |
|---|---|
| `supabase_schema.sql` | Supabase database की tables + functions (एक बार चलाना है) |
| `Code.gs` | Backend logic (अब SBApp/SBDrive के ज़रिए Supabase से बात करता है) |
| `SupabaseDB.gs` | Supabase data-layer — SpreadsheetApp/DriveApp का विकल्प |
| `Dashboard.html` | मुख्य UI (नया indigo-blue design) |
| `Payment.html` | भुगतान प्रबंधन UI (नया indigo-blue design) |

---

## Step 1 — Supabase project बनाएँ

1. <https://supabase.com> पर जाएँ → **New project**
2. नाम दें (जैसे `road-mgmt`), password सेट करें, region चुनें (Mumbai `ap-south-1` सबसे तेज़ रहेगा)

## Step 2 — Database schema चलाएँ

1. बाएँ menu से **SQL Editor** → **New query**
2. `supabase_schema.sql` की **पूरी फ़ाइल paste** करें → **RUN**
3. नीचे `Success` दिखे तो tables (`spreadsheets`, `sheets`, `sheet_rows`, `files`) और
   सभी `ss_*` functions बन गए।

## Step 3 — Storage bucket बनाएँ

1. बाएँ menu से **Storage** → **New bucket**
2. नाम: `rms-files` (बिल्कुल यही नाम)
3. **Public bucket** को **ON** करें → Create
   (फ़ाइलें — दस्तावेज़, फोटो, बिल — इसी bucket में रहेंगी और उनके links सीधे खुलेंगे)

## Step 4 — API keys कॉपी करें

1. **Project Settings → API** खोलें
2. दो चीज़ें कॉपी करें:
   - **Project URL** — जैसे `https://abcdefgh.supabase.co`
   - **service_role key** (secret) — `eyJ...` से शुरू होने वाली लंबी key

> ⚠️ service_role key **कभी भी** HTML/frontend में न डालें — यह सिर्फ़
> Apps Script की Script Properties में जाती है (server-side, browser में नहीं दिखती)।

## Step 5 — Apps Script project सेट करें

1. <https://script.google.com> → **New project**
2. ये फ़ाइलें बनाएँ और content paste करें:
   - `Code.gs` ← Code.gs
   - `SupabaseDB.gs` ← SupabaseDB.gs (**+ → Script** से नई फ़ाइल)
   - `Dashboard.html` ← Dashboard.html (**+ → HTML**)
   - `Payment.html` ← Payment.html (**+ → HTML**)
3. **Project Settings (⚙️) → Script Properties → Add script property** से दो properties जोड़ें:

   | Property | Value |
   |---|---|
   | `SUPABASE_URL` | `https://abcdefgh.supabase.co` |
   | `SUPABASE_SERVICE_KEY` | `eyJ...` (service_role key) |

## Step 6 — Tables/Sheets बनाएँ (एक बार)

1. Editor में ऊपर function-list से **`setupSheets`** चुनें → **Run**
2. पहली बार Google authorization माँगेगा → Allow करें
   (सिर्फ़ "external service से connect" की अनुमति — Supabase call के लिए)
3. इससे मुख्य sheets (1_Roads_Master, 3_Projects, ...) sample data के साथ Supabase में बन जाएँगी।
   - ख़ाली शुरू करना हो तो sample rows बाद में UI से delete कर सकते हैं।

## Step 7 — Deploy करें

1. **Deploy → New deployment → Web app**
2. Execute as: **Me** | Who has access: **Anyone**
3. **Deploy** → मिला हुआ URL browser में खोलें
4. Login: `admin` / `Admin@123` (users `Code.gs` के `USERS_` में बदल सकते हैं)

---

## पुराने Google Sheets का डेटा लाना (migration)

अगर पुराने spreadsheet में डेटा है, तो हर sheet के लिए:

1. Supabase → **SQL Editor** में इस तरह की query से जाँचें कि sheet बनी है:
   `select * from sheets where spreadsheet_id='main';`
2. सबसे आसान तरीक़ा: पुराने वेब-ऐप से डेटा **UI के ज़रिए re-enter/import** करें, या
3. Bulk migration के लिए हर sheet का CSV निकालकर SQL से डालें —
   हर पंक्ति `sheet_rows` में JSON array के रूप में जाती है (row 1 = header):

```sql
-- उदाहरण: 1_Roads_Master में एक पंक्ति जोड़ना
select ss_append_row('main', '1_Roads_Master',
  '["RD005","नया मार्ग","ग्रामीण मार्ग","SC2024001","विधानसभा-2","4.10","Active",""]'::jsonb);
```

---

## तकनीकी नोट्स

- **डेटा-मॉडल**: हर पुरानी "sheet" = Supabase में एक तार्किक table
  (`sheets` + `sheet_rows`, cells JSONB array में, row 1 = header)।
  भुगतान-परियोजनाएँ भी `spreadsheets` table में अलग-अलग workbook की तरह रहती हैं।
- **फ़ाइलें**: `rms-files` bucket में path `f/<uuid>/<filename>`;
  metadata `files` table में। Folder-view के लिए वेब-ऐप का
  `?page=files&folder=...` route है (दस्तावेज़/फोटो folder links यहीं खुलते हैं)।
- **सुरक्षा**: सभी tables पर RLS ON है और कोई public policy नहीं —
  यानी anon key से डेटा नहीं पढ़ा जा सकता; सिर्फ़ server (service_role) पढ़/लिख सकता है।
  Bucket public है ताकि फ़ाइल-links सीधे खुलें।
- **Import टेम्प्लेट** (Payment → आयात): अब Google Sheet के बजाय Supabase में बनता है,
  इसलिए Excel-import के लिए `.xlsx` upload वाला रास्ता इस्तेमाल करें।
- **पुराने Drive links**: पहले से saved `drive.google.com` links काम करते रहेंगे
  (UI दोनों तरह के links समझता है), पर नई uploads Supabase Storage में जाएँगी।
- **Limits**: Supabase free tier — 500MB database + 1GB storage; ज़रूरत पर upgrade करें।
  Apps Script की UrlFetch सीमा ~20,000 calls/दिन है — सामान्य उपयोग के लिए पर्याप्त।

## समस्या-निवारण

| समस्या | कारण/समाधान |
|---|---|
| "Supabase सेट नहीं है…" error | Script Properties में `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` जाँचें |
| "Supabase RPC … विफल (404)" | `supabase_schema.sql` दोबारा पूरा चलाएँ (कोई function छूट गया) |
| Upload विफल | Storage में `rms-files` **public** bucket बना है या नहीं जाँचें |
| डेटा नहीं दिख रहा | `setupSheets` एक बार चलाया? Dashboard में 🔄 रिफ्रेश दबाएँ (cache 15 min) |
