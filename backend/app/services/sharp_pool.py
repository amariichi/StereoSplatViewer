"""
A single long-lived ml-sharp process, kept warm so that images after the first
do not pay to rebuild the model.

Running the command-line tool once per image spends most of its time getting
ready rather than working: importing torch, constructing two vision
transformers, loading the checkpoint and moving it onto the GPU. Measured here,
one image took 16.5 seconds through the CLI and 3.4 seconds through a worker
that was already warm, and the two produced byte-identical PLY files.

The worker is a separate process on purpose. ml-sharp lives in its own virtual
environment with its own torch, and this repository does not vendor it, so the
backend starts scripts/sharp_worker.py with ml-sharp's interpreter and speaks to
it over pipes.

Everything here degrades to nothing: if the worker cannot be started, or dies,
or answers with an error, the caller falls back to the command-line path that
was always there. A faster route that is not available is not a failure.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import threading
from pathlib import Path

LOGGER = logging.getLogger(__name__)

# How long to wait for the model to load before giving up on the worker. The
# first ever start also downloads the checkpoint, which is why this is generous.
_STARTUP_TIMEOUT_S = 600.0


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def worker_script() -> Path:
    return _repo_root() / "scripts" / "sharp_worker.py"


def worker_python() -> Path | None:
    """
    ml-sharp's own interpreter, which is the only one that can import it.

    SHARP_WORKER_PYTHON overrides this for an installation kept elsewhere.
    """

    override = os.environ.get("SHARP_WORKER_PYTHON")
    if override:
        candidate = Path(override)
        return candidate if candidate.exists() else None

    # ML_SHARP_CLI pointing somewhere outside this repository means the operator
    # has chosen a particular ml-sharp installation. Quietly using the one under
    # third_party instead would run a different model than they asked for, and
    # nothing in the output would say so. Decline, unless they name the
    # interpreter explicitly with SHARP_WORKER_PYTHON.
    cli = os.environ.get("ML_SHARP_CLI")
    if cli:
        try:
            Path(cli).resolve().relative_to(_repo_root())
        except ValueError:
            return None

    candidate = _repo_root() / "third_party" / "ml-sharp" / ".venv" / "bin" / "python"
    return candidate if candidate.exists() else None


class SharpPool:
    """One worker, guarded by a lock so that jobs queue rather than collide."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._process: subprocess.Popen[str] | None = None
        self._device: str | None = None
        self._disabled_reason: str | None = None
        self._next_id = 0

    @property
    def device(self) -> str | None:
        return self._device

    def available(self) -> bool:
        """Whether a warm worker is standing by right now."""

        with self._lock:
            return self._is_alive()

    def status(self) -> dict[str, object]:
        with self._lock:
            return {
                "running": self._is_alive(),
                "device": self._device,
                "disabled": self._disabled_reason,
            }

    def _is_alive(self) -> bool:
        return self._process is not None and self._process.poll() is None

    def start(self) -> bool:
        """
        Start the worker and wait for the model to be in memory.

        Returns True when a worker is ready. Safe to call repeatedly; a second
        call while one is already running does nothing.
        """

        with self._lock:
            return self._start_locked()

    def _start_locked(self) -> bool:
        if self._is_alive():
            return True
        if self._disabled_reason:
            return False

        if os.environ.get("SHARP_WORKER", "").strip().lower() in {"0", "false", "no", "off"}:
            self._disabled_reason = "SHARP_WORKER is off; using the command-line path"
            LOGGER.info("%s", self._disabled_reason)
            return False

        python = worker_python()
        script = worker_script()
        if python is None or not script.exists():
            self._disabled_reason = (
                "ml-sharp's interpreter was not found, or ML_SHARP_CLI points outside this "
                "repository; using the command-line path"
            )
            LOGGER.info("%s", self._disabled_reason)
            return False

        try:
            process = subprocess.Popen(
                [str(python), str(script)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                bufsize=1,
            )
        except OSError as exc:
            self._disabled_reason = f"could not start the ml-sharp worker: {exc}"
            LOGGER.warning("%s", self._disabled_reason)
            return False

        # The worker announces itself once the model is loaded. Reading with a
        # timer rather than blocking forever, because a worker that never
        # becomes ready must not hold up every upload behind it.
        ready: dict[str, object] | None = None
        error: list[str] = []

        def read_ready() -> None:
            nonlocal ready
            try:
                assert process.stdout is not None
                line = process.stdout.readline()
                if line:
                    ready = json.loads(line)
            except (ValueError, OSError) as exc:
                error.append(str(exc))

        reader = threading.Thread(target=read_ready, daemon=True)
        reader.start()
        reader.join(_STARTUP_TIMEOUT_S)

        if ready is None or ready.get("event") != "ready":
            message = (
                ready.get("message") if isinstance(ready, dict) else None
            ) or (error[0] if error else "the worker did not become ready")
            self._disabled_reason = f"ml-sharp worker unavailable: {message}"
            LOGGER.warning("%s", self._disabled_reason)
            self._terminate_locked(process)
            return False

        self._process = process
        self._device = str(ready.get("device") or "unknown")
        LOGGER.info("ml-sharp worker is warm on %s", self._device)
        return True

    def predict(self, input_image: Path, output_ply: Path, log_path: Path | None) -> bool:
        """
        Ask the warm worker for one scene.

        Returns True when the PLY was written. False means the caller should use
        the command-line path instead; it never raises for that case, because a
        missing shortcut is not an error.
        """

        with self._lock:
            if not self._start_locked():
                return False

            process = self._process
            if process is None or process.stdin is None or process.stdout is None:
                return False

            self._next_id += 1
            request = {
                "id": str(self._next_id),
                "input": str(input_image),
                "output": str(output_ply),
                "log": str(log_path) if log_path else None,
            }

            try:
                process.stdin.write(json.dumps(request) + "\n")
                process.stdin.flush()
                line = process.stdout.readline()
            except (OSError, ValueError) as exc:
                LOGGER.warning("ml-sharp worker stopped responding: %s", exc)
                self._terminate_locked(process)
                self._process = None
                return False

            if not line:
                # The worker died mid-request. Clear it so the next call starts
                # a fresh one, and let this job go the long way round.
                LOGGER.warning("ml-sharp worker exited during a request")
                self._terminate_locked(process)
                self._process = None
                return False

            try:
                reply = json.loads(line)
            except ValueError:
                LOGGER.warning("ml-sharp worker sent something that was not JSON")
                return False

            if reply.get("event") != "done":
                LOGGER.warning("ml-sharp worker failed: %s", reply.get("message"))
                return False

        return output_ply.exists()

    def stop(self) -> None:
        with self._lock:
            if self._process is None:
                return
            process, self._process = self._process, None
            self._terminate_locked(process)

    @staticmethod
    def _terminate_locked(process: subprocess.Popen[str]) -> None:
        try:
            if process.stdin is not None and not process.stdin.closed:
                process.stdin.write(json.dumps({"op": "shutdown"}) + "\n")
                process.stdin.flush()
                process.stdin.close()
        except OSError:
            pass
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()


POOL = SharpPool()
