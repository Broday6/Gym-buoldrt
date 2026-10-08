// Heritage Timber: Finish & Size Explorer. Every product, texture and finish on screen is a real
// Ekena product photo from the listing; ceiling, blocks, calendars and the person are coded.
import {
  BRAND, FACTS, font, clamp, lerp, ease, prog, cue, cues, img, product, cover, productFit, card, text, measure,
  pill, check, header, envelope, section, calendar, person, block, dim, inch, slug, wordmark, rr, reveal, unionBox, arrow, label2, onAmt, litAmt, mix, ring, listWeights, listStack,
} from '../lib/core.mjs';

const H = FACTS.heritage;
const TEX = ['Mena', 'Salvaged Timber', 'Rustic Sawn', 'Resawn Rip', 'Reclaimed Axed Cut', 'Sanded Smooth'];
const FIN = ['Sandstone', 'Kona Brown', 'Vanilla Chai', 'Warm Caramel', 'Natural White Oak', 'Smokey Brown', 'Primed'];
const KICK = 'Heritage Timber';
const A = {};

export async function preload() {
  A.room = await img('heritage/angles/BMSTKB-09.jpg', { maxSide: 2000 });
  A.texBeam = {}; A.texSwatch = {};
  for (const t of TEX) {
    A.texBeam[t] = await product(`heritage/product/${slug(t)}/${t === 'Sanded Smooth' ? 'primed' : 'kona-brown'}.jpg`);
    if (t !== 'Sanded Smooth') A.texSwatch[t] = await img(`heritage/swatch/texture-${slug(t)}.jpg`, { maxSide: 700 });
  }
  A.finBeam = {}; A.finSwatch = {};
  for (const f of FIN) {
    A.finBeam[f] = await product(`heritage/product/salvaged-timber/${slug(f)}.jpg`);
    A.finSwatch[f] = await img(`heritage/swatch/finish-${slug(f)}.jpg`, { maxSide: 600 });
  }
  A.grid = {};
  for (const t of TEX) for (const f of FIN) {
    if (t === 'Sanded Smooth' && f !== 'Primed') continue;
    A.grid[t + '|' + f] = await img(`heritage/product/${slug(t)}/${slug(f)}.jpg`, { maxSide: 420, bbox: true });
  }
  A.finBox = unionBox(FIN.map(f => A.finBeam[f]));
  A.texBox = unionBox(TEX.map(t => A.texBeam[t]));
  A.endcap = await product('heritage/accessories/endcap.jpg');
  A.sample = await product('heritage/accessories/sample-kit.jpg');
  A.grain = A.texSwatch['Salvaged Timber'];
}

/** Sanded Smooth has no texture close-up on the listing: use a crop of its own primed product shot. */
function texTile(g, t, x, y, w, h, o = {}) {
  if (A.texSwatch[t]) cover(g, A.texSwatch[t], x, y, w, h, o);
  else {
    const b = A.texBeam[t];
    g.save(); g.globalAlpha *= o.alpha ?? 1; rr(g, x, y, w, h, o.r || 0); g.clip();
    g.fillStyle = '#F2EFE6'; g.fillRect(x, y, w, h);
    const bb = b.bb; const s = Math.max(w, h) / (bb.w * 0.32);
    g.drawImage(b.im, bb.x + bb.w * 0.36, bb.y + bb.h * 0.4, bb.w * 0.32, bb.w * 0.32, x, y, w, h);
    void s;
    g.restore();
  }
}

