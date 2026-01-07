# Third-Party Notices

This project depends on external libraries via package manifests (pip/npm) but does not vendor their sources.

Backend (pip):
- fastapi (MIT): backend web framework.
- uvicorn (BSD-3-Clause): ASGI server.
- python-multipart (Apache-2.0): multipart form upload handling.
- numpy (BSD-3-Clause): numerical operations for 360 image processing and PLY transforms.
- pillow (HPND): image decoding and cube face extraction.
- plyfile (BSD-3-Clause): PLY read/write support for applying rotations.
- piexif (MIT): writing EXIF focal length into cube face JPEGs for ml-sharp.

Frontend (npm):
- react (MIT): UI framework.
- react-dom (MIT): React DOM bindings.
- vite (MIT): frontend build tooling.
- typescript (Apache-2.0): type checking and tooling.
- eslint (MIT): lint tooling.
- @typescript-eslint/eslint-plugin / parser (MIT): TypeScript lint rules.
- eslint-plugin-react / react-hooks / jsx-a11y (MIT): React lint rules.
- @vitejs/plugin-react (MIT): Vite React integration.
- playcanvas (MIT): SuperSplat rendering runtime.
- supersplat (MIT): forked viewer with SBS and embed API.
- three (MIT): legacy fallback viewer (not exposed in UI).
- @playcanvas/splat-transform (MIT): optional CLI for merging 360 face splats.
