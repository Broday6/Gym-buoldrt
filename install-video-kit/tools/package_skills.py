#!/usr/bin/env python3
"""Sync the files both skills share, then package each skill as release/<name>.skill.

    python tools/package_skills.py

The review skill holds the originals of validate_review.py and schemas.md. The evaluator gets
copies, because an uploaded skill must be self-contained. A .skill file is a zip whose top-level
folder is the skill, the format the Skills upload and the "Save skill" button take.
"""
from __future__ import annotations

import re
import shutil
import sys
import zipfile
from pathlib import Path

KIT = Path(__file__).resolve().parent.parent
SKILLS = KIT / "skills"
DIST = KIT / "release"
SHARED = ["scripts/validate_review.py", "references/schemas.md"]
SOURCE, COPIES = "ekena-install-video-review", ["ekena-install-video-evaluator"]
SKIP_DIRS = {"__pycache__", "node_modules", "evals"}


def check_frontmatter(skill: Path) -> None:
    text = (skill / "SKILL.md").read_text(encoding="utf-8")
    m = re.match(r"^---\n(.*?)\n---", text, re.S)
    if not m:
        raise SystemExit(f"{skill.name}: SKILL.md has no frontmatter")
    fm = m.group(1)
    name = re.search(r"^name:\s*(\S+)", fm, re.M)
    if not name or name.group(1) != skill.name:
        raise SystemExit(f"{skill.name}: frontmatter name must match the folder name")
    desc = re.search(r"^description:\s*>?\s*\n?(.*)", fm, re.S | re.M)
    body = " ".join(line.strip() for line in (desc.group(1) if desc else "").splitlines())
    if "<" in body or ">" in body:
        raise SystemExit(f"{skill.name}: description may not contain angle brackets")
    if len(body) > 1024:
        raise SystemExit(f"{skill.name}: description is {len(body)} characters (max 1024)")


def main() -> int:
    for rel in SHARED:
        for dest in COPIES:
            target = SKILLS / dest / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(SKILLS / SOURCE / rel, target)
    DIST.mkdir(exist_ok=True)
    for skill in sorted(p for p in SKILLS.iterdir() if (p / "SKILL.md").exists()):
        check_frontmatter(skill)
        out = DIST / f"{skill.name}.skill"
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            for f in sorted(skill.rglob("*")):
                rel = f.relative_to(skill)
                if f.is_dir() or any(p in SKIP_DIRS for p in rel.parts) or f.suffix == ".pyc":
                    continue
                z.write(f, Path(skill.name) / rel)
        print(f"packaged {out.relative_to(KIT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
