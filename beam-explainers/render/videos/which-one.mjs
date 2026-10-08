// Heritage Timber vs Timberthane: Which Beam Do You Need? Every product, texture and finish on screen
// is a real Ekena product photo or swatch; ceilings, blocks, calendars, the endcap selector and the
// size diagrams' outlines are coded.
import {
  BRAND, FACTS, font, clamp, lerp, ease, prog, cue, img, product, cover, productFit, card, text, measure,
  pill, check, header, envelope, section, calendar, block, inch, slug, wordmark, rr, reveal, unionBox, label2, mix,
} from '../lib/core.mjs';

const KICK = 'Heritage vs Timberthane';
const HER = FACTS.heritage, TT = FACTS.timberthane;
const H_TEX = ['Mena', 'Salvaged Timber', 'Rustic Sawn', 'Resawn Rip', 'Reclaimed Axed Cut', 'Sanded Smooth'];
const H_FIN = ['Sandstone', 'Kona Brown', 'Vanilla Chai', 'Warm Caramel', 'Natural White Oak', 'Smokey Brown', 'Primed'];
const A = {};

export async function preload() {
  A.hRoom = await img('heritage/angles/BMSTKB-09.jpg', { maxSide: 1800 });
  A.tRoomWide = await img('timberthane/rooms/de297206d8edd7757b4d.jpg', { maxSide: 1800, bbox: true });
  A.tRoomTall = await img('timberthane/rooms/d699e20b616809ca930b.jpg', { maxSide: 1800 });
  A.hBeam = await product('heritage/product/salvaged-timber/kona-brown.jpg');
  A.tBeam = await product('timberthane/product/hand-hewn/aged.jpg');
  A.hollow = await img('heritage/angles/BMSTKB-04.jpg', { maxSide: 700, bbox: true });
  A.hEnd = await img('heritage/angles/BMSTKB-05.jpg', { maxSide: 900, bbox: true });
  A.endcap = await product('heritage/accessories/endcap.jpg');
  A.hSample = await product('heritage/accessories/sample-kit.jpg');
  A.tSample = await img('timberthane/accessories/material-sample.jpg', { maxSide: 800 });
  A.hGrain = await img('heritage/swatch/texture-salvaged-timber.jpg', { maxSide: 600 });
  A.tGrain = await img('timberthane/angles/BMHHS3C0ZD-0.jpg', { maxSide: 600 });
  A.shape = {};
  for (const k of ['plank', 'l-beam', 'u-beam', 'box-beam']) A.shape[k] = await product(`timberthane/shapes/hand-hewn-${k}.jpg`);
  A.shapeBox = unionBox(Object.values(A.shape));
  A.hTex = {}; for (const t of H_TEX) if (t !== 'Sanded Smooth') A.hTex[t] = await img(`heritage/swatch/texture-${slug(t)}.jpg`, { maxSide: 300 });
  A.hSmooth = await product('heritage/product/sanded-smooth/primed.jpg');
  A.hFin = {}; for (const f of H_FIN) A.hFin[f] = await img(`heritage/swatch/finish-${slug(f)}.jpg`, { maxSide: 240 });
  A.tTex = {}; for (const t of TT.textures) A.tTex[t] = await img(`timberthane/builder/texture-${slug(t)}.jpg`, { maxSide: 300 });
  A.tFin = {}; for (const f of TT.finishes) A.tFin[f] = await img(`timberthane/builder/finish-${slug(f)}.jpg`, { maxSide: 160 });
}

/** The two halves of the comparison: side by side in 16:9, stacked in 9:16. */
function cols(L) {
  const { W, P, u } = L;
  if (P) return [{ x: L.m, y: 410 * u, w: W - 2 * L.m, h: 660 * u }, { x: L.m, y: 1120 * u, w: W - 2 * L.m, h: 660 * u }];
  const w = (W - 2 * L.m - 60 * u) / 2;
  return [{ x: L.m, y: 250 * u, w, h: 760 * u }, { x: L.m + w + 60 * u, y: 250 * u, w, h: 760 * u }];
}
/** Column title: product line name + its tag. */
function colTitle(g, L, c, name, tag, a) {
  const { u } = L;
  g.save(); g.globalAlpha *= a;
  text(g, name, c.x + 36 * u, c.y + 70 * u, { f: font('P', 700, 44 * u) });
  const nw = measure(g, name, font('P', 700, 44 * u));
  pill(g, tag, c.x + 36 * u + nw + 20 * u, c.y + 30 * u, { size: 24 * u });
  g.restore();
}
const colIn = (st, t) => prog(st, t - 0.25, 0.6, ease.out);
function colCard(g, L, c, p) {
  g.translate(0, (1 - p) * 40 * L.u);
  card(g, c.x, c.y, c.w, c.h, { r: 28 * L.u, alpha: 1 });
}
/** Small tile of a Heritage texture (Sanded Smooth has no close-up on the listing: crop its product shot). */
function hTexTile(g, t, x, y, w, h, r) {
  if (A.hTex[t]) return cover(g, A.hTex[t], x, y, w, h, { r });
  const b = A.hSmooth;
  g.save(); rr(g, x, y, w, h, r); g.clip(); g.fillStyle = '#F2EFE6'; g.fillRect(x, y, w, h);
  g.drawImage(b.im, b.bb.x + b.bb.w * 0.36, b.bb.y + b.bb.h * 0.4, b.bb.w * 0.32, b.bb.w * 0.32, x, y, w, h); g.restore();
}

