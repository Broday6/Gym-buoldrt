// Heritage Timber hero edit: problem-led, full-bleed photography, kinetic type, burned-in captions,
// and wipes between scenes. Every beam, finish and texture on screen is a real Ekena photo (rooms,
// texture close-ups, and product shots cut out of their white backgrounds by tools/cutout.py).
// Coded drawing is only used for things that aren't the product: the ceiling and block, the size
// outlines, the length ruler, captions and UI.
import { createCanvas } from '@napi-rs/canvas';
import {
  BRAND, FPS, clamp, lerp, ease, cue, cues, img, cover, rr, text, measure, wrap, font, wordmark,
  inAmt, listStack, paper, dim, inch, sectionPath, block,
} from '../lib/core.mjs';

const SAGE_L = '#CBD5A2';
const DARK = '#141818';
const TR = 0.6; // scene-to-scene transition length (s), at the start of the incoming scene
const TRANS = { reveal: 'wipe', textures: 'wipe', finishes: 'wipe', sizes: 'wipe', install: 'fade', ship: 'wipe', end: 'fade' };
// Caption parts (split on "|") left off screen because the picture already shows the name in big type.
const NOCAP = { textures: [1, 2, 3, 4, 5, 6], finishes: [1, 2, 3, 4, 5, 6] };

const TEXTURES = [
  ['Mena', 'mena', ['Mina', 'Meena']], ['Salvaged Timber', 'salvaged-timber'], ['Rustic Sawn', 'rustic-sawn'],
  ['Resawn Rip', 'resawn-rip'], ['Reclaimed Axed Cut', 'reclaimed-axed-cut'], ['Sanded Smooth', 'sanded-smooth'],
];
const FINISHES = [
  ['Sandstone', 'sandstone'], ['Kona Brown', 'kona-brown', ['Kona']], ['Vanilla Chai', 'vanilla-chai', ['vanilla']],
  ['Warm Caramel', 'warm-caramel', ['warm']], ['Natural White Oak', 'natural-white-oak', ['natural']],
  ['Smokey Brown', 'smokey-brown', ['smoky', 'Smoky Brown']], ['Primed', 'primed', ['primed']],
];
const SIZES = [[3.5, 3.5], [3.5, 5.5], [5.5, 5.5], [5.5, 7.5], [7.5, 7.5], [7.5, 9.5], [9.5, 9.5], [9.5, 11.5]];
const LENGTHS = [4, 5, 6, 8, 10, 12, 16, 20, 24];

const A = {};
let OC = null, O = null; // offscreen canvas for the incoming scene during a transition

