"""
Equirectangular 360 ingestion helpers (stub).

This module only defines the interfaces and metadata for the future 360 pipeline:
- Detect *.360.jpg/png uploads.
- Define cube face orientations and overscan FOV handling.
- Provide a stub entry point for the equirectangular pipeline.
"""

from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import piexif
from PIL import Image
from plyfile import PlyData, PlyElement

from . import mlsharp, storage

DEFAULT_OVERSCAN_FOV_DEG = 105.0


@dataclass(frozen=True)
class CubeFaceSpec:
    """
    Defines a single cube face extraction with its orientation and FOV.
    """

    index: int
    name: str
    yaw_deg: float
    pitch_deg: float
    roll_deg: float
    fov_deg: float


@dataclass(frozen=True)
class CubeFaceExtraction:
    """
    Represents an extracted cube face image and the parameters used to create it.
    """

    face: CubeFaceSpec
    image_path: Path


class Mode360Error(Exception):
    """Raised when the 360 pipeline hits an unrecoverable error."""


FACE_SPECS: tuple[CubeFaceSpec, ...] = (
    CubeFaceSpec(
        index=0,
        name="+X",
        yaw_deg=90,
        pitch_deg=0,
        roll_deg=0,
        fov_deg=DEFAULT_OVERSCAN_FOV_DEG,
    ),
    CubeFaceSpec(
        index=1,
        name="-X",
        yaw_deg=-90,
        pitch_deg=0,
        roll_deg=0,
        fov_deg=DEFAULT_OVERSCAN_FOV_DEG,
    ),
    CubeFaceSpec(
        index=2,
        name="+Y",
        yaw_deg=0,
        pitch_deg=-90,
        roll_deg=0,
        fov_deg=DEFAULT_OVERSCAN_FOV_DEG,
    ),
    CubeFaceSpec(
        index=3,
        name="-Y",
        yaw_deg=0,
        pitch_deg=90,
        roll_deg=0,
        fov_deg=DEFAULT_OVERSCAN_FOV_DEG,
    ),
    CubeFaceSpec(
        index=4,
        name="+Z",
        yaw_deg=0,
        pitch_deg=0,
        roll_deg=0,
        fov_deg=DEFAULT_OVERSCAN_FOV_DEG,
    ),
    CubeFaceSpec(
        index=5,
        name="-Z",
        yaw_deg=180,
        pitch_deg=0,
        roll_deg=0,
        fov_deg=DEFAULT_OVERSCAN_FOV_DEG,
    ),
)


def is_360_filename(filename: str) -> bool:
    """
    Return True if the upload filename indicates a 360 equirectangular input.

    The convention is `*.360.jpg` or `*.360.png` (case-insensitive). `*.jpeg` is
    accepted as a pragmatic extension of the jpg pattern.
    """

    lowered = filename.lower()
    return lowered.endswith(".360.jpg") or lowered.endswith(".360.jpeg") or lowered.endswith(".360.png")


def extract_cube_faces(
    source: Path, workdir: Path, overscan_fov_deg: float = DEFAULT_OVERSCAN_FOV_DEG
) -> list[CubeFaceExtraction]:
    """
    Stub for equirectangular -> cube face extraction.

    Args:
        source: Path to the uploaded equirectangular image (2:1 aspect).
        workdir: Job directory where face_i.png and metadata.json will live.
        overscan_fov_deg: Per-face FOV (horizontal=vertical) including overscan to
            leave overlap near edges. Values outside 100..110 should be clamped by
            the caller before invoking this function.

    Returns:
        A list of six CubeFaceExtraction items, ordered by FACE_SPECS, each
        pointing to face_{index}.png under workdir.

    Raises:
        Mode360Error: always, until the extraction pipeline is implemented.
    """

    if not source.exists():
        raise Mode360Error(f"360 source image not found: {source}")

    clamped_fov = max(100.0, min(110.0, overscan_fov_deg))
    img = Image.open(source).convert("RGB")
    width, height = img.size
    if height == 0 or width == 0:
        raise Mode360Error("360 source image has invalid dimensions")
    if abs((width / height) - 2.0) > 0.1:
        raise Mode360Error(
            f"360 source image must be ~2:1 aspect ratio; got {width}x{height}"
        )

    face_size = height
    img_np = np.asarray(img)

    extractions: list[CubeFaceExtraction] = []
    for face in FACE_SPECS:
        face_out = workdir / f"face_{face.index}.jpg"
        face_img = _render_face(img_np, face_size, face, clamped_fov)
        _save_face_jpeg(face_out, face_img, clamped_fov, face_size)
        extractions.append(
            CubeFaceExtraction(
                face=CubeFaceSpec(
                    index=face.index,
                    name=face.name,
                    yaw_deg=face.yaw_deg,
                    pitch_deg=face.pitch_deg,
                    roll_deg=face.roll_deg,
                    fov_deg=clamped_fov,
                ),
                image_path=face_out,
            )
        )

    return extractions


