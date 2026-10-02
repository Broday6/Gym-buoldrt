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
evaluator writes `eval-report.json`, and the studio writes `feedback.json`. Read
`references/schemas.md` before writing your first manifest. `scripts/…` below means the `scripts`
folder next to this SKILL.md; use its full path.

Folders under `review/vN/`: `eval/` belongs to the evaluator (its evidence; never write there),
and `builder/` is yours.

## Once per project

Do this before the first version, and check it is still in place whenever you pick a project back up:

1. **`review/`** exists in the project folder.
2. **`HOUSE_RULES.md`** at the project root holds every rule Brody has set that overrides the guide
   (¼″ holes and no anchors for Shutter-Loks, no size callouts, no sound effects …). One numbered
   line each, with where it came from: `7. Beam ends may run off frame in lift shots. (v7-e7, 2 Oct 2026)`.
   The evaluator reads this file, so it is how a settled question stays settled.
3. **`publish_review.py`** in the project turns the build's own data (`timeline.json`, the
   narration-driven scene map, the claims table) into a manifest, so every version is published
   the same way. `references/publishing.md` has a template and the rules that matter.
4. **The official install PDF** is in the project and named in the manifest. Without it, the
   evaluator raises a blocker on every version.

## Every time a render is ready for Brody

### 1. Publish the version

Run `publish_review.py` for the new version id (`v1`, `v2` …; `v7b` for a quick alternative), then:

```
python scripts/validate_review.py <project>/review/vN/manifest.json
```

Fix every error before going on. A manifest that doesn't validate won't load in the studio.

What makes this work:
- **The files the manifest points at never change.** Point at the versioned copy, or the backup
  the build makes before overwriting.
- **Scene ids stay the same across versions**, even when a scene is re-timed, so notes and compare
  mode line up.
- **`previous` is the version whose notes this one answers.** Usually that's the last one Brody
  reviewed, which isn't always the newest. If v8 only fixed blockers and Brody then left notes on
  v7, v9 names `v7`.
- **`changes` accounts for everything Brody asked for on `previous`:** one entry per note
  (`kind: note`), per wording request (`kind: text`, with `scene` and `field`) and per pacing
  request (`kind: pace`, with `scene`). Each is `addressed` (say what changed) or `declined` (say
  why). An accepted evaluator finding is already a note, so give it one entry carrying both its
  `note` and its `finding` id. The studio shows Brody each request with its status, and flags
  anything you didn't mention.

### 2. Get it evaluated by a separate agent

Start the evaluator with the Agent tool, as its own agent, and give it only paths:

> Use the ekena-install-video-evaluator skill. Project folder: `<project>`. Version: `vN`.
> Previous version: `vM` (carry unchanged scenes from its report).

Don't pass your own opinion of the render, your contact sheets, or what you think is fine.
Its independence is the point. If you can't start a separate agent here, ask Brody to run it in a
fresh chat with that prompt. Don't evaluate it yourself in this conversation.

