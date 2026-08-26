from __future__ import annotations

"""
FastAPI application for StereoSplatViewer.

Implements the backend MVP described in ExecPlan.md:
- POST /api/upload: store an image, start ml-sharp, return job id.
- GET /api/scene/{jobId}/{plyName}.ply: stream generated PLY.
- GET /api/scene/{jobId}/status: read persisted status.
- GET /api/scene/{jobId}/logs: return stdout/stderr (optional helper).
- GET /api/scene/{jobId}/metadata.json: return 360 metadata if present.
"""

import logging
import shutil
import threading
import uuid
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from .services import focal, mlsharp, mode360, sharp_pool, sky, sog, storage

LOGGER = logging.getLogger(__name__)

app = FastAPI(title="StereoSplatViewer Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def report_data_root_on_startup() -> None:
    """
    Keep the current scene across a restart, and say what is on disk.

    This used to delete everything on startup, which destroyed work that costs
    minutes to regenerate and was easy to trigger by accident while a phone was
    mid-session. Deleting was never what bounded the disk: every upload clears
    the data root first, so one scene is the steady state either way. Anything
    older than the newest is a leftover from an interrupted run, so it is pruned
    here, and whatever remains is written to the log rather than accumulating
    unannounced.
    """

    # uvicorn configures its own loggers and leaves the root logger at WARNING,
    # so a plain LOGGER.info() from this module is discarded and never reaches
    # the terminal. Borrow uvicorn's handlers so these messages are actually
    # seen -- a report nobody receives is the same as no report.
    # Note it is "uvicorn" and not "uvicorn.error": the child logger carries the
    # level but the handler lives on the parent, so borrowing from the child
    # silently copies an empty list and changes nothing.
    source = logging.getLogger("uvicorn")
    if source.handlers and not LOGGER.handlers:
        LOGGER.handlers = source.handlers
        LOGGER.setLevel(source.level or logging.INFO)

    removed = storage.prune_to_latest()
    if removed:
        LOGGER.info("Removed %d leftover scene(s): %s", len(removed), ", ".join(removed))
    count, total = storage.data_root_summary()
    if count:
        LOGGER.info(
            "backend/.data holds %d scene(s), %.0f MB, at %s",
            count,
            total / 1_000_000,
            storage.DATA_ROOT,
        )
    else:
        LOGGER.info("backend/.data is empty")

    # Load the model now rather than when the first image arrives, but off the
    # startup path: the server answers immediately and the worker becomes warm
    # behind it, usually long before anyone has chosen a photograph. Waiting
    # here instead would hold up the whole app for the download on a first run.
    def warm() -> None:
        if sharp_pool.POOL.start():
            LOGGER.info("ml-sharp is warm on %s; scenes take about 3s each", sharp_pool.POOL.device)
        else:
            LOGGER.info("ml-sharp worker not available; each scene will start its own process")

    threading.Thread(target=warm, name="sharp-warmup", daemon=True).start()


@app.on_event("shutdown")
def stop_worker() -> None:
    sharp_pool.POOL.stop()


@app.get("/health")
def health() -> dict[str, str]:
    """
    Lightweight health endpoint to verify the server starts.
    """

    return {"status": "ok"}


def _persist_upload(job_id: str, upload: UploadFile) -> Path:
    filename = upload.filename or "input_image"
    target = storage.input_image_path(job_id, filename)
    with target.open("wb") as f:
        shutil.copyfileobj(upload.file, f)
    return target


# A scene never changes once it exists. Every upload clears the data root and
# takes a fresh job identifier, so a given URL under /api/scene/<jobId>/ names
# one set of bytes for as long as it names anything at all -- which is what
# `immutable` promises, and it is the difference between a phone that comes
# back from standby instantly and one that downloads eleven megabytes again.
#
# Without a directive the decision is left to the browser's own heuristics.
# Chrome kept the file; iOS Safari, where this matters most, is conservative
# about holding something that large on a guess.
_FOREVER = "public, max-age=31536000, immutable"

# And its opposite, for the handful of answers that are about right now. The
# viewer polls the first of these to notice a new scene, so caching it would
# freeze the page on whatever was current when it was first asked.
_NEVER = "no-store"


def _compress_for_the_wire(job_id: str) -> None:
    """
    Make the small copy a phone should download, once the scene is final.

    Deliberately here and not where each PLY is written. A 360 job writes seven
    of them -- six cube faces, then the merged panorama -- and compressing at
    that level ran the converter six times and left behind whichever face
    happened to be last, unrotated, under the name the viewer asks for. The
    scene is only finished once, so it is only compressed once, and the file
    compressed is the same one `latest_job` will serve.

    The status is written after this returns, so nothing is advertised as done
    until the bundle beside it is complete.
    """

    try:
        scene = storage.published_ply(job_id)
        if scene is None:
            return
        sog.convert(scene, storage.sog_path(job_id), storage.stdout_log_path(job_id))
    except Exception as exc:  # noqa: BLE001
        # The scene is finished; this is only the small copy of it. Letting
        # anything here escape would leave the job with no status written at
        # all, which reads to every caller as still running, for ever.
        LOGGER.warning("Could not compress the scene for %s: %s", job_id, exc)


def _start_job(job_id: str, input_path: Path, mlsharp_cli: str | None) -> None:
    if mode360.is_360_filename(input_path.name):
        storage.write_status(job_id, {"status": "running", "message": "360 processing started"})
        try:
            meta = mode360.process_equirectangular_job(
                job_id, input_path, input_path.parent, mlsharp_cli
            )
        except mode360.Mode360Error as exc:
            storage.write_status(job_id, {"status": "error", "message": str(exc)})
            return
        except Exception as exc:  # noqa: BLE001
            storage.write_status(job_id, {"status": "error", "message": f"360 failed: {exc}"})
            return
        # Six faces with no merge is not a finished scene: nothing can be
        # previewed, so say that in the status rather than reporting success.
        if meta.get("mode360", {}).get("mergedPly"):
            _compress_for_the_wire(job_id)
            storage.write_status(job_id, {"status": "done", "message": "360 scene merged"})
        else:
            storage.write_status(
                job_id,
                {
                    "status": "done",
                    "message": (
                        "360 faces generated but NOT merged - no splat-transform found; "
                        "nothing to preview"
                    ),
                },
            )
        return

    storage.write_status(job_id, {"status": "running", "message": "ml-sharp started"})
    job = mlsharp.MlSharpJob(
        job_id=job_id, input_image=input_path, workdir=input_path.parent, cli=mlsharp_cli
    )
    try:
        mlsharp.run_mlsharp(job)
    except mlsharp.MlSharpError as exc:
        storage.write_status(job_id, {"status": "error", "message": str(exc)})
        return
    _compress_for_the_wire(job_id)
    storage.write_status(job_id, {"status": "done", "message": "PLY generated"})


@app.get("/api/scene/latest")
async def latest_scene() -> JSONResponse:
    """The scene currently held, so the viewer page can be opened by its address.

    Without this a phone has to be given a job identifier, which means copying a
    hexadecimal string across by hand -- exactly the friction the viewer page
    exists to avoid.
    """
    latest = storage.latest_job()
    if latest is None:
        raise HTTPException(status_code=404, detail="no scene published yet")
    # Both are offered and each caller picks. The editor wants the PLY, which
    # is what its exports come from; the phone wants the small one.
    payload = {
        **latest,
        "plyUrl": f"/api/scene/{latest['jobId']}/{latest['name']}",
    }
    if storage.sog_path(latest["jobId"]).is_file():
        payload["sogUrl"] = f"/api/scene/{latest['jobId']}/scene.sog"
    return JSONResponse(payload, headers={"Cache-Control": _NEVER})


@app.post("/api/upload")
async def upload_image(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    mlsharp_cli: str | None = None,
    focal_length_35mm: float | None = Form(default=None),
    treat_sky: bool = Form(default=False),
) -> JSONResponse:
    try:
        storage.clear_data_root()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail="failed to clear cache") from exc
    job_id = uuid.uuid4().hex
    storage.write_status(job_id, {"status": "pending", "message": "upload received"})
    try:
        input_path = _persist_upload(job_id, file)
    except Exception as exc:  # noqa: BLE001
        storage.write_status(job_id, {"status": "error", "message": f"upload failed: {exc}"})
        raise HTTPException(status_code=400, detail="failed to store upload") from exc

    # SHARP reads the lens from EXIF and assumes 30 mm when there is none, which
    # sets the field of view the scene is unprojected through and therefore both
    # its shape and the distance it can comfortably be looked at from. Writing
    # the value in is the only way to tell the command-line tool.
    if focal.apply_focal_length(input_path, focal_length_35mm):
        LOGGER.info("Set the 35mm-equivalent focal length to %s mm", focal_length_35mm)

    # A flat blown-out sky gives the depth model nothing to measure, and a
    # quarter of it can end up at the subject's own distance. Treating it fixes
    # that where it happens and is mildly harmful where it does not, so it is
    # done only when asked for.
    sky_report = sky.describe(input_path)
    if treat_sky:
        sky_report["treated"] = sky.treat_sky(input_path)

    background_tasks.add_task(_start_job, job_id, input_path, mlsharp_cli)
    input_name = Path(file.filename or "").name
    stem = Path(input_name).stem if input_name else "scene"
    if input_name and mode360.is_360_filename(input_name):
        ply_name = "face_0.ply"
    else:
        ply_name = f"{stem}.ply" if stem else "scene.ply"
    ply_url = f"/api/scene/{job_id}/{ply_name}"
    status_url = f"/api/scene/{job_id}/status"
    logs_url = f"/api/scene/{job_id}/logs"
    meta_url = f"/api/scene/{job_id}/metadata.json" if input_name and mode360.is_360_filename(input_name) else None
    return JSONResponse(
        {
            "jobId": job_id,
            "sky": sky_report,
            "plyUrl": ply_url,
            "statusUrl": status_url,
            "logsUrl": logs_url,
            "metaUrl": meta_url,
        }
    )