// ---- helpers ------------------------------------------------------------------------------------------
/** The rect a photo's content occupies (photos letterboxed in a white square). */
function contentBox(rec) {
  const c = createCanvas(200, 200), x = c.getContext('2d');
  x.drawImage(rec.im, 0, 0, 200, 200);
  const d = x.getImageData(0, 0, 200, 200).data;
  const rowWhite = y => { for (let i = 0; i < 200; i++) { const k = (y * 200 + i) * 4; if (d[k] < 245 || d[k + 1] < 245 || d[k + 2] < 245) return false; } return true; };
  let y0 = 0, y1 = 199;
  while (y0 < 199 && rowWhite(y0)) y0++;
  while (y1 > y0 && rowWhite(y1)) y1--;
  const k = rec.h / 200;
  return { x: 0, y: (y0 + 1) * k, w: rec.w, h: (y1 - y0 - 1) * k };
}
/** Alpha bounding box of a cutout PNG. */
function alphaBox(rec) {
  const c = createCanvas(240, 240), x = c.getContext('2d');
  x.drawImage(rec.im, 0, 0, 240, 240);
  const d = x.getImageData(0, 0, 240, 240).data;
  let x0 = 240, y0 = 240, x1 = 0, y1 = 0;
  for (let y = 0; y < 240; y++) for (let i = 0; i < 240; i++) if (d[(y * 240 + i) * 4 + 3] > 20) { x0 = Math.min(x0, i); x1 = Math.max(x1, i); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const kx = rec.w / 240, ky = rec.h / 240;
  return { x: x0 * kx, y: y0 * ky, w: (x1 - x0 + 1) * kx, h: (y1 - y0 + 1) * ky };
}
function blurred(rec, px) {
  const c = createCanvas(rec.w, rec.h), x = c.getContext('2d');
  x.filter = `blur(${px}px)`;
  x.drawImage(rec.im, -px * 2, -px * 2, rec.w + px * 4, rec.h + px * 4);
  return { im: c, w: rec.w, h: rec.h };
}
/** A cut-out product photo fitted into a box, with a soft shadow that fades with it. */
function cutout(g, rec, x, y, w, h, { alpha = 1, shadow = 0.38, bb = null, u = 1, align = 'center' } = {}) {
  if (alpha <= 0) return null;
  bb = bb || rec.bb || { x: 0, y: 0, w: rec.w, h: rec.h };
  const s = Math.min(w / bb.w, h / bb.h);
  const dw = bb.w * s, dh = bb.h * s;
  const dx = align === 'left' ? x : x + (w - dw) / 2, dy = y + (h - dh) / 2;
  g.save();
  g.globalAlpha *= alpha;
  if (shadow) { g.shadowColor = `rgba(0,0,0,${shadow * g.globalAlpha})`; g.shadowBlur = 46 * u; g.shadowOffsetY = 26 * u; }
  g.drawImage(rec.im, bb.x, bb.y, bb.w, bb.h, dx, dy, dw, dh);
  g.restore();
  return { x: dx, y: dy, w: dw, h: dh };
}
function scrim(g, L, { from = 0.35, to = 1, a0 = 0, a1 = 0.78, dir = 'down', color = '10,12,12' } = {}) {
  const gr = dir === 'down' ? g.createLinearGradient(0, L.H * from, 0, L.H * to) : g.createLinearGradient(L.W * from, 0, L.W * to, 0);
  gr.addColorStop(0, `rgba(${color},${a0})`);
  gr.addColorStop(1, `rgba(${color},${a1})`);
  g.fillStyle = gr;
  g.fillRect(0, 0, L.W, L.H);
}
function vignette(g, L, a = 0.35) {
  const gr = g.createRadialGradient(L.W / 2, L.H / 2, Math.min(L.W, L.H) * 0.35, L.W / 2, L.H / 2, Math.max(L.W, L.H) * 0.75);
  gr.addColorStop(0, 'rgba(0,0,0,0)');
  gr.addColorStop(1, `rgba(0,0,0,${a})`);
  g.fillStyle = gr;
  g.fillRect(0, 0, L.W, L.H);
}
function darkBg(g, L, T) {
  g.fillStyle = DARK;
  g.fillRect(0, 0, L.W, L.H);
  const cx = L.W * (0.62 + 0.05 * Math.sin(T * 0.13)), cy = L.H * (0.45 + 0.04 * Math.cos(T * 0.1));
  const gr = g.createRadialGradient(cx, cy, 0, cx, cy, Math.max(L.W, L.H) * 0.7);
  gr.addColorStop(0, 'rgba(142,156,93,0.20)');
  gr.addColorStop(1, 'rgba(142,156,93,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, L.W, L.H);
}
const HS = L => (L.P ? 112 : 104) * L.u;
/** Letter-spaced small caps label. */
function kicker(g, s, x, y, { size, color = SAGE_L, alpha = 1, align = 'left' } = {}) {
  text(g, s.toUpperCase(), x, y, { f: font('P', 600, size), color, alpha, align, spacing: size * 0.18 });
}
/**
 * Kinetic type: each word rises out of a mask from time t0, staggered. lines = [[text, color], …].
 * Returns the y of the last baseline.
 */
function kinetic(g, lines, x, y, st, t0, { size, lh = 1.06, stagger = 0.07, d = 0.55, align = 'left', weight = 700, out = 1 } = {}) {
  const f = font('P', weight, size);
  let k = 0;
  lines.forEach(([s, color, tLine], li) => {
    const yy = y + li * size * lh;
    const words = s.split(' ');
    const total = measure(g, s, f);
    let xx = align === 'center' ? x - total / 2 : x;
    const startT = tLine ?? t0;
    words.forEach((w, wi) => {
      const p = ease.out(clamp((st - (startT + wi * stagger)) / d));
      const ww = measure(g, w + (wi < words.length - 1 ? ' ' : ''), f);
      if (p > 0) {
        g.save();
        g.beginPath(); g.rect(xx - size * 0.1, yy - size * 1.02, ww + size * 0.3, size * 1.3); g.clip();
        text(g, w, xx, yy + (1 - p) * size * 0.9, { f, color, alpha: p * out });
        g.restore();
      }
      xx += ww;
      k++;
    });
  });
  return y + (lines.length - 1) * size * lh;
}
function checkDot(g, x, y, r, { alpha = 1, color = BRAND.green } = {}) {
  g.save(); g.globalAlpha *= alpha;
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fillStyle = color; g.fill();
  g.strokeStyle = '#fff'; g.lineWidth = r * 0.26; g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath(); g.moveTo(x - r * 0.42, y + r * 0.02); g.lineTo(x - r * 0.1, y + r * 0.36); g.lineTo(x + r * 0.46, y - r * 0.32); g.stroke();
  g.restore();
}
function swatchDot(g, rec, x, y, r, { alpha = 1, ring = 0, ringColor = BRAND.greenDeep } = {}) {
  g.save(); g.globalAlpha *= alpha;
  g.save(); g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.clip();
  g.drawImage(rec.im, rec.w * 0.3, rec.h * 0.3, rec.w * 0.4, rec.h * 0.4, x - r, y - r, r * 2, r * 2);
  g.restore();
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.lineWidth = 2; g.strokeStyle = 'rgba(0,0,0,0.15)'; g.stroke();
  if (ring > 0) { g.globalAlpha *= ring; g.beginPath(); g.arc(x, y, r + 7, 0, Math.PI * 2); g.lineWidth = 4; g.strokeStyle = ringColor; g.stroke(); }
  g.restore();
}

// ---- captions -----------------------------------------------------------------------------------------
const normW = w => w.toLowerCase().replace(/[^a-z0-9]/g, '');
/** Caption chunks from the script's own words (not Whisper's spelling), timed from Whisper where the words line up. */
function captionChunks(s) {
  if (s._caps) return s._caps;
  const parts = s.vo.split('|').map(x => x.trim()).filter(Boolean);
  const toks = [];
  parts.forEach((p, pi) => p.split(/\s+/).forEach(w => toks.push({ w, pi, n: normW(w) })));
  const ww = s.words.map(w => ({ n: normW(w.w), t0: w.t0, t1: w.t1 }));
  let j = 0;
  for (const tk of toks) {
    for (let k = j; k < Math.min(ww.length, j + 4); k++) {
      const a = ww[k].n, b = tk.n;
      if (a && b && (a === b || (a.length > 2 && b.startsWith(a)) || (b.length > 2 && a.startsWith(b)))) { tk.t0 = ww[k].t0; tk.t1 = ww[k].t1; j = k + 1; break; }
    }
  }
  const vo0 = s.vo_start_s, vo1 = s.vo_start_s + s.vo_duration_s;
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].t0 !== undefined) continue;
    let a = i - 1; while (a >= 0 && toks[a].t0 === undefined) a--;
    let b = i + 1; while (b < toks.length && toks[b].t0 === undefined) b++;
    const ta = a >= 0 ? toks[a].t0 : vo0, tb = b < toks.length ? toks[b].t0 : vo1;
    toks[i].t0 = lerp(ta, tb, (i - a) / (b - a));
    toks[i].t1 = toks[i].t0 + 0.3;
  }
  const chunks = [];
  let cur = null;
  toks.forEach((tk, i) => {
    if (!cur || cur.pi !== tk.pi || cur.words.length >= 4) { cur = { pi: tk.pi, words: [] }; chunks.push(cur); }
    cur.words.push(tk);
    if (/[.,?!]$/.test(tk.w) && i + 1 < toks.length) cur = null;
  });
  chunks.forEach((c, i) => {
    c.a = c.words[0].t0 - 0.12;
    const last = c.words[c.words.length - 1];
    c.b = i + 1 < chunks.length ? Math.min(chunks[i + 1].words[0].t0 - 0.12, last.t1 + 0.9) : Math.min(last.t1 + 0.6, s.sd - 0.05);
    c.hide = (NOCAP[s.id] || []).includes(c.pi);
  });
  s._caps = chunks;
  return chunks;
}
function captions(g, L, s, st) {
  const size = (L.P ? 50 : 40) * L.u;
  const f = font('F', 700, size);
  const y = L.P ? L.H * 0.80 : L.H - 64 * L.u;
  for (const c of captionChunks(s)) {
    // Fade in over [a, a+0.1], out over [b-0.1, b]: consecutive chunks never overlap.
    if (c.hide || st < c.a || st > c.b) continue;
    const a = ease.inOut(clamp((st - c.a) / 0.1)) * (1 - ease.inOut(clamp((st - (c.b - 0.1)) / 0.1)));
    if (a <= 0) continue;
    const s2 = c.words.map(w => w.w).join(' ');
    const tw = measure(g, s2, f);
    const padX = size * 0.55, padY = size * 0.42;
    g.save();
    g.globalAlpha *= a;
    rr(g, L.W / 2 - tw / 2 - padX, y - size * 0.95 - padY * 0.3, tw + padX * 2, size * 1.3 + padY * 0.6, size * 0.3);
    g.fillStyle = 'rgba(12,14,14,0.62)';
    g.fill();
    let x = L.W / 2 - tw / 2;
    c.words.forEach((w, i) => {
      const said = st >= w.t0 - 0.05;
      const nxt = c.words[i + 1];
      const current = said && (!nxt || st < nxt.t0 - 0.05);
      text(g, w.w, x, y, { f, color: current ? SAGE_L : '#fff', alpha: said ? 1 : 0.55 });
      x += measure(g, w.w + ' ', f);
    });
    g.restore();
  }
}

