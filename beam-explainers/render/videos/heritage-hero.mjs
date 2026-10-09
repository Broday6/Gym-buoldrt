// Heritage Timber hero edit: objection-led (each scene answers one reason a buyer hesitates),
// full-bleed photography, kinetic type, burned-in captions, and wipes that land on the music's beats. Every beam, finish and texture on screen is a real Ekena photo (rooms,
// texture close-ups, and product shots cut out of their white backgrounds by tools/cutout.py).
// Coded drawing is only used for things that aren't the product: the ceiling and block, the size
// outlines, the length ruler, captions and UI.
import { createCanvas } from '@napi-rs/canvas';
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, IMG, BRAND, FPS, clamp, lerp, ease, cue, cues, img, cover, rr, text, measure, wrap, font, wordmark,
  inAmt, listStack, paper, dim, inch, sectionPath, block,
} from '../lib/core.mjs';

const SAGE_L = '#CBD5A2';
const DARK = '#141818';
const TR = 0.6; // scene-to-scene transition length (s), at the start of the incoming scene
const TRANS = { real: 'wipe', weight: 'wipe', install: 'fade', compare: 'wipe', choose: 'wipe', ship: 'wipe', end: 'fade' };
// Caption parts (split on "|") left off screen because the picture already shows the words in big type.
const NOCAP = {};
// Caption centre per scene (default: frame centre). The 16:9 end card centres it under the cream panel.
const CAPX = { end: L => (L.P ? L.W / 2 : L.W * 0.73) };

const TEXTURES = [
  ['Mena', 'mena', ['Mina', 'Meena']], ['Salvaged Timber', 'salvaged-timber'], ['Rustic Sawn', 'rustic-sawn'],
  ['Resawn Rip', 'resawn-rip'], ['Reclaimed Axed Cut', 'reclaimed-axed-cut'], ['Sanded Smooth', 'sanded-smooth'],
];
const FINISHES = [
  ['Sandstone', 'sandstone'], ['Kona Brown', 'kona-brown', ['Kona']], ['Vanilla Chai', 'vanilla-chai', ['vanilla']],
  ['Warm Caramel', 'warm-caramel', ['warm']], ['Natural White Oak', 'natural-white-oak', ['natural']],
  ['Smokey Brown', 'smokey-brown', ['smoky', 'Smoky Brown']], ['Primed', 'primed', ['primed']],
];
// Why not solid wood: [row, Heritage, solid wood]. Sources: claims H21-H24 (product record + Ekena's copy).
const COMPARE = [
  ['Weight', 'Ships at 18 lb (5½ in, 12 ft)', 'Heavy'],
  ['Install', 'One person, household tools', 'More labor'],
  ['Upkeep', 'Resists warping and cracking', 'More upkeep'],
  ['Texture', 'Cast from real timber', 'Real timber'],
];
const SPECS = [['Finishes', '6 hand-stained, or primed'], ['Textures', '6, cast from real timber'], ['Sizes', '8, from 3½×3½ to 9½×11½ in'], ['Lengths', '4 to 24 ft']];