def process_equirectangular_job(
    job_id: str, input_image: Path, workdir: Path, mlsharp_cli: str | None = None
) -> dict[str, Any]:
    """
    Stub entry point for the 360 pipeline.

    The intended flow is:
    1) Call extract_cube_faces(...) to emit face_i.png and metadata.json.
    2) Run ml-sharp per face to get face_i.ply.
    3) Apply known rotations from FACE_SPECS and merge (external CLI if present,
       otherwise fall back to multi-layer serving).

    For now this function simply raises to signal the missing implementation.
    """

    workdir.mkdir(parents=True, exist_ok=True)
    stdout_path = storage.stdout_log_path(job_id)
    stderr_path = storage.stderr_log_path(job_id)

    faces = extract_cube_faces(input_image, workdir, DEFAULT_OVERSCAN_FOV_DEG)
    face_outputs: list[dict[str, Any]] = []
    ply_paths: list[Path] = []

    for face in faces:
        job = mlsharp.MlSharpJob(
            job_id=job_id, input_image=face.image_path, workdir=workdir, cli=mlsharp_cli
        )
        with stdout_path.open("a", encoding="utf-8") as stdout_file:
            stdout_file.write(
                f"=== ml-sharp face {face.face.index} ({face.face.name}) ===\n"
            )
        mlsharp.run_mlsharp(job, stdout_path=stdout_path, stderr_path=stderr_path, append_logs=True)
        ply_path = workdir / f"{face.image_path.stem}.ply"
        _apply_face_rotation(ply_path, face.face)
        ply_paths.append(ply_path)
        face_outputs.append(
            {
                "index": face.face.index,
                "name": face.face.name,
                "yawDeg": face.face.yaw_deg,
                "pitchDeg": face.face.pitch_deg,
                "rollDeg": face.face.roll_deg,
                "fovDeg": face.face.fov_deg,
                "image": face.image_path.name,
                "ply": ply_path.name,
            }
        )

    _align_face_layers(ply_paths, faces, stdout_path)
    _apply_global_flip_and_center(ply_paths, stdout_path)

    merged_path = workdir / f"{input_image.stem}.ply"
    merged_ply = None
    merge_cli = _resolve_merge_cli()
    if merge_cli:
        if _merge_plys(merge_cli, merged_path, ply_paths, stdout_path, stderr_path):
            merged_ply = merged_path.name

    overscan_fov = faces[0].face.fov_deg if faces else DEFAULT_OVERSCAN_FOV_DEG
    metadata = {
        "mode360": {
            "enabled": True,
            "overscanFovDeg": overscan_fov,
            "faces": face_outputs,
            "mergedPly": merged_ply,
            "layers": [path.name for path in ply_paths],
        }
    }
    storage.metadata_path(job_id).write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return metadata