/** The active item at time st given cue times (−1 before the first). */
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
      cover(g, A.room, 0, 0, W, HH, { zoom: 1.04 + 0.06 * (st / s.sd), px: P ? 0.1 : -0.2 + 0.15 * (st / s.sd), py: -0.1, alpha: 1 });
      const gr = P ? g.createLinearGradient(0, HH * 0.22, 0, HH) : g.createLinearGradient(0, 0, W * 0.75, 0);
      gr.addColorStop(0, P ? 'rgba(20,24,20,0)' : 'rgba(20,24,20,0.84)');
      gr.addColorStop(P ? 0.5 : 0.62, 'rgba(20,24,20,0.6)');
      gr.addColorStop(1, P ? 'rgba(20,24,20,0.88)' : 'rgba(20,24,20,0.06)');
      g.fillStyle = gr; g.fillRect(0, 0, W, HH);
      g.restore();
      const x = L.m;
      const size = P ? 124 * u : 118 * u;
      g.save(); g.font = font('P', 700, size);
      const nLines = P ? (g.measureText(s.card).width > W - 2 * L.m ? 2 : 1) : 1;
      g.restore();
      const y = P ? HH * 0.64 - (nLines - 1) * size * 1.12 : HH * 0.50;
      const yEnd = y + (nLines - 1) * size * 1.12;
      g.save(); g.globalAlpha *= e;
      text(g, 'FINISH & SIZE EXPLORER', x, y - size * 1.1, { f: font('P', 600, L.kickSize * 1.1), color: '#E9D9BF', spacing: L.kickSize * 0.18, alpha: prog(st, 0.3, 0.6) });
      reveal(g, s.card, x, y, clamp((st - 0.2) / 0.9), { f: font('P', 700, size), color: '#fff', size, maxW: W - 2 * L.m });
      const sub = 'Quick Ship faux wood beams';
      text(g, sub, x, yEnd + size * 0.85, { f: font('F', 500, 40 * u), color: 'rgba(255,255,255,0.92)', alpha: prog(st, 0.9, 0.6) });
      const tags = ['Texture', 'Finish', 'Size'];
      const tTag = cue(s, 'texture', { fallback: 3.5 });
      let tx = x;
      tags.forEach((t, i) => {
        const p = prog(st, tTag + i * 0.55, 0.45, ease.back);
        g.save(); g.globalAlpha *= prog(st, tTag + i * 0.55, 0.45, ease.inOut);
        g.translate(tx, yEnd + size * 1.25 + (1 - p) * 20 * u);
        tx += pill(g, t, 0, 0, { size: 30 * u, fill: 'rgba(255,255,255,0.92)', color: BRAND.greenDeep }) + 16 * u;
        g.restore();
      });
      g.restore();
      wordmark(g, x, P ? HH - 120 * u : HH - 80 * u, 26 * u, { color: '#fff', alpha: e });
    },
  },
  // ------------------------------------------------------------------------------------------
  textures: {
    draw(g, L, s, st) {
      const { W, P, u } = L;
      header(g, L, KICK, s.card, st, s.sd);
      const e = envelope(st, s.sd);
      const ts = cues(s, [['Mena', 'Mina', 'Meena'], 'Salvaged', 'Rustic', ['Resawn', 're', 'resun'], 'Reclaimed', 'Sanded'], { after: 2.5 });
      const act = activeAt(ts, st);
      const big = P ? { x: L.m, y: 420 * u, w: W - 2 * L.m, h: 620 * u } : { x: L.m, y: 270 * u, w: 640 * u, h: 640 * u };
      const pr = P ? { x: L.m, y: 1080 * u, w: W - 2 * L.m, h: 420 * u } : { x: 820 * u, y: 250 * u, w: 990 * u, h: 520 * u };
      const tileS = P ? 136 * u : 142 * u, gap = P ? 20 * u : 26 * u;
      const rowX = P ? (W - (6 * tileS + 5 * gap)) / 2 : 830 * u, rowY = P ? 1560 * u : 800 * u;
      g.save(); g.globalAlpha *= e;
      // Big close-up: crossfade between textures.
      card(g, big.x, big.y, big.w, big.h, { r: 28 * u, shadow: 0.14 });
      const introA = prog(st, 0.6, 0.8);
      const W8 = listWeights(ts, st, introA);           // [intro, Mena, Salvaged, …]
      // Close-up: opaque, so stack from the last fully-in texture. The intro shows Mena dimmed.
      const zoomOf = i => 1.04 + 0.04 * clamp((st - (i >= 0 ? ts[i] : 99)) / 2);
      for (const { i, a } of listStack(ts, st)) {
        const t = TEX[Math.max(0, i)];
        texTile(g, t, big.x, big.y, big.w, big.h, { r: 28 * u, zoom: zoomOf(i), alpha: i < 0 ? 0.55 * a : a });
      }
      const pillOf = (nm, a) => {
        if (a <= 0.001) return;
        const pw = measure(g, nm, font('P', 700, 44 * u)) + 56 * u;
        g.save(); g.globalAlpha *= a;
        rr(g, big.x + 28 * u, big.y + big.h - 108 * u, pw, 80 * u, 40 * u); g.fillStyle = 'rgba(255,255,255,0.94)'; g.fill();
        text(g, nm, big.x + 28 * u + 28 * u, big.y + big.h - 54 * u, { f: font('P', 700, 44 * u), color: BRAND.ink });
        if (nm === 'Sanded Smooth') pill(g, 'Primed only', big.x + 28 * u + pw + 14 * u, big.y + big.h - 98 * u, { size: 28 * u });
        g.restore();
      };
      TEX.forEach((t, i) => pillOf(t, W8[i + 1]));
      const capA = W8[0];
      if (capA > 0.001) {
        const cap = 'Molded from real, weathered timber', cf = font('F', 600, 34 * u), cw = measure(g, cap, cf) + 56 * u;
        g.save(); g.globalAlpha *= capA; rr(g, big.x + 28 * u, big.y + big.h - 108 * u, cw, 80 * u, 40 * u); g.fillStyle = 'rgba(28,33,30,0.82)'; g.fill(); g.restore();
        text(g, cap, big.x + 56 * u, big.y + big.h - 56 * u, { f: cf, color: '#fff', alpha: capA });
      }
      // The real beam in each texture (intro: Salvaged Timber), multiplied, so weighted not stacked.
      const sc = 0.97 + 0.03 * clamp(st / s.sd);
      W8.forEach((w, k) => {
        if (w <= 0.001) return;
        const t = k === 0 ? 'Salvaged Timber' : TEX[k - 1];
        productFit(g, A.texBeam[t], pr.x, pr.y, pr.w, pr.h, { alpha: k === 0 ? 0.9 * w : w, bb: A.texBox, scale: sc });
      });
      // Thumbnails.
      TEX.forEach((t, i) => {
        const p = prog(st, 0.5 + i * 0.12, 0.5, ease.back);
        const on = onAmt(ts, i, st);
        const x = rowX + i * (tileS + gap), y = rowY - 10 * u * on;
        g.save(); g.globalAlpha *= clamp(p);
        card(g, x - 5 * u, y - 5 * u, tileS + 10 * u, tileS + 10 * u, { r: 18 * u, shadow: 0.08 + 0.1 * on });
        ring(g, x - 5 * u, y - 5 * u, tileS + 10 * u, tileS + 10 * u, 18 * u, { color: BRAND.green, lw: 5 * u, alpha: on });
        texTile(g, t, x, y, tileS, tileS, { r: 14 * u, alpha: litAmt(ts, i, st) });
        g.restore();
        label2(g, t, x + tileS / 2, y + tileS + 38 * u, tileS + gap * 0.6, { f: font('F', 600, 21 * u), size: 21 * u, color: mix(BRAND.muted, BRAND.ink, on), alpha: clamp(p) });
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
      const ts = cues(s, ['Sandstone', 'Kona', 'Vanilla', 'Warm', 'Natural', ['Smokey', 'Smoky'], 'primed'], { after: 1.8 });
      const act = activeAt(ts, st);
      const pr = P ? { x: L.m, y: 470 * u, w: W - 2 * L.m, h: 560 * u } : { x: L.m - 20 * u, y: 300 * u, w: 1000 * u, h: 640 * u };
      g.save(); g.globalAlpha *= e;
      const fsc = 0.97 + 0.03 * clamp(st / s.sd);
      // Intro shows Sandstone (the first named), so its weight carries straight through.
      const Wf = listWeights(ts, st, 0.9 * prog(st, 0.5, 0.7));
      Wf[1] += Wf[0];
      FIN.forEach((f, i) => { if (Wf[i + 1] > 0.001) productFit(g, A.finBeam[f], pr.x, pr.y, pr.w, pr.h, { alpha: Wf[i + 1], bb: A.finBox, scale: fsc }); });
      // Swatch disc + name.
      const R = P ? 150 * u : 170 * u;
      const cx = P ? L.m + R : 1360 * u, cy = P ? 1240 * u : 470 * u;
      const discA = prog(st, ts[0] - 0.15, 0.4, ease.inOut);
      if (discA > 0) {
        g.save(); g.globalAlpha *= discA;
        g.shadowColor = 'rgba(40,30,20,0.22)'; g.shadowBlur = 30 * u; g.shadowOffsetY = 10 * u;
        g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
        g.restore();
        g.save(); g.globalAlpha *= discA; g.beginPath(); g.arc(cx, cy, R - 8 * u, 0, Math.PI * 2); g.clip();
        for (const { i, a } of listStack(ts, st)) cover(g, A.finSwatch[FIN[Math.max(0, i)]], cx - R, cy - R, 2 * R, 2 * R, { alpha: a, zoom: 1.05 });
        g.restore();
        const nx = P ? cx + R + 44 * u : cx, ny = P ? cy - 6 * u : cy + R + 86 * u;
        const al = P ? 'left' : 'center';
        FIN.forEach((n, i) => {
          const a = listWeights(ts, st, 0)[i + 1];
          if (a <= 0.001) return;
          g.save(); g.globalAlpha *= a;
          text(g, n, nx, ny, { f: font('P', 700, 60 * u), align: al });
          text(g, n === 'Primed' ? 'Ready to paint or stain' : 'Hand-stained', nx, ny + 52 * u, { f: font('F', 500, 32 * u), color: BRAND.muted, align: al });
          g.restore();
        });
      }
      // Row of all seven.
      const r = P ? 50 * u : 44 * u, gap = P ? 22 * u : 24 * u;
      const rowW = 7 * 2 * r + 6 * gap;
      const rx = P ? (W - rowW) / 2 : 1360 * u - rowW / 2, ry = P ? 1560 * u : 920 * u;
      FIN.forEach((f, i) => {
        const p = prog(st, 0.4 + i * 0.1, 0.5, ease.back);
        const x = rx + r + i * (2 * r + gap);
        const on = onAmt(ts, i, st);
        g.save(); g.globalAlpha *= clamp(p);
        g.beginPath(); g.arc(x, ry, r + lerp(3, 7, on) * u, 0, Math.PI * 2); g.fillStyle = mix('#ffffff', BRAND.green, on); g.fill();
        g.beginPath(); g.arc(x, ry, r, 0, Math.PI * 2); g.save(); g.clip(); cover(g, A.finSwatch[f], x - r, ry - r, 2 * r, 2 * r); g.restore();
        if (P) label2(g, f, x, ry + r + 34 * u, 2 * r + gap * 0.9, { f: font('F', 600, 19 * u), size: 19 * u, color: mix(BRAND.muted, BRAND.ink, on) });
        g.restore();
      });
      g.restore();
    },
  },
  // ------------------------------------------------------------------------------------------
  matrix: {
    draw(g, L, s, st) {
      const { W, P, u } = L;
      header(g, L, KICK, s.card, st, s.sd);
      const e = envelope(st, s.sd);
      const tSS = cue(s, 'Sanded', { fallback: 2.6 });
      const rows = P ? FIN : TEX, cols = P ? TEX : FIN;
      const labW = P ? 190 * u : 250 * u;
      const top = P ? 560 * u : 300 * u, bottom = P ? 1600 * u : 1000 * u;
      const left = L.m + labW, right = W - L.m;
      const cw = (right - left) / cols.length, ch = (bottom - top) / rows.length;
      g.save(); g.globalAlpha *= e;
      cols.forEach((c, j) => {
        const lines = P ? (c === 'Reclaimed Axed Cut' ? ['Reclaimed', 'Axed Cut'] : c.split(' ').length > 1 ? c.split(' ') : [c]) : (c === 'Natural White Oak' ? ['Natural', 'White Oak'] : [c]);
        lines.forEach((ln, k) => text(g, ln, left + j * cw + cw / 2, top - (lines.length - k) * 26 * u - 4 * u, { f: font('F', 600, 22 * u), color: BRAND.muted, align: 'center', alpha: prog(st, 0.2 + j * 0.05, 0.4) }));
      });
      rows.forEach((rw, i) => {
        text(g, rw, L.m, top + i * ch + ch / 2 + 9 * u, { f: font('F', 700, (P ? 22 : 25) * u), color: BRAND.ink, alpha: prog(st, 0.2 + i * 0.06, 0.4) });
        cols.forEach((c, j) => {
          const t = P ? c : rw, f = P ? rw : c;
          const rec = A.grid[t + '|' + f];
          const d = 0.35 + (i + j) * 0.09;
          const p = prog(st, d, 0.45, ease.back);
          const x = left + j * cw + 6 * u, y = top + i * ch + 6 * u, w = cw - 12 * u, h = ch - 12 * u;
          g.save(); g.globalAlpha *= clamp(p);
          const sc = 0.7 + 0.3 * clamp(p);
          g.translate(x + w / 2, y + h / 2); g.scale(sc, sc); g.translate(-(x + w / 2), -(y + h / 2));
          if (rec) {
            const hi = t === 'Sanded Smooth' ? prog(st, tSS - 0.15, 0.35, ease.inOut) : 0;
            card(g, x, y, w, h, { r: 12 * u, shadow: 0.07 });
            ring(g, x, y, w, h, 12 * u, { color: BRAND.green, lw: 4 * u, alpha: hi });
            productFit(g, rec, x + 8 * u, y + 6 * u, w - 16 * u, h - 12 * u);
          } else {
            rr(g, x, y, w, h, 12 * u); g.fillStyle = 'rgba(0,0,0,0.035)'; g.fill();
            text(g, '–', x + w / 2, y + h / 2 + 12 * u, { f: font('F', 500, 34 * u), color: BRAND.line, align: 'center' });
          }
          g.restore();
        });
      });
      g.restore();
    },
  },
  // ------------------------------------------------------------------------------------------
  sizes: {
    draw(g, L, s, st) {
      const { W, P, u } = L;
      header(g, L, KICK, s.card, st, s.sd);
      const e = envelope(st, s.sd);
      const sizes = H.cross_sections_in;
      const t0 = cue(s, 'eight', { fallback: 0.8 }), t1 = cue(s, 'eleven', { after: 2, fallback: s.sd - 2.2 });
      g.save(); g.globalAlpha *= e;
      const rowsDef = P ? [sizes.slice(0, 4), sizes.slice(4)] : [sizes];
      const sc = P ? 23 * u : 28.5 * u, gap = P ? 40 * u : 30 * u;
      const ceilY = P ? [600 * u, 1120 * u] : [380 * u];
      let k = 0;
      rowsDef.forEach((row, ri) => {
        const totW = row.reduce((a, [w]) => a + w * sc, 0) + gap * (row.length - 1);
        let x = (W - totW) / 2;
        const cy = ceilY[ri];
        // Ceiling (coded): a drywall band.
        const cp = prog(st, 0.2, 0.6);
        g.save(); g.globalAlpha *= cp;
        g.fillStyle = '#E4DDD0'; g.fillRect(L.m - 20 * u, cy - 34 * u, (W - 2 * L.m + 40 * u) * cp, 34 * u);
        g.fillStyle = '#CFC6B6'; g.fillRect(L.m - 20 * u, cy - 4 * u, (W - 2 * L.m + 40 * u) * cp, 4 * u);
        g.restore();
        row.forEach(([w, h]) => {
          const tk = lerp(t0, t1, k / 7);
          const p = prog(st, tk - 0.15, 0.55, ease.out);
          const pw = w * sc, ph = h * sc * p;
          if (p > 0) section(g, 'U', x, cy, pw, ph, 0.75 * sc, { fill: BRAND.greenSoft, stroke: BRAND.greenDeep });
          const lab = `${inch(w)} × ${inch(h)}`;
          text(g, lab, x + pw / 2, cy + h * sc + 46 * u, { f: font('P', 600, (P ? 26 : 28) * u), align: 'center', alpha: clamp(p * 1.4 - 0.4) });
          x += pw + gap; k++;
        });
      });
      const ny = P ? 1580 * u : 900 * u;
      text(g, 'Width × height, in inches. Shown to scale.', W / 2, ny, { f: font('F', 500, 30 * u), color: BRAND.muted, align: 'center', alpha: prog(st, t1, 0.6) });
      g.restore();
    },
  },
  // ------------------------------------------------------------------------------------------
  fit: {
    draw(g, L, s, st) {
      const { W, P, u } = L;
      header(g, L, KICK, s.card, st, s.sd);
      const e = envelope(st, s.sd);
      const tSlide = cue(s, 'slides', { fallback: 2.5 }), tCut = cue(s, 'Cut', { after: tSlide, fallback: 5 });
      const tIn = cue(s, 'inside', { fallback: 1 });
      const sc = P ? 92 * u : 78 * u;
      const bw = 5.5 * sc, bh = 5.5 * sc, t = 0.75 * sc;
      const cx = P ? W / 2 : 560 * u;
      const cy = P ? 700 * u : 400 * u;       // ceiling line
      const x = cx - bw / 2;
      g.save(); g.globalAlpha *= e;
      // Ceiling + block (coded).
      g.fillStyle = '#E4DDD0'; g.fillRect(cx - bw * 1.1, cy - 40 * u, bw * 2.2, 40 * u);
      g.fillStyle = '#CFC6B6'; g.fillRect(cx - bw * 1.1, cy - 4 * u, bw * 2.2, 4 * u);
      const blkW = (4 - 0.125) * sc, blkH = 2.5 * sc;
      block(g, cx - blkW / 2, cy, blkW, blkH);
      // Beam rises over the block.
      const rise = 1 - prog(st, tSlide - 0.3, 1.1, ease.inOut);
      section(g, 'U', x, cy + rise * (P ? 150 : 260) * u, bw, bh, t, { fill: BRAND.greenSoft, stroke: BRAND.greenDeep, alpha: 0.35 + 0.65 * prog(st, 0.2, 0.5) });
      // Dimensions.
      const settled = tSlide - 0.3 + 1.1; // the beam has finished rising
      const dIn = prog(st, Math.max(tIn, settled), 0.5);
      dim(g, x + t, cy + bh + 70 * u, x + bw - t, cy + bh + 70 * u, '4 in inside', { alpha: dIn, size: 28 * u });
      dim(g, x + bw + 60 * u, cy, x + bw + 60 * u, cy + bh - t, '4¾ in', { alpha: dIn, size: 28 * u, off: 0 });
      dim(g, x - 60 * u, cy, x - 60 * u, cy + bh, '5½ in', { alpha: dIn * 0.85, size: 26 * u, color: BRAND.muted });
      const pc = prog(st, tCut - 0.1, 0.5);
      if (pc > 0) {
        dim(g, cx - blkW / 2, cy + blkH * 0.5, cx + blkW / 2, cy + blkH * 0.5, 'block 3 7/8 in', { alpha: pc, size: 24 * u, color: BRAND.accent });
      }
      // Table: outside width → inside width (from the listings).
      const tx = P ? L.m : 1120 * u, ty = P ? 1420 * u : 330 * u, tw = P ? W - 2 * L.m : 690 * u;
      const pT = prog(st, tIn + 0.4, 0.6);
      g.save(); g.globalAlpha *= pT;
      card(g, tx, ty, tw, P ? 380 * u : 470 * u, { r: 24 * u });
      text(g, 'Beam width', tx + 36 * u, ty + 64 * u, { f: font('P', 600, 30 * u) });
      text(g, 'inside width', tx + tw - 36 * u, ty + 64 * u, { f: font('P', 600, 30 * u), align: 'right' });
      [[3.5, 2], [5.5, 4], [7.5, 6], [9.5, 8]].forEach(([o, i], k) => {
        const yy = ty + (P ? 128 : 140) * u + k * (P ? 64 : 76) * u;
        const hl = o === 5.5;
        if (hl) { rr(g, tx + 20 * u, yy - 44 * u, tw - 40 * u, 62 * u, 14 * u); g.fillStyle = BRAND.greenSoft; g.fill(); }
        text(g, `${inch(o)} in`, tx + 44 * u, yy, { f: font('F', 600, 32 * u) });
        arrow(g, tx + tw * 0.38, yy - 11 * u, tx + tw * 0.56, { lw: 3 * u, head: 11 * u });
        text(g, `${inch(i)} in`, tx + tw - 44 * u, yy, { f: font('F', 700, 32 * u), color: BRAND.greenText, align: 'right' });
      });
      g.restore();
      const nx = P ? W / 2 : tx, ny = P ? 1860 * u : 900 * u;
      text(g, 'Cut blocks 1/8 in narrower than the inside width.', nx, ny, { f: font('F', 600, (P ? 30 : 32) * u), color: BRAND.ink, align: P ? 'center' : 'left', alpha: pc });
      g.restore();
    },
  },
  // ------------------------------------------------------------------------------------------
  lengths: {
    draw(g, L, s, st) {
      const { W, P, u } = L;
      header(g, L, KICK, s.card, st, s.sd);
      const e = envelope(st, s.sd);
      const lens = H.lengths_ft;
      const t0 = cue(s, 'four', { fallback: 1 }), t1 = cue(s, 'twenty', { after: t0, fallback: 2.5 });
      const grow = i => prog(st, lerp(t0, t1 + 0.5, i / (lens.length - 1)) - 0.2, 0.7, ease.out);
      g.save(); g.globalAlpha *= e;
      if (P) {
        // Posts standing on a floor, next to a 6 ft person.
        const floorY = 1700 * u, top = 560 * u, pxft = (floorY - top) / 24;
        const x0 = L.m + 170 * u, bw = 64 * u, gap = (W - L.m - x0 - lens.length * bw) / (lens.length - 1);
        g.fillStyle = '#CFC6B6'; g.fillRect(L.m - 20 * u, floorY, W - 2 * L.m + 40 * u, 4 * u);
        person(g, L.m + 70 * u, floorY, 6 * pxft, { alpha: prog(st, 0.3, 0.5) });
        text(g, '6 ft', L.m + 70 * u, floorY + 44 * u, { f: font('F', 600, 26 * u), color: BRAND.muted, align: 'center', alpha: prog(st, 0.3, 0.5) });
        lens.forEach((ft, i) => {
          const p = grow(i), x = x0 + i * (bw + gap), h = ft * pxft * p;
          if (h > 1) { rr(g, x, floorY - h, bw, h, 6 * u); g.fillStyle = BRAND.greenSoft; g.fill(); g.lineWidth = 2.5 * u; g.strokeStyle = BRAND.greenDeep; g.stroke(); }
          text(g, `${ft}`, x + bw / 2, floorY - h - 18 * u, { f: font('P', 600, 30 * u), align: 'center', alpha: clamp(p * 2 - 1) });
        });
        text(g, 'feet', W - L.m, floorY + 44 * u, { f: font('F', 600, 26 * u), color: BRAND.muted, align: 'right', alpha: prog(st, t1, 0.5) });
      } else {
        const x0 = L.m + 200 * u;
        const pxft = (W - L.m - x0 - 120 * u) / 24;
        const y0 = 290 * u, bh = 46 * u, gap = 22 * u;
        const floorY = y0 + lens.length * (bh + gap);
        person(g, x0 - 110 * u, floorY - gap, 6 * pxft, { alpha: prog(st, 0.3, 0.5) });
        text(g, '6 ft', x0 - 110 * u, floorY + 30 * u, { f: font('F', 600, 24 * u), color: BRAND.muted, align: 'center', alpha: prog(st, 0.3, 0.5) });
        lens.forEach((ft, i) => {
          const p = grow(i), y = y0 + i * (bh + gap), w = ft * pxft * p;
          if (w > 1) { rr(g, x0, y, w, bh, 6 * u); g.fillStyle = BRAND.greenSoft; g.fill(); g.lineWidth = 2.5 * u; g.strokeStyle = BRAND.greenDeep; g.stroke(); }
          text(g, `${ft} ft`, x0 + w + 18 * u, y + bh * 0.72, { f: font('P', 600, 28 * u), alpha: clamp(p * 2 - 1) });
        });
      }
      g.restore();
    },
  },
  // ------------------------------------------------------------------------------------------
  ship: {
    draw(g, L, s, st) {
      const { W, P, u } = L;
      header(g, L, KICK, s.card, st, s.sd);
      const e = envelope(st, s.sd);
      const tS = cue(s, 'Stained', { fallback: 0.6 }), tP = cue(s, 'Primed', { after: tS + 0.5, fallback: 4.5 }), tE = cue(s, 'End', { after: tP, alts: ['endcaps'], fallback: 7.5 });
      const cols = [
        { t: tS, title: 'Stained', line1: 'Usually ships in', line2: '3–5 business days', beam: A.finBeam['Kona Brown'], cal: [3, 5] },
        { t: tP, title: 'Primed', line1: 'Usually ships in', line2: '24–72 hours', beam: A.finBeam.Primed, hours: true },
        { t: tE, title: 'Endcaps', line1: 'Sold separately,', line2: 'unstained', beam: A.endcap },
      ];
      g.save(); g.globalAlpha *= e;
      cols.forEach((c, i) => {
        const p = prog(st, c.t - 0.2, 0.6, ease.out);
        const bx = P ? L.m : L.m + i * (560 * u + 35 * u), by = P ? 430 * u + i * 450 * u : 290 * u;
        const bw = P ? W - 2 * L.m : 560 * u, bh = P ? 410 * u : 660 * u;
        g.save(); g.globalAlpha *= clamp(p); g.translate(0, (1 - p) * 40 * u);
        card(g, bx, by, bw, bh, { r: 26 * u });
        const ir = P ? { x: bx + 20 * u, y: by + 20 * u, w: bw * 0.42, h: bh - 40 * u } : { x: bx + 30 * u, y: by + 30 * u, w: bw - 60 * u, h: 300 * u };
        productFit(g, c.beam, ir.x, ir.y, ir.w, ir.h, { scale: c.beam === A.endcap ? 0.8 : 1 });
        const tx = P ? bx + bw * 0.47 : bx + 40 * u, ty = P ? by + 90 * u : by + 400 * u;
        text(g, c.title, tx, ty, { f: font('P', 700, 46 * u) });
        text(g, c.line1, tx, ty + 56 * u, { f: font('F', 500, 32 * u), color: BRAND.muted });
        text(g, c.line2, tx, ty + 100 * u, { f: font('F', 700, 36 * u), color: BRAND.greenText });
        if (c.cal) calendar(g, tx, ty + 140 * u, (P ? 34 : 36) * u, 10, c.cal[0], c.cal[1], prog(st, c.t + 0.6, 1.4, ease.inOut), { label: false, gap: 7 * u });
        if (c.hours) {
          const hw = P ? bw * 0.47 : bw - 80 * u, hy = ty + 150 * u;
          rr(g, tx, hy, hw, 24 * u, 12 * u); g.fillStyle = '#EFEAE0'; g.fill();
          const hp = prog(st, c.t + 0.6, 1.2, ease.inOut);
          rr(g, tx + hw * (24 / 96), hy, hw * (48 / 96) * hp, 24 * u, 12 * u); g.fillStyle = BRAND.green; g.fill();
          ['0', '24', '48', '72', '96 h'].forEach((lb, k) => text(g, lb, tx + hw * k / 4, hy + 60 * u, { f: font('F', 500, 22 * u), color: BRAND.muted, align: k === 0 ? 'left' : k === 4 ? 'right' : 'center' }));
        }
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
      const tSample = cue(s, 'sample', { fallback: 1.5 });
      const size = P ? 96 * u : 92 * u;
      const ty = P ? 470 * u : 330 * u;
      reveal(g, s.card, P ? W / 2 : L.m, ty, clamp(st / 0.8), { f: font('P', 700, size), size, align: P ? 'center' : 'left', maxW: P ? W - 2 * L.m : 900 * u });
      text(g, 'Sample: a 3½ × 5½ in U-beam piece, 8 in long', P ? W / 2 : L.m, ty + (P ? 90 : 80) * u, { f: font('F', 500, (P ? 30 : 32) * u), color: BRAND.muted, align: P ? 'center' : 'left', alpha: prog(st, 0.6, 0.6) });
      const ir = P ? { x: L.m, y: 640 * u, w: W - 2 * L.m, h: 640 * u } : { x: 1040 * u, y: 190 * u, w: 760 * u, h: 640 * u };
      productFit(g, A.sample, ir.x, ir.y, ir.w, ir.h, { alpha: prog(st, tSample - 0.6, 0.7), scale: 0.95 + 0.05 * clamp(st / s.sd) });
      const r = 30 * u, gp = 16 * u;
      const rowW = FIN.length * 2 * r + (FIN.length - 1) * gp;
      const rx = P ? (W - rowW) / 2 : L.m, ry = P ? 1380 * u : 560 * u;
      FIN.forEach((f, i) => {
        const p = prog(st, 0.5 + i * 0.07, 0.4, ease.back);
        g.save(); g.globalAlpha *= clamp(p);
        g.beginPath(); g.arc(rx + r + i * (2 * r + gp), ry, r + 3 * u, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
        g.beginPath(); g.arc(rx + r + i * (2 * r + gp), ry, r, 0, Math.PI * 2); g.save(); g.clip(); cover(g, A.finSwatch[f], rx + i * (2 * r + gp), ry - r, 2 * r, 2 * r); g.restore();
        g.restore();
      });
      const wy = P ? HH - 330 * u : HH - 200 * u;
      wordmark(g, P ? W / 2 : L.m, wy, (P ? 40 : 38) * u, { align: P ? 'center' : 'left', alpha: prog(st, 0.4, 0.6) });
      text(g, BRAND.url, P ? W / 2 : L.m, wy + 70 * u, { f: font('F', 600, 38 * u), color: BRAND.ink, align: P ? 'center' : 'left', alpha: prog(st, 0.7, 0.6) });
      g.restore();
    },
  },
};

/** The wordmark sits in the corner of every content scene (not the hook or end card, which carry their own). */
export function overlay(g, L, s, st) {
  if (s.id === 'hook' || s.id === 'end') return;
  const { W, H: HH, P, u } = L;
  void HH; wordmark(g, W - L.m, L.headY - L.headSize * (P ? 1.25 : 1.05), (P ? 22 : 22) * u, { align: 'right', alpha: 0.85 * envelope(st, s.sd, 0.5, 0.3) });
}
