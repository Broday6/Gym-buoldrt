# Review contract — manifest, feedback, eval report

Three JSON files carry everything between the three parties of an install-video project:

| File | Written by | Read by |
|---|---|---|
| `review/<version>/manifest.json` | the builder, after every render it wants looked at | Review Studio, evaluator |
| `review/<version>/eval-report.json` | the evaluator (via `assemble_report.py`) | Review Studio, builder |
| `review/<version>/feedback.json` | Review Studio, as the user works | builder |

`scripts/validate_review.py <file>` checks any of the three. Run it after writing one by hand.

## Layout

```
<project>/                      the folder the build runs from
  HOUSE_RULES.md                rules the user has set that override the guide (optional, recommended)
  README.md                     claims table (existing)
  review/
    v1/manifest.json
    v1/eval-report.json
    v1/eval/…                   evaluator working files (frames, sheets, logs)
    v1/feedback.json
    v2/…
```

- A **version** is a folder under `review/` holding a `manifest.json`. Its name is the version id
  (`v1`, `v2`, `v7b` …). Versions sort naturally, so `v10` comes after `v9`.
- **Every path inside these files is relative to the project folder**, using forward slashes.
- A version's video files must **not be overwritten later**. Point each manifest at the copy that
  stays put (a versioned render folder, or the backup the build already makes before overwriting).
  Otherwise comparing with an earlier version shows the new video twice.
- Frames are the unit of time. `start_frame` is inclusive and `end_frame` is exclusive, so a
  scene with `start_frame: 600, end_frame: 1140` holds frames 600–1139. Frame `n` is shown at
  `n / fps` seconds. Frame numbers start at 0.

---

## manifest.json — `ekena-install-review/1`