def _render_face(
    image_np: np.ndarray, face_size: int, face: CubeFaceSpec, fov_deg: float
) -> np.ndarray:
    height, width, _ = image_np.shape
    tan_half = math.tan(math.radians(fov_deg * 0.5))
    xs = (np.arange(face_size) + 0.5) / face_size * 2 - 1
    ys = (np.arange(face_size) + 0.5) / face_size * 2 - 1
    grid_x, grid_y = np.meshgrid(xs, ys)
    right, up, forward = _face_basis(face.name)
    dir_world = (
        forward[None, None, :]
        + (grid_x * tan_half)[..., None] * right[None, None, :]
        + (grid_y * tan_half)[..., None] * up[None, None, :]
    )
    norm = np.linalg.norm(dir_world, axis=-1, keepdims=True)
    dir_world = dir_world / np.maximum(norm, 1e-8)
    x = dir_world[..., 0]
    y = dir_world[..., 1]
    z = dir_world[..., 2]

    lon = np.arctan2(x, z)
    lat = np.arcsin(np.clip(y, -1.0, 1.0))

    u = (lon / (2 * math.pi) + 0.5) * width
    v = (0.5 - lat / math.pi) * height

    return _sample_bilinear(image_np, u, v)


def _save_face_jpeg(path: Path, image: np.ndarray, fov_deg: float, face_size: int) -> None:
    f_px = (face_size / 2.0) / math.tan(math.radians(fov_deg * 0.5))
    diag = math.sqrt(face_size**2 + face_size**2)
    f_35mm = f_px * math.sqrt(36**2 + 24**2) / diag
    exif_dict = {
        "Exif": {
            piexif.ExifIFD.FocalLengthIn35mmFilm: int(round(f_35mm)),
            piexif.ExifIFD.FocalLength: (int(round(f_35mm * 100)), 100),
        }
    }
    exif_bytes = piexif.dump(exif_dict)
    Image.fromarray(image).save(path, format="JPEG", quality=95, exif=exif_bytes)


def _sample_bilinear(image: np.ndarray, u: np.ndarray, v: np.ndarray) -> np.ndarray:
    height, width, _ = image.shape
    u = np.mod(u, width)
    v = np.clip(v, 0, height - 1)

    x0 = np.floor(u).astype(np.int32)
    y0 = np.floor(v).astype(np.int32)
    x1 = (x0 + 1) % width
    y1 = np.clip(y0 + 1, 0, height - 1)

    dx = (u - x0)[..., None]
    dy = (v - y0)[..., None]

    c00 = image[y0, x0]
    c10 = image[y0, x1]
    c01 = image[y1, x0]
    c11 = image[y1, x1]

    c0 = c00 * (1 - dx) + c10 * dx
    c1 = c01 * (1 - dx) + c11 * dx
    return (c0 * (1 - dy) + c1 * dy).astype(np.uint8)


def _rotation_matrix(yaw_deg: float, pitch_deg: float, roll_deg: float) -> np.ndarray:
    yaw = math.radians(yaw_deg)
    pitch = math.radians(pitch_deg)
    roll = math.radians(roll_deg)

    cy, sy = math.cos(yaw), math.sin(yaw)
    cp, sp = math.cos(pitch), math.sin(pitch)
    cr, sr = math.cos(roll), math.sin(roll)

    rot_yaw = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    rot_pitch = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]])
    rot_roll = np.array([[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]])

    return rot_roll @ rot_pitch @ rot_yaw


def _quat_from_matrix(rot: np.ndarray) -> np.ndarray:
    trace = np.trace(rot)
    if trace > 0:
        s = math.sqrt(trace + 1.0) * 2
        w = 0.25 * s
        x = (rot[2, 1] - rot[1, 2]) / s
        y = (rot[0, 2] - rot[2, 0]) / s
        z = (rot[1, 0] - rot[0, 1]) / s
    else:
        if rot[0, 0] > rot[1, 1] and rot[0, 0] > rot[2, 2]:
            s = math.sqrt(1.0 + rot[0, 0] - rot[1, 1] - rot[2, 2]) * 2
            w = (rot[2, 1] - rot[1, 2]) / s
            x = 0.25 * s
            y = (rot[0, 1] + rot[1, 0]) / s
            z = (rot[0, 2] + rot[2, 0]) / s
        elif rot[1, 1] > rot[2, 2]:
            s = math.sqrt(1.0 + rot[1, 1] - rot[0, 0] - rot[2, 2]) * 2
            w = (rot[0, 2] - rot[2, 0]) / s
            x = (rot[0, 1] + rot[1, 0]) / s
            y = 0.25 * s
            z = (rot[1, 2] + rot[2, 1]) / s
        else:
            s = math.sqrt(1.0 + rot[2, 2] - rot[0, 0] - rot[1, 1]) * 2
            w = (rot[1, 0] - rot[0, 1]) / s
            x = (rot[0, 2] + rot[2, 0]) / s
            y = (rot[1, 2] + rot[2, 1]) / s
            z = 0.25 * s

    return np.array([w, x, y, z], dtype=np.float32)