// ---- preload ------------------------------------------------------------------------------------------
export async function preload(L) {
  const cut = async (name, dir = 'cutout') => { const r = await img(`heritage/${dir}/${name}.png`, { maxSide: 1200 }); r.bb = alphaBox(r); return r; };
  A.hook = await img('heritage/angles/BMSTKB-09.jpg', { maxSide: 1200 });
  A.room8 = await img('heritage/angles/BMSTKB-08.jpg', { maxSide: 1200 });
  A.room8blur = blurred(A.room8, 26);
  A.room7 = await img('heritage/angles/BMSTKB-07.jpg', { maxSide: 1200 });
  A.room6 = await img('heritage/angles/BMSTKB-06.jpg', { maxSide: 1200 });
  A.ship = await img('heritage/rooms/7652db729115ec792d44.jpg', { maxSide: 1200 });
  A.shipBox = contentBox(A.ship);
  A.hero = await cut('salvaged-timber__kona-brown');
  A.texIntro = await img('heritage/angles/BMSTKB-0.jpg', { maxSide: 1200 });
  A.tex = [];
  for (const [, sl] of TEXTURES) A.tex.push(sl === 'sanded-smooth' ? await cut('sanded-smooth__primed') : await img(`heritage/swatch-hi/texture-${sl}.jpg`, { maxSide: 1200 }));
  A.finSw = [], A.finBeam = [];
  for (const [, sl] of FINISHES) {
    A.finSw.push(await img(`heritage/swatch-hi/finish-${sl}.jpg`, { maxSide: 1200 }));
    A.finBeam.push(await cut(`salvaged-timber__${sl}`, 'cutout-frame'));
  }
  // One box for the whole set, so the beam doesn't shift as the finish changes.
  const bs = A.finBeam.map(r => r.bb);
  const x0 = Math.min(...bs.map(b => b.x)), y0 = Math.min(...bs.map(b => b.y));
  A.finBB = { x: x0, y: y0, w: Math.max(...bs.map(b => b.x + b.w)) - x0, h: Math.max(...bs.map(b => b.y + b.h)) - y0 };
  A.uEnd = await cut('angles__BMSTKB-05');
  A.sample = await cut('accessories__sample-kit');
  A.endcap = await img('heritage/accessories/endcap.jpg', { maxSide: 1200 });
  OC = createCanvas(L.W, L.H);
  O = OC.getContext('2d');
}

