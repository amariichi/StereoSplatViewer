"""
ml-sharp invocation helpers.

This module follows the contract in ExecPlan.md:
- Invoke ml-sharp via ML_SHARP_CLI or `sharp` from PATH.
- Work under backend/.data/{jobId}/
- Produce <input_stem>.ply (and copy to scene.ply for compatibility) and capture stdout/stderr.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from . import sharp_pool, storage


@dataclass
class MlSharpJob:
    job_id: str
    input_image: Path
    workdir: Path
    cli: str | None = None


class MlSharpError(Exception):
    """Raised when ml-sharp execution fails."""


def resolve_cli(custom_cli: str | None) -> str:
    """
    Pick the ml-sharp command to run.
    """

    if custom_cli:
        return custom_cli

    env_cli = os.environ.get("ML_SHARP_CLI")
    if env_cli:
        return env_cli

    repo_root = Path(__file__).resolve().parents[3]
    wrapper_path = repo_root / "scripts" / "ml_sharp_wrapper.sh"
    if wrapper_path.exists() and os.access(wrapper_path, os.X_OK):
        return str(wrapper_path)

    return "sharp"


def run_mlsharp(
    job: MlSharpJob,
    stdout_path: Path | None = None,
    stderr_path: Path | None = None,
    append_logs: bool = False,
) -> Path:
    """
    Execute ml-sharp CLI for the given job.

    Returns:
        Path to the generated PLY file on success.

    Raises:
        MlSharpError: if the CLI fails or the output PLY is missing.
    """

    cli = resolve_cli(job.cli)
    stdout_path = stdout_path or storage.stdout_log_path(job.job_id)
    stderr_path = stderr_path or storage.stderr_log_path(job.job_id)
    input_stem = job.input_image.stem or "scene"
    ply_out = job.workdir / f"{input_stem}.ply"

    # The command line path opens the log with "w" when it is not appending, so
    # a fresh job starts with an empty log. The worker only ever appends, so the
    # truncation has to happen here for both paths to behave the same way.
    if not append_logs:
        stdout_path.write_text("", encoding="utf-8")
        stderr_path.write_text("", encoding="utf-8")

    # A warm worker already holds the model, which is most of the cost: 3.4
    # seconds against 16.5 for the same image through the command line, for
    # byte-identical output. When there is no worker the command line still
    # runs, so this is a shortcut rather than a dependency.
    if not job.cli and sharp_pool.POOL.predict(job.input_image, ply_out, stdout_path):
        _finish(job, ply_out)
        return ply_out

    cmd = [cli, "--input", str(job.input_image), "--output", str(ply_out)]

    try:
        with stdout_path.open("a", encoding="utf-8") as stdout_file, stderr_path.open(
            "a", encoding="utf-8"
        ) as stderr_file:
            result = subprocess.run(
                cmd,
                cwd=job.workdir,
                stdout=stdout_file,
                stderr=stderr_file,
                check=False,
            )
    except FileNotFoundError as exc:
        raise MlSharpError(
            f"ml-sharp CLI not found: tried '{cli}'. Set ML_SHARP_CLI to an absolute path."
        ) from exc

    if result.returncode != 0:
        raise MlSharpError(f"ml-sharp exited with code {result.returncode}")

    if not ply_out.exists():
        raise MlSharpError("ml-sharp finished but output PLY not found")

    _finish(job, ply_out)
    return ply_out


def _finish(job: MlSharpJob, ply_out: Path) -> None:
    """Leave a copy under the fixed name the rest of the app looks for."""

    scene_ply = job.workdir / "scene.ply"
    if scene_ply != ply_out:
        shutil.copyfile(ply_out, scene_ply)
