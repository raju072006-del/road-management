# UI / CSS Design Guide — "Road Estimator" शैली

> किसी नए सॉफ्टवेयर में यही look चाहिए तो यह पूरा दस्तावेज़ designer/developer/AI को दे दें
> और कहें: **"इस design-system के अनुसार बनाओ।"**

---

## 1. समग्र पहचान (एक पंक्ति में)

**Modern indigo-blue business app** — dark sidebar + हल्की slate-grey body, बड़े गोल कोने,
मुलायम layered shadows, हर interaction पर हल्की smooth animation। Dense डेटा (tables/grids)
के लिए बना, फिर भी हवादार और साफ़।

---

## 2. Color Tokens

```css
/* Brand (indigo-blue) */
--navy:       #4056d6;   /* primary */
--navy-dark:  #2d3fae;   /* pressed/deep */
--navy-light: #6478f0;   /* hover/gradient-end */

/* State colors */
--green: #0e9f6e;  /* success  (badge bg #def7ec, text #046c4e) */
--red:   #e02d3c;  /* danger   (badge bg #fde4e4) */
--saffron:#f59e0b; /* warm accent (highlight, dots) */

/* Neutrals (slate) */
--bg:    #f2f4fa;  /* app background */
--panel: #ffffff;  /* cards/surfaces */
--ink:   #141c2e;  /* मुख्य text */
--muted: #66738a;  /* secondary text */
--line:  #e3e8f0;  /* borders */
--line-soft: #eef1f7;

/* Selection */
--sel: #dde6ff;  --sel-border: #4c66f0;

/* Dark sidebar surface */
--side-bg1:#131a2e; --side-bg2:#1a2340; --side-ink:#aab6d3;
```

- Primary actions पर gradient: `linear-gradient(135deg, var(--navy), var(--navy-light))`
- एक **secondary warm (amber/golden) theme** विशेष context के लिए (जैसे "Master edit" mode):
  bg `#fdf8ea`, border `#f1dfad`, text `#7a5f12`, active `#8a6a14` — ताकि user को दिखे कि वह अलग/संवेदनशील क्षेत्र में है।

## 3. Typography

- UI font: **Inter** + **Noto Sans Devanagari** (हिन्दी), fallback `system-ui, sans-serif`
- Numbers/formula/code: **Roboto Mono** + `font-variant-numeric: tabular-nums`
- Base 14px / line-height 1.5; view-heading 22px weight-800 `letter-spacing:-.02em`
- Table headers: 12px UPPERCASE `letter-spacing:.04em` color `#4a5875`
- `-webkit-font-smoothing:antialiased`

## 4. आकार-प्रकार (Shape & Depth)

```css
/* Radii */      --r-sm:8px;  --r-md:12px;  --r-lg:16px;  badges/chips/search = 999px (pill)
/* Shadows */
--shadow:    0 1px 2px rgba(20,28,46,.05), 0 2px 8px rgba(20,28,46,.05);   /* आराम की परत */
--shadow-md: 0 4px 14px rgba(20,28,46,.08), 0 2px 4px rgba(20,28,46,.05);  /* hover */
--shadow-lg: 0 14px 40px rgba(20,28,46,.16), 0 4px 12px rgba(20,28,46,.08);/* modal/menu */
/* रंगीन glow सिर्फ़ brand-elements पर: 0 6px 16px rgba(64,86,214,.38) */
```

- Borders हमेशा 1px–1.5px, रंग `--line`; focus में border brand + **soft glow ring**:
  `box-shadow: 0 0 0 3.5px rgba(76,102,240,.16)` (hard outline कभी नहीं)

## 5. Motion (smooth लगने का राज़)

```css
--ease: cubic-bezier(.4,0,.2,1);    /* सब transitions .14–.2s इसी से */
@keyframes viewIn { from{opacity:0; transform:translateY(8px)} to{opacity:1} }  /* हर view/tab खुलने पर .28s */
@keyframes popIn  { from{opacity:0; transform:scale(.95) translateY(8px)} to{opacity:1} } /* modal/menu .16–.24s */
```

- Cards hover: `translateY(-3px)` + shadow-md; buttons active: `scale(.97)`
- Toast: spring-सा `cubic-bezier(.34,1.4,.64,1)` से नीचे से slide-in
- **`prefers-reduced-motion: reduce` का सम्मान** — सभी animation बंद
- पतले custom scrollbars: 9px, thumb `#c3cbdc` rounded, track transparent

## 6. Layout ढाँचा

