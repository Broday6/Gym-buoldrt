// Render a code-built training video to MP4, frame by frame.
//
//   node render.mjs ../endurastone                  -> ../endurastone/endurastone-training.mp4 (1920x1080, 30 fps)
//   node render.mjs ../faux-wood-beams --fps 24 --out x.mp4
//   node render.mjs ../VIDEO --stills 5,30,60       -> PNG stills at those seconds (for review)
//   node render.mjs ../VIDEO --audio none           -> silent; by default VIDEO/voiceover.mp3 is muxed in if present
//
// Needs Playwright (Chromium) and ffmpeg on PATH. Each frame is drawn by
// window.__seek(t) in index.html, so the output is exact, not screen-captured.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require(path.join(process.env.NODE_PATH || '/opt/node22/lib/node_modules', 'playwright'))); }

const argv = process.argv.slice(2);
if (!argv[0] || argv[0].startsWith('--')) { console.error('usage: node render.mjs <video-folder> [--out file] [--fps n] [--stills t,t] [--audio file|none]'); process.exit(1); }
const here = path.resolve(argv.shift());
const args = Object.fromEntries(argv.reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const fps = +(args.fps || 30);
const out = path.resolve(args.out || path.join(here, `${path.basename(here)}-training.mp4`));

const exe = process.env.CHROMIUM_PATH;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(path.join(here, 'index.html')).href + '?render');
await page.evaluate(() => document.fonts.ready);
const total = await page.evaluate(() => window.__TOTAL);
const stage = page.locator('#stage');

if (args.stills) {
  const times = String(args.stills).split(',').map(Number);
  for (const t of times) {
    await page.evaluate(x => window.__seek(x), t);
    const f = path.join(args.dir ? path.resolve(args.dir) : here, `still-${String(t).padStart(5, '0')}.png`);
    await stage.screenshot({ path: f });
    console.log('wrote', f);
  }
  await browser.close();
  process.exit(0);
}

const frames = Math.ceil(total * fps);
console.log(`Rendering ${total}s at ${fps} fps = ${frames} frames -> ${out}`);
const audio = args.audio === 'none' ? null : path.resolve(args.audio ? args.audio : path.join(here, 'voiceover.mp3'));
const withAudio = audio && fs.existsSync(audio);
console.log(withAudio ? `Muxing narration: ${audio}` : 'No narration track (silent video)');
const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
  ...(withAudio ? ['-i', audio, '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '160k', '-t', String(total)] : []),
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '20', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
const started = Date.now();
for (let i = 0; i < frames; i++) {
  await page.evaluate(x => window.__seek(x), i / fps);
  const buf = await stage.screenshot({ type: 'jpeg', quality: 92 });
  if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
  if (i % (fps * 10) === 0) console.log(`  ${(i / fps).toFixed(0)}s / ${total}s  (${((Date.now() - started) / 1000).toFixed(0)}s elapsed)`);
}
ff.stdin.end();
await new Promise((res, rej) => ff.on('close', c => c === 0 ? res() : rej(new Error('ffmpeg exit ' + c))));
await browser.close();
console.log('done:', out);
