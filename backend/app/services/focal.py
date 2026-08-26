"""Telling SHARP what lens the photograph was taken with.

SHARP reads `FocalLengthIn35mmFilm` from the image's EXIF and, finding none,
assumes 30 mm. That assumption is not a small one. It sets the field of view the
scene is unprojected through, so it decides the shape of the reconstruction and
how far away everything ends up: on one measured photograph the subject sat at
2.66 metres under the 30 mm default and at 7.00 under 85 mm, which is where a
portrait taken with that lens actually was.

It also decides how the result can be looked at. A scene keeps the field of view
it was made with, so the picture appears its natural size only where the screen
subtends that angle -- 111 mm from the eye for the 30 mm default, which is no way
to hold a phone, and 313 mm for 85 mm, which is arm's length.

The command-line tool takes no focal length argument, so the value is written
into the file's EXIF before it is handed over.
"""

from __future__ import annotations

import logging
from pathlib import Path

LOGGER = logging.getLogger(__name__)

# Below this SHARP treats the value as a physical focal length rather than a
# 35 mm equivalent and multiplies it by 8.4, which is not what a caller giving a
# 35 mm equivalent means.
# What SHARP falls back to when the file says nothing. Recorded rather than
# left blank, so a scene always says what it was built with.
DEFAULT_ASSUMED_MM = 30.0

MIN_FOCAL_MM = 10.0
MAX_FOCAL_MM = 800.0


def clamp_focal_mm(focal_mm: float | None) -> float | None:
    """A usable 35 mm-equivalent focal length, or None to leave the file alone."""
    if focal_mm is None:
        return None
    try:
        value = float(focal_mm)
    except (TypeError, ValueError):
        return None
    if not (value == value) or value <= 0:  # NaN or nonsense
        return None
    return min(max(value, MIN_FOCAL_MM), MAX_FOCAL_MM)


def apply_focal_length(image_path: Path, focal_mm: float | None) -> bool:
    """Write the focal length into the image's EXIF, in place.

    Returns whether anything was written. Failure is not fatal: SHARP will fall
    back to its own default and the scene will still be produced, just with the
    wrong lens assumed.
    """
    value = clamp_focal_mm(focal_mm)
    if value is None:
        return False
    try:
        import piexif
        from PIL import Image

        with Image.open(image_path) as image:
            fmt = image.format
            data = image.convert("RGB") if image.mode not in ("RGB", "L") else image.copy()

        try:
            exif = piexif.load(str(image_path))
        except Exception:  # noqa: BLE001 - a file with no or broken EXIF is normal
            exif = {"0th": {}, "Exif": {}, "GPS": {}, "1st": {}, "thumbnail": None}
        exif.setdefault("Exif", {})
        exif["Exif"][piexif.ExifIFD.FocalLengthIn35mmFilm] = int(round(value))
        # A thumbnail carried over from the original can exceed the segment
        # limit and make the write fail for a reason unrelated to the change.
        exif["thumbnail"] = None
        exif["1st"] = {}

        # PNG and friends have nowhere to put this, so the file becomes a JPEG.
        # SHARP reads either.
        data.save(image_path, format="JPEG" if fmt != "JPEG" else fmt,
                  quality=95, exif=piexif.dump(exif))
        return True
    except Exception as exc:  # noqa: BLE001
        LOGGER.warning("Could not set the focal length on %s: %s", image_path, exc)
        return False


def effective_focal_mm(
    image_path: Path,
    from_exif: float | None,
    requested: float | None,
    wrote: bool,
) -> float:
    """
    The focal length SHARP will actually unproject through.

    Not the same as what was asked for. An override that could not be written
    is not in the file and will not be read; a photograph that says nothing
    gets the tool's own assumption rather than nothing at all. Recording the
    request instead would leave a scene labelled with a lens it was not built
    with, which is the sort of note that is worse than none.

    Rounded, because that is how the tag is stored.
    """

    if wrote:
        value = clamp_focal_mm(requested)
        if value is not None:
            return float(round(value))
    if from_exif is not None:
        return float(round(from_exif))
    return float(DEFAULT_ASSUMED_MM)


def read_focal_mm(image_path: Path) -> float | None:
    """
    The 35 mm-equivalent focal length the file already carries, if any.

    This is what decides whether anyone needs to be asked. A photograph that
    records its lens needs no help and should not be interrupted for one; a
    photograph that does not is the case the whole control exists for, and
    SHARP's 30 mm default is a guess that is wrong more often than not for a
    portrait.

    Anything unreadable is treated as absent, which is the same as what SHARP
    would conclude.
    """

    try:
        import piexif

        exif = piexif.load(str(image_path))
        value = exif.get("Exif", {}).get(piexif.ExifIFD.FocalLengthIn35mmFilm)
        if value is None:
            return None
        # piexif hands rationals back as a pair; a plain int is also seen.
        if isinstance(value, tuple) and len(value) == 2 and value[1]:
            value = value[0] / value[1]
        value = float(value)
        return value if value > 0 else None
    except Exception:  # noqa: BLE001 - no EXIF, broken EXIF and no piexif are all "absent"
        return None
