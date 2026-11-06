# Trace

https://trace.iakobin.com — see which substances of *potential* concern may be in a food product, with the evidence level and links to the research.

## Features
- **Barcode scan** in the browser: native `BarcodeDetector` where available, otherwise `html5-qrcode@2.3.8` (jsDelivr). Also scan from a photo, or type the number.
- **Product report**: name, image, brand, Nutri-Score, NOVA group, additives (E-numbers with names), ingredients, allergens, plus **substances of interest** matched against a curated knowledge base (`src/kb.json`, 42 entries). Each entry has a plain-language summary, an evidence level (regulatory ban, IARC classification, mandatory warning label, regulatory restriction, under review, limited evidence), source links (EFSA, EUR-Lex, WHO/IARC, PubMed) and a "latest research" PubMed search.
- **Receipt scan**: OCR runs in the browser with `tesseract.js@5.1.1` (Dutch + English). The image never leaves the device. Product lines are pulled out roughly; you can edit them, search Open Food Facts by name, and open a report.
- **History** is kept in `localStorage` only. The server stores no user data.
- **Search by name** on the scan page too.

## How it works
- `src/server.js`: a Node 22 HTTP server with no dependencies.
  - `GET /api/product/:barcode` proxies Open Food Facts API v2 and matches the result against the knowledge base.
  - `GET /api/search?q=` uses OFF `cgi/search.pl` (one upstream call; Dutch products are listed first, worldwide results if there are none). If that fails it falls back to `search.openfoodfacts.org`.
  - `GET /api/kb` returns the knowledge base.
  - `GET /health` returns `ok`.
- Matching works on OFF `additives_tags`, on `ingredients_tags`, on E-numbers in the ingredient text, and on Dutch/English keywords.
- Cache: in-memory LRU plus JSON files in `data/cache/`. Products are cached for 7 days, searches for 1 day. "Not found" products are cached in memory only, for 1 hour. An hourly prune deletes files older than 30 days and keeps at most `CACHE_MAX_FILES` files (oldest deleted first).
- Upstream response bodies are capped at 2 MB (larger responses are treated as errors). Additive names come from the OFF additives taxonomy, cached for 30 days.
- Abuse protection (per client IP, using the first `X-Forwarded-For` value):
  - product lookups: 15/min
  - searches: 3/min
  - These are kept well below the shared upstream budgets so one client can't use up OFF access for everyone.
  - Over the limit, the API returns 429 with `Retry-After`.
- Global upstream budgets are 90 product calls and 10 search calls per minute (configurable), to stay within OFF's rate limits.
- Only GET is accepted. Inputs are validated: barcodes must be 8–14 digits, search text 2–80 characters.
- HTML is served with a strict CSP that allows only the exact jsDelivr paths used (html5-qrcode@2.3.8, tesseract.js@5.1.1, tesseract.js-core@5.1.1, @tesseract.js-data/nld and /eng). The two `<script>` tags loaded from jsDelivr carry SRI (sha384) hashes. Files the tesseract worker loads itself (worker.min.js and the core via `importScripts`, language data via `fetch`) can't use SRI; they are pinned by version and path in the CSP only.

## Data sources
- [Open Food Facts](https://world.openfoodfacts.org) (ODbL). The User-Agent is `Trace/0.1 (iakobin labs; https://trace.iakobin.com)`.
- The knowledge base was curated from EFSA opinions, EU regulations (1333/2008, 1169/2011, 2022/63, 2023/2108, 2019/649, 2024/2067, 2023/915), IARC classifications and peer-reviewed studies. Every DOI and PMID was checked against Crossref and PubMed (Nov 2026).

## Env vars (`.env`)
| var | default | |
|---|---|---|
| `APP_TITLE` | Trace | page title |
| `PORT` | 3000 | |
| `OFF_USER_AGENT` | Trace/0.1 (iakobin labs; …) | User-Agent sent to OFF |
| `RATE_PRODUCT_PER_MIN` | 15 | per-IP product lookups |
| `RATE_SEARCH_PER_MIN` | 3 | per-IP searches |
| `UPSTREAM_PRODUCT_PER_MIN` | 90 | global OFF product budget |
| `UPSTREAM_SEARCH_PER_MIN` | 10 | global OFF search budget |
| `CACHE_MAX_FILES` | 20000 | max files in `data/cache/` |

## Deploy
`docker compose -f /srv/apps/trace/compose.yml up -d --build`

To edit the knowledge base, change `src/kb.json` and rebuild. Entries take `e` (E-codes), `tags` (OFF ingredient tags), `keywords` (prefix-matched in the ingredient text), and optionally `exclude` (regexes removed from the text before keyword matching).
