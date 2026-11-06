"use strict";
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = (u) => (/^https:\/\/[a-z0-9.-]+\.(openfoodfacts\.org)\//i.test(u || "") ? u : "");
  // Pinned CDN files; keep in sync with the CSP in server.js.
  const LIBS = {
    zxing: "https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js",
    tesseract: "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js",
    // Loaded by tesseract via importScripts() inside a worker: SRI isn't possible there.
    tesseractWorker: "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js",
    tesseractCore: "https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1",
  };
  // Subresource Integrity for the <script> tags we add (sha384 of the exact files).
  const SRI = {
    [LIBS.zxing]: "sha384-c9d8RFSL+u3exBOJ4Yp3HUJXS4znl9f+z66d1y54ig+ea249SpqR+w1wyvXz/lk+",
    [LIBS.tesseract]: "sha384-GJqSu7vueQ9qN0E9yLPb3Wtpd7OrgK8KmYzC8T1IysG1bcvxvIO4qtYR/D3A991F",
  };
  let KB = null;
  const kbReady = fetch("/api/kb").then((r) => r.json()).then((k) => { KB = k; KB.byId = Object.fromEntries(k.entries.map((e) => [e.id, e])); return k; });

  // ---------- utils ----------
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 4000);
  }
  async function api(path) {
    const r = await fetch(path, { headers: { Accept: "application/json" } });
    let j = {}; try { j = await r.json(); } catch {}
    if (!r.ok) { const e = new Error(j.error || `Request failed (${r.status})`); e.status = r.status; e.body = j; throw e; }
    return j;
  }
  const scripts = {};
  function loadScript(src) {
    return (scripts[src] ||= new Promise((ok, fail) => {
      const s = document.createElement("script"); s.src = src; s.async = true; s.crossOrigin = "anonymous";
      if (SRI[src]) s.integrity = SRI[src];
      s.onload = ok; s.onerror = () => { delete scripts[src]; fail(new Error("Could not load " + src)); };
      document.head.appendChild(s);
    }));
  }
  function validGtin(code) {
    if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
    const d = code.split("").map(Number), check = d.pop();
    const sum = d.reverse().reduce((s, n, i) => s + n * (i % 2 ? 1 : 3), 0);
    return (10 - (sum % 10)) % 10 === check;
  }
  const levelOf = (e) => KB.levels[e.level] || { label: e.level, rank: 1 };
  const pubmed = (q) => "https://pubmed.ncbi.nlm.nih.gov/?term=" + encodeURIComponent(q) + "&sort=date";

  // ---------- history (localStorage only) ----------
  const HKEY = "trace.history.v1";
  const hist = {
    all() { try { const a = JSON.parse(localStorage.getItem(HKEY) || "[]"); return Array.isArray(a) ? a : []; } catch { return []; } },
    save(a) { try { localStorage.setItem(HKEY, JSON.stringify(a.slice(0, 100))); } catch {} },
    add(item) { this.save([item, ...this.all().filter((x) => x.code !== item.code)]); },
    remove(code) { this.save(this.all().filter((x) => x.code !== code)); },
  };

  // ---------- routing ----------
  const views = ["scan", "receipt", "history", "product", "about"];
  function route() {
    const h = location.hash.replace(/^#\/?/, "");
    const [name, arg] = h.split("/");
    const v = views.includes(name) ? name : name === "p" ? "product" : "scan";
    if (v !== "scan") stopCamera();
    for (const x of views) $("#view-" + x).hidden = x !== v;
    document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("on", a.dataset.tab === v));
    if (v === "product") { let code = ""; try { code = decodeURIComponent(arg || ""); } catch {} showProduct(code); }
    if (v === "history") renderHistory();
    if (v === "about") renderAbout();
    if (v !== "product") document.title = "Mind Your Plate — what's in your food";
    window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", route);
  const go = (code) => { location.hash = "#/p/" + code; };

  // ---------- barcode scanning ----------
  let stream = null, rafId = 0, h5 = null, detector = null;
  const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e"];
  async function getDetector() {
    if (detector !== null) return detector;
    detector = false;
    try {
      if ("BarcodeDetector" in window) {
        const supported = await BarcodeDetector.getSupportedFormats();
        const f = FORMATS.filter((x) => supported.includes(x));
        if (f.length) detector = new BarcodeDetector({ formats: f });
      }
    } catch {}
    return detector;
  }
  function onCode(raw) {
    let code = String(raw).replace(/\D/g, "");
    if (code.length === 12 && validGtin("0" + code)) code = "0" + code; // UPC-A -> EAN-13
    if (!validGtin(code) && !/^\d{8,14}$/.test(code)) return false;
    if (navigator.vibrate) navigator.vibrate(60);
    stopCamera();
    go(code);
    return true;
  }
  async function startCamera() {
    $("#camMsg").textContent = "";
    if (!navigator.mediaDevices?.getUserMedia) { $("#camMsg").textContent = "Camera not available in this browser — use “Scan from photo” or type the number."; return; }
    $("#cam").hidden = false; $("#camStart").hidden = true; $("#camStop").hidden = false;
    const det = await getDetector();
    try {
      if (det) {
        $("#video").hidden = false;
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
        const v = $("#video"); v.srcObject = stream; await v.play();
        let last = 0;
        const tick = async (t) => {
          if (!stream) return;
          if (t - last > 180 && v.readyState >= 2) {
            last = t;
            try { const codes = await det.detect(v); for (const c of codes) if (onCode(c.rawValue)) return; } catch {}
          }
          rafId = requestAnimationFrame(tick);
        };
        rafId = requestAnimationFrame(tick);
      } else {
        $("#video").hidden = true;
        $("#camHint").textContent = "Loading scanner…";
        await loadScript(LIBS.zxing);
        const L = window.__Html5QrcodeLibrary__;
        const F = L.Html5QrcodeSupportedFormats;
        h5 = new L.Html5Qrcode("h5", { formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E], verbose: false });
        await h5.start({ facingMode: "environment" }, { fps: 10, qrbox: (w, h) => ({ width: Math.floor(w * 0.76), height: Math.floor(h * 0.36) }), aspectRatio: 4 / 3, disableFlip: true }, (text) => onCode(text), () => {});
        $("#camHint").textContent = "Looking for a barcode…";
      }
    } catch (e) {
      stopCamera();
      $("#camMsg").textContent = e && e.name === "NotAllowedError" ? "Camera permission was denied. You can allow it in your browser settings, or use “Scan from photo”." : "Could not start the camera (" + (e.message || e.name || "error") + "). Try “Scan from photo” or type the number.";
    }
  }
  function stopCamera() {
    cancelAnimationFrame(rafId);
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    if (h5) { const x = h5; h5 = null; x.stop().catch(() => {}).finally(() => { try { x.clear(); } catch {} }); }
    const cam = $("#cam"); if (cam) cam.hidden = true;
    $("#camStart").hidden = false; $("#camStop").hidden = true;
  }
  $("#camStart").onclick = startCamera;
  $("#camStop").onclick = stopCamera;
  $("#photoInput").onchange = async (ev) => {
    const file = ev.target.files[0]; ev.target.value = "";
    if (!file) return;
    $("#camMsg").innerHTML = '<span class="spinner"></span> Reading barcode…';
    try {
      const det = await getDetector();
      if (det) {
        const bmp = await createImageBitmap(file);
        const codes = await det.detect(bmp);
        if (codes.some((c) => onCode(c.rawValue))) return;
        throw new Error("none");
      }
      await loadScript(LIBS.zxing);
      const L = window.__Html5QrcodeLibrary__, F = L.Html5QrcodeSupportedFormats;
      const tmp = new L.Html5Qrcode("h5", { formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E], verbose: false });
      const text = await tmp.scanFile(file, false);
      try { tmp.clear(); } catch {}
      if (!onCode(text)) throw new Error("none");
    } catch {
      $("#camMsg").textContent = "No barcode found in that photo. Try a sharper, closer shot — or type the number below the bars.";
    }
  };
  $("#manual").onsubmit = (e) => {
    e.preventDefault();
    const code = $("#code").value.replace(/\D/g, "");
    if (code.length < 8 || code.length > 14) return toast("A barcode has 8 to 14 digits.");
    go(code);
  };

  // ---------- product search (shared by scan + receipt) ----------
  function renderHits(container, data, onPick) {
    if (!data.items.length) { container.innerHTML = '<p class="msg">No matches. Try fewer or different words (e.g. just the brand and product type).</p>'; return; }
    container.innerHTML = (data.scope === "world" ? '<p class="msg">No Dutch matches — showing worldwide results.</p>' : "") +
      '<ul class="results">' + data.items.map((h) => `<li><a class="hit" href="#/p/${esc(h.code)}" data-code="${esc(h.code)}">
        ${safeUrl(h.image) ? `<img class="thumb" loading="lazy" src="${esc(h.image)}" alt="">` : '<span class="thumb"></span>'}
        <span class="t"><b>${esc(h.name)}</b><span>${esc([h.brands, h.quantity].filter(Boolean).join(" · "))}</span></span></a></li>`).join("") + "</ul>";
    if (onPick) container.querySelectorAll("a.hit").forEach((a) => a.addEventListener("click", () => onPick(a.dataset.code)));
  }
  async function searchInto(q, container, onPick) {
    container.innerHTML = '<p class="msg"><span class="spinner"></span> Searching Open Food Facts…</p>';
    try { renderHits(container, await api("/api/search?q=" + encodeURIComponent(q)), onPick); }
    catch (e) { container.innerHTML = `<p class="msg">${esc(e.message)}</p>`; }
  }
  $("#nameSearch").onsubmit = (e) => { e.preventDefault(); const q = $("#q").value.trim(); if (q.length >= 2) searchInto(q, $("#nameResults")); };

  // ---------- product report ----------
  async function showProduct(code) {
    const el = $("#product");
    if (!/^\d{8,14}$/.test(code)) { el.innerHTML = '<div class="empty">That is not a valid barcode.</div>'; return; }
    el.innerHTML = `<div class="empty"><span class="spinner"></span> Looking up ${esc(code)}…</div>`;
    let d;
    try { [d] = await Promise.all([api("/api/product/" + code), kbReady]); }
    catch (e) {
      if (e.status === 404) {
        el.innerHTML = `<div class="card"><h1>Product not found</h1><p>Barcode <b>${esc(code)}</b> isn't in Open Food Facts yet.</p>
          <p class="small">You can add it (takes a few minutes with the Open Food Facts app) so everyone benefits — or search by name instead.</p>
          <div class="row wrap"><a class="btn primary" href="https://world.openfoodfacts.org/product/${esc(code)}" target="_blank" rel="noopener">Add on Open Food Facts</a><a class="btn" href="#/scan">Back to scan</a></div></div>`;
      } else {
        el.innerHTML = `<div class="card"><h1>Something went wrong</h1><p>${esc(e.message)}</p><div class="row wrap"><button class="btn primary" id="retry">Try again</button><a class="btn" href="#/scan">Back</a></div></div>`;
        $("#retry").onclick = () => showProduct(code);
      }
      return;
    }
    if (location.hash !== "#/p/" + code) return; // user navigated away meanwhile
    const p = d.product;
    document.title = (p.name || code) + " — Mind Your Plate";
    const subs = d.substances.map((s) => ({ ...s, e: KB.byId[s.id] })).filter((s) => s.e);
    const flagged = new Set(subs.flatMap((s) => s.e.e || []).map((x) => x.toUpperCase()));
    hist.add({ code: p.code || code, name: p.name, brands: p.brands, image: p.image, n: subs.length, top: subs[0] ? levelOf(subs[0].e).rank : 0, t: Date.now() });

    const nsText = { a: "Very good", b: "Good", c: "Average", d: "Poor", e: "Bad" };
    const novaText = { 1: "Unprocessed or minimally processed", 2: "Processed culinary ingredient", 3: "Processed food", 4: "Ultra-processed food" };
    const noData = !p.ingredients && !d.additives.length;
    el.innerHTML = `
      <div class="card">
        <div class="phead">
          ${safeUrl(p.image) ? `<img src="${esc(p.image)}" alt="">` : ""}
          <div>
            <h1>${esc(p.name || "Unnamed product")}</h1>
            <div class="meta">${esc([p.brands, p.quantity].filter(Boolean).join(" · "))}</div>
            <div class="meta small">Barcode ${esc(p.code || code)} · <a href="https://world.openfoodfacts.org/product/${esc(p.code || code)}" target="_blank" rel="noopener">view / edit on Open Food Facts</a></div>
          </div>
        </div>
        <div class="scores">
          ${p.nutriscore ? `<div class="score"><b class="ns-${p.nutriscore}">${p.nutriscore.toUpperCase()}</b><span>Nutri-Score<br><span class="muted">${nsText[p.nutriscore]}</span></span></div>` : ""}
          ${p.nova ? `<div class="score"><b class="nova-${p.nova}">${p.nova}</b><span>NOVA group<br><span class="muted">${novaText[p.nova]}</span></span></div>` : ""}
        </div>
        ${d.stale ? '<p class="msg">Showing saved data — Open Food Facts could not be reached just now.</p>' : ""}
      </div>

      <div class="summary ${subs.length ? "has" : ""}">
        <div class="n">${subs.length}</div>
        <div>${subs.length ? `substance${subs.length > 1 ? "s" : ""} of potential interest found.<br><span class="small muted">Shown with evidence level — most are authorised in the EU at the levels used.</span>`
          : noData ? `No ingredient data yet for this product, so we can't check it.<br><span class="small muted">Help by adding the ingredients on Open Food Facts.</span>`
          : `None of the ${KB.entries.length} substances on our list were found.<br><span class="small muted">Based on the ingredient data in Open Food Facts, which may be incomplete.</span>`}</div>
      </div>

      ${subs.map((s) => substanceCard(s.e, s.matched)).join("")}

      ${d.additives.length ? `<h2>Additives (${d.additives.length})</h2><div class="card"><div class="addlist">${d.additives.map((a) =>
        `<span class="add ${flagged.has(a.code) ? "flag" : ""}" title="${esc(a.cls)}"><b>${esc(a.code)}</b>${esc(a.name || "")}</span>`).join("")}</div></div>` : ""}

      <h2>Ingredients</h2>
      <div class="card ingr">${p.ingredients ? esc(p.ingredients) : '<span class="muted">No ingredient list available.</span>'}
        ${p.allergens.length ? `<p class="small"><b>Allergens:</b> ${esc(p.allergens.map((a) => a.replace(/^[a-z]{2}:/, "").replace(/-/g, " ")).join(", "))}</p>` : ""}
      </div>
      <div class="card disclaimer small"><strong>Not medical advice.</strong> “Potential concern” means a regulator, IARC or published research has flagged a question — not that this product is unsafe. Data from Open Food Facts may be incomplete; check the package. <a href="#/about">How this works</a></div>
      <div class="row wrap"><a class="btn primary" href="#/scan">Scan another</a><a class="btn" href="#/history">History</a></div>`;
  }

  function substanceCard(e, matched) {
    const lv = levelOf(e);
    return `<article class="card sub" style="--lc: var(--l${lv.rank})">
      <div class="hd">
        <div><h3>${esc(e.name)}</h3><div class="codes">${esc([(e.e || []).map((x) => x.toUpperCase()).join(", "), e.category].filter(Boolean).join(" · "))}</div></div>
        <span class="pill lvl lv${lv.rank}" title="${esc(lv.note)}">${esc(lv.label)}</span>
      </div>
      <p>${esc(e.summary)}</p>
      ${matched ? `<div class="found">Found as: ${esc(matched.join(", "))}</div>` : ""}
      <details><summary class="small">Sources (${e.sources.length})</summary><ul>${e.sources.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a></li>`).join("")}</ul></details>
      <a class="research" href="${esc(pubmed(e.pubmed || e.name))}" target="_blank" rel="noopener">Latest research on PubMed →</a>
    </article>`;
  }

  // ---------- history view ----------
  function renderHistory() {
    const items = hist.all();
    const el = $("#historyList");
    $("#clearHistory").hidden = !items.length;
    if (!items.length) { el.innerHTML = '<div class="empty">Nothing yet. Products you look up will appear here.</div>'; return; }
    el.innerHTML = '<div class="card"><ul class="results hist">' + items.map((h) => `<li class="row">
      <a class="hit" href="#/p/${esc(h.code)}">${safeUrl(h.image) ? `<img class="thumb" loading="lazy" src="${esc(h.image)}" alt="">` : '<span class="thumb"></span>'}
      <span class="t"><b>${esc(h.name || h.code)}</b><span>${esc([h.brands, new Date(h.t).toLocaleDateString()].filter(Boolean).join(" · "))}</span></span>
      <span class="pill ${h.n ? "lvl lv" + Math.min(5, Math.max(1, h.top || 1)) : ""}">${h.n ? h.n + " flagged" : "none flagged"}</span></a>
      <button class="del" data-code="${esc(h.code)}" aria-label="Remove">×</button></li>`).join("") + "</ul></div>";
    el.querySelectorAll(".del").forEach((b) => (b.onclick = () => { hist.remove(b.dataset.code); renderHistory(); }));
  }
  let confirmClear = false;
  $("#clearHistory").onclick = (e) => {
    if (!confirmClear) { confirmClear = true; e.target.textContent = "Tap again to clear everything"; setTimeout(() => { confirmClear = false; e.target.textContent = "Clear history"; }, 3000); return; }
    confirmClear = false; e.target.textContent = "Clear history"; hist.save([]); renderHistory();
  };

  // ---------- about view ----------
  async function renderAbout() {
    await kbReady;
    $("#levels").innerHTML = Object.values(KB.levels).sort((a, b) => b.rank - a.rank).map((l) => `<div><span class="pill lvl lv${l.rank}">${esc(l.label)}</span><span>${esc(l.note)}</span></div>`).join("");
    const draw = () => {
      const f = $("#kbFilter").value.trim().toLowerCase();
      const list = KB.entries.filter((e) => !f || [e.name, e.category, ...(e.e || []), ...(e.keywords || [])].join(" ").toLowerCase().includes(f.replace(/^e\s+/, "e")))
        .sort((a, b) => levelOf(b).rank - levelOf(a).rank || a.name.localeCompare(b.name));
      $("#kbList").innerHTML = list.map((e) => substanceCard(e)).join("") || '<p class="msg">No match.</p>';
    };
    $("#kbFilter").oninput = draw;
    draw();
  }

  // ---------- receipt OCR ----------
  const SKIP = /(totaal|subtota|te betalen|betaald|bankpas|maestro|v ?pay|mastercard|contant|wisselgeld|retour|kassa|bon ?nr|bonnr|transactie|terminal|merchant|autorisatie|klant|datum|tijd:|telefoon|www\.|http|kvk|filiaal|openingstijden|bedankt|tot ziens|welkom|bonus|korting|voordeel|air ?miles|koopzegel|spaar(punt|zegel)|statiegeld|emballage|zegels|punten|aantal|artikelen|omschrijving|bedrag|kopie|leesmethode|contactloos|akkoord|saldo|\b(pin|pinnen|tel|btw|vat|eur|euro|visa|kaart|prijs|totaal)\b)/i;
  const STORES = /^(albert heijn|ah to go|jumbo|lidl|aldi|plus|dirk( van den broek)?|coop|spar|deka ?markt|vomar|hoogvliet|ekoplaza|poiesz|nettorama|boni|picnic|kruidvat|etos|action)(\s+(b\.?v\.?|supermarkt(en)?|nederland))?\s*$/i;
  function parseReceipt(text) {
    const out = [];
    for (let line of text.split(/\n+/)) {
      line = line.replace(/[|_*=~"`]+/g, " ").replace(/\s+/g, " ").trim();
      if (line.length < 4 || SKIP.test(line) || STORES.test(line)) continue;
      let name = line
        .replace(/-?\s*€?\s*\d+[.,]\s?\d{2}\s*[a-z]?\s*$/i, "")   // trailing price (+ VAT letter)
        .replace(/-?\s*€?\s*\d+[.,]\s?\d{2}\s*[a-z]?\s*$/i, "")   // unit price + total
        .replace(/^\s*\d+\s*[x×*]\s*/i, "")                          // "2 x"
        .replace(/^\s*\d{1,3}\s+(?=[a-z])/i, "")                    // leading quantity
        .replace(/\b\d+[.,]?\d*\s?(kg|gr|g|ml|cl|l|st|stk)\b/gi, "")  // weights
        .replace(/[^0-9a-zà-ÿ'&%\- ]/gi, " ").replace(/\s+/g, " ").trim();
      const letters = (name.match(/[a-zà-ÿ]/gi) || []).length;
      if (letters < 3 || letters / name.length < 0.6) continue;
      name = name.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase()).slice(0, 60);
      if (!out.includes(name)) out.push(name);
    }
    return out.slice(0, 40);
  }
  function addLine(text = "", focus = false) {
    const box = document.createElement("div");
    box.className = "card line";
    box.innerHTML = `<form class="row" autocomplete="off"><input maxlength="80" placeholder="Product name" aria-label="Product name"><button class="btn small primary" type="submit">Search</button><button class="x" type="button" aria-label="Remove line">×</button></form><div class="res"></div>`;
    const input = $("input", box); input.value = text;
    $("form", box).onsubmit = (e) => {
      e.preventDefault();
      const q = input.value.trim();
      if (q.length < 2) return toast("Type at least 2 characters.");
      searchInto(q, $(".res", box));
    };
    $(".x", box).onclick = () => box.remove();
    $("#lines").appendChild(box);
    if (focus) input.focus();
  }
  $("#addLine").onclick = () => addLine("", true);

  async function prepImage(file) {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2200 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    const ctx = c.getContext("2d");
    ctx.filter = "grayscale(1) contrast(1.4)";
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    return c;
  }
  let ocrWorker = null;
  $("#receiptInput").onchange = async (ev) => {
    const file = ev.target.files[0]; ev.target.value = "";
    if (!file) return;
    if (file.size > 25e6) return toast("That image is very large — try a smaller photo.");
    const status = $("#ocrStatus"), prog = $("#ocrProgress");
    const prev = $("#receiptPreview"); if (prev.src) URL.revokeObjectURL(prev.src);
    prev.src = URL.createObjectURL(file); prev.hidden = false;
    $("#receiptInput").disabled = true;
    try {
      status.innerHTML = '<span class="spinner"></span> Loading text recognition (first time ~10 MB)…';
      prog.hidden = false; prog.value = 0;
      await loadScript(LIBS.tesseract);
      if (!ocrWorker) {
        ocrWorker = await Tesseract.createWorker(["nld", "eng"], 1, {
          workerPath: LIBS.tesseractWorker,
          corePath: LIBS.tesseractCore,
          logger: (m) => {
            if (typeof m.progress === "number") prog.value = m.progress;
            if (m.status) status.innerHTML = '<span class="spinner"></span> ' + esc(m.status.replace(/^./, (c) => c.toUpperCase())) + "…";
          },
        });
      }
      const canvas = await prepImage(file);
      const { data } = await ocrWorker.recognize(canvas);
      const lines = parseReceipt(data.text || "");
      $("#raw").textContent = data.text || ""; $("#rawWrap").hidden = !data.text;
      $("#lines").innerHTML = "";
      if (!lines.length) status.textContent = "Couldn't find product lines. Try a flatter, well-lit photo — or add items manually.";
      else status.textContent = `Found ${lines.length} possible item${lines.length > 1 ? "s" : ""}. Receipt names are often abbreviated: edit a line if needed, then tap Search and pick the matching product.`;
      lines.forEach((l) => addLine(l));
    } catch (e) {
      console.error(e);
      status.textContent = "Text recognition failed (" + (e.message || "error") + "). You can still add items manually.";
    } finally {
      prog.hidden = true; $("#receiptInput").disabled = false;
    }
  };

  route();
})();
