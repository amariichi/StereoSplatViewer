# Third-Party Notices

This project vendors nothing. Every dependency is referenced through a package
manifest, fetched at runtime, or installed separately by the person running it.
The list below is what that amounts to in practice, and the first two entries
carry conditions worth reading before the rest.

## ml-sharp, and its model (installed separately)

The whole application is a wrapper around `ml-sharp` from Apple Machine Learning
Research: it is what turns a photograph into a splat. `scripts/setup_wsl.sh`
clones it into `third_party/ml-sharp/`, which this repository ignores, so it is
never redistributed here.

Two separate sets of terms apply, both in that clone:

- `third_party/ml-sharp/LICENSE` covers the code. Apple's own licence, not one
  of the common open-source ones.
- `third_party/ml-sharp/LICENSE_MODEL` covers the trained weights, which the
  tool downloads on first use. It states that the model is released "for the
  sole purpose of scientific research of artificial intelligence and
  machine-learning technology". **If you intend to use the output for anything
  beyond research, read that file first.** Nothing in this repository grants
  rights to the model, and nothing here can.

## MediaPipe (fetched at runtime, by the phone viewer only)

The head tracking on `/viewer.html` uses Google's MediaPipe Tasks Vision, loaded
from a CDN when the page starts rather than installed from a manifest:

- `@mediapipe/tasks-vision` 1.0.0 (Apache-2.0), from `cdn.jsdelivr.net`
- the Face Landmarker model, from `storage.googleapis.com`

Two consequences follow. The phone viewer needs an internet connection the first
time it runs, even though everything else here is local; and opening it tells
those two hosts that a request was made. The editor page does not use MediaPipe
and contacts neither.

## Backend (pip)

- fastapi (MIT): web framework.
- uvicorn (BSD-3-Clause): ASGI server.
- python-multipart (Apache-2.0): multipart form upload handling.
- numpy (BSD-3-Clause): 360 image processing, PLY transforms, sky measurement.
- pillow (HPND): image decoding and cube face extraction.
- plyfile (BSD-3-Clause): PLY read/write, for applying rotations to cube faces.
- piexif (MIT): writing the EXIF focal length that ml-sharp reads.
- pytest (MIT, tests only): the backend test suite.

## Frontend (npm)

- playcanvas (MIT): the engine that renders the gaussian splats.
- react, react-dom (MIT): the interface.
- vite (MIT): dev server and build.
- typescript (Apache-2.0): type checking.
- vitest (MIT): the test runner.
- eslint, @typescript-eslint/*, eslint-plugin-react, eslint-plugin-react-hooks,
  eslint-plugin-jsx-a11y (MIT): lint tooling.
- @vitejs/plugin-react (MIT): Vite React integration.
- @types/react, @types/react-dom (MIT): type definitions.
- @playcanvas/splat-transform (MIT): merges the six faces of a 360 scene into
  one. Optional, and only the 360 path needs it.
