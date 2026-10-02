// Drives the Review Studio in Chromium against a demo project that already has eval reports.
//   node studio_e2e.mjs <server-url> <project-dir> <studio.html> <screenshot-dir>
// Run by test_kit.py. Exits non-zero on the first failed expectation.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let playwright;
for (const p of [process.env.PLAYWRIGHT_MODULE, "playwright", "/opt/node22/lib/node_modules/playwright"]) {
  if (!p) continue;
  try { playwright = require(p); break; } catch { /* try the next */ }
}
if (!playwright) { console.log("SKIP: playwright not installed"); process.exit(0); }

const [url, project, studioHtml, shots] = process.argv.slice(2);
const report = JSON.parse(fs.readFileSync(path.join(project, "review", "v1", "eval-report.json"), "utf8"));
const physId = report.findings.find((f) => f.criterion === "physics").id;
const reframeId = report.findings.find((f) => f.criterion === "reframe").id;
const sysId = report.findings.find((f) => f.scope === "systemic").id;
const fb = (v) => JSON.parse(fs.readFileSync(path.join(project, "review", v, "feedback.json"), "utf8"));
let failures = 0;
function expect(cond, msg) {
  if (cond) console.log("  ok  " + msg);
  else { console.log("  FAIL " + msg); failures++; }
}
async function waitSaved(page) {
  await page.waitForFunction(() => /^Saved/.test(document.getElementById("saveState").textContent), null, { timeout: 8000 });
}

const browser = await playwright.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 920 }, permissions: ["clipboard-read", "clipboard-write"] });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error" && !/favicon/.test(m.text())) errors.push(m.text()); });

// ---- v1: evaluator findings, a drawn note, wording and pacing
await page.goto(url + "#v=v1");
await page.waitForFunction(() => document.querySelectorAll(".tl-scene").length === 6);
await page.waitForFunction(() => document.getElementById("va").readyState >= 2);
expect((await page.inputValue("#versionSel")) === "v1", "opens the version named in the URL");
expect(await page.locator(".tl-mark.blocker").count() >= 2, "blocker findings are marked on the timeline");

await page.click('.tabs button[data-tab="eval"]');
const e1 = page.locator(`[data-sel="finding:${physId}"]`);
await e1.click();
await page.waitForTimeout(300);
const frameAfterClick = await page.evaluate(() => S.frame);
expect(frameAfterClick === 570, `clicking a finding jumps to its frame (got ${frameAfterClick})`);
expect(/scenes s02, s03, s05/.test(await page.locator(`[data-sel="finding:${sysId}"]`).textContent()),
  "a systemic finding lists every scene it covers");
await page.screenshot({ path: path.join(shots, "studio-evaluator.png") });
await e1.getByRole("button", { name: "Accept → note" }).click();
const e7 = page.locator(`[data-sel="finding:${reframeId}"]`);
await e7.getByRole("button", { name: "Reject" }).click();
await e7.locator("input").fill("Beam end is meant to run off frame here");
await e7.locator("input").press("Enter");
await waitSaved(page);
let f = fb("v1");
const accepted = f.notes.find((n) => n.from_finding === physId);
expect(accepted && f.findings[physId] && f.findings[physId].decision === "accept" && f.findings[physId].note === accepted.id,
  "accepting a finding turns it into a linked note");
expect(accepted && accepted.region && accepted.priority === "must" && accepted.category === "physics", "the note keeps the finding's box, priority and kind");
expect(f.findings[reframeId] && f.findings[reframeId].decision === "reject" && /meant to run off/.test(f.findings[reframeId].reason),
  "rejecting a finding records the reason");

// Seek to s03 with the keyboard and add a boxed note.
await page.click("#tlPlayhead", { force: true }).catch(() => {});
await page.evaluate(() => seekFrame(0));
await page.keyboard.press("]");
await page.keyboard.press("]");
await page.keyboard.press("Shift+ArrowRight");
await page.keyboard.press("ArrowRight");
await page.waitForTimeout(200);
const fr = await page.evaluate(() => S.frame);
expect(fr === 481, `] ] Shift+→ → lands on frame 481 (got ${fr})`);
await page.keyboard.press("n");
await page.waitForSelector("#composer:not(.hidden)");
await page.getByRole("button", { name: "Text", exact: true }).click();
await page.locator("#composer textarea").fill("Card says 'joists' but the guide calls them 'ceiling joists'");
const box = await page.locator("#ovA").boundingBox();
await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.6, { steps: 5 });
await page.mouse.up();
await page.screenshot({ path: path.join(shots, "studio-note.png") });
await page.locator("#composer textarea").press("Control+Enter");
await waitSaved(page);
f = fb("v1");
const mine = f.notes.find((n) => /ceiling joists/.test(n.text));
expect(mine && mine.frame === 481 && mine.scene === "s03" && mine.action === "drill_1" && mine.category === "text",
  "the new note is pinned to the frame, scene and nearest action");
expect(mine && mine.region && mine.region.w > 0.1 && mine.region.h > 0.1, "the drawn box is saved with the note");

