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

from . import storage


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

    cmd = [cli, "--input", str(job.input_image), "--output", str(ply_out)]

    try:
        stdout_mode = "a" if append_logs else "w"
        stderr_mode = "a" if append_logs else "w"
        with stdout_path.open(stdout_mode, encoding="utf-8") as stdout_file, stderr_path.open(
            stderr_mode, encoding="utf-8"
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

    scene_ply = job.workdir / "scene.ply"
    if scene_ply != ply_out:
        shutil.copyfile(ply_out, scene_ply)

    return ply_out