export const scenes = {
  // ------------------------------------------------------------------------------------------
  hook: {
    draw(g, L, s, st) {
      const { W, H: HH, P, u } = L;
      const e = envelope(st, s.sd, 0.6, 0.45);
      // The photo dissolves to the page over the hook's last 0.4 s (no hard cut into the next scene).
      const pout = 1 - ease.inOut(clamp((st - (s.sd - 0.9)) / 0.9)); // eases in and out: no frame jumps
      g.save(); g.globalAlpha *= pout;
      const z = 1.03 + 0.05 * (st / s.sd);
      const open = ease.inOut(clamp(st / 0.9));
      if (P) {
        const hh = HH / 2;
        cover(g, A.hRoom, 0, -hh * (1 - open), W, hh, { zoom: z, py: -0.2 });
        cover(g, A.tRoomTall, 0, hh + hh * (1 - open), W, hh, { zoom: z, py: -0.3 });
      } else {
        const hw = W / 2;
        cover(g, A.hRoom, -hw * (1 - open), 0, hw, HH, { zoom: z, px: 0.1 });
        cover(g, A.tRoomWide, hw + hw * (1 - open), 0, hw, HH, { zoom: z, px: 0.3, src: A.tRoomWide.bb });
      }
      const gr = g.createLinearGradient(0, 0, 0, HH);
      gr.addColorStop(0, 'rgba(20,24,20,0.15)'); gr.addColorStop(0.45, 'rgba(20,24,20,0.35)'); gr.addColorStop(1, 'rgba(20,24,20,0.86)');
      g.fillStyle = gr; g.fillRect(0, 0, W, HH);
      g.fillStyle = 'rgba(255,255,255,0.9)';
      if (P) g.fillRect(0, HH / 2 - 2 * u, W * open, 4 * u); else g.fillRect(W / 2 - 2 * u, 0, 4 * u, HH * open);
      g.restore();
      const tH = cue(s, 'Heritage', { fallback: 0.9 }), tT = cue(s, 'timber', { after: tH + 0.3, alts: ['timberthane'], fallback: 2.1 });
      const lab = (t, x, y, al) => {
        const p = prog(st, t - 0.1, 0.5, ease.back);
        g.save(); g.globalAlpha *= prog(st, t - 0.1, 0.5, ease.inOut) * e;
        pill(g, t === tH ? 'Heritage Timber' : 'Timberthane', x, y + (1 - p) * 20 * u, { size: 34 * u, fill: 'rgba(255,255,255,0.94)', color: BRAND.greenDeep, align: al });
        g.restore();
      };
      if (P) { lab(tH, L.m, 120 * u, 'left'); lab(tT, L.m, HH / 2 + 50 * u, 'left'); } else { lab(tH, L.m, 90 * u, 'left'); lab(tT, W / 2 + 50 * u, 90 * u, 'left'); }
      const size = P ? 104 * u : 110 * u;
      const y = P ? HH - 470 * u : HH - 230 * u;
      g.save(); g.globalAlpha *= e;
      text(g, 'WHICH BEAM DO YOU NEED?', P ? L.m : W / 2, y - size * 1.05, { f: font('P', 600, L.kickSize * 1.1), color: '#E9D9BF', spacing: L.kickSize * 0.18, align: P ? 'left' : 'center', alpha: prog(st, 0.5, 0.6) });
      reveal(g, s.card, P ? L.m : W / 2, y, clamp((st - 0.3) / 0.9), { f: font('P', 700, size), color: '#fff', size, align: P ? 'left' : 'center', maxW: W - 2 * L.m });
      g.restore();
      wordmark(g, P ? L.m : W / 2, HH - (P ? 120 : 70) * u, 26 * u, { color: '#fff', alpha: e * prog(st, 4.5, 0.6), align: P ? 'left' : 'center' });
    },
  },
  // ------------------------------------------------------------------------------------------
  both: {
    draw(g, L, s, st) {
      const { W, P, u } = L;
      header(g, L, KICK, s.card, st, s.sd);
      const e = envelope(st, s.sd);
      const items = [
        { t: cue(s, 'lightweight', { fallback: 1 }), title: 'Lightweight, high-density polyurethane' },
        { t: cue(s, 'textures', { fallback: 4 }), title: 'Textures molded from real wood' },
        { t: cue(s, 'hollow', { fallback: 7.2 }), title: 'Hollow: hides wiring and ducts', pic: 'hollow' },
        { t: cue(s, 'install', { fallback: 8.4 }), title: 'Same install: over a wood block', pic: 'block' },
      ];
      g.save(); g.globalAlpha *= e;
      const bx = P ? L.m : L.m, by = P ? 400 * u : 260 * u, bw = P ? W - 2 * L.m : 760 * u;
      const bh = P ? 300 * u : 340 * u;
      [[A.hBeam, 'Heritage Timber'], [A.tBeam, 'Timberthane']].forEach(([b, n], i) => {
        const p = prog(st, 0.3 + i * 0.25, 0.6);
        const x = P ? bx + i * (bw / 2 + 10 * u) : bx, y = P ? by : by + i * (bh + 30 * u), w = P ? bw / 2 - 10 * u : bw;
        g.save(); g.globalAlpha *= p;
        productFit(g, b, x, y, w, bh - 50 * u);
        text(g, n, x + w / 2, y + bh - 6 * u, { f: font('P', 600, 30 * u), align: 'center', color: BRAND.muted });
        g.restore();
      });
      const lx = P ? L.m : 960 * u, ly = P ? 820 * u : 300 * u, lw = P ? W - 2 * L.m : W - L.m - lx, rowH = P ? 230 * u : 175 * u;
      items.forEach((it, i) => {
        const p = prog(st, it.t - 0.2, 0.5, ease.out);
        const y = ly + i * rowH;
        g.save(); g.globalAlpha *= p; g.translate((1 - p) * 30 * u, 0);
        card(g, lx, y, lw, rowH - 24 * u, { r: 22 * u });
        check(g, lx + 56 * u, y + (rowH - 24 * u) / 2, 24 * u, { p: prog(st, it.t, 0.5) });
        const tw = it.pic ? lw - 330 * u : lw - 130 * u;
        const lines = label2 && null; void lines;
        const f = font('P', 600, (P ? 34 : 32) * u);
        const wrapped = (() => { g.save(); g.font = f; const out = []; let cur = ''; for (const w of it.title.split(' ')) { const t2 = cur ? cur + ' ' + w : w; if (cur && g.measureText(t2).width > tw) { out.push(cur); cur = w; } else cur = t2; } out.push(cur); g.restore(); return out; })();
        wrapped.forEach((ln, k) => text(g, ln, lx + 104 * u, y + (rowH - 24 * u) / 2 + 12 * u + (k - (wrapped.length - 1) / 2) * 40 * u, { f }));
        if (it.pic === 'hollow') {
          const pw = 210 * u, ph = rowH - 54 * u;
          cover(g, A.hollow, lx + lw - pw - 16 * u, y + 15 * u, pw, ph, { r: 14 * u, src: A.hollow.bb, zoom: 1.4 });
        }
        if (it.pic === 'block') {
          const cx = lx + lw - 120 * u, cy = y + 30 * u, sc = 22 * u;
          g.fillStyle = '#E4DDD0'; g.fillRect(cx - 4 * sc, cy - 10 * u, 8 * sc, 10 * u);
          block(g, cx - 1.9 * sc, cy, 3.8 * sc, 1.6 * sc);
          const rise = 1 - prog(st, it.t + 0.4, 0.9, ease.inOut);
          section(g, 'U', cx - 2.75 * sc, cy + rise * 30 * u, 5.5 * sc, 4 * sc, 0.75 * sc, { tex: A.hGrain, alpha: prog(st, it.t, 0.4) });
        }
        g.restore();
      });
      g.restore();
    },
  },
  // ------------------------------------------------------------------------------------------
  speed: {
    draw(g, L, s, st) {
      const { P, u } = L;
      header(g, L, KICK, s.card, st, s.sd);
      const e = envelope(st, s.sd);
      const tH = cue(s, 'Heritage', { fallback: 1.9 }), tH3 = cue(s, 'three', { after: tH, fallback: 5.4 });
      const tT = cue(s, 'Timber', { after: tH3, alts: ['Timberthane'], fallback: 7.6 }), tT10 = cue(s, '10', { after: tT, alts: ['ten'], fallback: 10.5 });
      const [c0, c1] = cols(L);
      g.save(); g.globalAlpha *= e;
      [[c0, tH, 'Heritage Timber', 'Quick Ship', A.hBeam, 'Stained beams usually ship in', '3–5 business days', [3, 5], tH3],
        [c1, tT, 'Timberthane', 'Made to order', A.tBeam, 'Usually ships in', '10–12 business days', [10, 12], tT10]].forEach(([c, t0, name, tag, beam, l1, l2, rng, tFill]) => {
        const p = colIn(st, t0);
        g.save(); g.globalAlpha *= p; colCard(g, L, c, p);
        colTitle(g, L, c, name, tag, 1);
        productFit(g, beam, c.x + 40 * u, c.y + 110 * u, c.w * (P ? 0.42 : 1) - 80 * u, (P ? 340 : 300) * u);
        const tx = P ? c.x + c.w * 0.47 : c.x + 40 * u, ty = P ? c.y + 210 * u : c.y + 480 * u;
        const pl = prog(st, tFill - 1.2, 0.5);
        text(g, l1, tx, ty, { f: font('F', 500, 32 * u), color: BRAND.muted, alpha: pl });
        text(g, l2, tx, ty + 50 * u, { f: font('P', 700, 44 * u), color: BRAND.green, alpha: pl });
        const cell = P ? 44 * u : 38 * u;
        const cx0 = P ? c.x + 40 * u : tx, cy0 = P ? c.y + 500 * u : ty + 110 * u;
        calendar(g, cx0, cy0, cell, 15, rng[0], rng[1], prog(st, tFill - 0.2, 0.9, ease.inOut), { label: false, gap: (P ? 9 : 8) * u, alpha: pl });
        text(g, 'business days', cx0, cy0 + cell + 40 * u, { f: font('F', 500, 24 * u), color: BRAND.muted, alpha: pl });
        g.restore();
      });
      g.restore();
    },
  },
  // ------------------------------------------------------------------------------------------
  sizes: {
    draw(g, L, s, st) {
      const { P, u } = L;
      header(g, L, KICK, s.card, st, s.sd);
      const e = envelope(st, s.sd);
      const tH = cue(s, 'Heritage', { fallback: 0.5 }), tHft = cue(s, 'feet', { after: tH, fallback: 7.4 });
      const tT = cue(s, 'Timber', { after: tHft, alts: ['Timberthane'], fallback: 8.8 }), tT3 = cue(s, '3', { after: tT, alts: ['three'], fallback: 11.2 }), tT30 = cue(s, '30', { after: tT3, alts: ['thirty'], fallback: 13.1 });
      const [c0, c1] = cols(L);
      const sc = 11.5 * u; // same scale in both columns, so the sizes compare honestly
      g.save(); g.globalAlpha *= e;
      // Heritage: the eight set sizes.
      { const p = colIn(st, tH);
        g.save(); g.globalAlpha *= p; colCard(g, L, c0, p);
        colTitle(g, L, c0, 'Heritage Timber', '8 set sizes', 1);
        const gap = 22 * u, tot = HER.cross_sections_in.reduce((a, [w]) => a + w * sc, 0) + gap * 7;
        let x = c0.x + (c0.w - tot) / 2; const cy = c0.y + (P ? 170 : 190) * u;
        g.fillStyle = '#E4DDD0'; g.fillRect(c0.x + 30 * u, cy - 14 * u, c0.w - 60 * u, 14 * u);
        HER.cross_sections_in.forEach(([w, h], k) => {
          const pk = prog(st, tH + 0.9 + k * 0.18, 0.5);
          if (pk > 0) section(g, 'U', x, cy, w * sc, h * sc * pk, 0.75 * sc, { tex: A.hGrain });
          x += w * sc + gap;
        });
        const ty = P ? c0.y + 480 * u : c0.y + 560 * u;
        text(g, `Up to ${inch(9.5)} × ${inch(11.5)} in`, c0.x + 40 * u, ty, { f: font('P', 700, 40 * u), alpha: prog(st, cue(s, 'up', { after: tH, fallback: 3.2 }), 0.5) });
        text(g, '4 to 24 ft long', c0.x + 40 * u, ty + 60 * u, { f: font('F', 600, 34 * u), color: BRAND.green, alpha: prog(st, tHft - 1.2, 0.5) });
        g.restore(); }
      // Timberthane: built to your size, same scale.
      { const p = colIn(st, tT);
        g.save(); g.globalAlpha *= p; colCard(g, L, c1, p);
        colTitle(g, L, c1, 'Timberthane', 'Your size', 1);
        const pm = ease.inOut(clamp((st - tT3 + 0.3) / 1.8));
        const v = Math.round(lerp(3, 24, pm) * 2) / 2;
        const cx = P ? c1.x + c1.w * 0.3 : c1.x + c1.w / 2, cy = c1.y + (P ? 150 : 190) * u;
        g.fillStyle = '#E4DDD0'; g.fillRect(cx - 14 * sc, cy - 14 * u, 28 * sc, 14 * u);
        g.save(); g.setLineDash([8 * u, 6 * u]); g.strokeStyle = BRAND.line; g.lineWidth = 2 * u; g.strokeRect(cx - 12 * sc, cy, 24 * sc, 24 * sc); g.restore();
        section(g, 'U', cx - v * sc / 2, cy, v * sc, v * sc, 1 * sc, { tex: A.tGrain });
        const tx = P ? c1.x + c1.w * 0.58 : c1.x + 40 * u, ty = P ? c1.y + 300 * u : c1.y + 560 * u;
        text(g, `${inch(v)} × ${inch(v)} in`, tx, ty, { f: font('P', 700, 40 * u), alpha: prog(st, tT3 - 0.3, 0.4) });
        text(g, '3 to 24 in, any size', tx, ty + 60 * u, { f: font('F', 600, 34 * u), color: BRAND.green, alpha: prog(st, tT3, 0.5) });
        text(g, 'Up to 30 ft long', tx, ty + 110 * u, { f: font('F', 600, 34 * u), color: BRAND.green, alpha: prog(st, tT30 - 0.2, 0.5) });
        g.restore(); }
      text(g, 'Both shown to the same scale.', L.W / 2, P ? 1840 * u : 1050 * u, { f: font('F', 500, 26 * u), color: BRAND.muted, align: 'center', alpha: prog(st, tT3 + 1, 0.6) });
      g.restore();
    },
  },
  // ------------------------------------------------------------------------------------------
  shapes: {
    draw(g, L, s, st) {
      const { P, u } = L;
      header(g, L, KICK, s.card, st, s.sd);
      const e = envelope(st, s.sd);
      const tH = cue(s, 'Heritage', { fallback: 0.5 }), tT = cue(s, 'Timberthane', { after: tH + 1, alts: ['Timber'], fallback: 3.4 });
      const tPl = cue(s, 'plank', { after: tT, fallback: 5 }), tL = cue(s, 'L', { after: tPl, fallback: 5.8 }), tB = cue(s, 'box', { after: tL, alts: ['four'], fallback: 7.4 });
      const [c0, c1] = cols(L);
      g.save(); g.globalAlpha *= e;
      { const p = colIn(st, tH);
        g.save(); g.globalAlpha *= p; colCard(g, L, c0, p);
        colTitle(g, L, c0, 'Heritage Timber', '1 shape', 1);
        productFit(g, A.hBeam, c0.x + 40 * u, c0.y + 120 * u, c0.w - 80 * u, c0.h - 260 * u);
        text(g, '3-sided U-beam', c0.x + c0.w / 2, c0.y + c0.h - 60 * u, { f: font('P', 600, 36 * u), align: 'center' });
        g.restore(); }
      { const p = colIn(st, tT);
        g.save(); g.globalAlpha *= p; colCard(g, L, c1, p);
        colTitle(g, L, c1, 'Timberthane', '4 shapes', 1);
        const items = [['u-beam', '3-sided U-beam', tT + 0.3], ['plank', '1-sided plank', tPl - 0.2], ['l-beam', '2-sided L-beam', tL - 0.1], ['box-beam', '4-sided box beam', tB - 0.1]];
        const gw = (c1.w - 100 * u) / 2, gh = (c1.h - 150 * u) / 2;
        items.forEach(([k, n, t], i) => {
          const pk = prog(st, t, 0.45, ease.back);
          const x = c1.x + 34 * u + (i % 2) * (gw + 30 * u), y = c1.y + 110 * u + Math.floor(i / 2) * (gh + 10 * u);
          g.save(); g.globalAlpha *= clamp(pk);
          productFit(g, A.shape[k], x, y, gw, gh - 50 * u, { bb: A.shapeBox, scale: 0.92 });
          text(g, n, x + gw / 2, y + gh - 14 * u, { f: font('F', 600, 28 * u), align: 'center' });
          g.restore();
        });
        g.restore(); }
      g.restore();
    },
  },
  // ------------------------------------------------------------------------------------------
  looks: {
    draw(g, L, s, st) {
      const { P, u } = L;
      header(g, L, KICK, s.card, st, s.sd);
      const e = envelope(st, s.sd);
      const tH = cue(s, 'six', { fallback: 1.2 }), tHf = cue(s, 'six', { after: tH + 0.2, fallback: 2.4 }), tHp = cue(s, 'primed', { after: tHf, fallback: 4.4 });
      const tT = cue(s, 'eight', { fallback: 7 }), tTf = cue(s, '28', { after: tT, alts: ['twenty'], fallback: 8.2 });
      const [c0, c1] = cols(L);
      g.save(); g.globalAlpha *= e;
      { const p = colIn(st, 0.5);
        g.save(); g.globalAlpha *= p; colCard(g, L, c0, p);
        colTitle(g, L, c0, 'Heritage Timber', 'Quick Ship', 1);
        const tx = c0.x + 40 * u; let y = c0.y + (P ? 140 : 160) * u;
        text(g, '6 textures', tx, y, { f: font('P', 700, 38 * u), alpha: prog(st, tH - 0.2, 0.4) });
        const ts = (c0.w - 80 * u - 5 * 16 * u) / 6;
        H_TEX.forEach((t, i) => { const pk = prog(st, tH + i * 0.08, 0.4, ease.back); g.save(); g.globalAlpha *= clamp(pk); hTexTile(g, t, tx + i * (ts + 16 * u), y + 26 * u, ts, ts, 12 * u); g.restore(); });
        y += ts + (P ? 110 : 140) * u;
        text(g, '6 stained finishes + primed', tx, y, { f: font('P', 700, 38 * u), alpha: prog(st, tHf - 0.2, 0.4) });
        const r = Math.min(40 * u, (c0.w - 80 * u - 6 * 14 * u) / 14);
        H_FIN.forEach((f, i) => {
          const pk = prog(st, (f === 'Primed' ? tHp : tHf) + i * 0.07, 0.4, ease.back);
          const x = tx + r + i * (2 * r + 14 * u), yy = y + 30 * u + r;
          g.save(); g.globalAlpha *= clamp(pk);
          g.beginPath(); g.arc(x, yy, r, 0, Math.PI * 2); g.save(); g.clip(); cover(g, A.hFin[f], x - r, yy - r, 2 * r, 2 * r); g.restore();
          g.restore();
        });
        g.restore(); }
      { const p = colIn(st, tT - 0.6);
        g.save(); g.globalAlpha *= p; colCard(g, L, c1, p);
        colTitle(g, L, c1, 'Timberthane', 'Made to order', 1);
        const tx = c1.x + 40 * u; let y = c1.y + (P ? 140 : 160) * u;
        text(g, '8 textures', tx, y, { f: font('P', 700, 38 * u), alpha: prog(st, tT - 0.2, 0.4) });
        const ts = (c1.w - 80 * u - 7 * 12 * u) / 8;
        TT.textures.forEach((t, i) => { const pk = prog(st, tT + i * 0.07, 0.4, ease.back); g.save(); g.globalAlpha *= clamp(pk); cover(g, A.tTex[t], tx + i * (ts + 12 * u), y + 26 * u, ts, ts, { r: 10 * u }); g.restore(); });
        y += ts + (P ? 110 : 140) * u;
        text(g, '28 colors + Factory Prepped', tx, y, { f: font('P', 700, 38 * u), alpha: prog(st, tTf - 0.2, 0.4) });
        const n = 15, gp = 8 * u, sw = (c1.w - 80 * u - (n - 1) * gp) / n;
        TT.finishes.forEach((f, i) => {
          const pk = prog(st, tTf + i * 0.035, 0.35, ease.back);
          const x = tx + (i % n) * (sw + gp), yy = y + 26 * u + Math.floor(i / n) * (sw + gp);
          g.save(); g.globalAlpha *= clamp(pk); cover(g, A.tFin[f], x, yy, sw, sw, { r: 6 * u }); g.restore();
        });
        g.restore(); }
      g.restore();
    },
  },
  // ------------------------------------------------------------------------------------------
  details: {
    draw(g, L, s, st) {
      const { W, P, u } = L;
      header(g, L, KICK, s.card, st, s.sd);
      const e = envelope(st, s.sd);
      const t1 = cue(s, 'molded', { fallback: 1.1 }), t2 = cue(s, 'caps', { after: t1, alts: ['endcaps', 'shipped'], fallback: 5 });
      const t3 = cue(s, 'caps', { after: t2 + 0.5, alts: ['endcaps', 'add'], fallback: 9.4 }), t4 = cue(s, 'made', { after: t3, fallback: 11 });
      const cw = P ? (W - 2 * L.m - 30 * u) / 2 : (W - 2 * L.m - 3 * 30 * u) / 4, ch = P ? 650 * u : 700 * u;
      const box = i => P ? { x: L.m + (i % 2) * (cw + 30 * u), y: 410 * u + Math.floor(i / 2) * (ch + 30 * u) } : { x: L.m + i * (cw + 30 * u), y: 270 * u };
      const items = [
        [t1, 'Heritage', 'One piece,', 'no corner seams'],
        [t2, 'Heritage', 'Endcaps ship', 'separately, unstained'],
        [t3, 'Timberthane', 'Add endcaps', 'when you order'],
        [t4, 'Timberthane', 'Made in', 'the USA'],
      ];
      g.save(); g.globalAlpha *= e;
      items.forEach(([t, line, a, b], i) => {
        const p = prog(st, t - 0.25, 0.55);
        const { x, y } = box(i);
        g.save(); g.globalAlpha *= p; g.translate(0, (1 - p) * 40 * u);
        card(g, x, y, cw, ch, { r: 24 * u });
        pill(g, line, x + 30 * u, y + 30 * u, { size: 24 * u, fill: line === 'Heritage' ? BRAND.greenSoft : '#EEE4D6', color: line === 'Heritage' ? BRAND.greenDeep : '#7A5530' });
        const ir = { x: x + 30 * u, y: y + 100 * u, w: cw - 60 * u, h: ch * 0.48 };
        if (i === 0) cover(g, A.hEnd, ir.x, ir.y, ir.w, ir.h, { r: 16 * u, src: A.hEnd.bb, zoom: 1.15 + 0.05 * clamp((st - t) / 3) });
        if (i === 1) productFit(g, A.endcap, ir.x, ir.y, ir.w, ir.h, { scale: 0.8 });
        if (i === 2) {
          const sx = ir.x, sy = ir.y + ir.h / 2 - 40 * u, sw = ir.w, sh = 80 * u;
          rr(g, sx, sy, sw, sh, sh / 2); g.fillStyle = '#EFEAE0'; g.fill();
          const pos = lerp(0, 2, prog(st, t + 0.3, 0.8, ease.inOut));
          rr(g, sx + 6 * u + pos * (sw - 12 * u) / 3, sy + 6 * u, (sw - 12 * u) / 3, sh - 12 * u, (sh - 12 * u) / 2); g.fillStyle = BRAND.green; g.fill();
          ['None', 'One', 'Two'].forEach((o, k) => text(g, o, sx + (k + 0.5) * sw / 3, sy + sh / 2 + 10 * u, { f: font('F', 700, 26 * u), color: mix(BRAND.muted, '#ffffff', clamp(1 - Math.abs(pos - k) * 1.5)), align: 'center' }));
        }
        if (i === 3) productFit(g, A.tBeam, ir.x, ir.y, ir.w, ir.h);
        text(g, a, x + 30 * u, y + ch - 110 * u, { f: font('P', 700, 32 * u) });
        text(g, b, x + 30 * u, y + ch - 66 * u, { f: font('P', 700, 32 * u), color: BRAND.green });
        g.restore();
      });
      g.restore();
    },
  },
  // ------------------------------------------------------------------------------------------
  choose: {
    draw(g, L, s, st) {
      const { P, u } = L;
      header(g, L, KICK, s.card, st, s.sd);
      const e = envelope(st, s.sd);
      const hb = [[cue(s, 'standard', { fallback: 0.7 }), 'A standard size fits'], [cue(s, 'need', { fallback: 1.7 }), 'You need it soon'], [cue(s, 'lower', { fallback: 4 }), 'Lower price']];
      const tGoH = cue(s, 'Go', { fallback: 2.8 });
      const tb = [[cue(s, 'exact', { fallback: 5.8 }), 'An exact size'], [cue(s, 'another', { fallback: 6.6 }), 'Plank, L-beam or box beam'], [cue(s, 'more', { fallback: 7.6 }), 'More textures and colors']];
      const tGoT = cue(s, 'Go', { after: tGoH + 1, fallback: 8.8 });
      const [c0, c1] = cols(L);
      g.save(); g.globalAlpha *= e;
      [[c0, 'Heritage Timber', hb, tGoH, A.hBeam, 0.5], [c1, 'Timberthane', tb, tGoT, A.tBeam, tb[0][0] - 0.5]].forEach(([c, name, bul, tGo, beam, tIn]) => {
        const p = colIn(st, tIn);
        g.save(); g.globalAlpha *= p; g.translate(0, (1 - p) * 40 * u);
        const on = prog(st, tGo, 0.4);
        card(g, c.x, c.y, c.w, c.h, { r: 28 * u, stroke: on > 0 ? `rgba(42,82,64,${on})` : null, lw: 6 * u, shadow: 0.1 + 0.08 * on });
        text(g, `Go ${name} if…`, c.x + 40 * u, c.y + 74 * u, { f: font('P', 700, 42 * u) });
        bul.forEach(([t, b], i) => {
          const pb = prog(st, t - 0.2, 0.4);
          const y = c.y + (P ? 150 : 160) * u + i * (P ? 76 : 84) * u;
          check(g, c.x + 62 * u, y, 22 * u, { alpha: pb, p: prog(st, t, 0.4) });
          text(g, b, c.x + 104 * u, y + 12 * u, { f: font('F', 600, 34 * u), alpha: pb });
        });
        const ir = P ? { x: c.x + c.w * 0.55, y: c.y + 110 * u, w: c.w * 0.42, h: c.h - 160 * u } : { x: c.x + 40 * u, y: c.y + 430 * u, w: c.w - 80 * u, h: c.h - 470 * u };
        productFit(g, beam, ir.x, ir.y, ir.w, ir.h);
        g.restore();
      });
      g.restore();
    },
  },
  // ------------------------------------------------------------------------------------------
  end: {
    draw(g, L, s, st) {
      const { W, H: HH, P, u } = L;
      const e = envelope(st, s.sd, 0.6, 0.01);
      g.save(); g.globalAlpha *= e;
      const size = P ? 92 * u : 84 * u, ty = P ? 380 * u : 220 * u;
      reveal(g, s.card, W / 2, ty, clamp(st / 0.8), { f: font('P', 700, size), size, align: 'center', maxW: W - 2 * L.m });
      const pin = prog(st, cue(s, 'sample', { fallback: 1.8 }) - 0.6, 0.7);
      const sw = P ? 420 * u : 520 * u, sh = P ? 420 * u : 400 * u, gap = P ? 60 * u : 120 * u;
      const y0 = P ? 720 * u : 330 * u, x0 = W / 2 - sw - gap / 2;
      g.save(); g.globalAlpha *= pin;
      productFit(g, A.hSample, x0, y0, sw, sh);
      text(g, 'Heritage sample', x0 + sw / 2, y0 + sh + 56 * u, { f: font('P', 600, 32 * u), align: 'center' });
      const tx = W / 2 + gap / 2;
      g.save(); g.translate(tx + sw / 2, y0 + sh / 2); g.rotate(-0.04); g.translate(-(tx + sw / 2), -(y0 + sh / 2));
      card(g, tx + sw * 0.1 - 8 * u, y0 + sh * 0.12 - 8 * u, sw * 0.8 + 16 * u, sh * 0.76 + 16 * u, { r: 16 * u, shadow: 0.2 });
      cover(g, A.tSample, tx + sw * 0.1, y0 + sh * 0.12, sw * 0.8, sh * 0.76, { r: 10 * u });
      g.restore();
      text(g, 'Timberthane sample', tx + sw / 2, y0 + sh + 56 * u, { f: font('P', 600, 32 * u), align: 'center' });
      g.restore();
      const wy = P ? HH - 330 * u : HH - 150 * u;
      wordmark(g, W / 2, wy, (P ? 40 : 36) * u, { align: 'center', alpha: prog(st, 0.4, 0.6) });
      text(g, BRAND.url, W / 2, wy + 64 * u, { f: font('F', 600, 36 * u), color: BRAND.ink, align: 'center', alpha: prog(st, 0.7, 0.6) });
      g.restore();
    },
  },
};

export function overlay(g, L, s, st) {
  if (s.id === 'hook' || s.id === 'end') return;
  const { W, u } = L;
  wordmark(g, W - L.m, L.headY - L.headSize * 1.05, 22 * u, { align: 'right', alpha: 0.85 * envelope(st, s.sd, 0.5, 0.3) });
}
void HER; void lerp;