When it returns:
- **Blockers:** fix them before Brody sees the version, then publish and evaluate again (the new
  version's `previous` stays the one Brody last reviewed). If the same blocker survives two
  attempts, or fixing it needs Brody's call, show the version anyway and say so plainly. Brody can
  then accept or reject that blocker in the studio like any other finding.
- **Majors and minors** go to Brody. Don't pre-empt Brody by fixing majors silently.

### 3. Open the Review Studio

Start the server in the background. It keeps running across versions and picks new ones up by itself:

```
python scripts/review_server.py <project>
```

It serves `http://127.0.0.1:8765/` (the next free port if that one is taken), and only to this
computer. It needs Edge or Chrome, since the cuts are H.264. Then tell Brody, in two or three
lines: the link; the version; what changed (or "first cut"); the evaluator's verdict and how
many findings need a decision.

> v8 is up at http://127.0.0.1:8765/#v=v8. It answers all 5 of your v7 notes (Changes tab), and
> the evaluator passed it with 2 findings for you to accept or reject.

How Brody uses it, if Brody asks: pause on a problem and press **N**, pick what kind of problem
it is, type the note, and drag a box on the picture. **Scene** tab: change a card's or line's
wording, or ask for a scene to run longer or shorter. **Evaluator** tab: accept (it becomes a
note) or reject (with a reason). **Changes** tab: check each earlier request, with **A/B** (press
**B** to flip) or **Side by side** against the previous version. Then press **Send to builder**,
or **Approve**.

### 4. Read the feedback

When Brody says the notes are in, or `feedback.json` has `"submitted": true`, read
`review/vN/feedback.json` along with that version's manifest. Then look before you change anything:

```
python scripts/note_frames.py <project> vN
```

For every note, this pulls the exact frame from the delivered cut with Brody's box drawn on it,
plus a five-frame strip around it, into `review/vN/builder/`. It also prints the note beside the
scene's code pointers. Open each image. `--frame 734 --cut 16x9 [--box x,y,w,h]` grabs any single frame.

What each part of the feedback asks for:
- **`notes`:** the exact `frame`, `cut`, `scene`, nearest `action`, a `category`, `must`/`nice`
  priority, and often a `region` box. The scene's `source` in the manifest says where it lives in code.
- **`text_changes`:** Brody's exact wording for a step card or narration line. Use it
  verbatim. A narration change means regenerating that line (phonetic spelling, then the ASR
  key-word check) and re-timing the scene to fit.
- **`pace`:** seconds more (+) or less (−) for a scene. See step 5 for where the time comes from.
- **`findings`:** each accepted finding is already a note (`from_finding`); fix it like one.
  For a rejected finding with a reason, and for a note that states something general ("the guide
  calls them ceiling joists"), decide whether it's a rule. If it is, add it to `HOUSE_RULES.md` in
  the format above, generalised only as far as the reason supports, and tell Brody in one line.
  If you can't tell whether Brody meant it generally, ask.
- **Findings Brody left undecided:** fix any blocker. Leave majors and minors as they are and list
  them in your reply as still open. The evaluator raises them again while they're still true.
- **`approved: true`** means this version is signed off. Do the final delivery steps and stop
  revising unless Brody asks.

**When to ask first.** Act on everything clear right away, and ask by id only about:
- a note you can't act on without guessing ("v7-n4: thinner caulk bead, or a different colour?"),
- two of Brody's inputs that disagree (a wording request and a note about the same card),
- a note phrased as a question ("should the card say 'from below'?"). Answer it from the guide
  and claims. If the answer is "no change", decline it in `changes` with that answer as the reason.
  If the guide doesn't settle it, ask.

Reply in chat in a few lines: what you'll change, what you'll decline and why, any rule you're
adding, and your questions. For example:

> Got your 6 notes on v7. Fixing n1–n3 and n5 (drill angle, freeze, caulk texture), plus the s05
> wording, and adding 0.5 s to s03 (taken from the title card). Declining n6: the guide's step 4
> does say "from the side". Added house rule 7: beam ends may run off frame in lift shots.
> One question, n4: "ceiling joists" on the card, or keep your wording "into a joist"?

### 5. Make the targeted change and re-render

Make the smallest code change that does what each note asks. Then re-render only the frame
ranges that changed and splice them in, as the build already does, and run the build's full checks.

**Pacing with a locked length.** When `target_duration_s` is set, every second added somewhere
comes out somewhere else. Take it, in this order, from:
1. title and end cards,
2. scenes where the narration finishes well before the scene ends,
3. nowhere a line already runs late or a card is already short.

Add time as motion (a slower move, a longer dwell with the camera still drifting), not as a held
frame: a still of 1 s or more fails the freeze check. Say in the `pace` change where the time
came from. Scenes that shift or change length get re-judged by the evaluator, which is expected.

Publish the next version with `previous` set (step 1) and `changes` filled in, with the `frames`
each change touched. Back up before overwriting, as always. Then go back to step 2.

## Things that go wrong

- **The studio says it can't play the video:** the browser has no H.264 (open it in Edge or
  Chrome), or the manifest path is wrong (the banner says which).
- **Compare shows the same video twice:** the previous version's manifest points at a file
  that was overwritten. See step 1.
- **A note lands in the wrong scene after re-timing:** scene ids changed between versions. Keep
  them stable.
- **Brody's earlier notes show as "not mentioned":** `changes` is missing them, or `previous`
  names a different version from the one Brody reviewed.
- **The evaluator refuses to carry a scene:** something in it changed. That is intended;
  it re-judges it.
