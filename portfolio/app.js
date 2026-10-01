(() => {
  const P = window.PORTFOLIO;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const capById = Object.fromEntries(P.capabilities.map((c) => [c.id, c]));

  /* ── content ─────────────────────────────────────────── */
  const glyphs = {
    search: '<circle cx="19" cy="19" r="11"/><path class="g-anim" d="M27 27l11 11"/><path d="M14 19h10"/>',
    creative: '<rect x="6" y="9" width="32" height="26"/><path class="g-anim" d="M6 30l10-9 7 6 6-5 9 8"/><circle cx="30" cy="16" r="2.5"/>',
    media: '<path d="M6 38h32"/><path class="g-anim" d="M10 38V24M18 38V16M26 38V20M34 38V8"/>',
    catalog: '<rect x="6" y="6" width="13" height="13"/><rect x="25" y="6" width="13" height="13"/><rect x="6" y="25" width="13" height="13"/><path class="g-anim" d="M25 31.5h13M31.5 25v13"/>',
    launch: '<path d="M6 36h32"/><path class="g-anim" d="M8 30l9-9 6 5 13-15"/><path d="M29 11h7v7"/>',
    agents: '<circle cx="10" cy="22" r="3.5"/><circle cx="34" cy="10" r="3.5"/><circle cx="34" cy="34" r="3.5"/><path class="g-anim" d="M13 20l18-9M13 24l18 9M34 14v16"/>',
  };
  $("[data-cap-grid]").innerHTML = P.capabilities.map((c) => `
    <article class="cap" id="cap-${c.id}" data-cap="${c.id}" data-reveal>
      <div class="cap-top">
        <svg class="cap-glyph" viewBox="0 0 44 44" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">${glyphs[c.id] || ""}</svg>
        <span class="cap-pin">${esc(c.pin)}</span>
      </div>
      <div><h3>${esc(c.title)}</h3></div>
      <div class="cap-body"><p>${esc(c.summary)}</p><ul>${c.proof.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>
      <div class="tags">${c.tools.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>
    </article>`).join("");

  const words = ["Search relevance", "Query understanding", "Merchandising", "AI image pipelines", "Veo video", "Google Ads", "Microsoft Ads", "Merchant Center", "NetSuite", "Catalog QA", "Launch operations", "Agent design"];
  const marquee = $("[data-marquee]");
  marquee.innerHTML = (reduce ? words : words.concat(words)).map((w) => `<span>${esc(w)}</span>`).join("");

  const commits = $("[data-commits]");
  commits.innerHTML = (reduce ? P.commits : P.commits.concat(P.commits)).map((c) => `<span class="commit"><i>●</i>${esc(c)}</span>`).join("");

  $("[data-count-caps]").textContent = P.capabilities.length;
  $("[data-count-shipped]").textContent = P.shipped.length;
  $("[data-email]").textContent = P.email;
  $("[data-github]").href = P.github;
  $("[data-year]").textContent = new Date().getFullYear();

  /* shipped list + filters */
  const list = $("[data-ship-list]");
  list.innerHTML = P.shipped.map((s) => `
    <li class="ship" data-cap="${s.cap}">
      <h3>${esc(s.title)}</h3>
      <span class="tag">${esc(capById[s.cap] ? capById[s.cap].pin : s.cap)}</span>
      <p>${esc(s.text)}</p>
    </li>`).join("");
  const bar = $("[data-ship-filters]");
  bar.innerHTML = [`<button type="button" data-f="all" aria-pressed="true">All <span>${P.shipped.length}</span></button>`]
    .concat(P.capabilities.map((c) => `<button type="button" data-f="${c.id}" aria-pressed="false">${esc(c.pin)} <span>${P.shipped.filter((s) => s.cap === c.id).length}</span></button>`))
    .join("");
  bar.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    $$("button", bar).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    const f = b.dataset.f;
    $$(".ship", list).forEach((row) => {
      const show = f === "all" || row.dataset.cap === f;
      if (show) {
        row.hidden = false;
        requestAnimationFrame(() => row.classList.remove("is-out"));
      } else {
        row.classList.add("is-out");
        setTimeout(() => { if (row.classList.contains("is-out")) row.hidden = true; }, reduce ? 0 : 300);
      }
    });
  });


  /* ── proof band ──────────────────────────────────────── */
  const numText = (v, d) => (d ? v.toFixed(d) : String(Math.round(v)));
  $("[data-proof]").innerHTML = P.proof.map((p, i) => {
    const ratio = p.of ? p.value / p.of : p.unit === "%" ? p.value / 100 : null;
    return `
    <article class="proof" data-reveal style="transition-delay:${(i % 4) * 70}ms">
      <div class="proof-n"><span data-count="${p.value}" data-decimals="${p.decimals || 0}">${numText(p.value, p.decimals)}</span>${p.of ? `<small>/${p.of}</small>` : p.unit ? `<small>${esc(p.unit)}</small>` : ""}</div>
      <div class="proof-l">${esc(p.label)}</div>
      <p class="proof-note">${esc(p.note)}</p>
      ${ratio !== null ? `<div class="proof-bar" aria-hidden="true"><i style="width:${ratio * 100}%"></i></div>` : ""}
      <span class="src">${esc(p.source)}</span>
    </article>`;
  }).join("");

  /* ── attributes ──────────────────────────────────────── */
  $("[data-attributes]").innerHTML = P.attributes.map((a, i) => `
    <article class="attr" data-reveal style="transition-delay:${(i % 3) * 80}ms">
      <h3>${esc(a.title)}</h3>
      <p>${esc(a.text)}</p>
      <blockquote>${esc(a.evidence)}</blockquote>
      <span class="src">${esc(a.source)}</span>
    </article>`).join("");

  /* ── compass: timeline, checks, bugs, toolbox ───────── */
  $("[data-timeline]").innerHTML = P.timeline.map((t) => `
    <li class="tl">
      <div class="tl-day">${esc(t.day)}<span>${t.commits} commits</span></div>
      <h3>${esc(t.title)}</h3>
      <p>${esc(t.text)}</p>
      <div class="tl-meter" aria-hidden="true">${Array.from({ length: t.commits }, (_, k) => `<i style="transition-delay:${k * 35}ms"></i>`).join("")}</div>
    </li>`).join("");

  $("[data-checks]").innerHTML = P.checks.map((c, i) => `
    <li class="${c.open ? "is-open" : ""}" style="transition-delay:${i * 60}ms">
      <span class="${c.open ? "mark-open" : "mark-ok"}" aria-hidden="true">${c.open ? "" : "✓"}</span>
      <b><span class="sr-only">${c.open ? "Open: " : "Passing: "}</span>${esc(c.text)}</b>
      <small>${esc(c.evidence)}</small>
    </li>`).join("");

  $("[data-bugs]").innerHTML = P.bugs.map((b) => `<li><b>${esc(b.title)}</b><p>${esc(b.text)}</p></li>`).join("");

  $("[data-toolbox]").innerHTML = P.toolbox.map((g, i) => `
    <div class="tool" data-reveal style="transition-delay:${(i % 3) * 70}ms">
      <h3>${esc(g.group)}</h3>
      <ul>${g.items.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
    </div>`).join("");

  /* ── charts ──────────────────────────────────────────── */
  const ms = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : v < 10 ? `${v} ms` : `${Math.round(v)} ms`);
  const table = (head, rows) => `<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;

  // latency: p95 bar per path, a tick at its target, shared 0–120 ms axis
  const LMAX = 120, lticks = [0, 20, 40, 60, 80, 100, 120];
  const lx = (v) => (v / LMAX) * 100;
  const gridLines = (ticks, f) => ticks.map((t) => `<span class="grid-line" style="left:${f(t)}%"></span>`).join("");
  $("[data-latency]").innerHTML = P.latency.map((r) => `
    <div class="chart-row" data-tip="<b>${esc(r.path)}</b>p95 ${r.p95} ms · p50 ${r.p50} ms<br>target under ${r.target} ms">
      <span class="chart-label">${esc(r.path)}</span>
      <div class="track">
        ${gridLines(lticks, lx)}
        <span class="bar" style="width:${lx(r.p95)}%"></span>
        <span class="target" style="left:${lx(r.target)}%"></span>
        <span class="bar-v" style="left:${lx(r.p95)}%">${Math.round(r.p95)} ms</span>
      </div>
    </div>`).join("") + `
    <div class="axis"><span></span><div class="axis-ticks">${lticks.map((t) => `<span style="left:${lx(t)}%">${t}${t === LMAX ? " ms" : ""}</span>`).join("")}</div></div>
    <div class="chart-key"><span><i></i>Target for that path</span><span>Cached repeats answer in under 0.1 ms</span></div>`;
  $("[data-latency-table]").innerHTML = table(["Path", "p50 ms", "p95 ms", "Target ms"], P.latency.map((r) => [esc(r.path), r.p50, r.p95, `< ${r.target}`]));

  // speedups: dumbbell on a log axis, before → after
  const LO = Math.log10(0.5), HI = Math.log10(10000);
  const sx = (v) => ((Math.log10(v) - LO) / (HI - LO)) * 100;
  const sticks = [1, 10, 100, 1000, 10000];
  const factor = (b, a) => { const f = b / a; return f >= 10 ? Math.round(f) : f.toFixed(1); };
  $("[data-speedups]").innerHTML = P.speedups.map((r) => `
    <div class="chart-row" data-tip="<b>${esc(r.what)}</b>${ms(r.before)} → ${ms(r.after)}<br>${factor(r.before, r.after)}× faster">
      <span class="chart-label">${esc(r.what)}</span>
      <div class="track">
        ${gridLines(sticks, sx)}
        <span class="link" style="left:${sx(r.after)}%;width:${sx(r.before) - sx(r.after)}%"></span>
        <span class="dot before" style="left:${sx(r.before)}%"></span>
        <span class="dot after" style="--from:${sx(r.before)}%;--to:${sx(r.after)}%"></span>
      </div>
      <span class="x">${factor(r.before, r.after)}×<small>${ms(r.before)} → ${ms(r.after)}</small></span>
    </div>`).join("") + `
    <div class="axis"><span></span><div class="axis-ticks">${sticks.map((t) => `<span style="left:${sx(t)}%">${t >= 1000 ? t / 1000 + " s" : t + " ms"}</span>`).join("")}</div><span></span></div>`;
  $("[data-speedups-table]").innerHTML = table(["Fix", "Before", "After", "Faster"], P.speedups.map((r) => [esc(r.what), ms(r.before), ms(r.after), `${factor(r.before, r.after)}×`]));

  // one tooltip for every chart row
  const tip = $("[data-tooltip]");
  const moveTip = (e) => {
    const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
    let x = e.clientX + pad, y = e.clientY + pad;
    if (x + w > innerWidth - 8) x = e.clientX - w - pad;
    if (y + h > innerHeight - 8) y = e.clientY - h - pad;
    tip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
  };
  $$(".chart-row[data-tip]").forEach((row) => {
    row.addEventListener("pointerenter", (e) => { tip.innerHTML = row.dataset.tip; tip.hidden = false; moveTip(e); });
    row.addEventListener("pointermove", moveTip);
    row.addEventListener("pointerleave", () => { tip.hidden = true; });
  });
  addEventListener("scroll", () => { tip.hidden = true; }, { passive: true });

  /* ── reveal on scroll ────────────────────────────────── */
  if (!reduce && "IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) { en.target.classList.remove("is-pending"); io.unobserve(en.target); }
      });
    }, { rootMargin: "0px 0px -8% 0px" });
    $$("[data-reveal]").forEach((el) => {
      if (el.getBoundingClientRect().top > innerHeight * 0.95) {
        el.classList.add("is-pending");
        io.observe(el);
      }
    });
  }

  /* counters count up the first time they come into view (values are correct at rest) */
  if (!reduce && "IntersectionObserver" in window) {
    const cio = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (!en.isIntersecting) return;
        cio.unobserve(en.target);
        const el = en.target, end = +el.dataset.count, d = +(el.dataset.decimals || 0), t0 = performance.now(), dur = 1500;
        const tick = (now) => {
          const k = Math.min(1, (now - t0) / dur);
          el.textContent = numText(end * (1 - Math.pow(1 - k, 3)), d);
          if (k < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    }, { threshold: 0.6 });
    $$("[data-count]").forEach((el) => { if (el.getBoundingClientRect().top > innerHeight) cio.observe(el); });
  }

  /* spotlight that follows the pointer on capability cards */
  $$(".cap").forEach((card) => {
    card.addEventListener("pointermove", (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty("--mx", `${e.clientX - r.left}px`);
      card.style.setProperty("--my", `${e.clientY - r.top}px`);
    });
  });

  /* ── nav: solid on scroll, progress bar, active link ─── */
  const nav = $(".nav"), prog = $("[data-progress]");
  const links = $$("[data-nav]");
  const sections = links.map((a) => $(a.getAttribute("href")));
  let ticking = false;
  const onScroll = () => {
    ticking = false;
    const y = scrollY, max = document.documentElement.scrollHeight - innerHeight;
    nav.classList.toggle("is-solid", y > 40);
    prog.style.transform = `scaleX(${max > 0 ? y / max : 0})`;
    let active = -1;
    sections.forEach((s, i) => { if (s && s.getBoundingClientRect().top < innerHeight * 0.4) active = i; });
    links.forEach((a, i) => a.classList.toggle("is-active", i === active));
  };
  addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } }, { passive: true });
  onScroll();

  /* ── copy email ──────────────────────────────────────── */
  const status = $("[data-copy-status]");
  $("[data-copy]").addEventListener("click", () => {
    const el = $("[data-email]");
    const selectIt = () => {
      const r = document.createRange(); r.selectNodeContents(el);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      status.textContent = "Selected. Press Ctrl+C or ⌘C to copy.";
    };
    try {
      navigator.clipboard.writeText(P.email).then(() => { status.textContent = "Copied to your clipboard."; }, selectIt);
    } catch (e) { selectIt(); }
  });

  /* ── query analyzer ──────────────────────────────────────
     A small rebuild of the Compass approach: route the query, pull out
     dimensions, match phrases longest-first, correct typos, keep the rest
     as ranking text. */
  const VOCAB = {
    type: {
      beam: ["beam", "beams", "faux beam", "faux beams", "ceiling beam", "ceiling beams", "mantel beam", "mantel beams"],
      corbel: ["corbel", "corbels"],
      mantel: ["mantel", "mantels", "mantle", "mantles", "fireplace mantel", "fireplace mantels"],
      shutter: ["shutter", "shutters", "louver", "louvers", "louvered"],
      bracket: ["bracket", "brackets"],
      medallion: ["medallion", "medallions", "ceiling medallion", "ceiling medallions"],
      column: ["column", "columns", "pillar", "pillars"],
      moulding: ["moulding", "mouldings", "molding", "moldings", "trim"],
      "gable vent": ["gable vent", "gable vents"],
    },
    finish: {
      black: ["black"], white: ["white"], primed: ["primed"], walnut: ["walnut"], oak: ["oak"],
      espresso: ["espresso"], natural: ["natural"], "aged pecan": ["aged pecan", "pecan"],
      gray: ["gray", "grey"], unfinished: ["unfinished", "raw"],
    },
    material: { polyurethane: ["polyurethane", "poly", "urethane"], "faux wood": ["faux"], cedar: ["cedar"], pvc: ["pvc", "vinyl"], wood: ["wood", "wooden"] },
    style: {
      "hand hewn": ["hand hewn", "hand-hewn", "handhewn"], "rough sawn": ["rough sawn", "rough-sawn"], rustic: ["rustic"],
      smooth: ["smooth"], farmhouse: ["farmhouse"], traditional: ["traditional"], craftsman: ["craftsman"], modern: ["modern"],
    },
  };
  const STOP = new Set(["a", "an", "the", "for", "with", "and", "in", "of", "to", "my", "on", "over", "above", "under", "that", "some", "i", "need"]);
  const PHRASES = [];
  for (const kind in VOCAB) for (const canon in VOCAB[kind]) for (const p of VOCAB[kind][canon]) PHRASES.push({ words: p.split(" "), kind, canon, text: p });
  PHRASES.sort((a, b) => b.words.length - a.words.length);
  const SINGLE = PHRASES.filter((p) => p.words.length === 1);

  const lev = (a, b) => {
    const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i]);
    for (let j = 1; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[m][n];
  };
  const num = (s) => {
    s = s.trim();
    const mixed = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
    if (mixed) return +mixed[1] + mixed[2] / mixed[3];
    const frac = s.match(/^(\d+)\/(\d+)$/);
    if (frac) return frac[1] / frac[2];
    return parseFloat(s);
  };
  const unitOf = (u) => {
    if (!u) return null;
    u = u.trim().toLowerCase();
    if (u === "'" || /^-?\s*(ft|feet|foot)$/.test(u)) return "ft";
    return "in";
  };
  const fmt = (n) => (Math.round(n * 100) / 100).toString();
  const N = "(\\d+(?:\\.\\d+)?(?:\\s+\\d+\\/\\d+)?|\\d+\\/\\d+)";
  const U = "(\\s*(?:\"|''|inches\\b|inch\\b|in\\b|'|ft\\b|feet\\b|foot\\b|-foot\\b|-ft\\b))?";
  const X = "\\s*(?:x|×|\\*|by)\\s*";
  const RE_CROSS = new RegExp(N + U + X + N + U + "(?:" + X + N + U + ")?", "i");
  const RE_LEN = new RegExp(N + "(\\s*-?\\s*(?:\"|''|inches\\b|inch\\b|in\\b|'|ft\\b|feet\\b|foot\\b))", "i");
  const RE_PART = /^(?=(?:.*\d){2})(?=(?:.*[a-z]){2})[a-z0-9-]{6,}$/i;

  function analyze(raw) {
    let q = raw.toLowerCase().replace(/[″“”]/g, '"').replace(/[′‘’]/g, "'").replace(/\s+/g, " ").trim();
    const out = { route: "Keyword", why: "", tokens: [], filters: [], notes: [], rank: [] };
    if (!q) { out.route = "Empty"; out.why = "Type a query to see how it is read."; return out; }

    if (!q.includes(" ") && RE_PART.test(q) && !/^[\d.]+(x[\d.]+)+$/.test(q)) {
      out.route = "Part number";
      out.why = "Exact match pinned first, then near part numbers";
      out.tokens.push({ kind: "part", label: "part no.", text: raw.trim().toUpperCase() });
      out.filters.push(["sku", raw.trim().toUpperCase()]);
      out.notes.push("No typo tolerance on part numbers: a near-miss SKU is a different product.");
      const dims = q.match(/(\d{2})x(\d{2})x(\d{2,3})/i);
      if (dims) out.notes.push(`Pattern looks like ${+dims[1]}″ × ${+dims[2]}″ × ${+dims[3]}″, so partial matches rank by those sizes.`);
      return out;
    }

    const dims = {};
    const cross = q.match(RE_CROSS);
    if (cross) {
      const vals = [[cross[1], cross[2]], [cross[3], cross[4]], [cross[5], cross[6]]].filter((v) => v[0]);
      const names = ["width", "height", "length"];
      vals.forEach(([v, u], i) => {
        let n = num(v), unit = unitOf(u);
        if (!unit && i === 2 && n <= 24) { unit = "ft"; out.notes.push(`Read the third number, ${fmt(n)}, as feet. A ${fmt(n)}-inch beam is not something this catalogue sells.`); }
        if (!unit) unit = "in";
        const inches = unit === "ft" ? n * 12 : n;
        dims[names[i]] = { inches, said: `${v.trim()}${u ? u.trim() : ""}` };
      });
      out.tokens.push({ kind: "dimension", label: vals.length === 3 ? "w × h × l" : "w × h", text: cross[0].trim() });
      q = q.replace(cross[0], " ");
    }
    let len = q.match(RE_LEN);
    while (len) {
      const n = num(len[1]), unit = unitOf(len[2]);
      const inches = unit === "ft" ? n * 12 : n;
      const key = !dims.length && (unit === "ft" || inches > 30) ? "length" : !dims.width ? "width" : "length";
      dims[key] = { inches, said: len[0].trim() };
      out.tokens.push({ kind: "dimension", label: key, text: len[0].trim() });
      q = q.replace(len[0], " ");
      len = q.match(RE_LEN);
    }

    const words = q.split(/[\s,]+/).filter(Boolean);
    const found = {};
    let hasStop = false;
    // The first product type filters; a second one ("corbel for a mantel") is context that ranks.
    const keep = (tok, canon) => {
      if (!found[tok.kind]) { found[tok.kind] = canon; return; }
      if (found[tok.kind] === canon) return;
      tok.label = "context";
      out.rank.push(canon);
      if (tok.kind === "type") out.notes.push(`Kept “${found.type}” as the product and used “${canon}” as context for ranking.`);
    };
    for (let i = 0; i < words.length;) {
      let hit = null;
      for (const p of PHRASES) {
        if (p.words.every((w, k) => words[i + k] === w)) { hit = p; break; }
      }
      if (hit) {
        const said = hit.text;
        const tok = { kind: hit.kind, label: hit.kind, text: said };
        if (!said.includes(hit.canon)) { tok.was = said; tok.text = hit.canon; }
        out.tokens.push(tok);
        keep(tok, hit.canon);
        if (/^ceiling beams?$/.test(said)) out.notes.push("Read “ceiling beams” as the beam product type, not the ceiling aisle.");
        if (tok.was) out.notes.push(`Treated “${said}” as “${hit.canon}”.`);
        i += hit.words.length;
        continue;
      }
      const w = words[i];
      if (STOP.has(w)) { hasStop = true; out.tokens.push({ kind: "stop", label: "ignored", text: w }); i++; continue; }
      let best = null, bestD = 9;
      if (w.length >= 4) for (const p of SINGLE) {
        const d = lev(w, p.text);
        if (d < bestD) { bestD = d; best = p; }
      }
      if (best && bestD <= (w.length >= 7 ? 2 : 1)) {
        const tok = { kind: best.kind, label: best.kind, text: best.canon, was: w };
        out.tokens.push(tok);
        keep(tok, best.canon);
        out.notes.push(`Corrected “${w}” to “${best.text}” (${bestD} edit${bestD > 1 ? "s" : ""}).`);
      } else {
        out.tokens.push({ kind: "keyword", label: "ranks", text: w });
        out.rank.push(w);
      }
      i++;
    }

    for (const k of ["type", "finish", "material", "style"]) if (found[k]) out.filters.push([k, found[k]]);
    for (const k of ["width", "height", "length"]) if (dims[k]) {
      const i = dims[k].inches;
      out.filters.push([k, `${fmt(i)} in` + (i >= 24 && i % 12 === 0 ? `  (${i / 12} ft)` : "")]);
    }
    if (out.rank.length) out.filters.push(["rank by", `"${out.rank.join(" ")}"`]);

    const nAttr = Object.keys(found).length;
    if (Object.keys(dims).length) { out.route = "Dimensional"; out.why = "Sizes become numeric filters, matched in any unit"; }
    else if (nAttr >= 2 || hasStop) { out.route = "Natural language"; out.why = "Attributes become filters; leftover words rank"; }
    else { out.route = "Keyword"; out.why = "Text match with typo tolerance"; }
    if (dims.length && found.type === "beam") out.notes.push("Lengths are compared in inches, so 12ft, 12', 12 foot and 144\" find the same beam.");
    return out;
  }

  const input = $("#q");
  const routeEl = $("[data-route]"), tokEl = $("[data-tokens]"), filEl = $("[data-filters]"), noteEl = $("[data-notes]");
  const render = () => {
    const r = analyze(input.value);
    routeEl.innerHTML = `<b>${esc(r.route)}</b><span>${esc(r.why)}</span>`;
    tokEl.innerHTML = r.tokens.map((t, i) => `
      <span class="tok" data-kind="${t.kind}" style="animation-delay:${i * 40}ms">
        <small>${esc(t.label)}</small>${t.was ? `<span><s>${esc(t.was)}</s> → ${esc(t.text)}</span>` : `<span>${esc(t.text)}</span>`}
      </span>`).join("");
    const pad = Math.max(0, ...r.filters.map((f) => f[0].length));
    filEl.innerHTML = r.filters.length
      ? r.filters.map(([k, v]) => `<span class="k">${esc(k.padEnd(pad))}</span>  =  <span class="v">${esc(v)}</span>`).join("\n")
      : `<span class="k">no filters yet</span>`;
    noteEl.innerHTML = r.notes.map((n) => `<li>${esc(n)}</li>`).join("");
    $$("[data-examples] button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.q === input.value)));
  };
  input.addEventListener("input", render);
  $("[data-examples]").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    input.value = b.dataset.q;
    render();
  });
  render();

  /* ── pipeline simulation ─────────────────────────────── */
  const pipe = $("[data-pipe]"), track = $("[data-pipe-track]"), packet = $("[data-packet]"), log = $("[data-pipe-log]");
  const nodes = $$("[data-stage]", track);
  const names = ["research", "brief", "generate", "evaluate", "deliver"];
  const steps = [
    { s: 0, msg: "Harvested product photos, line drawings and the install guide" },
    { s: 1, msg: "Seven slides, each a different room and a different customer problem" },
    { s: 2, msg: "Slide 4: three options rendered from the real product photo" },
    { s: 3, tone: "fail", msg: "FAIL slide 4: finish reads glossy, the real product is matte. Regenerate with the matte reference." },
    { s: 2, msg: "Slide 4 regenerated with the matte finish reference" },
    { s: 3, tone: "pass", msg: "PASS slide 4: finish, bracket count and scale match the real photos" },
    { s: 4, msg: "Final set attached to the product's launch task" },
  ];
  let step = 0, clock = 0, timer = null;
  const place = (i) => {
    const n = nodes[i], tr = track.getBoundingClientRect(), r = n.getBoundingClientRect();
    const vertical = getComputedStyle(track).gridTemplateColumns.split(" ").length === 1;
    const x = vertical ? 22 + 1 : r.left - tr.left + r.width / 2;
    const y = vertical ? r.top - tr.top + 22 : 22;
    packet.style.transform = `translate(${x}px, ${y}px)`;
  };
  const addLog = (st) => {
    clock += 3 + (st.s === 2 ? 9 : st.s === 3 ? 4 : 2);
    const t = `00:${String(clock).padStart(2, "0")}`;
    const li = document.createElement("li");
    li.innerHTML = `<span class="t">${t}</span><span class="s ${st.tone || ""}">${names[st.s]}</span><span class="${st.tone || ""}">${esc(st.msg)}</span>`;
    log.prepend(li);
    while (log.children.length > 5) log.lastChild.remove();
  };
  const show = (st) => {
    nodes.forEach((n, i) => {
      n.classList.toggle("is-on", i === st.s);
      n.classList.remove("is-fail", "is-pass");
    });
    if (st.tone) nodes[st.s].classList.add(`is-${st.tone}`);
    packet.classList.toggle("is-fail", st.tone === "fail");
    packet.classList.toggle("is-pass", st.tone === "pass");
    place(st.s);
    addLog(st);
  };
  const advance = () => {
    show(steps[step]);
    step = (step + 1) % steps.length;
    if (step === 0) { clock = 0; }
    timer = setTimeout(advance, step === 0 ? 3600 : 1900);
  };
  if (reduce) {
    steps.forEach(show);
  } else if ("IntersectionObserver" in window) {
    new IntersectionObserver(([en]) => {
      if (en.isIntersecting && !timer) advance();
      else if (!en.isIntersecting && timer) { clearTimeout(timer); timer = null; }
    }, { threshold: 0.25 }).observe(pipe);
    show(steps[0]); step = 1;
  } else {
    advance();
  }
  addEventListener("resize", () => place(steps[(step + steps.length - 1) % steps.length].s));

  /* hovering a capability card lights the matching pin on the frame */
  $$(".cap").forEach((card) => {
    card.addEventListener("pointerenter", () => window.dispatchEvent(new CustomEvent("cap:hot", { detail: card.dataset.cap })));
    card.addEventListener("pointerleave", () => window.dispatchEvent(new CustomEvent("cap:hot", { detail: null })));
  });
})();
