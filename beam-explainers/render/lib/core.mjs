// Shared drawing kit for the beam explainer videos: fonts, brand, easing, layout, real-photo
// handling (product shots on white are multiplied onto the paper so they sit on the page), and the
// small set of components every scene uses. Everything is drawn with the Canvas 2D API.
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RENDER = path.resolve(HERE, '..');
export const ROOT = path.resolve(RENDER, '..');
export const IMG = path.join(ROOT, 'img');
export const FPS = 60;

export const BRAND = JSON.parse(fs.readFileSync(path.join(RENDER, 'brand.json'), 'utf8'));
export const FACTS = JSON.parse(fs.readFileSync(path.join(ROOT, 'research', 'facts.json'), 'utf8'));

// ---- fonts ----------------------------------------------------------------------------------------
const FONT_DIR = path.join(RENDER, 'node_modules', '@fontsource');
for (const [fam, w] of [['poppins', 500], ['poppins', 600], ['poppins', 700], ['figtree', 400], ['figtree', 500], ['figtree', 600], ['figtree', 700]]) {
  GlobalFonts.registerFromPath(path.join(FONT_DIR, fam, 'files', `${fam}-latin-${w}-normal.woff2`), `${fam === 'poppins' ? 'P' : 'F'}${w}`);
}
export const font = (fam, w, px) => `${Math.round(px)}px ${fam}${w}`; // fam 'P' (Poppins) or 'F' (Figtree)

// ---- maths ----------------------------------------------------------------------------------------
export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const ease = {
  out: t => 1 - Math.pow(1 - clamp(t), 3),
  inOut: t => { t = clamp(t); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; },
  in: t => Math.pow(clamp(t), 3),
  back: t => { t = clamp(t); const c = 1.4; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
};
/** Progress 0..1 of an animation that starts at t0 and lasts d seconds, eased. */
export const prog = (t, t0, d = 0.5, fn = ease.out) => fn((t - t0) / d);

// ---- word cues --------------------------------------------------------------------------------------
const normWord = w => w.toLowerCase().replace(/[^a-z0-9]/g, '');
/**
 * Time (scene seconds) the narration says `phrase`, searched after `after` seconds. Falls back to
 * `fallback` when Whisper spelled it differently. `alts` are other spellings to accept.
 */
export function cue(scene, phrase, { after = 0, fallback = null, alts = [] } = {}) {
  const words = scene.words || [];
  for (const p of [phrase, ...alts]) {
    const want = p.split(/\s+/).map(normWord).filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      if (words[i].t0 < after) continue;
      let ok = true;
      for (let j = 0; j < want.length; j++) {
        const w = words[i + j] && normWord(words[i + j].w);
        if (!w || !(w === want[j] || (j === want.length - 1 && w.startsWith(want[j])))) { ok = false; break; }
      }
      if (ok) return words[i].t0;
    }
  }
  if (fallback === null) throw new Error(`cue not found in ${scene.id}: "${phrase}"`);
  return fallback;
}
/**
 * How "on" item i of a spoken list is (0..1): it fades in at its cue and out at the next item's cue,
 * so highlights never switch in a single frame.
 */
export function onAmt(ts, i, st, d = 0.3) {
  const a = ease.inOut(clamp((st - (ts[i] - 0.15)) / d));
  const b = i + 1 < ts.length ? ease.inOut(clamp((st - (ts[i + 1] - 0.15)) / d)) : 0;
  return a * (1 - b);
}
/** 0..1: how far item i of a spoken list has faded in (starts just before its cue). */
// Ease-in-out over half a second: starts and ends at zero speed, so a dissolve never reads as a cut.
export const inAmt = (ts, i, st, d = 0.5) => ease.inOut(clamp((st - (ts[i] - 0.15)) / d));
/**
 * Crossfade weights for a spoken list: [intro, item0, item1, …]. Each depends only on time, so
 * overlapping fades (names said close together) blend instead of jumping. Weights sum to ≤ 1.
 */
