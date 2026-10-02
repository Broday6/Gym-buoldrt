"""Shared helpers for the evaluator scripts. Standard library only, Python 3.8+."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from fractions import Fraction
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import validate_review as vr  # noqa: E402


class EvalError(SystemExit):
    """Stops a script with a message meant for the evaluator to act on."""


def tool(name: str, override: str | None) -> str:
    exe = override or os.environ.get(name.upper()) or name
    if shutil.which(exe) is None and not Path(exe).exists():
        raise EvalError(f"{name} not found. Put it on PATH, set {name.upper()}=<path>, or pass --{name} <path>.")
    return exe


def load_version(project: Path, version: str) -> tuple[dict, Path]:
    vdir = project / "review" / version
    mpath = vdir / "manifest.json"
    if not mpath.is_file():
        raise EvalError(f"no manifest at {mpath}")
    try:
        m = json.loads(mpath.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise EvalError(f"{mpath} is not valid JSON: {exc}")
    res = vr.validate_manifest(m, version_dir=version)
    if not res.ok:
        raise EvalError("manifest.json has errors — send it back to the builder:\n  " + "\n  ".join(res.errors))
    return m, vdir


def cut_path(project: Path, cut: dict) -> Path:
    return (project / cut["file"]).resolve()


def run(cmd: list[str], check: bool = True) -> subprocess.CompletedProcess:
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if check and proc.returncode != 0:
        tail = "\n".join(proc.stderr.strip().splitlines()[-15:])
        raise EvalError(f"command failed ({proc.returncode}): {' '.join(cmd[:8])} …\n{tail}")
    return proc


def ffprobe_json(ffprobe: str, path: Path, *args: str) -> dict:
    proc = run([ffprobe, "-v", "error", *args, "-of", "json", str(path)])
    return json.loads(proc.stdout or "{}")


def frac(s) -> float | None:
    try:
        f = Fraction(str(s))
        return float(f) if f else None
    except (ValueError, ZeroDivisionError):
        return None


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def fmt_time(frame: int, fps: float) -> str:
    t = frame / fps
    m = int(t // 60)
    return f"{m}:{t - 60 * m:05.2f}"
