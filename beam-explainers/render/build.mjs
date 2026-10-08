// Render one video cut, frame by frame, straight into ffmpeg (H.264, 60 fps) with the mixed audio.
//
//   node build.mjs <video> <cut> <out.mp4>               full render (cut: 16x9 | 9x16)
//   node build.mjs <video> <cut> --stills dir [scene@t …]  preview PNGs (t in scene seconds; default: 3 per scene)
//   node build.mjs <video> <cut> <out.mp4> --frames a:b   render only frames a..b-1 (for splice re-renders)
//
// <video> is a module in videos/ (which-one | heritage | timberthane). Timing comes from
// ../out/<video>/timeline.json; audio from ../out/<video>/audio/mix.wav.
import { createCanvas } from '@napi-rs/canvas';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, FPS, layout, loadBrand, paper } from './lib/core.mjs';

const [video, cut, ...rest] = process.argv.slice(2);
if (!video || !cut) { console.error('usage: node build.mjs <video> <16x9|9x16> <out.mp4> | --stills dir'); process.exit(2); }
const [W, H] = cut === '9x16' ? [1080, 1920] : [1920, 1080];
const outDir = path.join(ROOT, 'out', video);
const tl = JSON.parse(fs.readFileSync(path.join(outDir, 'timeline.json'), 'utf8'));
const script = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', `${video}.json`), 'utf8'));
const mod = await import(`./videos/${video}.mjs`);
await loadBrand();

const L = layout(W, H);
const canvas = createCanvas(W, H);
const g = canvas.getContext('2d');
const byId = Object.fromEntries(script.scenes.map(s => [s.id, s]));
const scenes = tl.scenes.map(s => ({ ...s, ...byId[s.id], words: s.words, sd: (s.end_frame - s.start_frame) / FPS }));
for (const s of scenes) if (!mod.scenes[s.id]) throw new Error(`videos/${video}.mjs has no scene ${s.id}`);
await mod.preload?.(L);
for (const s of scenes) await mod.scenes[s.id].preload?.(L, s);

function sceneAt(f) {
  for (const s of scenes) if (f >= s.start_frame && f < s.end_frame) return s;
  return scenes[scenes.length - 1];
}
function drawFrame(f) {
  const s = sceneAt(f);
  const T = f / FPS, st = (f - s.start_frame) / FPS;
  g.save();
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  paper(g, L, T);
  // Slow push-in over the whole scene: the frame is never still.
  const k = 1 + 0.014 * (st / s.sd);
  g.translate(W / 2, H / 2); g.scale(k, k); g.translate(-W / 2, -H / 2);
  mod.scenes[s.id].draw(g, L, s, st, T);
  g.restore();
  mod.overlay?.(g, L, s, st, T, f);
}

const si = rest.indexOf('--stills');
if (si >= 0) {
  const dir = rest[si + 1];
  fs.mkdirSync(dir, { recursive: true });
  let picks = rest.slice(si + 2);
  if (!picks.length) picks = scenes.flatMap(s => [0.25, 0.55, 0.9].map(q => `${s.id}@${(s.sd * q).toFixed(2)}`));
  for (const p of picks) {
    const [id, t] = p.split('@');
    const s = scenes.find(x => x.id === id);
    const f = Math.min(s.end_frame - 1, s.start_frame + Math.round(parseFloat(t) * FPS));
    drawFrame(f);
    const file = path.join(dir, `${cut}-${id}-${t}.png`);
    fs.writeFileSync(file, await canvas.encode('png'));
  }
  console.log(`wrote ${picks.length} stills to ${dir}`);
  process.exit(0);
}

const out = rest[0];
const fi = rest.indexOf('--frames');
const [fa, fb] = fi >= 0 ? rest[fi + 1].split(':').map(Number) : [0, tl.frames];
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
const audio = path.join(outDir, 'audio', 'mix.wav');
const args = ['-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-'];
if (fi < 0) args.push('-i', audio, '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '192k');
args.push('-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-tune', 'film', '-pix_fmt', 'yuv420p',
  '-profile:v', 'high', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
  '-movflags', '+faststart', '-frames:v', String(fb - fa), out);
const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'inherit', 'inherit'] });
const t0 = Date.now();
for (let f = fa; f < fb; f++) {
  drawFrame(f);
  const buf = canvas.data();
  if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
  if (f % 600 === 0) process.stderr.write(`  ${video} ${cut} f${f}/${fb} ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
}
ff.stdin.end();
const code = await new Promise(r => ff.on('close', r));
console.log(`${out}: ${fb - fa} frames in ${((Date.now() - t0) / 1000).toFixed(0)}s, ffmpeg exit ${code}`);
process.exit(code);