// ---- scenes -------------------------------------------------------------------------------------------
export const scenes = {
  hook: {
    draw(g, L, s, st) {
      const { W, H, u, P, m } = L;
      const k = ease.inOut(clamp(st / (s.sd + TR)));
      cover(g, A.hook, 0, 0, W, H, { zoom: lerp(1.18, 1.04, k), py: P ? 0 : 0.85, px: P ? 0.05 : 0 });
      scrim(g, L, { from: P ? 0.42 : 0.3, a1: 0.82 });
      vignette(g, L, 0.3);
      const size = Math.min(HS(L), (W - 2 * m) / measure(g, 'Without the weight.', font('P', 700, 1)) * 0.98);
      const tL = cue(s, 'look', { fallback: 1.2 }) - 0.35, tW = cue(s, 'without', { fallback: 2.4 }) - 0.2;
      const yb = P ? H * 0.70 : H - 175 * u;
      kinetic(g, [['The timber look.', '#fff', tL], ['Without the weight.', SAGE_L, tW]], m, yb - size * 1.06, st, tL, { size });
      wordmark(g, m, (P ? 150 : 110) * u, (P ? 26 : 22) * u, { color: '#fff', alpha: ease.out(clamp((st - 0.3) / 0.6)) });
      // Open from a dimmed frame (not black: the first frame already shows the room).
      const fin = 0.7 * (1 - ease.inOut(clamp(st / 0.8)));
      if (fin > 0) { g.fillStyle = `rgba(0,0,0,${fin})`; g.fillRect(0, 0, W, H); }
    },
  },

  reveal: {
    draw(g, L, s, st, T) {
      const { W, H, u, P, m } = L;
      cover(g, A.room8blur, 0, 0, W, H, { zoom: 1.12 + 0.03 * st / s.sd });
      g.fillStyle = 'rgba(14,17,17,0.62)'; g.fillRect(0, 0, W, H);
      const gx = P ? W * 0.5 : W * 0.68, gy = P ? H * 0.47 : H * 0.48;
      const gr = g.createRadialGradient(gx, gy, 0, gx, gy, Math.max(W, H) * 0.5);
      gr.addColorStop(0, 'rgba(203,213,162,0.20)'); gr.addColorStop(1, 'rgba(203,213,162,0)');
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
      // The beam glides in from the right, ahead of the background (parallax), then keeps drifting.
      const pin = ease.out(clamp((st - 0.05) / 1.2));
      const drift = -30 * u * (st / s.sd);
      const bx = (P ? 0 : W * 0.36) + (1 - pin) * W * 0.35 + drift, by = P ? H * 0.29 : H * 0.12;
      cutout(g, A.hero, bx, by, P ? W : W * 0.64, P ? H * 0.33 : H * 0.74, { alpha: ease.out(clamp((st - 0.05) / 0.6)), u });
      // Words.
      const size = (P ? 128 : 124) * u;
      const tH = cue(s, 'Heritage', { fallback: 0.6 }) - 0.15, tE = cue(s, 'Ekena', { fallback: 1.9, alts: ['Ikenna'] }) - 0.1;
      const y1 = P ? 400 * u : H * 0.30;
      kicker(g, 'Ekena Millwork', m, y1 - size * 0.95, { size: (P ? 30 : 26) * u, alpha: ease.out(clamp((st - tE) / 0.5)) });
      const yl = kinetic(g, [['Heritage', '#fff'], ['Timber', '#fff']], m, y1, st, tH, { size, stagger: 0.12 });
      const feats = [['Molded from real, weathered timber', 'molded'], ['No corner seams', 'corner']];
      const fs = (P ? 38 : 34) * u, gap = (P ? 70 : 66) * u;
      const fy = P ? H * 0.665 : yl + 120 * u;
      let after = 0;
      feats.forEach(([lab, ph], i) => {
        const t = cue(s, ph, { after, fallback: 3.5 + i }) - 0.15; after = t + 0.2;
        const p = ease.out(clamp((st - t) / 0.5));
        const y = fy + i * gap;
        checkDot(g, m + fs * 0.5, y - fs * 0.35, fs * 0.55, { alpha: p });
        text(g, lab, m + fs * 1.5 + (1 - p) * 24 * u, y, { f: font('F', 600, fs), color: '#fff', alpha: p });
      });
    },
  },

  textures: {
    draw(g, L, s, st) {
      const { W, H, u, P, m } = L;
      const ts = cues(s, TEXTURES.map(([n, , alts]) => [n, ...(alts || [])]), { after: 1.6 });
      s._ts = ts;
      const ins = ts.map((_, i) => inAmt(ts, i, st, 0.6));
      // Intro panel: a close-up of Salvaged Timber with the headline.
      let base = -1;
      ins.forEach((v, i) => { if (v >= 1) base = i; });
      const panel = (i, cx) => {
        if (i < 0) {
          cover(g, A.texIntro, 0, 0, W, H, { zoom: 1.12 - 0.06 * clamp(st / 3) });
          g.fillStyle = 'rgba(12,14,14,0.45)'; g.fillRect(0, 0, W, H);
          const size = (P ? 128 : 150) * u;
          kicker(g, 'Pick a texture', W / 2, H / 2 - size * 0.85, { size: (P ? 32 : 28) * u, align: 'center', alpha: ease.out(clamp(st / 0.6)) });
          kinetic(g, [['6 textures', '#fff']], W / 2, H / 2 + size * 0.35, st, 0.25, { size, align: 'center' });
          return;
        }
        const t0 = ts[i];
        const local = Math.max(0, st - t0);
        const name = TEXTURES[i][0];
        if (TEXTURES[i][1] === 'sanded-smooth') {
          paper(g, L, st);
          // The beam keeps easing toward the camera, so the page never sits still.
          const z = 1 + 0.08 * ease.out(clamp(local / 2.5)), bw = (P ? W - m : W * 0.66) * z, bh = (P ? H * 0.42 : H * 0.62) * z;
          const bx0 = (P ? m * 0.5 : W * 0.30) - (bw / z) * (z - 1) * 0.5 - 30 * u * local, by0 = (P ? H * 0.20 : H * 0.10) - (bh / z) * (z - 1) * 0.5;
          cutout(g, A.tex[i], bx0, by0, bw, bh, { u, shadow: 0.25 });
          const y = P ? H * 0.70 : H - 200 * u;
          kicker(g, `0${i + 1} / 06`, m, y - 128 * u, { size: (P ? 30 : 26) * u, color: BRAND.greenText });
          text(g, name, m, y, { f: font('P', 700, (P ? 100 : 104) * u), color: BRAND.ink });
          const pw = measure(g, 'Primed only', font('F', 700, 30 * u)) + 48 * u;
          rr(g, m, y + 34 * u, pw, 56 * u, 28 * u); g.fillStyle = BRAND.green; g.fill();
          text(g, 'Primed only', m + pw / 2, y + 72 * u, { f: font('F', 700, 30 * u), color: '#fff', align: 'center' });
          return;
        }
        cover(g, A.tex[i], 0, 0, W, H, { zoom: 1.14 - 0.06 * clamp(local / 2.5), px: i % 2 ? 0.3 : -0.3, py: 0 });
        scrim(g, L, { from: P ? 0.5 : 0.45, a1: 0.8 });
        const y = P ? H * 0.70 : H - 200 * u;
        kicker(g, `0${i + 1} / 06`, m, y - 128 * u, { size: (P ? 30 : 26) * u });
        const ns = Math.min((P ? 100 : 104) * u, (W - 2 * m) / measure(g, name, font('P', 700, 1)));
        text(g, name, m, y, { f: font('P', 700, ns), color: '#fff' });
        void cx;
      };
      panel(base, 0);
      for (let i = base + 1; i < ts.length; i++) {
        if (ins[i] <= 0) continue;
        // Wipe: the next texture slides its edge across from the left, with a sage line on the edge.
        const ex = ins[i] * W;
        g.save(); g.beginPath(); g.rect(0, 0, ex, H); g.clip(); panel(i); g.restore();
        if (ins[i] < 1) { g.fillStyle = SAGE_L; g.fillRect(ex - 3 * u, 0, 6 * u, H); }
      }
      // Progress ticks, top right.
      const n = 6, tw = (P ? 46 : 40) * u, tg = 10 * u, tx = W - m - n * tw - (n - 1) * tg, ty = (P ? 140 : 90) * u;
      const show = ease.out(clamp((st - (ts[0] - 0.3)) / 0.5));
      for (let i = 0; i < n; i++) {
        rr(g, tx + i * (tw + tg), ty, tw, 6 * u, 3 * u);
        g.fillStyle = `rgba(255,255,255,${0.35 * show})`; g.fill();
        const p = ins[i];
        if (p > 0) { rr(g, tx + i * (tw + tg), ty, tw * p, 6 * u, 3 * u); g.fillStyle = i === 5 && ins[5] > 0.5 ? BRAND.green : SAGE_L; g.globalAlpha = show; g.fill(); g.globalAlpha = 1; }
      }
    },
  },

  finishes: {
    draw(g, L, s, st, T) {
      const { W, H, u, P, m } = L;
      const ts = cues(s, FINISHES.map(([n, , alts]) => [n, ...(alts || [])]), { after: 1.6 });
      const stack = listStack(ts, st, 0.55);
      // Photo panel (left, or top in portrait).
      const pw = P ? W : W * 0.46, ph = P ? H * 0.40 : H;
      g.save(); g.beginPath(); g.rect(0, 0, pw, ph); g.clip();
      for (const { i, a } of stack) {
        if (i < 0) cover(g, A.room7, 0, 0, pw, ph, { zoom: 1.1 - 0.04 * clamp(st / 2), px: P ? 0 : 0.2, py: P ? 0.6 : 0, alpha: a });
        else cover(g, A.finSw[i], 0, 0, pw, ph, { zoom: 1.12 - 0.05 * clamp((st - ts[i]) / 2), px: i % 2 ? 0.25 : -0.25, alpha: a });
      }
      g.restore();
      // Paper panel.
      const px = P ? 0 : pw, py = P ? ph : 0;
      g.save(); g.beginPath(); g.rect(px, py, W - px, H - py); g.clip(); paper(g, L, T); g.restore();
      const cx0 = P ? m : pw + 90 * u, cw = P ? W - 2 * m : W - pw - 90 * u - m;
      // Headline (the card), small and steady.
      const hs = (P ? 64 : 60) * u;
      const hy = P ? ph + 120 * u : 170 * u;
      kinetic(g, [['Hand-stained, or primed', BRAND.ink]], cx0, hy, st, 0.2, { size: hs, stagger: 0.05 });
      // Beam in the current finish.
      const by = P ? ph + 150 * u : 220 * u, bh = P ? H * 0.20 : H * 0.42;
      for (const { i, a } of stack) {
        const k = i < 0 ? 0 : i;
        const alpha = i < 0 ? a * ease.out(clamp((st - 0.3) / 0.6)) * 0.0 : a;
        cutout(g, A.finBeam[k], cx0, by, cw, bh, { alpha, u, bb: A.finBB, shadow: 0.22 });
      }
      // Name + kicker.
      const ny = P ? H * 0.76 : H * 0.76, nsz = (P ? 84 : 80) * u;
      FINISHES.forEach((_, i) => {
        const fin = ease.inOut(clamp((st - (ts[i] - 0.15)) / 0.25));
        const fout = i + 1 < ts.length ? ease.inOut(clamp((st - (ts[i + 1] - 0.42)) / 0.25)) : 0;
        const a = fin * (1 - fout);
        if (a <= 0) return;
        const primed = FINISHES[i][1] === 'primed';
        kicker(g, primed ? 'Ready to paint' : 'Hand-stained', cx0, ny - nsz * 0.95, { size: (P ? 28 : 24) * u, color: BRAND.greenText, alpha: a });
        text(g, FINISHES[i][0], cx0, ny + (1 - fin) * 18 * u, { f: font('P', 700, nsz), color: BRAND.ink, alpha: a });
      });
      // Swatch row: every finish, the current one ringed.
      const r = (P ? 30 : 28) * u, gap = (P ? 18 : 18) * u, rowY = P ? H * 0.85 : H * 0.865;
      const ins = ts.map((_, i) => inAmt(ts, i, st, 0.55));
      FINISHES.forEach((_, i) => {
        const appear = ease.out(clamp((st - 0.5 - i * 0.07) / 0.5));
        const on = ins[i] * (1 - (i + 1 < ins.length ? ins[i + 1] : 0));
        const x = cx0 + r + i * (2 * r + gap);
        swatchDot(g, A.finSw[i], x, rowY - on * 8 * u, r, { alpha: appear * (0.55 + 0.45 * Math.max(on, 0.6 * ins[i])), ring: on });
      });
    },
  },

  sizes: {
    draw(g, L, s, st, T) {
      const { W, H, u, P, m } = L;
      paper(g, L, T);
      const size = HS(L);
      const tS = cue(s, 'sizes', { fallback: 0.6 }) - 0.3;
      kinetic(g, [['8 sizes', BRAND.ink]], m, P ? 300 * u : 190 * u, st, tS, { size });
      const tLen = cue(s, 'lengths', { fallback: 5.6 }) - 0.2;
      kicker(g, '4 to 24 ft long', m + (P ? 0 : measure(g, '8 sizes', font('P', 700, size)) + 40 * u), P ? 380 * u : 190 * u, { size: (P ? 40 : 36) * u, color: BRAND.greenText, alpha: ease.out(clamp((st - tLen) / 0.5)) });
      // Outlines to scale, hanging from a ceiling line (coded: shows size, not the product's look).
      const rows = P ? [SIZES.slice(0, 4), SIZES.slice(4)] : [SIZES];
      const gapIn = 1.5;
      const widest = Math.max(...rows.map(r => r.reduce((a, [w]) => a + w, 0) + gapIn * (r.length - 1)));
      const sc = (W - 2 * m) / (widest + 3);
      const ceil = P ? [520 * u, 900 * u] : [H * 0.34];
      const t3 = cue(s, '3', { fallback: 1.6, alts: ['three'] }), t9 = cue(s, '9', { fallback: 3.2, alts: ['nine'], after: t3 + 0.3 });
      let idx = 0;
      rows.forEach((row, ri) => {
        const y0 = ceil[ri];
        const lw = ease.inOut(clamp((st - tS) / 0.8));
        g.fillStyle = BRAND.line; g.fillRect(m, y0 - 10 * u, (W - 2 * m) * lw, 10 * u);
        let x = m;
        row.forEach(([w, h]) => {
          const i = idx++;
          const p = ease.out(clamp((st - (tS + 0.25 + i * 0.09)) / 0.5));
          const pw = w * sc, phh = h * sc, t = 0.75 * sc;
          const hi = i === 0 ? ease.inOut(clamp((st - t3 + 0.1) / 0.4)) * (1 - ease.inOut(clamp((st - t9 + 0.1) / 0.4)))
            : i === 7 ? ease.inOut(clamp((st - t9 + 0.1) / 0.4)) * (1 - ease.inOut(clamp((st - tLen) / 0.5))) : 0;
          g.save();
          g.globalAlpha *= p;
          g.translate(0, -(1 - p) * 40 * u);
          sectionPath(g, 'U', x, y0, pw, phh, t);
          g.fillStyle = hi > 0 ? `rgba(142,156,93,${0.25 + 0.5 * hi})` : 'rgba(142,156,93,0.22)';
          g.fill('evenodd');
          g.lineWidth = 3 * u; g.lineJoin = 'round'; g.strokeStyle = BRAND.greenDeep;
          sectionPath(g, 'U', x, y0, pw, phh, t); g.stroke();
          const lab = `${inch(w)}×${inch(h)}`;
          text(g, lab, x + pw / 2, y0 + phh + 40 * u, { f: font('F', 700, (P ? 26 : 25) * u), color: hi > 0.5 ? BRAND.greenDeep : BRAND.muted, align: 'center' });
          g.restore();
          if (i === 7) dim(g, x + pw + 26 * u, y0, x + pw + 26 * u, y0 + phh, '11½', { alpha: hi, size: 24 * u, off: 42 * u });
          if (i === 0) dim(g, x, y0 + phh + 80 * u, x + pw, y0 + phh + 80 * u, '3½ in', { alpha: hi, size: 24 * u });
          x += pw + gapIn * sc;
        });
      });
      // Length ruler: 4 to 24 ft; every orderable length is a dot.
      const t4 = cue(s, '4', { after: tLen, fallback: 6.2, alts: ['four'] }), t24 = cue(s, '24', { after: t4, fallback: 7.0, alts: ['twenty'] });
      const ry = P ? H * 0.70 : H * 0.79, rx0 = m, rx1 = W - m;
      const ft = v => lerp(rx0, rx1, v / 24);
      const ra = ease.out(clamp((st - tLen) / 0.5));
      if (ra > 0) {
        g.save(); g.globalAlpha *= ra;
        rr(g, rx0, ry - 7 * u, rx1 - rx0, 14 * u, 7 * u); g.fillStyle = BRAND.paperDeep; g.fill();
        const grow = lerp(4, 24, ease.inOut(clamp((st - t4) / Math.max(0.6, t24 - t4 + 0.3))));
        rr(g, ft(0), ry - 7 * u, ft(grow) - ft(0), 14 * u, 7 * u); g.fillStyle = BRAND.green; g.fill();
        LENGTHS.forEach(v => {
          const on = grow >= v - 0.01 ? 1 : 0.35;
          g.beginPath(); g.arc(ft(v), ry, 11 * u, 0, Math.PI * 2); g.fillStyle = on === 1 ? BRAND.greenDeep : '#fff'; g.fill();
          g.lineWidth = 2.5 * u; g.strokeStyle = BRAND.greenDeep; g.stroke();
          if (!P || [4, 8, 12, 16, 20, 24].includes(v)) text(g, `${v}`, ft(v), ry - 28 * u, { f: font('F', 700, 24 * u), color: BRAND.greenDeep, align: 'center', alpha: 0.5 + 0.5 * on });
        });
        text(g, 'feet', rx1, ry + 50 * u, { f: font('F', 600, 24 * u), color: BRAND.muted, align: 'right' });
        g.restore();
      }
    },
  },

  install: {
    draw(g, L, s, st, T) {
      const { W, H, u, P, m } = L;
      darkBg(g, L, T);
      const size = (P ? 88 : 80) * u;
      kinetic(g, [['Hollow.', '#fff'], ['Slides over a block.', SAGE_L, cue(s, 'slide', { fallback: 1.7 }) - 0.3]], m, P ? 260 * u : 170 * u, st, 0.15, { size });
      // Real photo: the open end of a Heritage beam.
      const box = P ? [m, 440 * u, W - 2.4 * m, 420 * u] : [m * 0.4, 330 * u, W * 0.52, 640 * u];
      const pin = ease.out(clamp((st - 0.1) / 0.8));
      const r = cutout(g, A.uEnd, box[0] - (1 - pin) * 60 * u, box[1], box[2], box[3], { alpha: pin, u, shadow: 0.5 });
      // Ring on the hollow end.
      const tH = cue(s, 'hollow', { fallback: 0.6 });
      const ra = ease.out(clamp((st - tH - 0.1) / 0.5));
      if (r && ra > 0) {
        const cx = r.x + r.w * 0.86, cy = r.y + r.h * 0.42, rad = r.h * 0.42 * (0.9 + 0.1 * ra);
        g.save(); g.globalAlpha *= ra; g.beginPath(); g.ellipse(cx, cy, rad * 0.62, rad, 0, 0, Math.PI * 2);
        g.lineWidth = 5 * u; g.strokeStyle = SAGE_L; g.setLineDash([14 * u, 10 * u]); g.lineDashOffset = -st * 30 * u; g.stroke(); g.restore();
        // Label on the dark background below the beam, tied to the ring by a short line.
        const hw = measure(g, 'Hollow inside', font('F', 700, 30 * u));
        // Portrait: below the beam. Landscape: above the ring (the caption owns the bottom).
        const ly = P ? r.y + r.h + 46 * u : cy - rad - 40 * u, lx = Math.min(cx + hw / 2, W - m * 0.6);
        g.save(); g.globalAlpha *= ra; g.strokeStyle = SAGE_L; g.lineWidth = 3 * u;
        g.beginPath();
        if (P) { g.moveTo(cx, cy + rad); g.lineTo(cx, ly - 34 * u); } else { g.moveTo(cx, cy - rad); g.lineTo(cx, ly + 12 * u); }
        g.stroke(); g.restore();
        text(g, 'Hollow inside', lx, ly, { f: font('F', 700, 30 * u), color: SAGE_L, align: 'right', alpha: ra });
      }
      // Coded diagram (not the product): ceiling, wood block, and the beam's outline sliding up over it.
      const dx = P ? W * 0.25 : W * 0.6, dw = P ? W * 0.5 : W * 0.3, dy = P ? 990 * u : 300 * u;
      const ceilH = 30 * u;
      const da = ease.out(clamp((st - 0.6) / 0.6));
      g.save(); g.globalAlpha *= da;
      g.fillStyle = '#3A403E'; g.fillRect(dx - 40 * u, dy, dw + 80 * u, ceilH);
      text(g, 'CEILING', dx - 40 * u, dy - 16 * u, { f: font('P', 600, 20 * u), color: '#9AA09A', spacing: 4 });
      const bw = dw * 0.5, bh = dw * 0.36, bx = dx + (dw - bw) / 2;
      block(g, bx, dy + ceilH, bw, bh);
      const tB = cue(s, 'block', { fallback: 2.7 });
      text(g, 'Wood block', bx + bw / 2, dy + ceilH + bh / 2 + 9 * u, { f: font('F', 700, 24 * u), color: '#4A3418', align: 'center', alpha: 1 - ease.inOut(clamp((st - tB) / 0.4)) });
      const tS = cue(s, 'slide', { fallback: 1.7 });
      const slide = ease.inOut(clamp((st - tS) / 1.1));
      const wall = 0.75 / 5.5, ow = bw / (1 - 2 * wall) + 2, oh = ow * 1.0;
      const ox = bx - (ow - bw) / 2, oy = dy + ceilH + lerp(oh * 0.9, 0, slide);
      g.save();
      g.beginPath(); g.rect(dx - 60 * u, dy + ceilH, dw + 120 * u, H); g.clip();
      sectionPath(g, 'U', ox, oy, ow, oh, ow * wall);
      g.fillStyle = 'rgba(203,213,162,0.18)'; g.fill('evenodd');
      g.lineWidth = 4 * u; g.strokeStyle = SAGE_L; sectionPath(g, 'U', ox, oy, ow, oh, ow * wall); g.stroke();
      g.restore();
      // Wiring through the hollow.
      const tW = cue(s, 'hide', { fallback: 4.0 }) - 0.1;
      const wp = ease.inOut(clamp((st - tW) / 0.8));
      if (wp > 0) {
        const wy = dy + ceilH + bh + (oh * (1 - wall) - bh) * 0.5;
        g.lineWidth = 6 * u; g.lineCap = 'round'; g.strokeStyle = '#E2A04A';
        g.beginPath(); g.moveTo(ox + ow * wall * 1.8, wy); g.lineTo(lerp(ox + ow * wall * 1.8, ox + ow * (1 - wall * 1.8), wp), wy); g.stroke();
        text(g, 'Room for wiring', ox + ow / 2, oy + oh + 52 * u, { f: font('F', 700, 28 * u), color: '#E2A04A', align: 'center', alpha: wp });
      }
      g.restore();
    },
  },

  ship: {
    draw(g, L, s, st) {
      const { W, H, u, P, m } = L;
      cover(g, A.ship, 0, 0, W, H, { src: A.shipBox, zoom: lerp(1.04, 1.14, ease.inOut(clamp(st / (s.sd + TR)))), py: 0.75, px: P ? 0.1 : 0 });
      if (P) scrim(g, L, { from: 0.15, to: 0.9, a0: 0.25, a1: 0.85 }); else scrim(g, L, { from: 0, to: 0.75, a0: 0.82, a1: 0.15, dir: 'right' });
      vignette(g, L, 0.3);
      const size = HS(L);
      const y0 = P ? 520 * u : 300 * u;
      kicker(g, 'Heritage Quick Ship', m, y0 - size * 1.0, { size: (P ? 30 : 26) * u, alpha: ease.out(clamp(st / 0.6)) });
      kinetic(g, [['Quick Ship', '#fff']], m, y0, st, cue(s, 'ship', { fallback: 0.6 }) - 0.35, { size });
      const stat = (num, unit, label, t, x, y) => {
        const p = ease.out(clamp((st - t) / 0.6));
        const ns = (P ? 190 : 180) * u;
        g.save(); g.beginPath(); g.rect(x - 10 * u, y - ns * 1.0, W, ns * 1.25); g.clip();
        text(g, num, x, y + (1 - p) * ns * 0.8, { f: font('P', 700, ns), color: '#fff', alpha: p });
        g.restore();
        text(g, unit, x, y + 58 * u, { f: font('F', 700, 36 * u), color: SAGE_L, alpha: p });
        text(g, label, x, y + 104 * u, { f: font('F', 500, 30 * u), color: 'rgba(255,255,255,0.88)', alpha: p });
      };
      const t3 = cue(s, 'three', { fallback: 2.9, alts: ['3'] }) - 0.3;
      const tP = cue(s, 'primed', { fallback: 4.7 });
      const t1 = cue(s, 'one', { after: tP, fallback: 5.2, alts: ['1'] }) - 0.3;
      if (P) { stat('3–5', 'business days', 'Stained', t3, m, 900 * u); stat('24–72', 'hours', 'Primed', t1, m, 1260 * u); }
      else { stat('3–5', 'business days', 'Stained', t3, m, 640 * u); stat('24–72', 'hours', 'Primed', t1, m + 470 * u, 640 * u); }
      text(g, 'Usual ship times', m, P ? 1450 * u : 880 * u, { f: font('F', 500, 24 * u), color: 'rgba(255,255,255,0.7)', alpha: ease.out(clamp((st - t1) / 0.6)) });
    },
  },

  end: {
    draw(g, L, s, st, T) {
      const { W, H, u, P, m } = L;
      paper(g, L, T);
      const pw = P ? W : W * 0.46, ph = P ? H * 0.36 : H;
      cover(g, A.room6, 0, 0, pw, ph, { zoom: lerp(1.06, 1.14, clamp(st / s.sd)), py: P ? 0.8 : 0, px: P ? 0 : -0.1 });
      const cx = P ? m : pw + 90 * u, cw = P ? W - 2 * m : W - pw - 90 * u - m;
      const ly = P ? ph + 110 * u : 150 * u;
      wordmark(g, cx, ly, 24 * u, { alpha: ease.out(clamp(st / 0.6)) });
      const hs = (P ? 104 : 96) * u, hy = P ? ph + 270 * u : 330 * u;
      kinetic(g, [['Order a sample', BRAND.ink]], cx, hy, st, cue(s, 'Order', { fallback: 0.6 }) - 0.3, { size: hs });
      text(g, 'See it in your own light.', cx, hy + 64 * u, { f: font('F', 500, (P ? 36 : 32) * u), color: BRAND.muted, alpha: ease.out(clamp((st - cue(s, 'see', { fallback: 1.5 }) + 0.2) / 0.5)) });
      // The real sample, and an endcap.
      const sp = ease.out(clamp((st - 0.9) / 0.7));
      const sy = P ? hy + 110 * u : hy + 120 * u, sh = P ? 330 * u : 330 * u;
      cutout(g, A.sample, cx, sy + (1 - sp) * 30 * u, cw * 0.48, sh, { alpha: sp, u, shadow: 0.25, align: 'left' });
      const ep = ease.out(clamp((st - 1.5) / 0.7));
      const ex = cx + cw * 0.58, es = Math.min(cw * 0.26, 170 * u);
      g.save(); g.globalAlpha *= ep;
      g.shadowColor = `rgba(0,0,0,${0.2 * ep})`; g.shadowBlur = 24 * u; g.shadowOffsetY = 10 * u;
      g.drawImage(A.endcap.im, A.endcap.w * 0.12, A.endcap.h * 0.12, A.endcap.w * 0.76, A.endcap.h * 0.76, ex, sy + 30 * u, es, es);
      g.restore();
      text(g, 'Endcaps sold', ex, sy + 30 * u + es + 40 * u, { f: font('F', 700, 24 * u), color: BRAND.ink, alpha: ep });
      text(g, 'separately, unstained', ex, sy + 30 * u + es + 72 * u, { f: font('F', 500, 24 * u), color: BRAND.muted, alpha: ep });
      // URL.
      const up = ease.out(clamp((st - 2.0) / 0.6));
      const uf = font('F', 700, 34 * u), url = BRAND.url, uw = measure(g, url, uf) + 70 * u;
      const uy = P ? H - 210 * u : H - 220 * u;
      g.save(); g.globalAlpha *= up;
      rr(g, cx, uy, uw, 76 * u, 38 * u); g.fillStyle = BRAND.green; g.fill();
      text(g, url, cx + uw / 2, uy + 50 * u, { f: uf, color: '#fff', align: 'center' });
      g.restore();
    },
  },
};

