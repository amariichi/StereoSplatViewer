"""Giving a blown-out sky something for the depth model to look at.

A single-image depth model has to infer distance from what it can see. Where a
photograph is overexposed to pure white it can see nothing at all, and the model
has to guess. On one measured photograph the top tenth of the frame was 95 per
cent pure white with a standard deviation of 0.58 levels out of 255 -- flat to
the point of being featureless -- and a quarter of the gaussians produced for
that sky were placed at the subject's own distance rather than far away. In the
scene that appears as a wall of white standing around the head.

The remedy is small: a gentle vertical ramp and a little noise, applied only
inside the blown region. Measured on that photograph, the proportion of sky
placed at the subject's distance fell from 25.7 per cent to 2.9 per cent, while
the subject's own depth was unchanged to two decimal places. Below about eight
levels of ramp the effect fades; above it there is nothing further to gain, so
that is what is used, and at roughly three per cent of the range it is not
visible in the photograph itself.

This is a guess about what the white means, and it is not always the right one,
so it is never applied on its own initiative. Measured on two photographs:

    0007-14, sky flat to 1.15 levels   25.8% of sky at the subject's distance
                                        2.9% after treatment -- the fault fixed
    0007-12, sky flat to 1.81 levels    2.4% before, 2.7% after -- no fault to
                                        fix, and the sky's median distance fell
                                        from 23.95 to 3.00, which is worse

The direction of the ramp was tested too. On 0007-14 a ramp darkening upward
gave 2.9 per cent and darkening downward 20.9, so the direction matters where
the treatment helps; on 0007-12 both directions collapsed the sky equally, so
the harm there is from touching the image at all rather than from which way
round. Re-encoding was ruled out separately: saving the same pixels again as
JPEG moved the sky's median from 17.19 to 17.27, and as PNG not at all.

Two photographs are not enough to tell in advance which case a new one is, so
the caller asks for this explicitly and looks at the result. What is offered
here is the measurement -- `describe` -- and the treatment, kept apart.
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np
from PIL import Image

LOGGER = logging.getLogger(__name__)

# Above this a pixel counts as blown out. Not 255, because JPEG rounding and a
# little chroma noise leave genuinely clipped pixels a shade below it.
WHITE_LEVEL = 245.0

# How flat the blown region has to be before it is worth treating. A bright but
# textured area -- a white wall in sunlight, a sunlit sand beach -- already
# gives the model something to work with.
MAX_TEXTURE_STD = 2.5

# How much of the frame the blown region must cover. Below this there is little
# to gain and more chance the white is part of the subject.
MIN_AREA_FRACTION = 0.02

# How much of the top edge it must touch. A sky is open to the top of the frame;
# a highlight on a shoulder is not.
MIN_TOP_EDGE_FRACTION = 0.20

# The treatment. Eight levels of ramp is where the measured effect saturates.
RAMP_LEVELS = 8.0
NOISE_LEVELS = 2.0


def _blown_mask(luminance: np.ndarray) -> np.ndarray:
    return luminance > WHITE_LEVEL


def _reaches_top(mask: np.ndarray) -> float:
    """What fraction of the top row of the image is blown out."""

    return float(mask[0].mean()) if mask.size else 0.0


def describe(image_path: Path) -> dict[str, float | bool]:
    """What treating this image would involve, without changing anything."""

    with Image.open(image_path) as handle:
        rgb = np.asarray(handle.convert("RGB"), dtype=np.float32)

    luminance = rgb.mean(axis=2)
    mask = _blown_mask(luminance)
    area = float(mask.mean())
    top = _reaches_top(mask)
    texture = float(luminance[mask].std()) if mask.any() else 0.0

    return {
        "blownFraction": area,
        "topEdgeFraction": top,
        "textureInBlown": texture,
        # Whether this photograph looks like the case where treating helps. It
        # is a suggestion for a person to accept or ignore, not a decision:
        # the thresholds come from two photographs, which is enough to tell the
        # two apart and not enough to predict a third.
        "looksBlownOut": bool(
            area >= MIN_AREA_FRACTION
            and top >= MIN_TOP_EDGE_FRACTION
            and texture <= MAX_TEXTURE_STD
        ),
    }


def treat_sky(image_path: Path, seed: int = 0) -> bool:
    """
    Add a faint ramp and noise to a flat blown-out sky, in place.

    Returns True when the image was changed. Returns False, having done nothing,
    when the image has no such region -- which is the common case and not a
    failure.
    """

    try:
        with Image.open(image_path) as handle:
            exif = handle.info.get("exif")
            icc = handle.info.get("icc_profile")
            rgb = np.asarray(handle.convert("RGB"), dtype=np.float32)
    except OSError as exc:
        LOGGER.warning("Could not read %s to check for a blown sky: %s", image_path, exc)
        return False

    luminance = rgb.mean(axis=2)
    mask = _blown_mask(luminance)
    if not mask.any():
        return False
    area = float(mask.mean())
    texture = float(luminance[mask].std())

    height, width, _ = rgb.shape
    # Darkening upward. Measured on the photograph this was built for, that
    # direction left 2.9 per cent of the sky at the subject's distance and the
    # other 20.9, so it is not an arbitrary choice.
    ramp = (1.0 - np.linspace(0.0, 1.0, height, dtype=np.float32))[:, None, None] * RAMP_LEVELS
    noise = np.random.default_rng(seed).normal(0.0, NOISE_LEVELS, rgb.shape).astype(np.float32)
    treated = rgb - (ramp + noise) * mask[:, :, None]

    out = Image.fromarray(np.clip(treated, 0, 255).astype(np.uint8))
    save_args: dict[str, object] = {"quality": 96}
    if exif:
        save_args["exif"] = exif
    if icc:
        save_args["icc_profile"] = icc
    try:
        out.save(image_path, **save_args)
    except OSError as exc:
        LOGGER.warning("Could not write the treated image %s: %s", image_path, exc)
        return False

    LOGGER.info(
        "Treated a flat blown-out sky in %s: %.1f%% of the frame, texture %.2f",
        image_path.name, area * 100, texture,
    )
    return True
