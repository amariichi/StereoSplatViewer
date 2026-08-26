"""
Compress a finished scene into the format a phone can actually download.

SHARP writes a plain PLY, and for one photograph that is 66 MB. On a desktop
over a local network nobody notices. Over a mobile connection it is the whole
experience: the viewer page sits there with nothing on it while the scene
arrives, which is what the head-coupled viewer is for and where it is worst.

The same scene as a SOG bundle is 10.9 MB, converted in 2.2 seconds, measured
here on the portrait used to develop this. PlayCanvas reads `.sog` through the
same `gsplat` asset type as the PLY, so the viewer needs a different URL and
nothing else.

The PLY is kept. The editor has the memory for it and exports come from it, so
nothing that leaves this machine goes through a lossy intermediate; the SOG
exists for the wire.

Everything here degrades to nothing. A scene that could not be compressed is
still served as a PLY, and slowly is better than not at all.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

LOGGER = logging.getLogger(__name__)

# Long enough for a scene several times the size of the ones measured, short
# enough that a hung converter does not hold an upload open indefinitely.
_TIMEOUT_S = 300.0


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def resolve_cli() -> str | None:
    """
    Find splat-transform, preferring whatever the operator has chosen.

    The frontend already depends on it, so the copy under `frontend/node_modules`
    is present on any machine that has run `npm ci` and is the reason this works
    without a separate install step. It is looked at last so that naming one
    explicitly, or having one on PATH, still wins.
    """

    for env in ("SPLAT_TRANSFORM_CLI", "SPLAT_MERGE_CLI"):
        value = os.environ.get(env)
        if value:
            return value
    found = shutil.which("splat-transform")
    if found:
        return found
    local = _repo_root() / "frontend" / "node_modules" / ".bin" / "splat-transform"
    return str(local) if local.is_file() else None


def convert(ply_path: Path, sog_path: Path, log_path: Path | None = None) -> bool:
    """
    Write `sog_path` from `ply_path`. Returns whether it is there afterwards.

    Never raises. The caller has a finished scene either way, and the only
    consequence of a failure is that the phone downloads the large one.
    """

    def note(message: str) -> None:
        LOGGER.info("%s", message)
        if not log_path:
            return
        try:
            stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
            with Path(log_path).open("a", encoding="utf-8") as handle:
                handle.write(f"{stamp} | INFO | {message}\n")
        except OSError:
            pass

    try:
        present = ply_path.is_file()
        cli = resolve_cli()
    except OSError as exc:
        note(f"Could not look for the scene or the compressor: {exc}. Serving the PLY.")
        return False

    if not present:
        note(f"No scene to compress at {ply_path}")
        return False

    if cli is None:
        note(
            "splat-transform not found, so the scene is served as a PLY. "
            "It works and it is about six times the download. Run `npm ci` in "
            "frontend/, or set SPLAT_TRANSFORM_CLI."
        )
        return False

    def discard() -> None:
        """Leave nothing half-written behind: a partial bundle would be served."""

        try:
            sog_path.unlink(missing_ok=True)
        except OSError as exc:
            note(f"Could not remove {sog_path.name}: {exc}")

    discard()
    note(f"Compressing {ply_path.name} to {sog_path.name}")
    try:
        result = subprocess.run(
            [cli, str(ply_path), str(sog_path)],
            capture_output=True,
            text=True,
            timeout=_TIMEOUT_S,
            check=False,
        )
        if result.returncode != 0 or not sog_path.is_file():
            tail = (result.stderr or result.stdout or "").strip().splitlines()[-3:]
            note(f"splat-transform exited {result.returncode}. Serving the PLY. {' '.join(tail)}")
            discard()
            return False
        before = ply_path.stat().st_size
        after = sog_path.stat().st_size
    except (OSError, subprocess.SubprocessError) as exc:
        # Includes the timeout, and the stat calls: everything from here on is
        # tidying up, and the caller has a finished scene whatever happens.
        note(f"Could not compress the scene: {exc}. Serving the PLY.")
        discard()
        return False

    note(f"Compressed {before / 1e6:.1f} MB to {after / 1e6:.1f} MB")
    return True