const A = {};
let OC = null, O = null; // offscreen canvas for the incoming scene during a transition
/** Beats of the music that fall in [a, b] of scene time (the edit is cut to them). */
function beatsIn(s, a, b) {
  const t0 = s.start_frame / FPS;
  return A.beats.map(x => x - A.off - t0).filter(x => x >= a && x <= b);
}

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
    const cx = CAPX[s.id] ? CAPX[s.id](L) : L.W / 2;
    rr(g, cx - tw / 2 - padX, y - size * 0.95 - padY * 0.3, tw + padX * 2, size * 1.3 + padY * 0.6, size * 0.3);
    g.fillStyle = 'rgba(12,14,14,0.62)';
    g.fill();
    let x = cx - tw / 2;
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
  // Full-frame photos come from img/heritage/hi (tools/upscale.py: Lanczos 2x + light sharpening).
  const hi = name => img(`heritage/hi/${name}.jpg`, { maxSide: 2400 });
  A.hook = await hi('BMSTKB-09');
  A.room8 = await img('heritage/angles/BMSTKB-08.jpg', { maxSide: 1200 });
  A.room8blur = blurred(A.room8, 26);
  A.room6 = await hi('BMSTKB-06');
  A.ship = await hi('BMRSWC-08');
  // The same Ekena room render in each finish (Salvaged Timber). Smokey Brown has no room render,
  // so it is shown as its real close-up instead.
  const FCODE = { sandstone: 'SS', 'kona-brown': 'KB', 'vanilla-chai': 'VC', 'warm-caramel': 'WC', 'natural-white-oak': 'WO', primed: 'OT' };
  A.finRoom = [];
  for (const [, sl] of FINISHES) A.finRoom.push(FCODE[sl] ? await hi(`BMST${FCODE[sl]}-07`) : null);
  A.finIntro = await hi('BMSTKB-07');
  A.hero = await cut('salvaged-timber__kona-brown');
  A.texIntro = await hi('BMSTKB-0');
  A.tex = [];
  for (const [, sl] of TEXTURES) A.tex.push(sl === 'sanded-smooth' ? await cut('sanded-smooth__primed') : await hi(`texture-${sl}`));
  A.finSw = [], A.finBeam = [];
  for (const [, sl] of FINISHES) {
    A.finSw.push(await hi(`finish-${sl}`));
    A.finBeam.push(await cut(`salvaged-timber__${sl}`, 'cutout-frame'));
  }
  // One box for the whole set, so the beam doesn't shift as the finish changes.
  const bs = A.finBeam.map(r => r.bb);
  const x0 = Math.min(...bs.map(b => b.x)), y0 = Math.min(...bs.map(b => b.y));
  A.finBB = { x: x0, y: y0, w: Math.max(...bs.map(b => b.x + b.w)) - x0, h: Math.max(...bs.map(b => b.y + b.h)) - y0 };
  A.uEnd = await cut('angles__BMSTKB-05');
  A.sample = await cut('accessories__sample-kit');
  A.endcap = await img('heritage/accessories/endcap.jpg', { maxSide: 1200 });
  A.cmp = await hi('BMRDWO-09');
  A.sbBeam = await cut('room-renders__BMSTSB-05');
  // Generated stills (see deliver/generation-pack): used when present, real Ekena images otherwise.
  const shape = L.P ? '9x16' : '16x9';
  const opt = rel => fs.existsSync(path.join(IMG, rel)) ? img(rel, { maxSide: 2400 }) : null;
  A.before = await opt(`heritage/generated/before-09-${shape}.jpg`);
  A.person = await opt(`heritage/generated/person-lift-${shape}.jpg`);
  A.beats = JSON.parse(fs.readFileSync(path.join(ROOT, 'music', 'peaceful-beats.json'), 'utf8')).beats;
  A.off = JSON.parse(fs.readFileSync(path.join(ROOT, 'out', 'heritage-hero', 'timeline.json'), 'utf8')).music_offset_s ?? 0;
  OC = createCanvas(L.W, L.H);
  O = OC.getContext('2d');
}

