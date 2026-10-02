---
name: ekena-install-video-review
description: >
  The review loop for Ekena's CODE-BUILT install and explainer videos, the ones rendered locally
  from a 3D scene, timeline.json, Kokoro narration and a synthesized score. Every render worth
  showing becomes a numbered version. An independent evaluator agent grades it. Brody reviews it in the
  Review Studio, a local page that plays both cuts frame by frame, pins notes and boxes to exact
  frames, compares against the previous version, and lets Brody accept or reject the evaluator's
  findings. The notes come back as feedback.json, mapped to scenes, actions and code, for targeted
  re-renders. ALWAYS use it while building or revising an install video with Brody: "show me the new
  render", "let me review it", "open the review", "I left notes", "notes on v7 are in", "send it
  to the evaluator", "what changed since last time", "approve it", or whenever a render is ready
  for Brody to look at. Pairs with ekena-install-video-evaluator.
---

# Ekena install-video review loop

Building these videos together used to mean Brody describing a moment in chat ("around 0:32 the
hammer swings the wrong way") and the builder guessing the frame. This loop replaces that guess
with a shared record:

```
render ─► publish vN ─► evaluator (separate agent) ─► fix blockers ─► Review Studio ─► Brody's notes
   ▲                                                                                    │
   └──────── targeted change + splice re-render ◄── feedback.json (frames, scenes, code) ◄┘
```

Each version is a folder, `review/vN/`, holding three JSON files. You write `manifest.json`, the
evaluator writes `eval-report.json`, and the studio writes `feedback.json`. The formats are in
`references/schemas.md`. Read it before writing your first manifest.

All script paths below are relative to this skill's folder.

## Once per project

1. **Create `review/`** in the project folder.
2. **Create `HOUSE_RULES.md`** at the project root, and move into it every rule Brody has set that
   overrides the guide (¼″ holes and no anchors for Shutter-Loks, no size callouts, no sound
   effects …), one numbered line each. The evaluator reads this file, so it is how a settled
   question stays settled.
3. **Write `publish_review.py` in the project.** It turns the build's own data (`timeline.json`,
   the narration-driven scene map, the claims table) into a manifest. Do it once, so every
   version is produced the same way. `references/publishing.md` has a template and the rules
   that matter (stable scene ids, files that are never overwritten, the changes list).

## Every time a render is ready for Brody

### 1. Publish the version

Run `publish_review.py` for the new version id (`v1`, `v2` …; `v7b` for a quick alternative), then:

```
python scripts/validate_review.py <project>/review/vN/manifest.json
```

Fix every error before going on. A manifest that doesn't validate won't load in the studio.

What makes this work:
- **The files the manifest points at never change.** Point at the versioned copy, or the backup
  the build makes before overwriting. If v7's manifest points at a file v8 overwrites, comparing v8
  with v7 shows the same video twice.
- **Scene ids stay the same across versions**, even when a scene is re-timed, so notes and compare
  mode line up.
- **`changes` accounts for every note from the previous version.** Each one is `addressed`
  (say what changed) or `declined` (say why). The studio shows Brody each previous note with
  its status, and flags any you didn't mention. Accepted evaluator findings go in the same way,
  with `finding` instead of `note`.

### 2. Get it evaluated by a separate agent

Start the evaluator with the Agent tool, as its own agent, and give it only paths:

> Use the ekena-install-video-evaluator skill. Project folder: `<project>`. Version: `vN`.
> Previous version: `vM` (carry unchanged scenes from its report).

Don't pass your own opinion of the render, your contact sheets, or what you think is fine.
Its independence is the point. If you can't start a separate agent here, ask Brody to run it in a
fresh chat with that prompt. Don't evaluate it yourself in this conversation.

When it returns:
- **Blockers:** fix them before Brody sees the version (house-rule breaks, a wrong step, a
  misspelling, a freeze, a tool going the wrong way). Publish vN+1, list the blocker ids it fixes in
  `changes` (as `finding`), and evaluate again. If the same blocker survives two attempts, or fixing
  it needs Brody's call, show the version anyway and say so plainly.
- **Majors and minors** go to Brody. Brody accepts or rejects them in the studio. Don't
  pre-empt Brody by fixing majors silently.

### 3. Open the Review Studio

Start the server in the background. It keeps running across versions and picks new ones up by itself:

```
python scripts/review_server.py <project>
```

It serves `http://127.0.0.1:8765/` (the next free port if that one is taken), and only to this
computer. It needs Edge or Chrome, since the cuts are H.264. Then tell Brody, in two or three lines:
the link; the version; what changed (or "first cut"); the evaluator's verdict and how many
findings need a decision. For example:

> v8 is up at http://127.0.0.1:8765/#v=v8. It fixes all 5 of your v7 notes (Changes tab), and
> the evaluator passed it with 2 findings for you to accept or reject.

How Brody uses it, if Brody asks: pause on a problem and press **N**, pick what kind of problem
it is, type the note, and drag a box on the picture. **Scene** tab: change a card's or line's
wording, or ask for a scene to run longer or shorter. **Evaluator** tab: accept (it becomes a
note) or reject (with a reason). **Changes** tab: check each earlier note, with **A/B** (press
**B** to flip) or **Side by side** against the previous version. Then press **Send to builder**,
or **Approve**.

### 4. Read the feedback

When Brody says the notes are in, or `feedback.json` has `"submitted": true`, read
`review/vN/feedback.json`, along with the manifest so you can resolve scenes, actions and code:

- **`notes`:** each has the exact `frame`, `cut`, `scene`, nearest `action`, a `category`,
  `must`/`nice` priority, and often a `region` box. Open that frame from the delivered file (use
  `ffmpeg -ss` or the evaluator's `extract_frames.py`) and look inside the box before changing
  anything. The scene's `source.files` and `timeline_keys` in the manifest tell you where it
  lives in code.
- **`text_changes`:** Brody's exact wording for a step card or narration line. Use it
  verbatim. A narration change means regenerating that line (phonetic spelling, then the ASR
  key-word check) and re-timing the scene to fit.
- **`pace`:** seconds more (+) or less (−) for a scene. If the total is locked
  (`target_duration_s`), take the time back from other scenes and say which.
- **`findings`:** each accepted finding is already a note (`from_finding`). For each rejected
  finding with a reason, decide whether the reason is a general rule. If it is, add it to
  `HOUSE_RULES.md` and tell Brody in one line ("Added rule 7: beam ends may run off frame in
  lift shots"), so the evaluator stops raising it.
- **`approved: true`** means this version is signed off. Do the final delivery steps and stop
  revising unless Brody asks.

If a note is ambiguous, ask about that note by id ("v7-n4: should the caulk bead be thinner,
or a different colour?") before guessing. Everything clear can go ahead meanwhile.

### 5. Make the targeted change and re-render

Make the smallest code change that does what each note asks. Re-render only the frame ranges
that changed and splice them in, as the build already does. Then run the build's full checks, and
publish the next version with `previous` set and `changes` filled in: one entry per note and
accepted finding, with the frames it touched. Back up before overwriting, as always. Then go back
to step 2.

## Things that go wrong

- **The studio says it can't play the video:** the browser has no H.264 (open it in Edge or
  Chrome), or the manifest path is wrong (the banner says which).
- **Compare shows the same video twice:** the previous version's manifest points at a file
  that was overwritten. See step 1.
- **A note lands in the wrong scene after re-timing:** scene ids changed between versions. Keep
  them stable.
- **The evaluator refuses to carry a scene:** something in it changed. That is intended;
  it re-judges it.