def _quat_multiply(q1: np.ndarray, q2: np.ndarray) -> np.ndarray:
    w1, x1, y1, z1 = q1.T
    w2, x2, y2, z2 = q2.T
    w = w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2
    x = w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2
    y = w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2
    z = w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2
    return np.stack([w, x, y, z], axis=1)


def _matrix_from_quat(quat: np.ndarray) -> np.ndarray:
    w = quat[:, 0]
    x = quat[:, 1]
    y = quat[:, 2]
    z = quat[:, 3]
    n = w * w + x * x + y * y + z * z
    n = np.where(n == 0, 1.0, n)
    s = 2.0 / n
    wx = s * w * x
    wy = s * w * y
    wz = s * w * z
    xx = s * x * x
    xy = s * x * y
    xz = s * x * z
    yy = s * y * y
    yz = s * y * z
    zz = s * z * z
    m00 = 1.0 - (yy + zz)
    m01 = xy - wz
    m02 = xz + wy
    m10 = xy + wz
    m11 = 1.0 - (xx + zz)
    m12 = yz - wx
    m20 = xz - wy
    m21 = yz + wx
    m22 = 1.0 - (xx + yy)
    return np.stack(
        [
            np.stack([m00, m01, m02], axis=1),
            np.stack([m10, m11, m12], axis=1),
            np.stack([m20, m21, m22], axis=1),
        ],
        axis=1,
    )


def _apply_face_rotation(ply_path: Path, face: CubeFaceSpec) -> None:
    ply = PlyData.read(ply_path)
    vertex = ply["vertex"].data.copy()
    right, up, forward = _face_basis(face.name)
    rot = np.stack([right, up, forward], axis=1)

    positions = np.stack([vertex["x"], vertex["y"], vertex["z"]], axis=1)
    positions = positions @ rot.T
    vertex["x"] = positions[:, 0]
    vertex["y"] = positions[:, 1]
    vertex["z"] = positions[:, 2]

    if all(key in vertex.dtype.names for key in ("rot_0", "rot_1", "rot_2", "rot_3")):
        q_existing = np.stack(
            [vertex["rot_0"], vertex["rot_1"], vertex["rot_2"], vertex["rot_3"]], axis=1
        )
        q_rot = _quat_from_matrix(rot).reshape(1, 4)
        q_new = _quat_multiply(q_rot.repeat(q_existing.shape[0], axis=0), q_existing)
        vertex["rot_0"] = q_new[:, 0]
        vertex["rot_1"] = q_new[:, 1]
        vertex["rot_2"] = q_new[:, 2]
        vertex["rot_3"] = q_new[:, 3]

    elements = []
    for element in ply.elements:
        if element.name == "vertex":
            elements.append(PlyElement.describe(vertex, "vertex"))
        else:
            elements.append(element)
    updated = PlyData(elements, text=ply.text, byte_order=ply.byte_order)
    updated.write(ply_path)


