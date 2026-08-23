"""The blown-sky measurement, on images built to have a known answer.

The treatment itself is judged by what SHARP does with it, which needs a GPU and
several seconds, so it is not tested here. What is tested is the part that
decides whether to offer it: a flat white top must be recognised, and a bright
subject against a normal background must not be.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services import sky  # noqa: E402


def _write(tmp_path: Path, pixels: np.ndarray, name: str = "t.png") -> Path:
    path = tmp_path / name
    Image.fromarray(np.clip(pixels, 0, 255).astype(np.uint8)).save(path)
    return path


def test_flat_white_top_is_recognised(tmp_path: Path) -> None:
    im = np.full((200, 150, 3), 60.0)
    im[:70] = 255.0  # a third of the frame, flat, reaching the top edge
    report = sky.describe(_write(tmp_path, im))
    assert report["looksBlownOut"] is True
    assert report["topEdgeFraction"] == pytest.approx(1.0)
    assert report["textureInBlown"] < sky.MAX_TEXTURE_STD


def test_a_bright_subject_is_left_alone(tmp_path: Path) -> None:
    # White in the middle of the frame, touching no edge: a dress, not a sky.
    im = np.full((200, 150, 3), 60.0)
    im[80:150, 40:110] = 255.0
    report = sky.describe(_write(tmp_path, im))
    assert report["looksBlownOut"] is False
    assert report["topEdgeFraction"] == 0.0


def test_a_bright_but_textured_sky_is_left_alone(tmp_path: Path) -> None:
    # Bright enough to be blown, but with plenty of variation, so the model
    # already has something to measure.
    rng = np.random.default_rng(0)
    im = np.full((200, 150, 3), 60.0)
    im[:70] = 250.0 + rng.normal(0, 8.0, (70, 150, 3))
    report = sky.describe(_write(tmp_path, im))
    assert report["textureInBlown"] > sky.MAX_TEXTURE_STD
    assert report["looksBlownOut"] is False


def test_treating_changes_only_the_blown_pixels(tmp_path: Path) -> None:
    im = np.full((200, 150, 3), 60.0)
    im[:70] = 255.0
    # A JPEG would blur the boundary, so use a format that keeps it exact.
    path = _write(tmp_path, im, "t.png")
    before = np.asarray(Image.open(path).convert("RGB"), dtype=float)

    assert sky.treat_sky(path) is True

    after = np.asarray(Image.open(path).convert("RGB"), dtype=float)
    mask = before.mean(axis=2) > sky.WHITE_LEVEL
    assert np.array_equal(after[~mask], before[~mask]), "the subject must not move"
    assert not np.array_equal(after[mask], before[mask]), "the sky must change"
    # Slight enough that a person would not see it.
    assert np.abs(after[mask] - before[mask]).mean() < 16.0


def test_an_image_with_no_white_is_untouched(tmp_path: Path) -> None:
    im = np.full((120, 120, 3), 100.0)
    path = _write(tmp_path, im)
    before = path.read_bytes()
    assert sky.treat_sky(path) is False
    assert path.read_bytes() == before
