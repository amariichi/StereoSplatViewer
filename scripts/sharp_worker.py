"""
A long-lived ml-sharp process that keeps the model in memory.

Running `sharp predict` once per image spends most of its time getting ready:
importing torch, building the two vision transformers, loading the checkpoint
and moving it onto the GPU. Measured on a 360 job, each face took about 11.5
seconds wall clock of which the inference itself was 1.15 seconds. Six faces
therefore cost around a hundred seconds to do seven seconds of work.

This script does the expensive part once and then waits, so every image after
the first pays only for its own inference.

It is deliberately a separate process rather than something imported into the
backend: ml-sharp lives in its own virtual environment with its own torch, and
this repository does not vendor it. The backend starts this file with ml-sharp's
interpreter and talks to it over pipes.

Protocol, one JSON object per line in each direction.

    in   {"id": "abc", "input": "/path/in.jpg", "output": "/path/out.ply",
          "log": "/path/stdout.log"}
    in   {"op": "shutdown"}

    out  {"event": "ready", "device": "cuda"}
    out  {"event": "done", "id": "abc", "output": "/path/out.ply"}
    out  {"event": "error", "id": "abc", "message": "..."}
    out  {"event": "fatal", "message": "..."}

Stdout carries only the protocol. Anything meant for a human goes to the log
file named in the request, so that each job keeps its own log exactly as it did
when every job was its own process.
"""

from __future__ import annotations

import json
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path


def emit(payload: dict) -> None:
    """Send one protocol line. Flushed, because the reader blocks on it."""

    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def note(log_path: str | None, message: str) -> None:
    """Append a human-readable line to this job's log, if it has one."""

    if not log_path:
        return
    try:
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        with Path(log_path).open("a", encoding="utf-8") as handle:
            handle.write(f"{stamp} | INFO | {message}\n")
    except OSError:
        # A log that cannot be written is not a reason to lose the scene.
        pass


def die_with_parent() -> None:
    """
    Ask the kernel to end this process if the backend goes away.

    Without this a worker outlives the server that started it, holding the GPU
    and answering to nobody. That happened here: killing the backend left the
    worker resident, and clearing it up by name is dangerous -- `pkill -f` on a
    pattern matches every command line containing it, including the shell
    running the pkill, and that mistake took two unrelated servers with it.
    Ending with the parent removes the need to hunt for it at all.

    Linux only. Elsewhere the loop still ends when stdin closes.
    """

    try:
        import ctypes

        PR_SET_PDEATHSIG = 1
        SIGTERM = 15
        ctypes.CDLL("libc.so.6", use_errno=True).prctl(PR_SET_PDEATHSIG, SIGTERM, 0, 0, 0)
    except Exception:  # noqa: BLE001
        pass


def main() -> int:
    die_with_parent()
    try:
        import torch
        from sharp.cli.predict import DEFAULT_MODEL_URL, predict_image
        from sharp.models import PredictorParams, create_predictor
        from sharp.utils import io
        from sharp.utils.gaussians import save_ply
    except Exception as exc:  # noqa: BLE001
        emit({"event": "fatal", "message": f"cannot import ml-sharp: {exc}"})
        return 1

    try:
        if torch.cuda.is_available():
            device = "cuda"
        elif hasattr(torch, "mps") and torch.mps.is_available():
            device = "mps"
        else:
            device = "cpu"

        # The same three steps `sharp predict` performs, done once.
        state_dict = torch.hub.load_state_dict_from_url(DEFAULT_MODEL_URL, progress=False)
        predictor = create_predictor(PredictorParams())
        predictor.load_state_dict(state_dict)
        predictor.eval()
        predictor.to(device)
    except Exception as exc:  # noqa: BLE001
        emit({"event": "fatal", "message": f"cannot load the model: {exc}"})
        return 1

    def release_workspace() -> None:
        """
        Hand the inference workspace back to the driver between jobs.

        Torch does not return memory it has finished with; its allocator keeps
        the blocks so that the next allocation of the same shape costs nothing.
        For this model that is the difference between holding 2.9 GB and
        holding 11.3 GB, measured on an RTX PRO 4500: 2.7 GB of that is the
        weights, which have to stay, and the rest is one image's activations,
        which do not. An idle worker sitting on 11.3 GB is 11.3 GB no other
        program on this machine can have.

        Giving it back costs nothing worth measuring. Three runs of the same
        image took 2.63s with the cache kept and 2.38s and 2.37s with it
        emptied after each, so re-allocating hides behind the inference itself.

        Called even when the job failed, because a failure part-way through is
        exactly when a large allocation is left behind.
        """

        try:
            if device == "cuda":
                torch.cuda.empty_cache()
            elif device == "mps":
                torch.mps.empty_cache()
        except Exception:  # noqa: BLE001
            # The scene is already saved and reported by this point. Failing to
            # tidy up is not a reason to end the worker.
            pass

    emit({"event": "ready", "device": device})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError:
            emit({"event": "error", "id": None, "message": "request was not JSON"})
            continue

        if request.get("op") == "shutdown":
            return 0

        job_id = request.get("id")
        log_path = request.get("log")
        gaussians = None
        try:
            input_path = Path(request["input"])
            output_path = Path(request["output"])

            note(log_path, f"Worker is processing {input_path} on {device}")
            image, _, f_px = io.load_rgb(input_path)
            height, width = image.shape[:2]

            note(log_path, "Running inference.")
            gaussians = predict_image(predictor, image, f_px, torch.device(device))

            note(log_path, f"Saving 3DGS to {output_path}")
            output_path.parent.mkdir(parents=True, exist_ok=True)
            save_ply(gaussians, f_px, (height, width), output_path)

            if not output_path.exists():
                raise RuntimeError(f"ml-sharp wrote nothing to {output_path}")

            emit({"event": "done", "id": job_id, "output": str(output_path)})
        except Exception as exc:  # noqa: BLE001
            note(log_path, f"Worker failed: {exc}")
            note(log_path, traceback.format_exc())
            emit({"event": "error", "id": job_id, "message": str(exc)})
        finally:
            # Drop the scene before emptying the cache, or its own tensors are
            # still allocated and stay where they are.
            gaussians = None
            release_workspace()

    return 0


if __name__ == "__main__":
    sys.exit(main())