def _align_face_layers(
    ply_paths: list[Path],
    faces: list[CubeFaceExtraction],
    stdout_path: Path,
) -> None:
    if len(ply_paths) != len(faces):
        return
    face_map = {face.face.name: (face.face, path) for face, path in zip(faces, ply_paths)}
    if "+Z" not in face_map:
        return

    pairs = [
        ("+X", "+Z"),
        ("-X", "+Z"),
        ("+Y", "+Z"),
        ("-Y", "+Z"),
        ("-Z", "+X"),
    ]

    with stdout_path.open("a", encoding="utf-8") as stdout_file:
        stdout_file.write("=== 360 overlap alignment ===\n")
        for name, ref_name in pairs:
            if name not in face_map or ref_name not in face_map:
                continue
            face_spec, path = face_map[name]
            ref_spec, ref_path = face_map[ref_name]
            positions = _load_positions(path)
            ref_positions = _load_positions(ref_path)
            forward = _face_forward(face_spec)
            ref_forward = _face_forward(ref_spec)
            cos_half = math.cos(math.radians(face_spec.fov_deg * 0.5))
            sample_a = _sample_overlap(positions, forward, ref_forward, cos_half)
            sample_b = _sample_overlap(ref_positions, ref_forward, forward, cos_half)
            if sample_a is None or sample_b is None:
                stdout_file.write(f"skip alignment {name} -> {ref_name}\n")
                continue
            med_a = np.median(sample_a)
            med_b = np.median(sample_b)
            if not np.isfinite(med_a) or not np.isfinite(med_b) or med_a <= 0:
                stdout_file.write(f"skip alignment {name} -> {ref_name}\n")
                continue
            scale = float(np.clip(med_b / med_a, 0.5, 2.0))
            offset = med_b - scale * med_a
            _apply_normal_adjust(path, forward, scale, offset)
            stdout_file.write(
                f"align {name} -> {ref_name}: scale={scale:.3f}, offset={offset:.3f}\n"
            )


def _load_positions(ply_path: Path) -> np.ndarray:
    ply = PlyData.read(ply_path)
    vertex = ply["vertex"].data
    return np.stack([vertex["x"], vertex["y"], vertex["z"]], axis=1).astype(np.float32)


def _face_forward(face: CubeFaceSpec) -> np.ndarray:
    _, _, forward = _face_basis(face.name)
    norm = np.linalg.norm(forward)
    if norm == 0:
        return forward
    return forward / norm