```json
{
  "schema": "ekena-install-review/1",
  "project": "Timberthane Faux Beam — Ceiling Install",
  "version": "v7",
  "created": "2026-10-02T14:05:00Z",
  "previous": "v6",
  "fps": 60,
  "frame_count": 4500,
  "target_duration_s": 75,
  "cuts": [
    {"id": "16x9", "file": "renders/v7/beam_install_16x9.mp4", "width": 1920, "height": 1080},
    {"id": "9x16", "file": "renders/v7/beam_install_9x16.mp4", "width": 1080, "height": 1920}
  ],
  "scenes": [
    {
      "id": "s03",
      "title": "Mark the joists",
      "kind": "step",
      "start_frame": 600,
      "end_frame": 1140,
      "step_card": "Step 2 — Find and mark the joists",
      "narration": "Use a stud finder to find each ceiling joist, and mark it.",
      "claims": ["C4", "C5"],
      "transition_in": "cut",
      "static_ok": false,
      "black_ok": false,
      "actions": [
        {"id": "drill_1", "label": "Drill pilot hole 1", "frame": 720, "end_frame": 780}
      ],
      "source": {"files": ["scenes/joists.js"], "timeline_keys": ["mark_joists", "drill_1"]}
    }
  ],
  "claims": [
    {"id": "C4", "text": "Fasten the mounting blocks into joists", "source": "Install guide p.2, step 3"}
  ],
  "key_terms": ["joists", "mounting block", {"term": "Shutter-Loks", "heard_as": ["shutter locks"]}],
  "references": {
    "install_guide": "research/timberthane-install-guide.pdf",
    "product_images": ["research/renders/rough-sawn-hero.jpg"],
    "house_rules": "HOUSE_RULES.md",
    "readme": "README.md"
  },
  "changes": [
    {"note": "v6-n3", "finding": null, "scene": "s04", "frames": [1500, 1620],
     "status": "addressed", "summary": "Hammer now swings toward the wall, not away from it"}
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `schema` | yes | Always `ekena-install-review/1`. |
| `project` | yes | Display name. |
| `version` | yes | Must equal the folder name. |
| `created` | no | ISO-8601 time of the render. |
| `previous` | no | The version this one revises. Turns on compare mode and the "Previous notes" list. |
| `fps` | yes | Frames per second of every cut (60 for this pipeline). |
| `frame_count` | yes | Exact frame count of every cut. |
| `target_duration_s` | no | The length the user asked for. Tells the studio a pace change has to be rebalanced. |
| `cuts[]` | yes, ≥1 | One per delivered aspect ratio. `id` is free text (`16x9`, `9x16`). |
| `scenes[]` | yes, ≥1 | Contiguous, in order, covering frames `0 … frame_count`. |
| `scenes[].id` | yes | Stable across versions. **Keep the same id when a scene is re-timed**, so compare mode and notes from earlier versions line up. |
| `scenes[].kind` | no | `title`, `step`, `diagram`, `end` or `other`. |
| `scenes[].step_card` / `narration` | no | The exact on-screen card text and spoken line. The studio lets the user propose edits to them. The evaluator checks the picture against them. |
| `scenes[].claims` | no | Claim ids backing the card and narration. A step scene with none is flagged. |
| `scenes[].transition_in` | no | `cut`, `dissolve` or `continuous`. With `cut`, the technical check expects a hard cut on `start_frame`. |
| `scenes[].static_ok` | no | The picture may hold still here (title or end card), so a freeze is not a fault. |
| `scenes[].black_ok` | no | Black frames are intended here (fade from or to black). |
| `scenes[].actions[]` | no | Timeline events worth checking on their own. `id` is unique in the manifest. Reuse the `timeline.json` key when there is one. |
| `scenes[].source` | no | Where the scene lives in code. This is what turns a note into a targeted change. |
| `claims[]` | no | The README claims table, as data. |
| `key_terms[]` | no | Words that must be heard clearly in the narration. A plain string, or `{"term", "heard_as"}` when the spoken form is spelled differently from the product name (`Shutter-Loks` is said "shutter locks"). Matching is exact, so a near miss such as "mountain block" fails. |
| `references` | no | Ground truth for the evaluator. |
| `changes[]` | no | What this version did about notes (`note`) and evaluator findings (`finding`) on the previous version. `status` is `addressed` or `declined`. A declined item must say why in `summary`. |

---

## feedback.json — `ekena-install-feedback/1`

Written by the Review Studio. The builder treats it as read-only.

```json
{
  "schema": "ekena-install-feedback/1",
  "project": "Timberthane Faux Beam — Ceiling Install",
  "version": "v7",
  "updated": "2026-10-02T15:12:40Z",
  "submitted": true,
  "approved": false,
  "approved_at": null,
  "notes": [
    {"id": "v7-n1", "cut": "16x9", "frame": 734, "scene": "s03", "action": "drill_1",
     "category": "physics", "priority": "must",
     "text": "Drill should be square to the beam, it's tilted",
     "region": {"x": 0.41, "y": 0.22, "w": 0.12, "h": 0.18},
     "from_finding": null, "created": "2026-10-02T15:03:11Z"}
  ],
  "text_changes": [
    {"scene": "s05", "field": "step_card", "from": "Step 4 — Glue", "to": "Step 4 — Apply adhesive"}
  ],
  "pace": [
    {"scene": "s06", "delta_s": 0.5}
  ],
  "findings": {
    "e2": {"decision": "accept", "reason": "", "note": "v7-n4"},
    "e5": {"decision": "reject", "reason": "Correct — no anchors for Shutter-Loks is our rule"}
  }
}
```

- `notes[].region` uses fractions of that cut's frame (0–1, origin top-left), or `null`.
- `notes[].category` is one of `product`, `install`, `physics`, `graphics`, `text`, `narration`,
  `timing`, `color`, `audio` or `other`. `priority` is `must` or `nice`.
- `text_changes[].field` is `step_card` or `narration`. `to` is the user's exact wording, so use it verbatim.
- `pace[].delta_s` is how much longer (+) or shorter (−) the user wants that scene to run. When
  `target_duration_s` is set, the builder keeps the total locked by taking the time back from
  other scenes and says where it took it from.
- `findings` holds the user's decision on each evaluator finding. An accepted finding becomes a
  note (`note`). A rejected finding with a reason is a candidate rule for `HOUSE_RULES.md`.
- `submitted: true` means the user pressed **Send to builder**. `approved: true` means this version is
  signed off.

---

## eval-report.json — `ekena-install-eval/1`

Written by the evaluator. `assemble_report.py` builds it from `technical.json`,
`narration.json` and the evaluator's `judgments.json`, and applies the gates, so the pass bar
cannot drift.

```json
{
  "schema": "ekena-install-eval/1",
  "project": "Timberthane Faux Beam — Ceiling Install",
  "version": "v7",
  "evaluated_at": "2026-10-02T14:40:00Z",
  "overall": "fail",
  "summary": "2 blockers: s03 drill not square to beam; s05 card misspells 'adhesive'.",
  "technical": {"pass": true, "checks": [ … from tech_checks.py … ]},
  "narration": {"available": true, "scenes": [ … from transcribe_check.py … ]},
  "scenes": [
    {"scene": "s03", "pass": false, "carried": false,
     "scores": {"product": 2, "install": 2, "physics": 0, "graphics": 2, "sync": 2, "reframe": 2, "craft": 2},
     "total": 12, "gate_reasons": ["physics scored 0"]}
  ],
  "findings": [
    {"id": "e1", "scene": "s03", "action": "drill_1", "cut": "16x9", "frame": 734, "end_frame": 780,
     "severity": "blocker", "criterion": "physics", "scope": "local",
     "rule": null, "source": "Install guide p.2, fig. 3",
     "what": "Drill bit enters the beam at ~20° off square; the guide shows it square to the face.",
     "fix": "Square the drill's path in scenes/joists.js (drill_1 approach vector).",
     "evidence": ["review/v7/eval/frames/16x9_f000734.jpg"],
     "region": {"x": 0.40, "y": 0.20, "w": 0.15, "h": 0.20}}
  ]
}
```

- `severity`: `blocker` must be fixed before the user sees the version. `major` goes to the user
  to accept or reject. `minor` is polish.
- `scope`: `local` is one moment. `systemic` is the same defect in three or more scenes: fix the
  shared cause once (material, colour lock, a shared tool path), not scene by scene.
- `carried: true` on a scene means it was not re-judged because nothing in it changed since the
  previous version. Its scores are copied from that report.
