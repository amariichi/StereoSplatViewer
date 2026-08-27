from __future__ import annotations

"""Read capture-camera projection hints embedded in SHARP PLY files."""

from functools import lru_cache
import math
from pathlib import Path

from plyfile import PlyData


def _element_values(ply: PlyData, element_name: str, property_name: str) -> list[float]:
    element = ply[element_name]
    names = element.data.dtype.names or ()
    name = property_name if property_name in names else (names[0] if names else None)
    if name is None:
        return []
    return [float(value) for value in element.data[name].reshape(-1)]


@lru_cache(maxsize=16)
def _read_projection(path_text: str, mtime_ns: int, size: int) -> dict[str, float] | None:
    # mtime and size are intentionally part of the cache key. Relensing may
    # rebuild a job in place, and a path-only cache would then retain the old
    # camera indefinitely.
    del mtime_ns, size
    try:
        ply = PlyData.read(path_text, mmap="c")
        intrinsic = _element_values(ply, "intrinsic", "intrinsic")
        image_size = _element_values(ply, "image_size", "image_size")
    except (KeyError, OSError, TypeError, ValueError):
        return None

    if len(intrinsic) < 9 or len(image_size) < 2:
        return None
    fx, fy = intrinsic[0], intrinsic[4]
    width, height = image_size[0], image_size[1]
    if not all(math.isfinite(value) and value > 0 for value in (fx, fy, width, height)):
        return None

    tangent = height / (2 * fy)
    aspect = width / height
    if not all(math.isfinite(value) and value > 0 for value in (tangent, aspect)):
        return None
    return {
        "captureTangent": tangent,
        "captureAspect": aspect,
    }


def read_capture_projection(path: Path | None) -> dict[str, float] | None:
    """Return vertical half-FOV tangent and image aspect, or ``None`` safely."""

    if path is None:
        return None
    try:
        stat = path.stat()
    except OSError:
        return None
    return _read_projection(str(path), stat.st_mtime_ns, stat.st_size)
