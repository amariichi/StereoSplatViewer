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

from .services import focal, mlsharp, mode360, ply_camera, sharp_pool, sky, sog, storage

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
    lens = storage.read_lens(latest["jobId"])
    # The bytes at these URLs are cached for a year as immutable, which is true
    # of any one URL and false of a job that can be built again through a
    # different lens. The revision makes the second build a different URL, so
    # what is cached stays valid and what is asked for is the new scene.
    stamp = f"?v={lens['revision']}" if lens.get("revision") else ""
    payload = {
        **latest,
        "plyUrl": f"/api/scene/{latest['jobId']}/{latest['name']}{stamp}",
    }
    projection = ply_camera.read_capture_projection(storage.published_ply(latest["jobId"]))
    if projection:
        payload["projection"] = projection
    if storage.sog_path(latest["jobId"]).is_file():
        payload["sogUrl"] = f"/api/scene/{latest['jobId']}/scene.sog{stamp}"
    # So that a viewer which did not make this scene can still tell whether the
    # lens was known, and offer to replace it when it was not.
    payload.update(lens)
    # A scene from before this was recorded has no answer either way, and
    # "no lens" would be a guess that offers to rebuild everything.
    payload["lensRecorded"] = lens.get("recorded", False)
    return JSONResponse(payload, headers={"Cache-Control": _NEVER})


@app.post("/api/upload")
async def upload_image(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    mlsharp_cli: str | None = None,
    focal_length_35mm: float | None = Form(default=None),
    treat_sky: bool = Form(default=False),
    hold_for_lens: bool = Form(default=False),
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
    # Read before writing: this is what the file itself said, and it is what
    # decides whether the viewer has to ask anybody anything.
    focal_from_exif = focal.read_focal_mm(input_path)
    wrote = focal.apply_focal_length(input_path, focal_length_35mm)
    if wrote:
        LOGGER.info("Set the 35mm-equivalent focal length to %s mm", focal_length_35mm)
    # What SHARP will actually read, which is not always what was asked for: an
    # override that could not be written is not in the file, and a photograph
    # that says nothing gets SHARP's own 30 mm rather than no lens at all.
    storage.write_lens(
        job_id,
        focal_from_exif,
        focal.effective_focal_mm(input_path, focal_from_exif, focal_length_35mm, wrote),
        source=input_path.name,
    )

    # A flat blown-out sky gives the depth model nothing to measure, and a
    # quarter of it can end up at the subject's own distance. Treating it fixes
    # that where it happens and is mildly harmful where it does not, so it is
    # done only when asked for.
    sky_report = sky.describe(input_path)
    if treat_sky:
        sky_report["treated"] = sky.treat_sky(input_path)

    # Asked for by a caller that would rather supply the lens than guess and
    # build twice. A photograph that records its own is started straight away;
    # one that does not is left standing until somebody answers, because the
    # 30 mm SHARP would otherwise assume is wrong often enough that building on
    # it means building again -- twenty seconds and eleven megabytes, twice.
    needs_lens = hold_for_lens and focal_from_exif is None and focal_length_35mm is None
    if needs_lens:
        storage.write_status(
            job_id, {"status": "pending", "message": "waiting for the lens"})
    else:
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
            # Null means the photograph did not say, and SHARP fell back to its
            # 30 mm default -- a guess, and the reason the viewer offers to
            # replace it.
            "focalFromExif": focal_from_exif,
            "focalUsed": focal.clamp_focal_mm(focal_length_35mm) or focal_from_exif,
            # True means nothing is running yet and this job is waiting to be
            # told which lens to use. Post one to `relens` to start it.
            "needsLens": needs_lens,
        }
    )


