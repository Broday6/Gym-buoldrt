// Timberthane: Finish & Size Explorer. Every product, texture and finish on screen is a real Ekena
// product photo or swatch from the listings and the custom builder; the ceiling, sliders, endcap
// selector, calendar and person are coded.
import {
  BRAND, FACTS, font, clamp, lerp, ease, prog, cue, cues, img, product, cover, productFit, card, text, measure,
  pill, header, envelope, section, calendar, person, inch, slug, wordmark, rr, reveal, unionBox, label2, check, onAmt, litAmt, mix, ring,
} from '../lib/core.mjs';

const T = FACTS.timberthane;
const KICK = 'Timberthane';
const SHAPES = [['plank', '1-sided plank', 'plank'], ['l-beam', '2-sided L-beam', 'L'], ['u-beam', '3-sided U-beam', 'U'], ['box-beam', '4-sided box beam', 'box']];
const TEX = T.textures; // Hand Hewn, Rough Sawn, Rough Cedar, Sandblasted, Pecky Cypress, Riverwood, Knotty Pine, Rustic Smooth
const BUILDER_FIN = T.finishes; // 29, builder order
const A = {};

export async function preload() {
  A.roomWide = await img('timberthane/rooms/de297206d8edd7757b4d.jpg', { maxSide: 2000, bbox: true });
  A.roomTall = await img('timberthane/rooms/d699e20b616809ca930b.jpg', { maxSide: 2000 });
  A.shape = {};
  for (const [k] of SHAPES) A.shape[k] = await product(`timberthane/shapes/hand-hewn-${k}.jpg`);
  A.shapeBox = unionBox(Object.values(A.shape));
  A.texBeam = {}; A.texSw = {};
  for (const t of TEX) {
    A.texBeam[t] = await product(`timberthane/product/${slug(t)}/${t === 'Rustic Smooth' ? 'factory-prepped' : 'aged'}.jpg`);
    A.texSw[t] = await img(`timberthane/builder/texture-${slug(t)}.jpg`, { maxSide: 500 });
  }
  A.texBox = unionBox(TEX.map(t => A.texBeam[t]));
  A.finBeam = {};
  A.stockFin = [];
  for (const f of BUILDER_FIN) {
    try { A.finBeam[f] = await product(`timberthane/product/hand-hewn/${slug(f)}.jpg`); A.stockFin.push(f); } catch { /* builder-only finish: swatch only */ }
  }
  A.finBox = unionBox(Object.values(A.finBeam));
  A.finSw = {};
  for (const f of BUILDER_FIN) A.finSw[f] = await img(`timberthane/builder/finish-${slug(f)}.jpg`, { maxSide: 300 });
  A.grain = await img('timberthane/angles/BMHHS3C0ZD-0.jpg', { maxSide: 900 });
  A.sample = await img('timberthane/accessories/material-sample.jpg', { maxSide: 900 });
}
const activeAt = (ts, st) => ts.reduce((a, t, i) => (st >= t - 0.12 ? i : a), -1);