@app.post("/api/cleanup")
def cleanup_cache() -> JSONResponse:
    storage.clear_data_root()
    return JSONResponse({"status": "ok"})


@app.get("/api/scene/{job_id}/status")
def get_status(job_id: str) -> JSONResponse:
    status = storage.read_status(job_id)
    if status is None:
        raise HTTPException(status_code=404, detail="job not found")
    return JSONResponse(status, headers={"Cache-Control": _NEVER})


@app.get("/api/scene/{job_id}/{ply_name}.ply")
def get_ply(job_id: str, ply_name: str) -> FileResponse:
    if Path(ply_name).name != ply_name:
        raise HTTPException(status_code=400, detail="invalid ply filename")
    ply_file = storage.job_dir(job_id) / f"{ply_name}.ply"
    if not ply_file.exists():
        status = storage.read_status(job_id)
        detail = "scene not ready"
        if status and status.get("status") == "error":
            detail = f"job failed: {status.get('message', '')}"
        raise HTTPException(status_code=404, detail=detail)
    return FileResponse(
        ply_file,
        media_type="application/octet-stream",
        headers={"Cache-Control": _FOREVER},
    )




@app.get("/api/scene/{job_id}/scene.sog")
def get_sog(job_id: str) -> FileResponse:
    """The compressed scene, which is what a phone should be downloading.

    About a sixth of the PLY. Absent when splat-transform could not be found or
    could not run, in which case the viewer falls back to the PLY by itself.
    """

    sog_file = storage.sog_path(job_id)
    if not sog_file.exists():
        raise HTTPException(status_code=404, detail="no compressed scene for this job")
    return FileResponse(
        sog_file,
        media_type="application/octet-stream",
        headers={"Cache-Control": _FOREVER},
    )


@app.get("/api/scene/{job_id}/logs")
def get_logs(job_id: str) -> JSONResponse:
    stdout_path = storage.stdout_log_path(job_id)
    stderr_path = storage.stderr_log_path(job_id)
    if not stdout_path.exists() and not stderr_path.exists():
        raise HTTPException(status_code=404, detail="logs not found")
    stdout_text = stdout_path.read_text(encoding="utf-8") if stdout_path.exists() else ""
    stderr_text = stderr_path.read_text(encoding="utf-8") if stderr_path.exists() else ""
    return JSONResponse(
        {"stdout": stdout_text, "stderr": stderr_text},
        headers={"Cache-Control": _NEVER},
    )


@app.get("/api/scene/{job_id}/metadata.json")
def get_metadata(job_id: str) -> FileResponse:
    metadata_path = storage.metadata_path(job_id)
    if not metadata_path.exists():
        raise HTTPException(status_code=404, detail="metadata not found")
    return FileResponse(
        metadata_path,
        media_type="application/json",
        headers={"Cache-Control": _FOREVER},
    )
