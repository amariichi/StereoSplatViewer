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

import shutil
import uuid
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from .services import mlsharp, mode360, storage

app = FastAPI(title="StereoSplatViewer Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def clear_cache_on_startup() -> None:
    storage.clear_data_root()


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


def _start_job(job_id: str, input_path: Path, mlsharp_cli: str | None) -> None:
    if mode360.is_360_filename(input_path.name):
        storage.write_status(job_id, {"status": "running", "message": "360 processing started"})
        try:
            mode360.process_equirectangular_job(job_id, input_path, input_path.parent, mlsharp_cli)
        except mode360.Mode360Error as exc:
            storage.write_status(job_id, {"status": "error", "message": str(exc)})
            return
        except Exception as exc:  # noqa: BLE001
            storage.write_status(job_id, {"status": "error", "message": f"360 failed: {exc}"})
            return
        storage.write_status(job_id, {"status": "done", "message": "360 PLYs generated"})
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
    storage.write_status(job_id, {"status": "done", "message": "PLY generated"})


@app.post("/api/upload")
async def upload_image(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    mlsharp_cli: str | None = None,
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
    return JSONResponse(status)


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
    return FileResponse(ply_file, media_type="application/octet-stream")




@app.get("/api/scene/{job_id}/logs")
def get_logs(job_id: str) -> JSONResponse:
    stdout_path = storage.stdout_log_path(job_id)
    stderr_path = storage.stderr_log_path(job_id)
    if not stdout_path.exists() and not stderr_path.exists():
        raise HTTPException(status_code=404, detail="logs not found")
    stdout_text = stdout_path.read_text(encoding="utf-8") if stdout_path.exists() else ""
    stderr_text = stderr_path.read_text(encoding="utf-8") if stderr_path.exists() else ""
    return JSONResponse({"stdout": stdout_text, "stderr": stderr_text})


@app.get("/api/scene/{job_id}/metadata.json")
def get_metadata(job_id: str) -> FileResponse:
    metadata_path = storage.metadata_path(job_id)
    if not metadata_path.exists():
        raise HTTPException(status_code=404, detail="metadata not found")
    return FileResponse(metadata_path, media_type="application/json")
