from pathlib import Path

import numpy as np
from plyfile import PlyData, PlyElement

from app.services.ply_camera import read_capture_projection


def _write_camera_ply(path: Path, *, fx: float = 1200, fy: float = 1000) -> None:
    intrinsic = np.array(
        [(fx,), (0,), (800,), (0,), (fy,), (600,), (0,), (0,), (1,)],
        dtype=[("intrinsic", "f4")],
    )
    image_size = np.array([(1600,), (1200,)], dtype=[("image_size", "i4")])
    PlyData([
        PlyElement.describe(intrinsic, "intrinsic"),
        PlyElement.describe(image_size, "image_size"),
    ]).write(path)


def test_reads_vertical_tangent_and_capture_aspect(tmp_path: Path) -> None:
    path = tmp_path / "scene.ply"
    _write_camera_ply(path)

    projection = read_capture_projection(path)

    assert projection is not None
    assert projection["captureTangent"] == 0.6
    assert projection["captureAspect"] == 4 / 3


def test_missing_or_incomplete_metadata_falls_back_safely(tmp_path: Path) -> None:
    missing = tmp_path / "missing.ply"
    assert read_capture_projection(missing) is None

    incomplete = tmp_path / "incomplete.ply"
    vertices = np.array([(0.0, 0.0, -1.0)], dtype=[("x", "f4"), ("y", "f4"), ("z", "f4")])
    PlyData([PlyElement.describe(vertices, "vertex")]).write(incomplete)
    assert read_capture_projection(incomplete) is None