export const scenes = {
  // ------------------------------------------------------------------------------------------
  hook: {
    draw(g, L, s, st) {
      const { W, H: HH, P, u } = L;
      const e = envelope(st, s.sd, 0.8, 0.45);
      // The photo dissolves to the page over the hook's last 0.4 s (no hard cut into the next scene).
      const pout = 1 - ease.inOut(clamp((st - (s.sd - 0.9)) / 0.9)); // eases in and out: no frame jumps
      g.save(); g.globalAlpha *= pout;
      if (P) cover(g, A.roomTall, 0, 0, W, HH, { zoom: 1.03 + 0.06 * (st / s.sd), py: -0.2 });
      else cover(g, A.roomWide, 0, 0, W, HH, { zoom: 1.02 + 0.06 * (st / s.sd), px: -0.3 + 0.3 * (st / s.sd), src: A.roomWide.bb });
      const gr = P ? g.createLinearGradient(0, HH * 0.22, 0, HH) : g.createLinearGradient(0, 0, W * 0.8, 0);
      gr.addColorStop(0, P ? 'rgba(20,24,20,0)' : 'rgba(20,24,20,0.86)');
      gr.addColorStop(P ? 0.5 : 0.6, 'rgba(20,24,20,0.62)');
      gr.addColorStop(1, P ? 'rgba(20,24,20,0.9)' : 'rgba(20,24,20,0.06)');
      g.fillStyle = gr; g.fillRect(0, 0, W, HH);
      g.restore();
      const x = L.m, size = P ? 124 * u : 118 * u;
      const y = P ? HH * 0.64 : HH * 0.48;
      g.save(); g.globalAlpha *= e;
      text(g, 'FINISH & SIZE EXPLORER', x, y - size * 1.1, { f: font('P', 600, L.kickSize * 1.1), color: '#E9D9BF', spacing: L.kickSize * 0.18, alpha: prog(st, 0.3, 0.6) });
      reveal(g, s.card, x, y, clamp((st - 0.2) / 0.9), { f: font('P', 700, size), color: '#fff', size, maxW: W - 2 * L.m });
      text(g, 'Made-to-order faux wood beams', x, y + size * 0.85, { f: font('F', 500, 40 * u), color: 'rgba(255,255,255,0.92)', alpha: prog(st, 0.9, 0.6) });
      const tags = [['Shape', 'shape'], ['Texture', 'texture'], ['Finish', 'finish'], ['Size', 'size']];
      let tx = x, after = 2.5;
      tags.forEach(([t, w]) => {
        const tc = cue(s, w, { after, fallback: after + 0.7 }); after = tc + 0.1;
        const p = prog(st, tc - 0.1, 0.45, ease.back);
        g.save(); g.globalAlpha *= prog(st, tc - 0.1, 0.45, ease.inOut);
        g.translate(tx, y + size * 1.25 + (1 - p) * 20 * u);
        tx += pill(g, t, 0, 0, { size: 30 * u, fill: 'rgba(255,255,255,0.92)', color: BRAND.greenDeep }) + 16 * u;
        g.restore();
      });
      g.restore();
      wordmark(g, x, P ? HH - 120 * u : HH - 80 * u, 26 * u, { color: '#fff', alpha: e });
    },
  },
  // ------------------------------------------------------------------------------------------
  shapes: {
    draw(g, L, s, st) {
      const { W, P, u } = L;
      header(g, L, KICK, s.card, st, s.sd);
      const e = envelope(st, s.sd);
      const ts = cues(s, ['one-sided', 'two-sided', 'three-sided', 'four-sided'].map(w => [w, w.split('-')[0]]), { after: 0.8 });
      const act = activeAt(ts, st);
      g.save(); g.globalAlpha *= e;
      SHAPES.forEach(([k, name, sh], i) => {
        const p = prog(st, ts[i] - 0.25, 0.55, ease.out);
        const cw = P ? (W - 2 * L.m - 30 * u) / 2 : (W - 2 * L.m - 3 * 30 * u) / 4;
        const ch = P ? 600 * u : 620 * u;
        const cx = P ? L.m + (i % 2) * (cw + 30 * u) : L.m + i * (cw + 30 * u);
        const cy = P ? 440 * u + Math.floor(i / 2) * (ch + 30 * u) : 290 * u;
        const on = onAmt(ts, i, st);
        g.save(); g.globalAlpha *= clamp(p); g.translate(0, (1 - p) * 40 * u);
        card(g, cx, cy, cw, ch, { r: 24 * u, shadow: 0.09 + 0.07 * on });
        ring(g, cx, cy, cw, ch, 24 * u, { color: BRAND.green, lw: 5 * u, alpha: on });
        productFit(g, A.shape[k], cx + 24 * u, cy + 20 * u, cw - 48 * u, ch * 0.5, { bb: A.shapeBox });
        // Coded section icon, filled with the real grain.
        const sc = 15 * u, sw = 8 * sc, shh = (sh === 'plank' ? 2 : 8) * sc;
        const ix = cx + cw / 2 - sw / 2, iy = cy + ch * 0.55;
        g.fillStyle = '#E4DDD0'; g.fillRect(ix - 20 * u, iy - 10 * u, sw + 40 * u, 10 * u);
        section(g, sh, ix, iy, sw, sh === 'plank' ? 1 * sc : shh, 1 * sc, { tex: A.grain });
        text(g, name, cx + cw / 2, cy + ch - 46 * u, { f: font('P', 600, (P ? 36 : 32) * u), align: 'center' });
        g.restore();
      });
      g.restore();
    },
  },
  // ------------------------------------------------------------------------------------------
  textures: {
    draw(g, L, s, st) {
      const { W, P, u } = L;
      header(g, L, KICK, s.card, st, s.sd);
      const e = envelope(st, s.sd);
      const ts = cues(s, [['Hand', 'hand'], 'Rough Sawn', 'Rough Cedar', 'Sandblasted', ['Pecky', 'Pecke', 'Peci', 'Peckey'], 'Riverwood', ['Knotty', 'Naughty'], 'Rustic'], { after: 0.6 });
      const act = activeAt(ts, st);
      const show = Math.max(0, act), tS = act >= 0 ? ts[act] : 0;
      const fi = act >= 0 ? ease.inOut(clamp((st - (tS - 0.15)) / 0.5)) : 1;
      const pr = P ? { x: L.m, y: 420 * u, w: W - 2 * L.m, h: 520 * u } : { x: L.m - 10 * u, y: 300 * u, w: 860 * u, h: 560 * u };
      g.save(); g.globalAlpha *= e;
      const sc = 0.97 + 0.03 * clamp(st / s.sd);
      // Intro shows Hand Hewn (the first named); each texture crossfades from the one on screen.
      if (act > 0) productFit(g, A.texBeam[TEX[act - 1]], pr.x, pr.y, pr.w, pr.h, { alpha: 1 - fi, bb: A.texBox, scale: sc });
      productFit(g, A.texBeam[TEX[show]], pr.x, pr.y, pr.w, pr.h, { alpha: act <= 0 ? prog(st, 0.3, 0.6) : fi, bb: A.texBox, scale: sc });
      if (act >= 0) text(g, TEX[act] + (TEX[act] === 'Rustic Smooth' ? ' (Factory Prepped)' : ' (Aged)'), P ? W / 2 : pr.x + pr.w / 2, pr.y + pr.h + 40 * u, { f: font('F', 600, 30 * u), color: BRAND.muted, align: 'center', alpha: fi });
      const cols = 4, gap = 22 * u;
      const gx = P ? L.m : 1000 * u, gy = P ? 1060 * u : 280 * u, gw = P ? W - 2 * L.m : W - L.m - gx;
      const tw = (gw - (cols - 1) * gap) / cols, th = tw;
      TEX.forEach((t, i) => {
        const p = prog(st, 0.3 + i * 0.08, 0.45, ease.back);
        const x = gx + (i % cols) * (tw + gap), y = gy + Math.floor(i / cols) * (th + 90 * u);
        const on = onAmt(ts, i, st);
        g.save(); g.globalAlpha *= clamp(p);
        card(g, x - 4 * u, y - 4 * u, tw + 8 * u, th + 8 * u, { r: 16 * u, shadow: 0.07 + 0.11 * on });
        ring(g, x - 4 * u, y - 4 * u, tw + 8 * u, th + 8 * u, 16 * u, { color: BRAND.green, lw: 5 * u, alpha: on });
        cover(g, A.texSw[t], x, y, tw, th, { r: 12 * u, alpha: litAmt(ts, i, st, 0.5) });
        label2(g, t, x + tw / 2, y + th + 38 * u, tw + gap, { f: font('F', 600, 24 * u), size: 24 * u, color: mix(BRAND.muted, BRAND.ink, on) });
        g.restore();
      });
      g.restore();
    },
  },
  // ------------------------------------------------------------------------------------------
  finishes: {
    draw(g, L, s, st) {
      const { W, P, u } = L;
      header(g, L, KICK, s.card, st, s.sd);
      const e = envelope(st, s.sd);
      const tTwenty = cue(s, 'hand', { fallback: 1.6, alts: ['28', 'twenty'] });
      const named = cues(s, [['Sand', 'sand'], 'Driftwood', 'Hickory', 'Cherry', ['Factory', 'factory']], { after: tTwenty });
      const names = ['Sand Dune', 'Driftwood', 'Hickory', 'Cherry', 'Factory Prepped'];
      // Before the first named finish, cycle through stock finish photos; each change crossfades from the one on screen.
      const step = 0.42, cyc = A.stockFin.filter(f => f !== 'Factory Prepped' && !names.includes(f));
      const cycAt = t => (t < tTwenty ? 'Aged' : cyc[Math.floor((t - tTwenty) / step) % cyc.length]);
      let cur, prev, tChange;
      const na = activeAt(named, st);
      if (na >= 0) { cur = names[na]; tChange = named[na]; prev = na > 0 ? names[na - 1] : cycAt(named[0] - 0.2); }
      else {
        cur = cycAt(st);
        const k = Math.max(0, Math.floor((st - tTwenty) / step));
        tChange = st < tTwenty ? -10 : tTwenty + k * step;
        prev = st < tTwenty ? 'Aged' : cycAt(tChange - 0.01);
      }
      const fi = ease.inOut(clamp((st - (tChange - 0.1)) / 0.3));
      const pr = P ? { x: L.m, y: 410 * u, w: W - 2 * L.m, h: 470 * u } : { x: L.m - 10 * u, y: 300 * u, w: 860 * u, h: 520 * u };
      g.save(); g.globalAlpha *= e;
      const sc = 0.97 + 0.03 * clamp(st / s.sd);
      productFit(g, A.finBeam[prev], pr.x, pr.y, pr.w, pr.h, { bb: A.finBox, scale: sc, alpha: 1 - fi });
      productFit(g, A.finBeam[cur], pr.x, pr.y, pr.w, pr.h, { bb: A.finBox, scale: sc, alpha: fi });
      const lx = P ? W / 2 : pr.x + pr.w / 2, ly = pr.y + pr.h + (P ? 50 : 60) * u;
      const nameF = font('P', 700, 46 * u);
      if (prev !== cur) text(g, prev, lx, ly, { f: nameF, align: 'center', color: BRAND.ink, alpha: 1 - fi });
      text(g, cur, lx, ly, { f: nameF, align: 'center', color: BRAND.ink, alpha: prev !== cur ? fi : 1 });
      // All 29 swatches from the builder.
      const cols = P ? 6 : 6, gap = 14 * u;
      const gx = P ? L.m : 990 * u, gy = P ? 1010 * u : 270 * u, gw = P ? W - 2 * L.m : W - L.m - gx;
      const sw = (gw - (cols - 1) * gap) / cols, shh = sw * 0.62, rowH = shh + 36 * u;
      BUILDER_FIN.forEach((f, i) => {
        const p = prog(st, tTwenty - 0.3 + i * 0.045, 0.4, ease.back);
        const x = gx + (i % cols) * (sw + gap), y = gy + Math.floor(i / cols) * rowH;
        const on = f === cur ? fi : f === prev ? 1 - fi : 0;
        g.save(); g.globalAlpha *= clamp(p);
        if (on > 0) { g.save(); g.globalAlpha *= on; rr(g, x - 5 * u, y - 5 * u, sw + 10 * u, shh + 10 * u, 12 * u); g.fillStyle = BRAND.green; g.fill(); g.restore(); }
        cover(g, A.finSw[f], x, y, sw, shh, { r: 9 * u });
        text(g, f, x + sw / 2, y + shh + 25 * u, { f: font('F', 600, (P ? 17 : 16.5) * u), color: mix(BRAND.muted, BRAND.ink, on), align: 'center' });
        g.restore();
      });
      g.restore();
    },
  },
  // ------------------------------------------------------------------------------------------
  size: {
    draw(g, L, s, st) {
      const { W, P, u } = L;
      header(g, L, KICK, s.card, st, s.sd);
      const e = envelope(st, s.sd);
      const tW = cue(s, 'three', { fallback: 2.0 }), tWend = cue(s, 'wide', { after: tW, fallback: 4.0 });
      const tH = cue(s, 'three', { after: tWend, fallback: 4.6 }), tHend = cue(s, 'tall', { after: tH, fallback: 6.4 });
      const step = v => Math.round(v * 2) / 2;
      const pw = ease.inOut(clamp((st - tW + 0.2) / (tWend - tW + 0.4))), ph = ease.inOut(clamp((st - tH + 0.2) / (tHend - tH + 0.4)));
      const wIn = step(lerp(3, 24, pw)), hIn = step(lerp(3, 24, ph));
      const sc = P ? 26 * u : 23 * u;
      const cx = P ? W / 2 : 600 * u, ceil = P ? 470 * u : 300 * u;
      g.save(); g.globalAlpha *= e;
      g.fillStyle = '#E4DDD0'; g.fillRect(cx - 24 * sc / 2 - 60 * u, ceil - 34 * u, 24 * sc + 120 * u, 34 * u);
      g.fillStyle = '#CFC6B6'; g.fillRect(cx - 24 * sc / 2 - 60 * u, ceil - 4 * u, 24 * sc + 120 * u, 4 * u);
      // Faint outline of the largest size, to scale.
      g.save(); g.setLineDash([10 * u, 8 * u]); g.strokeStyle = BRAND.line; g.lineWidth = 2 * u;
      g.strokeRect(cx - 12 * sc, ceil, 24 * sc, 24 * sc); g.restore();
      section(g, 'U', cx - wIn * sc / 2, ceil, wIn * sc, hIn * sc, 1 * sc, { tex: A.grain });
      // Readout + two coded sliders (the builder's choices).
      const rx = P ? L.m : 1150 * u, ry = P ? 1210 * u : 330 * u, rw = P ? W - 2 * L.m : 660 * u;
      text(g, `${inch(wIn)} × ${inch(hIn)} in`, rx, ry + 90 * u, { f: font('P', 700, 104 * u), color: BRAND.ink });
      [['Width', wIn, pw, tW], ['Height', hIn, ph, tH]].forEach(([lab, v, p, t0], k) => {
        const yy = ry + 210 * u + k * 150 * u;
        const a = prog(st, k ? tH - 1.2 : 0.5, 0.5);
        text(g, lab, rx, yy, { f: font('F', 600, 32 * u), color: BRAND.muted, alpha: a });
        text(g, `${inch(v)} in`, rx + rw, yy, { f: font('F', 700, 32 * u), color: BRAND.green, align: 'right', alpha: a });
        const by = yy + 36 * u;
        g.save(); g.globalAlpha *= a;
        rr(g, rx, by, rw, 12 * u, 6 * u); g.fillStyle = '#E7E1D5'; g.fill();
        rr(g, rx, by, rw * p, 12 * u, 6 * u); g.fillStyle = BRAND.green; g.fill();
        g.beginPath(); g.arc(rx + rw * p, by + 6 * u, 18 * u, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill(); g.lineWidth = 4 * u; g.strokeStyle = BRAND.green; g.stroke();
        text(g, '3', rx, by + 52 * u, { f: font('F', 500, 22 * u), color: BRAND.muted });
        text(g, '24', rx + rw, by + 52 * u, { f: font('F', 500, 22 * u), color: BRAND.muted, align: 'right' });
        g.restore();
        void t0;
      });
      text(g, 'In ½ in steps. Shown to scale.', rx, ry + 560 * u, { f: font('F', 500, 28 * u), color: BRAND.muted, alpha: prog(st, 1.0, 0.6) });
      g.restore();
    },
  },
  // ------------------------------------------------------------------------------------------
  length: {
    draw(g, L, s, st) {
      const { W, P, u } = L;
      header(g, L, KICK, s.card, st, s.sd);
      const e = envelope(st, s.sd);
      const t0 = cue(s, 'two', { fallback: 1.0 }), t1 = cue(s, 'thirty', { after: t0, fallback: 2.4 });
      const p = ease.inOut(clamp((st - t0 + 0.1) / (t1 - t0 + 0.6)));
      const inches = Math.round(lerp(24, 360, p));
      const ftxt = inches % 12 ? `${Math.floor(inches / 12)} ft ${inches % 12} in` : `${inches / 12} ft`;
      g.save(); g.globalAlpha *= e;
      if (P) {
        const floorY = 1720 * u, top = 600 * u, pxft = (floorY - top) / 30, bx = W / 2 + 40 * u, bw = 110 * u;
        g.fillStyle = '#CFC6B6'; g.fillRect(L.m - 20 * u, floorY, W - 2 * L.m + 40 * u, 4 * u);
        for (let f = 0; f <= 30; f += 5) { const y = floorY - f * pxft; g.fillStyle = BRAND.line; g.fillRect(bx - 40 * u, y - 1, 24 * u, 2); text(g, String(f), bx - 52 * u, y + 9 * u, { f: font('F', 500, 24 * u), color: BRAND.muted, align: 'right' }); }
        const h = (inches / 12) * pxft;
        g.save(); rr(g, bx, floorY - h, bw, h, 8 * u); g.clip(); cover(g, A.grain, bx, floorY - h, bw, h); g.restore();
        person(g, L.m + 90 * u, floorY, 6 * pxft, { alpha: prog(st, 0.3, 0.5) });
        text(g, '6 ft', L.m + 90 * u, floorY + 44 * u, { f: font('F', 600, 26 * u), color: BRAND.muted, align: 'center' });
        text(g, ftxt, bx + bw + 30 * u, floorY - h + 40 * u, { f: font('P', 700, 52 * u) });
      } else {
        const x0 = L.m + 170 * u, pxft = (W - L.m - x0 - 30 * u) / 30, by = 600 * u, bh = 90 * u;
        for (let f = 0; f <= 30; f++) {
          const x = x0 + f * pxft, big = f % 5 === 0;
          g.fillStyle = big ? BRAND.muted : BRAND.line; g.fillRect(x - 1, by + bh + 16 * u, 2, (big ? 26 : 14) * u);
          if (big) text(g, `${f}`, x, by + bh + 74 * u, { f: font('F', 500, 26 * u), color: BRAND.muted, align: 'center' });
        }
        text(g, 'feet', x0 + 30 * pxft, by + bh + 112 * u, { f: font('F', 500, 24 * u), color: BRAND.muted, align: 'right' });
        const w = (inches / 12) * pxft;
        g.save(); rr(g, x0, by, w, bh, 8 * u); g.clip(); cover(g, A.grain, x0, by, w, bh); g.restore();
        person(g, L.m + 50 * u, by + bh, 6 * pxft, { alpha: prog(st, 0.3, 0.5) });
        text(g, '6 ft', L.m + 50 * u, by + bh + 74 * u, { f: font('F', 600, 24 * u), color: BRAND.muted, align: 'center' });
        text(g, ftxt, Math.min(x0 + w, W - L.m - 330 * u) + 10 * u, by - 40 * u, { f: font('P', 700, 64 * u) });
      }
      g.restore();
    },
  },
  // ------------------------------------------------------------------------------------------
  made: {
    draw(g, L, s, st) {
      const { W, P, u } = L;
      header(g, L, KICK, s.card, st, s.sd);
      const e = envelope(st, s.sd);
      const tE = cue(s, 'one', { fallback: 0.8 }), tH = cue(s, 'hand', { after: tE, fallback: 3.5 }), tU = cue(s, 'made', { after: tH, alts: ['USA', 'U'], fallback: 5.5 }), tS = cue(s, 'ships', { after: tU, fallback: 7 });
      g.save(); g.globalAlpha *= e;
      const box = i => P ? { x: L.m, y: 420 * u + i * 440 * u, w: W - 2 * L.m, h: 410 * u } : { x: L.m + i * (560 * u + 35 * u), y: 290 * u, w: 560 * u, h: 650 * u };
      // 1. Endcaps selector (coded UI).
      { const b = box(0), p = prog(st, tE - 0.3, 0.6);
        g.save(); g.globalAlpha *= p; g.translate(0, (1 - p) * 40 * u);
        card(g, b.x, b.y, b.w, b.h, { r: 26 * u });
        text(g, 'Endcaps', b.x + 40 * u, b.y + 90 * u, { f: font('P', 700, 46 * u) });
        text(g, 'Choose on the builder', b.x + 40 * u, b.y + 140 * u, { f: font('F', 500, 30 * u), color: BRAND.muted });
        const opts = ['None', 'One', 'Two'], sx = b.x + 40 * u, sy = b.y + (P ? 210 : 230) * u, sw = b.w - 80 * u, sh = 84 * u;
        rr(g, sx, sy, sw, sh, sh / 2); g.fillStyle = '#EFEAE0'; g.fill();
        const tOne = tE, tTwo = cue(s, 'two', { after: tE, fallback: tE + 0.5 });
        const sel = st >= tTwo ? 2 : st >= tOne ? 1 : 0;
        const pos = lerp(sel - (st >= tTwo ? 1 - prog(st, tTwo, 0.3) : st >= tOne ? 1 - prog(st, tOne, 0.3) : 0), sel, 1);
        rr(g, sx + 6 * u + pos * (sw - 12 * u) / 3, sy + 6 * u, (sw - 12 * u) / 3, sh - 12 * u, (sh - 12 * u) / 2); g.fillStyle = BRAND.green; g.fill();
        opts.forEach((o, k) => text(g, o, sx + (k + 0.5) * sw / 3, sy + sh / 2 + 11 * u, { f: font('F', 700, 30 * u), color: mix(BRAND.muted, '#ffffff', clamp(1 - Math.abs(pos - k) * 1.5)), align: 'center' }));
        g.restore(); }
      // 2. Hand finished: real finish swatches fanned.
      { const b = box(1), p = prog(st, tH - 0.3, 0.6);
        g.save(); g.globalAlpha *= p; g.translate(0, (1 - p) * 40 * u);
        card(g, b.x, b.y, b.w, b.h, { r: 26 * u });
        text(g, 'Hand finished', b.x + 40 * u, b.y + 90 * u, { f: font('P', 700, 46 * u) });
        text(g, 'Every batch, by hand', b.x + 40 * u, b.y + 140 * u, { f: font('F', 500, 30 * u), color: BRAND.muted });
        ['Aged', 'Harvest Oak', 'Toffee', 'Slate', 'Cherry'].forEach((f, k) => {
          const sw = P ? 150 * u : 150 * u, x = b.x + 40 * u + k * (P ? 175 : 92) * u, y = b.y + (P ? 200 : 230) * u + (P ? 0 : (k % 2) * 30 * u);
          const pk = prog(st, tH + k * 0.12, 0.4, ease.back);
          g.save(); g.globalAlpha *= clamp(pk);
          card(g, x - 4 * u, y - 4 * u, sw + 8 * u, sw + 8 * u, { r: 14 * u, shadow: 0.14 });
          cover(g, A.finSw[f], x, y, sw, sw, { r: 10 * u });
          g.restore();
        });
        g.restore(); }
      // 3. Made in the USA + lead time.
      { const b = box(2), p = prog(st, tU - 0.3, 0.6);
        g.save(); g.globalAlpha *= p; g.translate(0, (1 - p) * 40 * u);
        card(g, b.x, b.y, b.w, b.h, { r: 26 * u });
        text(g, 'Made in the USA', b.x + 40 * u, b.y + 90 * u, { f: font('P', 700, 46 * u) });
        text(g, 'Usually ships in', b.x + 40 * u, b.y + 150 * u, { f: font('F', 500, 30 * u), color: BRAND.muted, alpha: prog(st, tS - 0.2, 0.5) });
        text(g, '10–12 business days', b.x + 40 * u, b.y + 196 * u, { f: font('F', 700, 36 * u), color: BRAND.green, alpha: prog(st, tS - 0.2, 0.5) });
        calendar(g, b.x + 40 * u, b.y + (P ? 240 : 250) * u, (P ? 44 : 30) * u, 15, 10, 12, prog(st, tS + 0.2, 1.6, ease.inOut), { label: false, gap: (P ? 9 : 6) * u, alpha: prog(st, tS - 0.2, 0.5) });
        g.restore(); }
      g.restore();
    },
  },
  // ------------------------------------------------------------------------------------------
  end: {
    draw(g, L, s, st) {
      const { W, H: HH, P, u } = L;
      const e = envelope(st, s.sd, 0.6, 0.01);
      g.save(); g.globalAlpha *= e;
      const size = P ? 96 * u : 92 * u, ty = P ? 470 * u : 330 * u;
      reveal(g, s.card, P ? W / 2 : L.m, ty, clamp(st / 0.8), { f: font('P', 700, size), size, align: P ? 'center' : 'left', maxW: P ? W - 2 * L.m : 900 * u });
      text(g, 'Timberthane material samples are 10 × 7 in', P ? W / 2 : L.m, ty + (P ? 90 : 80) * u, { f: font('F', 500, (P ? 30 : 32) * u), color: BRAND.muted, align: P ? 'center' : 'left', alpha: prog(st, 0.6, 0.6) });
      const ir = P ? { x: W / 2 - 300 * u, y: 640 * u, w: 600 * u, h: 600 * u } : { x: 1150 * u, y: 230 * u, w: 600 * u, h: 600 * u };
      const pin = prog(st, 0.5, 0.8);
      g.save(); g.globalAlpha *= pin;
      g.translate(ir.x + ir.w / 2, ir.y + ir.h / 2); g.rotate(-0.05 + 0.02 * clamp(st / s.sd)); g.translate(-(ir.x + ir.w / 2), -(ir.y + ir.h / 2));
      card(g, ir.x - 10 * u, ir.y - 10 * u, ir.w + 20 * u, ir.h * 0.7 + 20 * u, { r: 18 * u, shadow: 0.2 });
      cover(g, A.sample, ir.x, ir.y, ir.w, ir.h * 0.7, { r: 12 * u });
      g.restore();
      const r = 26 * u, gp = 12 * u, row = ['Aged', 'Hickory', 'Harvest Oak', 'Toffee', 'Driftwood', 'Slate', 'Redwood', 'Sand Dune'];
      const rowW = row.length * 2 * r + (row.length - 1) * gp;
      const rx = P ? (W - rowW) / 2 : L.m, ry = P ? 1170 * u : 560 * u;
      row.forEach((f, i) => {
        const p = prog(st, 0.5 + i * 0.07, 0.4, ease.back);
        g.save(); g.globalAlpha *= clamp(p);
        g.beginPath(); g.arc(rx + r + i * (2 * r + gp), ry, r + 3 * u, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
        g.beginPath(); g.arc(rx + r + i * (2 * r + gp), ry, r, 0, Math.PI * 2); g.save(); g.clip(); cover(g, A.finSw[f], rx + i * (2 * r + gp), ry - r, 2 * r, 2 * r); g.restore();
        g.restore();
      });
      const wy = P ? HH - 330 * u : HH - 200 * u;
      wordmark(g, P ? W / 2 : L.m, wy, (P ? 40 : 38) * u, { align: P ? 'center' : 'left', alpha: prog(st, 0.4, 0.6) });
      text(g, BRAND.url, P ? W / 2 : L.m, wy + 70 * u, { f: font('F', 600, 38 * u), color: BRAND.ink, align: P ? 'center' : 'left', alpha: prog(st, 0.7, 0.6) });
      g.restore();
    },
  },
};

export function overlay(g, L, s, st) {
  if (s.id === 'hook' || s.id === 'end') return;
  const { W, u } = L;
  wordmark(g, W - L.m, L.headY - L.headSize * 1.05, 22 * u, { align: 'right', alpha: 0.85 * envelope(st, s.sd, 0.5, 0.3) });
}
void check; void measure; void calendar; void T;