```
┌──────────┬──────────────────────────────────┐
│ Sidebar  │ Topbar (frosted glass, blur 12px)│
│ (dark,   ├──────────────────────────────────┤
│ 240px,   │ Views (bg --bg, padding 26/30px) │
│ gradient)│   … cards / panels / grids …     │
│          ├──────────────────────────────────┤
│          │ Status bar (dark, sidebar जैसा)  │
└──────────┴──────────────────────────────────┘
```

- **Sidebar**: `linear-gradient(180deg,#131a2e,#1a2340)`, text `#aab6d3`;
  active item = **gradient indigo pill** (rounded-10px, white text, रंगीन glow shadow, बाईं ओर 3.5px accent bar);
  hover = `rgba(255,255,255,.07)` + `translateX(2px)`
- **Topbar**: `rgba(255,255,255,.85)` + `backdrop-filter:blur(12px)`, नीचे 1px border
- Responsive: ≤980px पर sidebar सिर्फ़ icons (66px); mobile पर hamburger

## 7. Components की रेसिपी

| Component | नुस्ख़ा |
|---|---|
| **Card** | white, radius 16, border 1px `--line`, shadow, padding 18px; icon को 42px gradient-tile (`#eef1ff→#e3e9ff`, radius 12) में रखें; hover पर lift |
| **Button** | radius 10, border 1.5px, weight 600; `primary` = indigo gradient + glow; `ghost` = transparent→हल्का नीला hover; `danger` = लाल text→hover पर भरा लाल; sizes: sm/xs |
| **Input/Select** | bg `#fbfcfe`, border 1.5px, radius 10, focus = brand border + glow ring; label ऊपर 12px weight-600 `#3d4a63` |
| **Search box** | pill (radius 999), बाक़ी input जैसा |
| **Tabs** | segmented control: बाहरी pill-container bg `#e8ecf5` radius 14 padding 5px; active tab = white + छोटी shadow |
| **Badge/Chip** | pill, 11-12px weight 600-700; success हरा, neutral slate, count-badge indigo gradient |
| **Table** | wrapper: white + radius 12 + border, sticky header (`#f7f9fd`, uppercase 12px); rows: even `#fafbfe`, hover `#eef2fe`; numbers right-aligned tabular |
| **Modal** | overlay `rgba(15,20,38,.44)` + `blur(4px)`; box radius 16, shadow-lg, popIn; **confirm-dialog pattern**: 48px रंगीन icon-tile + title + नाम की mono-chip + रंगीन note-strip (हरा=safe / पीला=warning) + danger बटन |
| **Context menu** | white 97% + blur, radius 12, items radius 8, hover `--sel` |
| **Toast** | bottom-center, dark `rgba(19,26,46,.96)` + blur, radius 14, white action-button, spring slide-in |
| **Hint/Note strip** | हल्का gradient नीला `#eef2ff→#f4f0ff`, border `#dfe4ff`, text `#3d4db4`, radius 12 |
| **Empty state** | बड़ा हल्का icon (44px `#ccd4e4`) + muted संदेश, fadeIn |
| **Linear form-row** | fields एक पंक्ति में flex, हर row हल्के bg (`#fbfcfe`) के rounded-12 डिब्बे में; अंत में गोल ✕ बटन (hover लाल) |

## 8. Data-grid (spreadsheet) विशेष

- Cell borders `#e6eaf2`; selection = 2px `--sel-border` outline + `--sel` bg
- Header row sticky, locked शीर्ष पंक्ति = indigo gradient + white text; locked footer = सुनहरी (`#fef4d8`, text `#7a5b00`)
- Formula वाले cell का text brand-नीला; error लाल; linked/manual cells के लिए हल्के पीले/नीले bg
- सम्पादन overlay-input cell के अंदर, row की ऊँचाई edit के दौरान स्थिर

## 9. लिखने के नियम (principles)

1. रंग कम, अर्थपूर्ण — brand indigo सिर्फ़ action/focus/selection पर; state-रंग सिर्फ़ state पर
2. हर interactive चीज़ पर hover + active + focus-visible की transition हो (.14–.2s)
3. गहराई shadow से बनाओ, गाढ़े border से नहीं
4. गोलाई उदार (10–16px), छोटे tags/search pill
5. Dense data में भी साँस — sticky headers, zebra rows, hover highlight
6. ख़तरनाक क्रियाओं के लिए designed confirm-dialog (icon + रंगीन note), कभी native `confirm()` नहीं
7. विशेष mode (जैसे master-edit) को अलग warm रंग-परिवार दो ताकि context हमेशा दिखे

---
*स्रोत: Road Estimator का `styles.css` — सभी exact मान वहीं से लिए जा सकते हैं।*
