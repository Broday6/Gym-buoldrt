# Install-video review kit

Two tools for the code-built Ekena installation videos:

- **Review Studio**: a local page for reviewing a render together. It plays both cuts frame
  by frame, shows the scene map, and lets you pin a note and a box to the exact frame. You can
  change a card's wording or a scene's pacing, compare against the previous version, and accept
  or reject what the evaluator found. Your notes reach the builder as structured data, already
  tied to scenes, timeline events and code, so a note becomes a targeted fix instead of a guess
  about "around 0:32".
- **Install-video evaluator**: a second agent, separate from the one that built the video. It
  pulls its own frames from the delivered files and runs its own technical and narration checks.
  It grades every scene against the install guide, your house rules and Ekena's renders, and
  catches blockers before you see a version.

Everything runs on the PC that builds the videos. The studio is served only to that computer, and
nothing is uploaded.

```
render ─► publish v8 ─► evaluator (separate agent) ─► builder fixes blockers ─► Review Studio ─► your notes
   ▲                                                                                              │
   └──────────── targeted change + splice re-render ◄──── feedback.json (frame, scene, code) ◄────┘
```

## What's here

| Path | What it is |
|---|---|
| `skills/ekena-install-video-review/` | Skill for the **builder**: publish each version, get it evaluated, open the studio, turn your notes into changes |
| `…/assets/studio.html` | The Review Studio page |
| `…/scripts/review_server.py` | Serves the studio for one project and saves your notes (Python standard library only) |
| `…/scripts/publish_gate.py` | The check every video passes before it is published: evaluator pass, your Approve in the studio, and the file byte-for-byte the approved one. Writes `release.json` when it clears |
| `…/scripts/note_frames.py` | For the builder: the exact frame of each of your notes, with your box drawn on it, plus a strip of frames around it |
| `…/scripts/validate_review.py` | Checks a manifest, feedback or report file |
| `…/references/schemas.md` | The three files that carry everything: `manifest.json`, `feedback.json`, `eval-report.json` |
| `…/references/publishing.md` | How the builder writes `manifest.json` from `timeline.json` and the scene map |
| `skills/ekena-install-video-evaluator/` | Skill for the **evaluator**: what to check, how to score, how to write findings |
| `…/scripts/tech_checks.py` | Frame count, length, fps, codec, loudness/true peak, decode errors, black frames, freezes, cuts on frame |
| `…/scripts/extract_frames.py` | Exact frames by number, contact sheet per scene, motion strip per action, 16:9/9:16 reframe pairs |
| `…/scripts/transcribe_check.py` | Local Whisper on the delivered audio: each line heard in its own scene, key terms heard exactly. Without a speech model it still flags narrated scenes that are silent or as flat as a tone |
| `…/scripts/assemble_report.py` | Merges it all, applies the pass/fail gates, writes `eval-report.json` |
| `tools/make_demo_project.py` | Makes a small fake project to try everything on |
| `tools/build_static_review.py` | Bundles a project's review into a folder the studio opens without the server, for sharing a review as a page. Viewers' notes stay in their browser; they hand them over with *Copy summary* or *Copy feedback*. `--proxy-mb 13` bundles review proxies (same frames, smaller files) for hosts that cap file size; the gate still checks the full-quality cuts |
| `tests/` | End-to-end test: the scripts on the demo, plus the studio driven in a real browser |
| `release/*.skill` | The two skills, packaged for upload (`python tools/package_skills.py` rebuilds them) |

## Setting it up

1. **Install the two skills.** Open each `.skill` file from `release/` and press **Save skill**,
   or upload them under Settings → Capabilities → Skills.
2. **On the video PC**, the evaluator needs `ffmpeg`, `ffprobe` and Pillow (`pip install pillow`).
   For the narration check it also needs faster-whisper or openai-whisper; if the build's own
   speech check already uses Whisper, it will find it. The studio needs Python 3.8+ and Edge or Chrome.
3. **In the video chat**, tell the builder: *"Set up the review loop for this project."* It
   creates `review/`, moves your saved rules into `HOUSE_RULES.md`, and writes `publish_review.py`.

## Using it

After each render the builder publishes a version, has the evaluator check it, fixes any
blockers, and sends you a link like `http://127.0.0.1:8765/#v=v8`. In the studio:

| Do this | How |
|---|---|
| Play, step | **Space**; **←/→** one frame; **Shift+←/→** one second; **[ ]** previous/next scene; click or drag the timeline |
| Leave a note | Pause on it and press **N**. Pick the kind of problem, type it, and drag a box on the picture. **Ctrl+Enter** saves |
| Change wording or pacing | **Scene** tab → *Change wording* on the step card or narration; **± 0.5 s** to make a scene run longer or shorter |
| Deal with the evaluator | **Evaluator** tab → *Accept → note* or *Reject* (give a reason; it may become a house rule) |
| Check what changed | **Changes** tab: each of your earlier notes is shown as addressed, declined (with the reason) or not mentioned. *Check it in A/B*, then press **B** to flip between versions, or use **Side by side** |
| Switch 16:9 ↔ 9:16 | **C**, or the *Cut* buttons |
| Finish | **Send to builder**: saves, and copies a text summary you can paste into the chat. **Approve** signs the version off |

**Nothing gets published without going through this.** Before a video goes to Asana, YouTube, the
website, Drive or anyone's inbox, the builder runs `publish_gate.py` on the exact files. The gate
clears the latest version only if the evaluator passed it, you pressed **Approve**, and each file
matches the approved render byte for byte. Otherwise it stops and says what's missing.

Notes save as you go, to `review/<version>/feedback.json` (the previous copy is kept as
`feedback.prev.json`). If the page is opened without the server, as a plain file, it asks you
for the files instead and gives you `feedback.json` to download.

## Try it on the demo

```
python tools/make_demo_project.py demo
python skills/ekena-install-video-review/scripts/review_server.py demo
```

v1 has a deliberate freeze in scene s03 and two notes. v2 "fixes" the freeze and declines one of
the notes, so the Changes tab and A/B have something to show. To see the evaluator's scripts work
on it:

```
python skills/ekena-install-video-evaluator/scripts/tech_checks.py demo v1
python skills/ekena-install-video-evaluator/scripts/extract_frames.py demo v1
```

## Tests

```
python tests/test_kit.py            # needs ffmpeg; the browser part needs Node + Playwright
```