// ---- frame --------------------------------------------------------------------------------------------
function drawScene(g, L, s, st, T) {
  g.save();
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  // A slow push-in on every scene, so the frame is never still.
  const k = 1 + 0.012 * (st / s.sd);
  g.translate(L.W / 2, L.H / 2); g.scale(k, k); g.translate(-L.W / 2, -L.H / 2);
  scenes[s.id].draw(g, L, s, st, T);
  g.restore();
}

export function drawFrame(g, L, all, f) {
  let i = all.findIndex(s => f >= s.start_frame && f < s.end_frame);
  if (i < 0) i = all.length - 1;
  const s = all[i], T = f / FPS, st = (f - s.start_frame) / FPS;
  const kind = TRANS[s.id];
  if (i > 0 && kind && st < TR) {
    const p = ease.inOut(st / TR), prev = all[i - 1];
    g.save();
    if (kind === 'wipe') { g.translate(-p * 50 * L.u, 0); }
    drawScene(g, L, prev, prev.sd + st, T);
    g.restore();
    O.save();
    O.clearRect(0, 0, L.W, L.H);
    if (kind === 'wipe') O.translate((1 - p) * 70 * L.u, 0);
    drawScene(O, L, s, st, T);
    O.restore();
    if (kind === 'wipe') {
      // Soft-edged wipe from the left; fully open (no leftover corner) when p reaches 1.
      const band = 160 * L.u, ex = lerp(0, L.W + band, p);
      O.save();
      O.globalCompositeOperation = 'destination-in';
      const gr = O.createLinearGradient(ex - band, 0, ex, 0);
      gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      O.fillStyle = gr; O.fillRect(0, 0, L.W, L.H);
      O.restore();
      g.drawImage(OC, 0, 0);
    } else {
      g.save(); g.globalAlpha = p; g.drawImage(OC, 0, 0); g.restore();
    }
  } else {
    drawScene(g, L, s, st, T);
  }
  captions(g, L, s, st);
}