await page.click('.tabs button[data-tab="scene"]');
await page.getByRole("button", { name: "Change wording" }).first().click();
await page.locator("#tabpanel textarea").fill("Step 2 — Screw each mounting block into a joist");
await page.getByRole("button", { name: "Request this wording" }).click();
await page.getByRole("button", { name: "+ 0.5 s" }).click();
await waitSaved(page);
f = fb("v1");
expect(f.text_changes.length === 1 && f.text_changes[0].field === "step_card" && f.text_changes[0].scene === "s03"
  && f.text_changes[0].from.startsWith("Step 2 — Screw the mounting"), "a wording change keeps the original and the new text");
expect(f.pace.length === 1 && f.pace[0].delta_s === 0.5 && f.pace[0].scene === "s03", "a pacing request is saved per scene");

// Findings e2–e6 are still undecided, so the studio asks before sending.
let asked = "";
page.once("dialog", (d) => { asked = d.message(); d.accept(); });
await page.click("#btnSend");
await page.waitForFunction(() => S.fb.submitted === true);
await waitSaved(page);
expect(/not accepted or rejected yet/.test(asked), "sending with undecided findings asks first");
f = fb("v1");
expect(f.submitted === true, "Send to builder marks the feedback submitted");
const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
expect(/Must fix/.test(clip) && /ceiling joists/.test(clip) && new RegExp(reframeId + ": rejected").test(clip),
  "the summary on the clipboard lists notes and decisions");

// ---- v2: what changed, compare, cuts
await page.selectOption("#versionSel", "v2");
await page.waitForFunction(() => S.vid === "v2" && document.getElementById("va").readyState >= 2);
await page.click('.tabs button[data-tab="changes"]');
const cards = await page.locator("#tabpanel .card").allTextContents();
expect(cards.some((t) => /addressed/i.test(t) && /freezes/.test(t)), "a note the builder addressed shows as addressed");
expect(cards.some((t) => /declined/i.test(t) && /Builder:/.test(t)), "a declined note shows the builder's reason");
expect(cards.some((t) => /not mentioned/i.test(t)), "a note the builder skipped is called out");
expect(cards.some((t) => /s03 · step card/.test(t) && /not mentioned/i.test(t)) && cards.some((t) => /s03 · pacing/.test(t)),
  "wording and pacing requests on the previous version are tracked too");

await page.evaluate(() => seekFrame(600));
await page.click('#cmpSeg button[data-mode="ab"]');
await page.waitForFunction(() => document.getElementById("vb").readyState >= 1);
await page.keyboard.press("b");
await page.waitForTimeout(400);
const ab = await page.evaluate(() => ({ visible: !document.getElementById("stageB").classList.contains("hidden"),
  tb: document.getElementById("vb").currentTime }));
expect(ab.visible && Math.abs(ab.tb - 600.5 / 60) < 0.05, `B flips to the previous version at the same moment (vb at ${ab.tb.toFixed(3)} s)`);
await page.keyboard.press("b");
await page.click('#cmpSeg button[data-mode="side"]');
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(shots, "studio-compare.png") });
const side = await page.evaluate(() => ["stageA", "stageB"].every((id) => !document.getElementById(id).classList.contains("hidden")));
expect(side, "side by side shows both versions");
await page.click('#cmpSeg button[data-mode="off"]');
await page.keyboard.press("c");
await page.waitForFunction(() => /9x16/.test(document.getElementById("va").currentSrc));
expect(await page.evaluate(() => S.frame) === 600, "switching cut keeps the frame");

expect(errors.length === 0, "no script errors" + (errors.length ? ": " + errors.join(" | ") : ""));

// ---- without the server: open files by hand
const fpage = await ctx.newPage();
const ferrors = [];
fpage.on("pageerror", (e) => ferrors.push(e.message));
await fpage.goto("file://" + path.resolve(studioHtml));
await fpage.waitForSelector("#openFiles:not(.hidden)");
const v2 = path.join(project, "review", "v2");
const m2 = JSON.parse(fs.readFileSync(path.join(v2, "manifest.json"), "utf8"));
await fpage.setInputFiles("#fileInput", [path.join(v2, "manifest.json"), path.join(v2, "eval-report.json"),
  ...m2.cuts.map((c) => path.join(project, c.file))]);
await fpage.waitForFunction(() => document.querySelectorAll(".tl-scene").length === 6 && document.getElementById("va").readyState >= 2);
await fpage.evaluate(() => seekFrame(300));
await fpage.keyboard.press("n");
await fpage.locator("#composer textarea").fill("Offline note");
await fpage.locator("#composer textarea").press("Control+Enter");
const [dl] = await Promise.all([fpage.waitForEvent("download"), fpage.click("#btnDownload")]);
const saved = JSON.parse(fs.readFileSync(await dl.path(), "utf8"));
expect(saved.notes.length === 1 && saved.notes[0].text === "Offline note" && saved.version === "v2", "file mode: notes download as feedback.json");
expect(ferrors.length === 0, "file mode: no script errors" + (ferrors.length ? ": " + ferrors.join(" | ") : ""));

await browser.close();
console.log(failures ? `${failures} FAILED` : "all studio checks passed");
process.exit(failures ? 1 : 0);