export function listWeights(ts, st, introA = 1, d = 0.5) {
  const ins = ts.map((_, i) => inAmt(ts, i, st, d));
  const w = [introA * (1 - (ins[0] ?? 0))];
  ins.forEach((v, i) => w.push(v * (1 - (i + 1 < ins.length ? ins[i + 1] : 0))));
  return w;
}
/**
 * For opaque pictures: the items to draw bottom-to-top with their alpha. Starts from the last item
 * that is fully in, so nothing underneath bleeds through.
 */
export function listStack(ts, st, d = 0.5) {
  const ins = ts.map((_, i) => inAmt(ts, i, st, d));
  let k = -1;
  ins.forEach((v, i) => { if (v >= 1) k = i; });
  const out = [{ i: k, a: 1 }];
  for (let i = k + 1; i < ts.length; i++) if (ins[i] > 0) out.push({ i, a: ins[i] });
  return out; // i = -1 means the intro picture
}

/** Opacity of item i in a list that dims the not-yet-named items once the list starts: 1 → lo → 1. */
export function litAmt(ts, i, st, lo = 0.55, d = 0.35) {
  if (i === 0) return 1;
  const dim = ease.inOut(clamp((st - (ts[0] - 0.15)) / d)), back = ease.inOut(clamp((st - (ts[i] - 0.15)) / d));
  return 1 - (1 - lo) * dim * (1 - back);
}
/** Mix two #rrggbb colours. */
export function mix(c1, c2, t) {
  const a = c1.match(/\w\w/g).map(h => parseInt(h, 16)), b = c2.match(/\w\w/g).map(h => parseInt(h, 16));
  return '#' + a.map((v, k) => Math.round(lerp(v, b[k], clamp(t))).toString(16).padStart(2, '0')).join('');
}
/** A rounded ring drawn on its own, so it can fade. */
export function ring(g, x, y, w, h, r, { color = '#2A5240', lw = 5, alpha = 1 } = {}) {
  if (alpha <= 0) return;
  g.save(); g.globalAlpha *= alpha; rr(g, x, y, w, h, r); g.lineWidth = lw; g.strokeStyle = color; g.stroke(); g.restore();
}

/** Cues for a list of phrases spoken in order; each searched after the previous one. */
export function cues(scene, phrases, opts = {}) {
  let after = opts.after ?? 0;
  return phrases.map(p => {
    const [phrase, alts] = Array.isArray(p) ? [p[0], p.slice(1)] : [p, []];
    const t = cue(scene, phrase, { after, alts, fallback: after + 0.8 });
    after = t + 0.05;
    return t;
  });
}

// ---- layout -----------------------------------------------------------------------------------------
export function layout(W, H) {
  const P = H > W;
  const u = Math.min(W, H) / 1080;
  const m = P ? 80 * u : 110 * u;
  return {
    W, H, P, u, m,
    headY: P ? 250 * u : 150 * u,           // baseline of the headline
    headSize: P ? 86 * u : 76 * u,
    kickSize: P ? 30 * u : 26 * u,
    bodyY: P ? 470 * u : 300 * u,            // top of the content area
    bodyB: P ? H - 230 * u : H - 130 * u,    // bottom of the content area
  };
}