def _face_basis(name: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    if name == "+X":
        right = np.array([0.0, 0.0, -1.0], dtype=np.float32)
        up = np.array([0.0, -1.0, 0.0], dtype=np.float32)
        forward = np.array([1.0, 0.0, 0.0], dtype=np.float32)
    elif name == "-X":
        right = np.array([0.0, 0.0, 1.0], dtype=np.float32)
        up = np.array([0.0, -1.0, 0.0], dtype=np.float32)
        forward = np.array([-1.0, 0.0, 0.0], dtype=np.float32)
    elif name == "+Y":
        right = np.array([1.0, 0.0, 0.0], dtype=np.float32)
        up = np.array([0.0, 0.0, -1.0], dtype=np.float32)
        forward = np.array([0.0, 1.0, 0.0], dtype=np.float32)
    elif name == "-Y":
        right = np.array([1.0, 0.0, 0.0], dtype=np.float32)
        up = np.array([0.0, 0.0, 1.0], dtype=np.float32)
        forward = np.array([0.0, -1.0, 0.0], dtype=np.float32)
    elif name == "-Z":
        right = np.array([-1.0, 0.0, 0.0], dtype=np.float32)
        up = np.array([0.0, -1.0, 0.0], dtype=np.float32)
        forward = np.array([0.0, 0.0, -1.0], dtype=np.float32)
    else:  # +Z
        right = np.array([1.0, 0.0, 0.0], dtype=np.float32)
        up = np.array([0.0, -1.0, 0.0], dtype=np.float32)
        forward = np.array([0.0, 0.0, 1.0], dtype=np.float32)
    return right, up, forward


def _sample_overlap(
    positions: np.ndarray,
    face_forward: np.ndarray,
    other_forward: np.ndarray,
    cos_half: float,
    max_samples: int = 50000,
) -> np.ndarray | None:
    if positions.size == 0:
        return None
    norms = np.linalg.norm(positions, axis=1, keepdims=True)
    norms = np.maximum(norms, 1e-6)
    dirs = positions / norms
    mask = (dirs @ face_forward) >= cos_half
    mask &= (dirs @ other_forward) >= cos_half
    idx = np.flatnonzero(mask)
    if idx.size == 0:
        return None
    if idx.size > max_samples:
        idx = np.random.choice(idx, size=max_samples, replace=False)
    proj = positions[idx] @ face_forward
    return proj[np.isfinite(proj)]


def _apply_normal_adjust(
    ply_path: Path, forward: np.ndarray, scale: float, offset: float
) -> None:
    ply = PlyData.read(ply_path)
    vertex = ply["vertex"].data.copy()
    positions = np.stack([vertex["x"], vertex["y"], vertex["z"]], axis=1)
    proj = positions @ forward
    positions += (scale - 1.0) * proj[:, None] * forward[None, :]
    positions += offset * forward[None, :]
    vertex["x"] = positions[:, 0]
    vertex["y"] = positions[:, 1]
    vertex["z"] = positions[:, 2]
    elements = []
    for element in ply.elements:
        if element.name == "vertex":
            elements.append(PlyElement.describe(vertex, "vertex"))
        else:
            elements.append(element)
    updated = PlyData(elements, text=ply.text, byte_order=ply.byte_order)
    updated.write(ply_path)


def _apply_global_flip_and_center(ply_paths: list[Path], stdout_path: Path) -> None:
    if not ply_paths:
        return
    center = _compute_global_center(ply_paths)
    flip = np.diag([1.0, -1.0, 1.0]).astype(np.float32)
    with stdout_path.open("a", encoding="utf-8") as stdout_file:
        stdout_file.write(
            "=== 360 global normalize ===\n"
            f"center={center[0]:.3f},{center[1]:.3f},{center[2]:.3f}\n"
        )
    for path in ply_paths:
        _apply_transform(path, flip, -center)


def _compute_global_center(ply_paths: list[Path], max_samples: int = 200000) -> np.ndarray:
    mins = np.array([np.inf, np.inf, np.inf], dtype=np.float32)
    maxs = np.array([-np.inf, -np.inf, -np.inf], dtype=np.float32)
    for path in ply_paths:
        positions = _load_positions(path)
        if positions.shape[0] > max_samples:
            idx = np.random.choice(positions.shape[0], size=max_samples, replace=False)
            positions = positions[idx]
        mins = np.minimum(mins, positions.min(axis=0))
        maxs = np.maximum(maxs, positions.max(axis=0))
    return (mins + maxs) * 0.5


def _apply_transform(ply_path: Path, rot: np.ndarray, offset: np.ndarray) -> None:
    ply = PlyData.read(ply_path)
    vertex = ply["vertex"].data.copy()
    positions = np.stack([vertex["x"], vertex["y"], vertex["z"]], axis=1)
    positions = positions @ rot.T + offset
    vertex["x"] = positions[:, 0]
    vertex["y"] = positions[:, 1]
    vertex["z"] = positions[:, 2]

    det = float(np.linalg.det(rot))
    if det > 0 and all(
        key in vertex.dtype.names for key in ("rot_0", "rot_1", "rot_2", "rot_3")
    ):
        q_existing = np.stack(
            [vertex["rot_0"], vertex["rot_1"], vertex["rot_2"], vertex["rot_3"]], axis=1
        )
        r_existing = _matrix_from_quat(q_existing)
        r_new = rot @ r_existing @ rot.T
        q_new = _quat_from_matrix(r_new)
        vertex["rot_0"] = q_new[:, 0]
        vertex["rot_1"] = q_new[:, 1]
        vertex["rot_2"] = q_new[:, 2]
        vertex["rot_3"] = q_new[:, 3]

    elements = []
    for element in ply.elements:
        if element.name == "vertex":
            elements.append(PlyElement.describe(vertex, "vertex"))
        else:
            elements.append(element)
    updated = PlyData(elements, text=ply.text, byte_order=ply.byte_order)
    updated.write(ply_path)


def _resolve_merge_cli() -> str | None:
    env_cli = os.environ.get("SPLAT_MERGE_CLI")
    if env_cli:
        return env_cli
    return shutil.which("splat-transform")


def _merge_plys(
    cli: str,
    output_path: Path,
    inputs: list[Path],
    stdout_path: Path,
    stderr_path: Path,
) -> bool:
    cmd = [cli, "-w"] + [str(path) for path in inputs] + [str(output_path)]
    try:
        with stdout_path.open("a", encoding="utf-8") as stdout_file, stderr_path.open(
            "a", encoding="utf-8"
        ) as stderr_file:
            stdout_file.write("=== merge 360 ply ===\n")
            result = subprocess.run(
                cmd,
                stdout=stdout_file,
                stderr=stderr_file,
                check=False,
            )
    except FileNotFoundError:
        return False
    return result.returncode == 0 and output_path.exists()