@app.post("/api/scene/{job_id}/relens")
def relens(job_id: str, background_tasks: BackgroundTasks,
           focal_length_35mm: float = Form(...)) -> JSONResponse:
    """
    Build this job's scene through a given lens.

    Used two ways, and they are the same operation. A job held at upload because
    its photograph did not record a lens is started by this. A job already built
    is built again by it.

    Only worth having because the lens cannot be judged before the scene
    exists. A photograph that does not record its own is unprojected through
    SHARP's 30 mm default, and if that is wrong the depth is wrong with it --
    visibly, as a scene pressed flat or drawn out. There is no way to know
    except to look, so there has to be a way to look again.

    The source image is still in the job directory, so this reuses it rather
    than asking for the picture a second time. The job is replaced in place:
    every upload clears the data root, so one scene at a time is the shape the
    rest of this is built around, and the previous lens is not kept. Finding
    the right one means trying it, not collecting them.
    """

    directory = storage.job_dir(job_id)
    if not directory.exists():
        raise HTTPException(status_code=404, detail="no such scene")

    # One build at a time. Two of these at once would rewrite the same source's
    # EXIF, the same logs and the same outputs, and whichever finished last
    # would not necessarily be the lens recorded last.
    status = storage.read_status(job_id) or {}
    if status.get("status") == "running":
        raise HTTPException(status_code=409, detail="this scene is already being built")

    lens = storage.read_lens(job_id)
    recorded = lens.get("source")
    source = directory / Path(str(recorded)).name if recorded else None
    if source is None or not source.is_file():
        # Guessing is what made this dangerous: a finished 360 job is full of
        # generated cube faces, and the first image by name is one of them.
        raise HTTPException(status_code=409, detail="the source image is no longer here")

    # A panorama is six reconstructions merged, not one, and rebuilding it as a
    # single image would quietly replace it with a flat piece of itself.
    if mode360.is_360_filename(source.name):
        raise HTTPException(
            status_code=409, detail="a 360 scene cannot be rebuilt through a different lens")

    value = focal.clamp_focal_mm(focal_length_35mm)
    if value is None:
        raise HTTPException(status_code=400, detail="that is not a usable focal length")
    if not focal.apply_focal_length(source, value):
        raise HTTPException(status_code=500, detail="could not set the focal length")

    # Marked running before anything else, so `latest` stops publishing the old
    # scene the moment the new one is asked for rather than serving it until
    # the replacement lands.
    # The original answer is preserved: it is what decides whether the offer is
    # made at all, and it must not be overwritten by an answer given since.
    storage.write_lens(job_id, lens.get("fromExif"), value, source=source.name)
    storage.write_status(job_id, {"status": "running", "message": f"rebuilding at {value:.0f} mm"})
    background_tasks.add_task(_start_job, job_id, source, None)
    return JSONResponse({
        "jobId": job_id,
        "focalUsed": value,
        "statusUrl": f"/api/scene/{job_id}/status",
    })


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


@app.get("/api/scene/{job_id}/lens")
def get_lens(job_id: str) -> JSONResponse:
    """
    What this scene's photograph said about its lens, and what was used.

    `latest` carries the same two numbers, but a viewer opened on an address
    that names a scene never asks `latest` -- that is the whole point of naming
    one -- and would otherwise never learn that the lens was a guess.

    `known` is the question actually being asked: was there a value in the file,
    or did SHARP fall back to 30 mm. It is reported separately from `fromExif`
    because a scene made before any of this was recorded has neither, and
    guessing "no lens" for those would offer to rebuild every scene ever made.
    """

    if not storage.job_dir(job_id).exists():
        raise HTTPException(status_code=404, detail="no such scene")
    return JSONResponse(storage.read_lens(job_id), headers={"Cache-Control": _NEVER})


@app.get("/api/scene/{job_id}/projection")
def get_projection(job_id: str) -> JSONResponse:
    """Capture projection embedded in the full PLY, also usable by SOG clients."""

    projection = ply_camera.read_capture_projection(storage.published_ply(job_id))
    if projection is None:
        raise HTTPException(status_code=404, detail="no capture projection for this scene")
    # Relensing rebuilds this path in place under the same job id. Keep the
    # tiny answer fresh instead of retaining the old intrinsics for a year.
    return JSONResponse(projection, headers={"Cache-Control": _NEVER})


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