// ---- scenes -------------------------------------------------------------------------------------------
export const scenes = {
  hook: {
    draw(g, L, s, st) {
      const { W, H, u, P, m } = L;
      const k = ease.inOut(clamp(st / (s.sd + TR)));
      const cam = { zoom: lerp(1.18, 1.04, k), py: P ? 0 : 0.85, px: P ? 0.05 : 0 };
      cover(g, A.hook, 0, 0, W, H, cam);
      if (A.before) {
        // Bare ceiling first; the beams wipe in on the beat nearest "beams".
        const tb = cue(s, 'beams', { fallback: 2.0 });
        const bt = beatsIn(s, tb - 0.5, tb + 0.5).sort((x, y) => Math.abs(x - tb) - Math.abs(y - tb))[0] ?? tb;
        const p = ease.out(clamp((st - bt) / 0.6));
        if (p < 1) {
          g.save(); g.beginPath(); g.rect(p * W, 0, W, H); g.clip(); cover(g, A.before, 0, 0, W, H, cam); g.restore();
          if (p > 0) { g.fillStyle = SAGE_L; g.fillRect(p * W - 3 * u, 0, 6 * u, H); }
        }
      }
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

  real: {
    draw(g, L, s, st) {
      const { W, H, u, P, m } = L;
      // Up close (a real macro) beside the same finish across a room (an Ekena render).
      const pin = ease.out(clamp(st / 0.9));
      const split = P ? H * 0.5 : W * 0.5;
      const tC = cue(s, 'cast', { fallback: 3.2 });
      g.save(); g.beginPath(); P ? g.rect(0, 0, W, split) : g.rect(0, 0, split, H); g.clip();
      cover(g, A.finSw[FINISHES.findIndex(f => f[1] === 'kona-brown')], 0, 0, P ? W : split, P ? split : H, { zoom: 1.12 - 0.06 * clamp(st / s.sd), px: -0.1 });
      g.restore();
      g.save(); g.beginPath(); P ? g.rect(0, split, W, H - split) : g.rect(split, 0, W - split, H); g.clip();
      cover(g, A.finIntro, P ? 0 : split + (1 - pin) * 80 * u, P ? split + (1 - pin) * 80 * u : 0, P ? W : W - split, P ? H - split : H,
        { zoom: lerp(1.08, 1.0, clamp(st / s.sd)), py: P ? 0.4 : 0.5 });
      g.restore();
      g.fillStyle = '#fff'; P ? g.fillRect(0, split - 2 * u, W, 4 * u) : g.fillRect(split - 2 * u, 0, 4 * u, H);
      // Shade only behind the words: the top of the frame (headline) and a strip under each label.
      scrim(g, L, { from: P ? 0.3 : 0.45, to: 0, a0: 0, a1: 0.6 });
      if (!P) scrim(g, L, { from: 0.72, to: 1, a0: 0, a1: 0.55 });
      // Labels for each half.
      const la = ease.out(clamp((st - tC) / 0.5));
      const lf = (P ? 30 : 26) * u;
      kicker(g, 'Up close', P ? m : m, P ? split - 40 * u : H - 150 * u, { size: lf, alpha: la, color: '#fff' });
      if (P) { g.save(); g.globalAlpha *= la * 0.6; rr(g, m - 16 * u, split + 30 * u, measure(g, 'ACROSS THE ROOM', font('P', 600, lf), lf * 0.18) + 32 * u, lf * 1.9, lf * 0.5); g.fillStyle = '#141818'; g.fill(); g.restore(); }
      kicker(g, 'Across the room', P ? m : split + m * 0.6, P ? split + 30 * u + lf * 1.3 : H - 150 * u, { size: lf, alpha: la, color: '#fff' });
      // Brand, then the card.
      const size = (P ? 104 : 96) * u;
      const tH = cue(s, 'Heritage', { fallback: 0.6 }) - 0.15, tE = cue(s, 'Ekena', { fallback: 1.9, alts: ['Ikenna', 'E.'] }) - 0.1;
      const y1 = P ? 300 * u : 260 * u;
      kicker(g, 'Ekena Millwork', m, y1 - size * 0.95, { size: (P ? 30 : 26) * u, alpha: ease.out(clamp((st - tE) / 0.5)) });
      kinetic(g, [['Heritage Timber', '#fff'], ['Cast from real timber', SAGE_L, tC - 0.2]], m, y1, st, tH, { size: Math.min(size, (P ? W - 2 * m : split - m * 1.4) / measure(g, 'Cast from real timber', font('P', 700, 1))) });
    },
  },

  weight: {
    draw(g, L, s, st, T) {
      const { W, H, u, P, m } = L;
      const t18 = cue(s, 'eighteen', { fallback: 2.6, alts: ['18', 'about'] }), tOne = cue(s, 'One', { fallback: 2.6 });
      if (A.person) {
        cover(g, A.person, 0, 0, W, H, { zoom: lerp(1.08, 1.0, clamp(st / s.sd)) });
        P ? scrim(g, L, { from: 0.4, a1: 0.85 }) : scrim(g, L, { from: 0.35, to: 1, a0: 0, a1: 0.8, dir: 'right' });
      } else {
        darkBg(g, L, T);
        // The real beam, long, entering on the diagonal.
        const pin = ease.out(clamp((st - 0.05) / 1.1));
        cutout(g, A.hero, (P ? -W * 0.1 : -W * 0.04) - (1 - pin) * W * 0.3 - 20 * u * st, P ? H * 0.47 : H * 0.18, P ? W * 1.15 : W * 0.68, P ? H * 0.30 : H * 0.72,
          { alpha: ease.out(clamp(st / 0.5)), u, shadow: 0.5 });
      }
      // Stat: counts up to 18 as it's said.
      const x = P ? m : W * 0.62, y = P ? 520 * u : H * 0.46;
      const c = ease.out(clamp((st - t18 + 0.45) / 0.5)); // reaches 18 as the word starts
      const ns = (P ? 260 : 250) * u;
      kicker(g, 'A 5½ × 5½ in × 12 ft beam ships at', x, y - ns * 0.95, { size: (P ? 30 : 26) * u, alpha: ease.out(clamp((st - 0.3) / 0.5)) });
      g.save(); g.globalAlpha *= ease.out(clamp((st - t18 + 0.55) / 0.3));
      const num = String(Math.round(18 * c));
      text(g, num, x, y, { f: font('P', 700, ns), color: '#fff' });
      text(g, 'lb', x + measure(g, num, font('P', 700, ns)) + 16 * u, y, { f: font('P', 700, ns * 0.42), color: SAGE_L });
      g.restore();
      text(g, 'Shipping weight, Heritage Salvaged Timber', x, y + 60 * u, { f: font('F', 600, (P ? 32 : 28) * u), color: 'rgba(255,255,255,0.8)', alpha: ease.out(clamp((st - t18 - 0.3) / 0.5)) });
      kinetic(g, [['One person can lift it.', SAGE_L]], x, y + (P ? 190 : 170) * u, st, tOne - 0.2, { size: (P ? 64 : 58) * u });
    },
  },

  compare: {
    draw(g, L, s, st) {
      const { W, H, u, P, m } = L;
      cover(g, A.cmp, 0, 0, W, H, { zoom: lerp(1.1, 1.02, clamp(st / s.sd)), py: 0.7 });
      g.fillStyle = 'rgba(14,17,17,0.74)'; g.fillRect(0, 0, W, H);
      const size = (P ? 92 : 84) * u;
      kinetic(g, [['Why not solid wood?', '#fff']], m, P ? 300 * u : 190 * u, st, 0.15, { size: Math.min(size, (W - 2 * m) / measure(g, 'Why not solid wood?', font('P', 700, 1))) });
      // Table: rows arrive on the beats.
      const x0 = m, tw = Math.min(W - 2 * m, 1500 * u), cols = P ? [0, 0.25, 0.70] : [0, 0.22, 0.68];
      const y0 = P ? 470 * u : 300 * u, rh = (P ? 150 : 128) * u, fs = (P ? 34 : 34) * u;
      const rb = beatsIn(s, 0.7, s.sd - 1.2);
      const times = [0.45, ...[0, 1, 2, 3].map(i => rb[i * 1] ?? 0.9 + i * 0.7)];
      const ha = ease.out(clamp((st - times[0]) / 0.5));
      // Heritage column panel.
      g.save(); g.globalAlpha *= ha;
      rr(g, x0 + tw * cols[1] - 24 * u, y0 - 70 * u, tw * (cols[2] - cols[1]), rh * 4 + 96 * u, 18 * u);
      g.fillStyle = 'rgba(142,156,93,0.22)'; g.fill();
      text(g, 'HERITAGE TIMBER', x0 + tw * cols[1], y0 - 20 * u, { f: font('P', 600, (P ? 24 : 24) * u), color: SAGE_L, spacing: 4 });
      text(g, 'SOLID WOOD', x0 + tw * cols[2], y0 - 20 * u, { f: font('P', 600, 24 * u), color: 'rgba(255,255,255,0.6)', spacing: 4 });
      g.restore();
      COMPARE.forEach(([lab, her, wood], i) => {
        const a = ease.out(clamp((st - times[i + 1]) / 0.45));
        if (a <= 0) return;
        const y = y0 + i * rh;
        g.save(); g.globalAlpha *= a;
        g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(x0, y + 8 * u, tw, 2 * u);
        const yy = y + rh * 0.56 + (1 - a) * 14 * u;
        text(g, lab, x0, yy, { f: font('F', 600, fs * 0.85), color: 'rgba(255,255,255,0.75)' });
        checkDot(g, x0 + tw * cols[1] + fs * 0.45, yy - fs * 0.33, fs * 0.45);
        const hl = wrap(g, her, font('F', 700, fs), tw * (cols[2] - cols[1]) - fs * 2.2).slice(0, 2);
        hl.forEach((ln, k) => text(g, ln, x0 + tw * cols[1] + fs * 1.3, yy + (k - (hl.length - 1) / 2) * fs * 1.15, { f: font('F', 700, fs), color: '#fff' }));
        text(g, wood, x0 + tw * cols[2], yy, { f: font('F', 500, fs), color: 'rgba(255,255,255,0.6)' });
        g.restore();
      });
    },
  },

  choose: {
    draw(g, L, s, st, T) {
      const { W, H, u, P, m } = L;
      // The same Ekena room, the finish changing on each beat (Smokey Brown has no room render: Ekena's studio shot of it).
      const bt = beatsIn(s, 0.3, s.sd);
      const ts = FINISHES.map((_, i) => bt[i] ?? 0.4 + i * 0.7);
      const stack = listStack(ts.map(t => t + 0.15), st, 0.35);
      const cam = { zoom: lerp(1.07, 1.0, ease.inOut(clamp(st / (s.sd + TR)))), py: P ? 0 : 0.5, px: P ? 0.05 : 0 };
      for (const { i, a } of stack) {
        const room = i < 0 ? A.finIntro : A.finRoom[i];
        if (room) cover(g, room, 0, 0, W, H, { ...cam, alpha: a });
        else {
          // No room render in this finish: Ekena's own studio shot of the beam in it, on a dark panel,
          // placed clear of the spec table (16:9 right) and the name panel (9:16 middle).
          g.save(); g.globalAlpha *= a; darkBg(g, L, T); g.restore();
          // Left-aligned past the frame edge, so the photo's cropped end is off screen; below the headline.
          if (P) cutout(g, A.sbBeam, -70 * u, 370 * u, W, 400 * u, { alpha: a, u, shadow: 0.45, align: 'left' });
          else cutout(g, A.sbBeam, -90 * u, 300 * u, W * 0.6, 440 * u, { alpha: a, u, shadow: 0.45, align: 'left' });
        }
      }
      scrim(g, L, { from: 0.3, to: 0, a0: 0, a1: 0.55 });
      scrim(g, L, { from: P ? 0.45 : 0.5, a1: 0.85 });
      if (P) {
        // 9:16: the name block sits over the bright ceiling, so it gets its own dark panel.
        const ny0 = H * 0.47;
        g.save(); g.globalAlpha *= ease.out(clamp((st - 0.3) / 0.4)) * 0.78;
        rr(g, m - 24 * u, ny0 - 110 * u, W - 2 * m + 48 * u, 210 * u, 18 * u); g.fillStyle = '#141818'; g.fill(); g.restore();
      }
      const hs = (P ? 80 : 76) * u;
      kinetic(g, [['Your finish.', '#fff'], ['Your size.', SAGE_L, cue(s, 'Eight', { fallback: 3.4 }) - 0.2]], m, P ? 230 * u : 160 * u, st, 0.15, { size: hs });
      // Current finish: name + swatch row.
      const ny = P ? H * 0.47 : H - 230 * u;
      FINISHES.forEach(([name, sl], i) => {
        // Names follow their photo: in once the cross-fade is half done, out just before the next.
        const fin = ease.inOut(clamp((st - ts[i] - 0.15) / 0.2));
        const fout = i + 1 < ts.length ? ease.inOut(clamp((st - ts[i + 1]) / 0.15)) : 0;
        const a = fin * (1 - fout);
        if (a <= 0) return;
        kicker(g, sl === 'primed' ? 'Ready to paint' : A.finRoom[i] ? 'Hand-stained' : 'Hand-stained', m, ny - 62 * u, { size: (P ? 26 : 24) * u, alpha: a });
        text(g, name, m, ny, { f: font('P', 700, (P ? 64 : 60) * u), color: '#fff', alpha: a });
      });
      const r = (P ? 26 : 24) * u, gap = 14 * u, rowY = ny + (P ? 70 : 62) * u;
      const ins = ts.map(t => clamp((st - t) / 0.2));
      FINISHES.forEach((_, i) => {
        const on = ins[i] * (1 - (i + 1 < ins.length ? ins[i + 1] : 0));
        swatchDot(g, A.finSw[i], m + r + i * (2 * r + gap), rowY - on * 6 * u, r, { alpha: ease.out(clamp((st - 0.3 - i * 0.05) / 0.4)) * (0.6 + 0.4 * Math.max(on, 0.6 * ins[i])), ring: on, ringColor: SAGE_L });
      });
      // Spec table, as "Eight sizes" is said.
      const tE = cue(s, 'Eight', { fallback: 3.4, alts: ['8'] }) - 0.2;
      const pa = ease.out(clamp((st - tE) / 0.5));
      if (pa > 0) {
        const pw = P ? W - 2 * m : 760 * u, px = P ? m : W - m - pw, py = P ? H * 0.53 : 300 * u, rh = (P ? 68 : 72) * u;
        g.save(); g.globalAlpha *= pa;
        rr(g, px, py + (1 - pa) * 20 * u, pw, rh * SPECS.length + 40 * u, 18 * u); g.fillStyle = 'rgba(14,17,17,0.72)'; g.fill();
        SPECS.forEach(([k, v], i) => {
          const y = py + (1 - pa) * 20 * u + 20 * u + i * rh;
          if (i) { g.fillStyle = 'rgba(255,255,255,0.14)'; g.fillRect(px + 28 * u, y, pw - 56 * u, 2 * u); }
          text(g, k, px + 28 * u, y + rh * 0.62, { f: font('F', 600, 26 * u), color: 'rgba(255,255,255,0.7)' });
          text(g, v, px + pw - 28 * u, y + rh * 0.62, { f: font('F', 700, (P ? 30 : 30) * u), color: '#fff', align: 'right' });
        });
        g.restore();
      }
    },
  },

  install: {
    draw(g, L, s, st, T) {
      const { W, H, u, P, m } = L;
      darkBg(g, L, T);
      const size = (P ? 88 : 80) * u;
      kinetic(g, [['One-person install.', '#fff'], ['Slides over a block.', SAGE_L, cue(s, 'slides', { fallback: 0.8 }) - 0.3]], m, P ? 260 * u : 170 * u, st, 0.15, { size });
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
        // Portrait: below the beam. Landscape: right of the ring, between photo and diagram
        // (the card owns the top, the caption the bottom).
        g.save(); g.globalAlpha *= ra; g.strokeStyle = SAGE_L; g.lineWidth = 3 * u;
        g.beginPath();
        if (P) {
          const ly = r.y + r.h + 46 * u;
          g.moveTo(cx, cy + rad); g.lineTo(cx, ly - 34 * u); g.stroke(); g.restore();
          text(g, 'Hollow inside', Math.min(cx + hw / 2, W - m * 0.6), ly, { f: font('F', 700, 30 * u), color: SAGE_L, align: 'right', alpha: ra });
        } else {
          const ex = cx + rad * 0.62, lx = ex + 46 * u;
          g.moveTo(ex, cy); g.lineTo(lx - 12 * u, cy); g.stroke(); g.restore();
          text(g, 'Hollow inside', lx, cy + 10 * u, { f: font('F', 700, 30 * u), color: SAGE_L, alpha: ra });
        }
      }
      // Coded diagram (not the product): ceiling, wood block, and the beam's outline sliding up over it.
      const dx = P ? W * 0.25 : W * 0.64, dw = P ? W * 0.5 : W * 0.3, dy = P ? 990 * u : 300 * u;
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
      cover(g, A.ship, 0, 0, W, H, { zoom: lerp(1.04, 1.14, ease.inOut(clamp(st / (s.sd + TR)))), py: 0.75, px: P ? 0.1 : 0 });
      if (P) { scrim(g, L, { from: 0.55, to: 0.15, a0: 0, a1: 0.6 }); scrim(g, L, { from: 0.72, to: 1, a0: 0, a1: 0.55 }); } else scrim(g, L, { from: 0, to: 0.75, a0: 0.82, a1: 0.15, dir: 'right' });
      vignette(g, L, 0.3);
      const size = HS(L);
      const y0 = P ? 520 * u : 300 * u;
      kicker(g, 'In stock', m, y0 - size * 1.0, { size: (P ? 30 : 26) * u, alpha: ease.out(clamp(st / 0.6)) });
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
      const t1 = cue(s, 'business', { fallback: 2.0 }) + 0.3;
      // Everything clears in the last 0.3 s, so nothing is left under the end card's fade.
      g.globalAlpha *= 1 - ease.inOut(clamp((st - (s.sd - 0.35)) / 0.3));
      if (P) {
        g.save(); g.globalAlpha *= ease.out(clamp((st - t3 + 0.2) / 0.4)) * 0.78 * (1 - ease.inOut(clamp((st - (s.sd - 0.35)) / 0.3)));
        rr(g, m - 30 * u, 720 * u, W - 2 * m + 60 * u, 715 * u, 20 * u); g.fillStyle = '#141818'; g.fill(); g.restore(); // the panel ends above the caption band
      }
      if (P) { stat('3–5', 'business days', 'Stained', t3, m, 900 * u); stat('24–72', 'hours', 'Primed', t1, m, 1260 * u); }
      else { stat('3–5', 'business days', 'Stained', t3, m, 640 * u); stat('24–72', 'hours', 'Primed', t1, m + 470 * u, 640 * u); }
      text(g, 'Usual ship times', m, P ? 1405 * u : 880 * u, { f: font('F', 500, 24 * u), color: 'rgba(255,255,255,0.7)', alpha: ease.out(clamp((st - t1) / 0.6)) });
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
  g.imageSmoothingQuality = 'high';
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
    // Ease-out, counted from one frame early: the wipe's biggest step is the boundary frame itself,
    // which sits on a beat of the music.
    const p = ease.out((st + 1 / FPS) / TR), prev = all[i - 1];
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
      const band = 160 * L.u, ex = lerp(band, L.W + band, p); // the soft edge starts on screen, so the first step is the biggest
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
