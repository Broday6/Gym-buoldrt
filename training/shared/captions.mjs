// Export a video's timed captions (window.__captions) to JSON for voiceover.py.
//   node captions.mjs ../VIDEO captions.json
import { createRequire } from 'node:module'; import path from 'node:path'; import fs from 'node:fs'; import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url); let chromium; try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(path.join(process.env.NODE_PATH || '/opt/node22/lib/node_modules', 'playwright'))); }
const b = await chromium.launch(); const p = await b.newPage();
await p.goto(pathToFileURL(path.resolve(process.argv[2], 'index.html')).href + '?render');
fs.writeFileSync(process.argv[3], JSON.stringify(await p.evaluate(() => window.__captions), null, 1)); await b.close();
