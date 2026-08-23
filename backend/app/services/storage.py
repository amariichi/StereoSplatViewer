"""
Job storage helpers.

Creates and manages job directories under backend/.data/{jobId}. Status is
persisted in a small JSON file per job so that it survives process restarts.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any, Literal, TypedDict

DATA_ROOT = Path(__file__).resolve().parents[2] / ".data"


class JobStatus(TypedDict, total=False):
    status: Literal["pending", "running", "done", "error"]
    message: str


def ensure_data_root() -> Path:
    DATA_ROOT.mkdir(parents=True, exist_ok=True)
    return DATA_ROOT


def clear_data_root() -> None:
    if DATA_ROOT.exists():
        shutil.rmtree(DATA_ROOT)
    DATA_ROOT.mkdir(parents=True, exist_ok=True)
    keep = DATA_ROOT / ".gitkeep"
    keep.write_text("", encoding="utf-8")


def data_root_summary() -> tuple[int, int]:
    """How many scenes are on disk and how many bytes they occupy."""

    if not DATA_ROOT.exists():
        return (0, 0)
    jobs = [d for d in DATA_ROOT.iterdir() if d.is_dir()]
    total = sum(f.stat().st_size for d in jobs for f in d.rglob("*") if f.is_file())
    return (len(jobs), total)


def prune_to_latest() -> list[str]:
    """
    Drop every scene except the newest, and return the names of what was removed.

    Uploading clears the data root first, so one scene is the intended steady
    state. Anything older is a leftover from an interrupted run, and keeping it
    would let the disk fill up quietly. The newest is kept because it is the one
    the viewer page serves.
    """

    if not DATA_ROOT.exists():
        return []
    jobs = [d for d in DATA_ROOT.iterdir() if d.is_dir()]
    if len(jobs) <= 1:
        return []
    newest = max(jobs, key=lambda d: d.stat().st_mtime)
    removed = []
    for job in jobs:
        if job == newest:
            continue
        shutil.rmtree(job, ignore_errors=True)
        removed.append(job.name)
    return removed


def job_dir(job_id: str) -> Path:
    """
    Return the path to the job directory without creating it.
    """

    return ensure_data_root() / job_id


def ensure_job_dir(job_id: str) -> Path:
    """
    Create the job directory if it does not exist and return it.
    """

    path = job_dir(job_id)
    path.mkdir(parents=True, exist_ok=True)
    return path


def input_image_path(job_id: str, filename: str) -> Path:
    """
    Compute the path to store the uploaded image for a job.
    """

    return ensure_job_dir(job_id) / filename


def ply_path(job_id: str) -> Path:
    return job_dir(job_id) / "scene.ply"


def metadata_path(job_id: str) -> Path:
    return job_dir(job_id) / "metadata.json"


def status_path(job_id: str) -> Path:
    return job_dir(job_id) / "status.json"


def stdout_log_path(job_id: str) -> Path:
    return job_dir(job_id) / "stdout.log"


def stderr_log_path(job_id: str) -> Path:
    return job_dir(job_id) / "stderr.log"


def write_status(job_id: str, status: JobStatus) -> None:
    ensure_job_dir(job_id)
    status_file = status_path(job_id)
    status_file.write_text(json.dumps(status, ensure_ascii=False, indent=2))


def read_status(job_id: str) -> JobStatus | None:
    status_file = status_path(job_id)
    if not status_file.exists():
        return None
    try:
        data: Any = json.loads(status_file.read_text())
    except json.JSONDecodeError:
        return None
    return JobStatus(status=data.get("status", "pending"), message=data.get("message", ""))


def latest_job() -> dict[str, str] | None:
    """The scene currently held, if there is one.

    Every upload clears the data root first, so there is at most one job at any
    time and "latest" is unambiguous. This exists so that the viewer page can be
    opened on a phone by its plain address, without anyone having to copy a job
    identifier across by hand.
    """
    if not DATA_ROOT.exists():
        return None
    candidates = [d for d in DATA_ROOT.iterdir() if d.is_dir()]
    if not candidates:
        return None
    newest = max(candidates, key=lambda d: d.stat().st_mtime)
    # A job that is still running has a directory but no scene in it yet.
    scenes = sorted(newest.glob("*.ply"))
    if not scenes:
        return None
    return {"jobId": newest.name, "name": scenes[0].name}
