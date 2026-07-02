# Road Estimate System (सड़क आकलन प्रणाली)

1000+ आपस में जुड़ी Excel शीट को manage करने, उनमें से 15-20 शीट चुनकर **Road Estimate** बनाने,
सभी शीट का **प्रिंट** निकालने और **links समेत .xlsx** export करने का web-based software।

बनाया गया: HTML + CSS + Vanilla JS · Calculation engine: **HyperFormula** · Excel I/O: **SheetJS**
Data store: **IndexedDB** (आपके PC के browser में)।

---

## 1. क्या-क्या कर सकते हैं

- **एक-एक शीट बनाओ** (`+ नई शीट`), हर cell में मान या formula।
- **शीट आपस में link करो** — किसी cell में लिखो `=RoadA!C5*1.18` (दूसरी शीट `RoadA` के cell `C5` को जोड़ा)।
  HyperFormula इसे live calculate करता है (SUM, IF, ROUND, आदि सैकड़ों Excel functions चलते हैं)।
- **Estimate बनाओ** — `+ नया`, फिर उसमें 15-20 शीट जोड़ो, क्रम ऊपर/नीचे करो।
- **⬇ Excel (.xlsx)** — चुनी शीट एक ही workbook में अलग-अलग tabs बनकर निकलती हैं, **cross-sheet links बने रहते हैं**।
- **🖨 प्रिंट** — सभी चुनी शीट एक साथ, हर शीट नए page पर, सरकारी फॉर्मेट में।
- **⬆ Excel Import** — आपकी मौजूदा .xlsx फाइलें (formulas समेत) software में आ जाती हैं।
- **⬇ Backup / ↺ Restore** — पूरा data एक JSON फाइल में।

> सुझाव: शीट के नाम में **space ना डालें**, underscore इस्तेमाल करें (जैसे `Road_A_Earthwork`),
> ताकि formula में link साफ़ रहे: `=Road_A_Earthwork!B10`।

---

## 2. Database कहाँ और कैसे है? (आपका मुख्य सवाल)

**Code और Data अलग चीज़ें हैं —**

| चीज़ | कहाँ रहती है | कैसे चलती है |
|---|---|---|
| **Code (software)** | GitHub repo | VS Code में edit → `git push` → GitHub Pages पर live |
| **Data (1000 शीट)** | आपके browser का **IndexedDB** | अपने-आप save, offline भी चलता है |

GitHub में सिर्फ़ **code** जाता है, आपका **data नहीं** (और जाना भी नहीं चाहिए — वो आपका निजी कार्य-डेटा है)।
इसलिए `git push` करने से data कहीं नहीं जाता; आपका data इसी PC के इस browser में सुरक्षित रहता है।

### Data का backup ज़रूरी है
IndexedDB एक ही browser/PC से बंधा है। इसलिए:
- हर हफ़्ते **⬇ Backup (JSON)** दबाकर एक फाइल अपने Drive/pen-drive में रखें।
- नया PC या browser बदलने पर **↺ Restore** से वापस ले आएँ।

### बाद में cloud चाहिए हो तो (multi-device, auto-backup)
जब काम बढ़े और कहीं से भी access चाहिए, तो **Supabase** (free Postgres database) पर shift करें।
इसके लिए सिर्फ़ `js/app.js` की **STORAGE (db.*)** layer बदलनी है — बाकी पूरा software वैसा ही रहेगा
(इसीलिए storage को अलग रखा गया है)। मोटे तौर पर:

1. supabase.com पर free project बनाओ → एक table `sheets`, एक `estimates`।
2. `index.html` में Supabase JS जोड़ो।
3. `db.getAll/put/del` के अंदर IndexedDB की जगह Supabase calls डाल दो।

Firebase Firestore भी विकल्प है — दोनों का free tier आपके लिए काफ़ी है।

---

## 3. VS Code + GitHub setup (step-by-step)

### एक बार का setup
1. **Git** install करो: https://git-scm.com/download/win
2. **VS Code** खोलो → इस folder `road-estimate-app` को `File > Open Folder` से खोलो।
3. GitHub पर एक **नया repository** बनाओ (मान लो नाम `road-estimate-app`), बिना README के।
4. VS Code का Terminal खोलो (`Ctrl + ~`) और चलाओ:

```bash
git init
git add .
git commit -m "first version"
git branch -M main
git remote add origin https://github.com/<your-username>/road-estimate-app.git
git push -u origin main
```

### हर सुधार के बाद (रोज़ का काम)
कोड बदलने के बाद बस ये तीन command:

```bash
git add .
git commit -m "जो बदला उसका छोटा विवरण"
git push
```

बस — आपका सुधार GitHub पर चढ़ गया।

---

## 4. Online live करना (GitHub Pages — मुफ़्त)

1. GitHub पर अपने repo में जाओ → **Settings → Pages**।
2. **Source** में `Deploy from a branch`, Branch = `main`, Folder = `/ (root)` चुनो → **Save**।
3. 1-2 मिनट में link मिल जाएगा:
   `https://<your-username>.github.io/road-estimate-app/`
4. उसी link को browser में खोलो — software online चलेगा।

> ध्यान: GitHub Pages पर data फिर भी **उसी browser के IndexedDB** में रहेगा (cloud तभी जब Supabase लगाओ)।

---

## 5. बिना internet के चलाना
`index.html` पर double-click करके भी software खुल जाता है। बस **पहली बार** engine load होने के लिए
internet चाहिए (HyperFormula/SheetJS CDN से आते हैं)। चाहें तो बाद में इन दो files को भी repo में
रखकर पूरी तरह offline बना सकते हैं — बताऊँगा अगर ज़रूरत हो।

---

## 6. फाइल संरचना
```
road-estimate-app/
├── index.html      ← layout (header, शीट सूची, grid, estimate panel)
├── styles.css      ← सरकारी (NIC-style) design
├── js/app.js       ← पूरा logic — हिस्सों में बँटा (STORAGE/ENGINE/SHEETS/ESTIMATE/EXPORT)
├── README.md       ← यही फाइल
└── .gitignore
```

`app.js` के ऊपर हर हिस्से पर हिंदी comment है, ताकि सुधार आसान रहे।