// ---- images ------------------------------------------------------------------------------------------
const cache = new Map();
/** Load an image (path relative to img/). Product shots get their non-white bounding box measured. */
export async function img(rel, { maxSide = 1400, bbox = false } = {}) {
  const key = rel + '|' + maxSide;
  if (cache.has(key)) return cache.get(key);
  const full = path.join(IMG, rel);
  const src = await loadImage(fs.readFileSync(full));
  let im = src;
  const s = Math.min(1, maxSide / Math.max(src.width, src.height));
  if (s < 1) {
    const c = createCanvas(Math.round(src.width * s), Math.round(src.height * s));
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    im = c;
  }
  const rec = { im, w: im.width, h: im.height, rel };
  if (bbox) {
    const c = createCanvas(200, Math.round(200 * im.height / im.width));
    const g = c.getContext('2d');
    g.drawImage(im, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4;
      if (d[i] < 236 || d[i + 1] < 236 || d[i + 2] < 236) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    const k = im.width / c.width;
    rec.bb = x1 > x0 ? { x: x0 * k, y: y0 * k, w: (x1 - x0 + 1) * k, h: (y1 - y0 + 1) * k } : { x: 0, y: 0, w: im.width, h: im.height };
  }
  cache.set(key, rec);
  return rec;
}
export const product = rel => img(rel, { maxSide: 1200, bbox: true });
/** One content box covering every photo in a set (same studio shot, different finish or texture). */
export function unionBox(recs) {
  const x0 = Math.min(...recs.map(r => r.bb.x)), y0 = Math.min(...recs.map(r => r.bb.y));
  const x1 = Math.max(...recs.map(r => r.bb.x + r.bb.w)), y1 = Math.max(...recs.map(r => r.bb.y + r.bb.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
/** A drawn right arrow (the brand fonts have no arrow glyph). */
export function arrow(g, x0, y, x1, { color = '#6B6A63', lw = 3, head = 10 } = {}) {
  g.save(); g.strokeStyle = color; g.lineWidth = lw; g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.moveTo(x1 - head, y - head * 0.8); g.lineTo(x1, y); g.lineTo(x1 - head, y + head * 0.8); g.stroke();
  g.restore();
}
/** Centered label wrapped onto at most two lines. */
export function label2(g, s, x, y, maxW, { f, color, lh = 1.15, size = 22, alpha = 1 } = {}) {
  const lines = wrap(g, s, f, maxW).slice(0, 2);
  lines.forEach((ln, i) => text(g, ln, x, y + i * size * lh, { f, color, align: 'center', alpha }));
  return lines.length;
}

/** Draw an image to cover a rect (crop), with zoom and pan (−1..1) for slow camera moves. */
export function cover(g, rec, x, y, w, h, { zoom = 1, px = 0, py = 0, alpha = 1, r = 0, src = null } = {}) {
  // src: crop to this part of the image first (e.g. a photo letterboxed inside a white square).
  const sb = src || { x: 0, y: 0, w: rec.w, h: rec.h };
  const s = Math.max(w / sb.w, h / sb.h) * zoom;
  const dw = sb.w * s, dh = sb.h * s;
  const ox = x + (w - dw) / 2 + px * (dw - w) / 2, oy = y + (h - dh) / 2 + py * (dh - h) / 2;
  g.save();
  g.globalAlpha *= alpha;
  if (r) { rr(g, x, y, w, h, r); g.clip(); } else { g.beginPath(); g.rect(x, y, w, h); g.clip(); }
  g.drawImage(rec.im, sb.x, sb.y, sb.w, sb.h, ox, oy, dw, dh);
  g.restore();
}

/**
 * A product photo shot on white, fitted by its content box into (x, y, w, h) and multiplied onto
 * whatever is underneath, so the white disappears and the beam sits on the page.
 */
export function productFit(g, rec, x, y, w, h, { alpha = 1, scale = 1, multiply = true, align = 'center', bb = null } = {}) {
  bb = bb || rec.bb || { x: 0, y: 0, w: rec.w, h: rec.h };
  const s = Math.min(w / bb.w, h / bb.h) * scale;
  const dw = bb.w * s, dh = bb.h * s;
  const dx = align === 'left' ? x : x + (w - dw) / 2, dy = y + (h - dh) / 2;
  g.save();
  g.globalAlpha *= alpha;
  if (multiply) g.globalCompositeOperation = 'multiply';
  g.drawImage(rec.im, bb.x, bb.y, bb.w, bb.h, dx, dy, dw, dh);
  g.restore();
  return { x: dx, y: dy, w: dw, h: dh };
}

// ---- shapes & text ------------------------------------------------------------------------------------
export function rr(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
/** White card with a soft shadow. */
export function card(g, x, y, w, h, { r = 22, fill = BRAND.card, shadow = 0.10, alpha = 1, stroke = null, lw = 2 } = {}) {
  g.save();
  g.globalAlpha *= alpha;
  if (shadow) {
    g.shadowColor = `rgba(40,30,20,${shadow * g.globalAlpha})`; // the shadow fades with its card
    g.shadowBlur = Math.max(w, h) * 0.06 + 12;
    g.shadowOffsetY = 8;
  }
  rr(g, x, y, w, h, r);
  g.fillStyle = fill;
  g.fill();
  g.shadowColor = 'transparent';
  if (stroke) { g.lineWidth = lw; g.strokeStyle = stroke; g.stroke(); }
  g.restore();
}
export function text(g, s, x, y, { f = font('F', 500, 30), color = BRAND.ink, align = 'left', base = 'alphabetic', alpha = 1, spacing = 0 } = {}) {
  g.save();
  g.globalAlpha *= alpha;
  g.font = f;
  g.fillStyle = color;
  g.textAlign = align;
  g.textBaseline = base;
  if (spacing) g.letterSpacing = `${spacing}px`;
  g.fillText(s, x, y);
  g.restore();
}
export function measure(g, s, f, spacing = 0) {
  g.save(); g.font = f; if (spacing) g.letterSpacing = `${spacing}px`;
  const w = g.measureText(s).width; g.restore(); return w;
}
/** Split text into lines that fit maxW. */
export function wrap(g, s, f, maxW) {
  const words = s.split(/ +/); // NBSP keeps words together
  const lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (cur && measure(g, t, f) > maxW) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}
/** Text that rises into place line by line, clipped at its baseline box (a "mask reveal"). */
export function reveal(g, s, x, y, p, { f, color = BRAND.ink, lh = 1.12, maxW = 1e9, align = 'left', size = 60 } = {}) {
  const lines = wrap(g, s, f, maxW);
  lines.forEach((ln, i) => {
    const pi = ease.out(clamp(p * 1.25 - i * 0.18));
    const yy = y + i * size * lh;
    g.save();
    g.beginPath();
    g.rect(x - (align === 'center' ? maxW / 2 : align === 'right' ? maxW : 0) - 10, yy - size * 1.05, (maxW < 1e8 ? maxW : 4000) + 20, size * 1.35);
    g.clip();
    text(g, ln, x, yy + (1 - pi) * size * 1.1, { f, color, align, alpha: pi });
    g.restore();
  });
  return lines.length;
}
/** Small rounded label. Returns its width. */
export function pill(g, s, x, y, { size = 26, fill = BRAND.greenSoft, color = BRAND.greenDeep, alpha = 1, align = 'left', weight = 600, padX = 0.8, h = 1.75 } = {}) {
  const f = font('F', weight, size);
  const w = measure(g, s, f) + size * padX * 2;
  const hh = size * h;
  const x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  g.save();
  g.globalAlpha *= alpha;
  rr(g, x0, y, w, hh, hh / 2);
  g.fillStyle = fill;
  g.fill();
  text(g, s, x0 + w / 2, y + hh / 2 + size * 0.36, { f, color, align: 'center' });
  g.restore();
  return w;
}
export function check(g, x, y, s, { color = BRAND.green, alpha = 1, p = 1 } = {}) {
  g.save();
  g.globalAlpha *= alpha;
  g.beginPath(); g.arc(x, y, s, 0, Math.PI * 2); g.fillStyle = color; g.fill();
  g.strokeStyle = '#fff'; g.lineWidth = s * 0.28; g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath();
  const a = [x - s * 0.45, y + s * 0.02], b = [x - s * 0.1, y + s * 0.38], c = [x + s * 0.5, y - s * 0.34];
  const q = clamp(p);
  g.moveTo(...a);
  if (q < 0.4) g.lineTo(lerp(a[0], b[0], q / 0.4), lerp(a[1], b[1], q / 0.4));
  else { g.lineTo(...b); g.lineTo(lerp(b[0], c[0], (q - 0.4) / 0.6), lerp(b[1], c[1], (q - 0.4) / 0.6)); }
  g.stroke();
  g.restore();
}

// ---- page furniture ------------------------------------------------------------------------------------
/** Paper background with a slow-moving soft light, so no two frames are identical. */
export function paper(g, L, T) {
  g.fillStyle = BRAND.paper;
  g.fillRect(0, 0, L.W, L.H);
  const cx = L.W * (0.3 + 0.08 * Math.sin(T * 0.11)), cy = L.H * (0.25 + 0.06 * Math.cos(T * 0.09));
  const rad = Math.max(L.W, L.H) * 0.9;
  const gr = g.createRadialGradient(cx, cy, 0, cx, cy, rad);
  gr.addColorStop(0, 'rgba(255,255,255,0.55)');
  gr.addColorStop(1, 'rgba(226,218,204,0.35)');
  g.fillStyle = gr;
  g.fillRect(0, 0, L.W, L.H);
}
/** The logo, or the wordmark when no logo file is set. */
let logoRec = null, logoWhite = null;
export async function loadBrand() {
  if (BRAND.logo) logoRec = await loadImage(fs.readFileSync(path.join(RENDER, BRAND.logo)));
  if (BRAND.logoWhite) logoWhite = await loadImage(fs.readFileSync(path.join(RENDER, BRAND.logoWhite)));
}
export function wordmark(g, x, y, size, { color = BRAND.green, alpha = 1, align = 'left' } = {}) {
  g.save();
  g.globalAlpha *= alpha;
  if (logoRec) {
    const im = (color === '#fff' || color === '#ffffff') && logoWhite ? logoWhite : logoRec;
    const h = size * 2.1, w = im.width * h / im.height;
    const x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    g.drawImage(im, x0, y - h * 0.78, w, h);
  } else {
    const f = font('P', 600, size);
    const sp = size * 0.22;
    const tw = measure(g, BRAND.wordmark, f, sp);
    const sq = size * 0.9;
    const total = sq + size * 0.55 + tw;
    const x0 = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
    g.fillStyle = color;
    rr(g, x0, y - sq * 0.86, sq, sq, sq * 0.18); g.fill();
    g.fillStyle = BRAND.paper;
    g.font = font('P', 700, sq * 0.78); g.textAlign = 'center';
    g.fillText('E', x0 + sq / 2, y - sq * 0.14);
    text(g, BRAND.wordmark, x0 + sq + size * 0.55, y, { f, color, spacing: sp });
  }
  g.restore();
}
/** Kicker (small caps label) + headline that reveals in. Headline text is the scene's card. */
export function header(g, L, kicker, headline, st, sd, { color = BRAND.ink, kcolor = BRAND.greenText, maxW = null } = {}) {
  const pin = clamp(st / 0.7), pout = 1 - ease.in(clamp((st - (sd - 0.4)) / 0.4));
  const a = pout;
  g.save();
  g.globalAlpha *= a;
  const ks = L.kickSize;
  if (kicker) text(g, kicker.toUpperCase(), L.m, L.headY - L.headSize * 1.05, { f: font('P', 600, ks), color: kcolor, spacing: ks * 0.16, alpha: ease.out(clamp(st / 0.5)) });
  const lines = reveal(g, headline, L.m, L.headY, pin, { f: font('P', 700, L.headSize), color, size: L.headSize, maxW: maxW || (L.W - 2 * L.m) });
  g.restore();
  return lines;
}
/** Scene in/out envelope for content: 0 → 1 over the first `din` s, back to 0 over the last `dout` s. */
export function envelope(st, sd, din = 0.55, dout = 0.4) {
  return ease.out(clamp(st / din)) * (1 - ease.in(clamp((st - (sd - dout)) / dout)));
}

// ---- beam cross-sections (to scale, filled with the real texture photo) -------------------------------------
/**
 * A beam's cross-section as it hangs: open at the top (the ceiling side). shape: 'U' | 'L' | 'plank' | 'box'.
 * (x, y) is the top-left of the outside; w, h outside size in px; t wall thickness in px.
 */
export function sectionPath(g, shape, x, y, w, h, t) {
  g.beginPath();
  if (shape === 'U') {
    g.moveTo(x, y); g.lineTo(x + t, y); g.lineTo(x + t, y + h - t); g.lineTo(x + w - t, y + h - t); g.lineTo(x + w - t, y);
    g.lineTo(x + w, y); g.lineTo(x + w, y + h); g.lineTo(x, y + h); g.closePath();
  } else if (shape === 'L') {
    g.moveTo(x, y); g.lineTo(x + t, y); g.lineTo(x + t, y + h - t); g.lineTo(x + w, y + h - t); g.lineTo(x + w, y + h); g.lineTo(x, y + h); g.closePath();
  } else if (shape === 'plank') {
    g.rect(x, y + h - t, w, t);
  } else if (shape === 'box') {
    g.rect(x, y, w, h);
    g.moveTo(x + t, y + t); g.lineTo(x + t, y + h - t); g.lineTo(x + w - t, y + h - t); g.lineTo(x + w - t, y + t); g.closePath();
  }
}
export function section(g, shape, x, y, w, h, t, { tex = null, fill = '#6a5646', alpha = 1, stroke = 'rgba(0,0,0,0.25)' } = {}) {
  g.save();
  g.globalAlpha *= alpha;
  sectionPath(g, shape, x, y, w, h, t);
  if (tex) {
    g.save();
    g.clip('evenodd');
    const s = Math.max(w, h) / Math.min(tex.w, tex.h) * 1.05;
    g.drawImage(tex.im, x + w / 2 - tex.w * s / 2, y + h / 2 - tex.h * s / 2, tex.w * s, tex.h * s);
    g.restore();
  } else {
    g.fillStyle = fill;
    g.fill('evenodd');
  }
  if (stroke) { g.lineWidth = 2.5; g.lineJoin = 'round'; g.strokeStyle = stroke; sectionPath(g, shape, x, y, w, h, t); g.stroke(); }
  g.restore();
}

// ---- coded models (things that aren't the product) ------------------------------------------------------
/** A strip of business days (weeks of five). `filled` days fill; days in [lo, hi] are highlighted. */
export function calendar(g, x, y, cell, days, lo, hi, p, { color = BRAND.green, label = true, gap = null, alpha = 1 } = {}) {
  gap = gap ?? cell * 0.22;
  g.save();
  g.globalAlpha *= alpha;
  const weeks = Math.ceil(days / 5);
  for (let i = 0; i < days; i++) {
    const wk = Math.floor(i / 5), d = i % 5;
    const cx = x + (i * (cell + gap)) + wk * gap * 2.2;
    const day = i + 1;
    const fillP = clamp(p * hi * 1.15 - i);
    rr(g, cx, y, cell, cell, cell * 0.22);
    g.fillStyle = '#fff'; g.fill();
    g.lineWidth = 2; g.strokeStyle = BRAND.line; g.stroke();
    if (fillP > 0 && day <= hi) {
      g.save();
      rr(g, cx, y, cell, cell, cell * 0.22); g.clip();
      g.globalAlpha *= day >= lo ? 1 : 0.38;
      g.fillStyle = color;
      g.fillRect(cx, y + cell * (1 - ease.out(fillP)), cell, cell);
      g.restore();
    }
    if (label) text(g, String(day), cx + cell / 2, y + cell * 0.64, { f: font('F', 600, cell * 0.38), color: fillP > 0.6 && day <= hi ? '#fff' : BRAND.muted, align: 'center' });
    void weeks; void d;
  }
  g.restore();
  return x + days * (cell + gap) + (Math.ceil(days / 5) - 1) * gap * 2.2;
}
/** Simple standing person, `h` px tall (feet at y), for scale against lengths. */
export function person(g, x, y, h, { color = '#8C877C', alpha = 1 } = {}) {
  g.save();
  g.globalAlpha *= alpha;
  g.fillStyle = color;
  const head = h * 0.065;
  g.beginPath(); g.arc(x, y - h + head, head, 0, Math.PI * 2); g.fill();
  const sw = h * 0.13;
  rr(g, x - sw, y - h + head * 2.25, sw * 2, h * 0.42, sw * 0.5); g.fill();
  rr(g, x - sw * 0.82, y - h * 0.5, sw * 0.72, h * 0.5, sw * 0.3); g.fill();
  rr(g, x + sw * 0.1, y - h * 0.5, sw * 0.72, h * 0.5, sw * 0.3); g.fill();
  g.restore();
}
/** A short wood mounting block in section (end grain), coded: it isn't the product. */
export function block(g, x, y, w, h, { alpha = 1 } = {}) {
  g.save();
  g.globalAlpha *= alpha;
  rr(g, x, y, w, h, 3);
  const gr = g.createLinearGradient(x, y, x + w, y + h);
  gr.addColorStop(0, '#E2C79A'); gr.addColorStop(1, '#C9A672');
  g.fillStyle = gr; g.fill();
  g.strokeStyle = 'rgba(120,85,40,0.55)'; g.lineWidth = 1.5;
  for (let i = 1; i < 4; i++) { g.beginPath(); g.ellipse(x + w * 0.55, y + h * 0.6, w * 0.12 * i, h * 0.1 * i, 0, 0, Math.PI * 2); g.stroke(); }
  g.restore();
}
/** Dimension line with end ticks and a centred label. */
export function dim(g, x0, y0, x1, y1, label, { color = BRAND.greenText, size = 24, alpha = 1, off = 0 } = {}) {
  g.save();
  g.globalAlpha *= alpha;
  g.strokeStyle = color; g.fillStyle = color; g.lineWidth = 2.5;
  g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
  const ang = Math.atan2(y1 - y0, x1 - x0) + Math.PI / 2, tk = size * 0.4;
  for (const [x, y] of [[x0, y0], [x1, y1]]) { g.beginPath(); g.moveTo(x - Math.cos(ang) * tk, y - Math.sin(ang) * tk); g.lineTo(x + Math.cos(ang) * tk, y + Math.sin(ang) * tk); g.stroke(); }
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const f = font('F', 700, size);
  const w = measure(g, label, f) + size * 0.8;
  const vertical = Math.abs(x1 - x0) < Math.abs(y1 - y0);
  const lx = vertical ? mx + off : mx, ly = vertical ? my : my + off;
  rr(g, lx - w / 2, ly - size * 0.75, w, size * 1.5, size * 0.4); g.fillStyle = BRAND.paper; g.fill();
  text(g, label, lx, ly + size * 0.36, { f, color, align: 'center' });
  g.restore();
}

/** Inches as the cards print them: 3.5 → "3½". */
export function inch(v) {
  const whole = Math.floor(v + 1e-6), frac = v - whole;
  const fr = Math.abs(frac - 0.5) < 1e-6 ? '½' : Math.abs(frac - 0.25) < 1e-6 ? '¼' : Math.abs(frac - 0.75) < 1e-6 ? '¾' : '';
  return (whole || !fr ? String(whole) : '') + fr;
}
export const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
