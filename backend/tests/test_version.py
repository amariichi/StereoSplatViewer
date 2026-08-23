"""The three places a version appears must agree.

VERSION is the one a person edits. The two package manifests have to carry it
too, because the tools that read them cannot read VERSION, and a release where
they disagree is a release nobody can identify afterwards. This test is what
catches that, since nothing else would.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read_version() -> str:
    return (ROOT / "VERSION").read_text(encoding="utf-8").strip()


def test_version_file_is_a_plain_number() -> None:
    assert re.fullmatch(r"\d+\.\d+(\.\d+)?", read_version()), "VERSION should look like 1.0"


def test_backend_manifest_agrees() -> None:
    text = (ROOT / "backend" / "pyproject.toml").read_text(encoding="utf-8")
    match = re.search(r'^version = "([^"]+)"', text, re.MULTILINE)
    assert match, "no version in backend/pyproject.toml"
    assert match.group(1) == read_version()


def test_frontend_manifest_agrees() -> None:
    # npm insists on three parts, so 1.0 is carried there as 1.0.0.
    package = json.loads((ROOT / "frontend" / "package.json").read_text(encoding="utf-8"))
    version = read_version()
    expected = version if version.count(".") == 2 else f"{version}.0"
    assert package["version"] == expected
