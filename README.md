# StereoSplatViewer

<img width="400" height="225" alt="Image" src="https://github.com/user-attachments/assets/92b47d44-2c8f-4ccf-b5cc-be3f6404a0b0" />
<img width="400" height="225" alt="Image" src="https://github.com/user-attachments/assets/eba7fa51-19de-474f-b053-bfcd730e497e" />

![Image](https://github.com/user-attachments/assets/f7ab7dc2-3806-4197-b205-f81c08223d9e)
![Image](https://github.com/user-attachments/assets/091536f2-6cdb-4b71-92b0-1bfe98e89fb9)

---

[English](#english) / [日本語](#%E6%97%A5%E6%9C%AC%E8%AA%9E)

---

## English

StereoSplatViewer is a local web app that turns a single image into a 3D Gaussian splat (PLY) using an external `ml-sharp` installation, then lets you adjust stereo parameters in the browser and export SBS images. This repository intentionally avoids bundling any third-party code or model weights; it only references dependencies via package manifests.

## Repository layout

- `backend/`: FastAPI backend (upload → ml-sharp → PLY).
- `frontend/`: Vite + React + TypeScript UI.
- `docs/`: Third-party notices.
- `scripts/`: Environment helpers.

## External dependency policy

- **Do not vendor ml-sharp or model weights.** `ml-sharp` is a separate repository; `scripts/setup_wsl.sh` can clone and install it, but users must review and accept its license/terms before running the script. The backend uses `ML_SHARP_CLI` or `sharp` on `PATH`.
- Renderer dependencies (SuperSplat fork) are installed via npm, not vendored.
  - This repo can clone ml-sharp into `third_party/` via `scripts/setup_wsl.sh`, but the folder remains gitignored.
  - When `scripts/ml_sharp_wrapper.sh` exists, the backend uses it automatically (no env var needed).

## Quick start

### Prerequisites
- Python 3.10+
- Node.js 18+ (or 20+)
- Git
- A working `ml-sharp` installation (separate repo; see below)

Optional:
- `uv` (faster venv + pip)
- CUDA-capable GPU (ml-sharp performance)

### Install and run

SuperSplat is based on the upstream https://github.com/playcanvas/supersplat, forked by amariichi and specialized for this app on the `sbs-spike` branch. The setup script pulls the latest `sbs-spike` fork.

1. Run the setup script to fetch ml-sharp locally (Ubuntu or WSL): `scripts/setup_wsl.sh`.
1. The script also creates venvs for ml-sharp and the backend, installing deps (prefers `uv` if available).
1. Start backend: `uvicorn backend.app.main:app --reload`.
1. Start frontend: `cd frontend && npm install && npm run dev`.
   - The frontend defaults to `http://localhost:8000` for the backend.
   - If you run the backend on another port, set `VITE_API_BASE=http://localhost:<port>` before `npm run dev`.
   - The experimental SuperSplat renderer is pulled from the app-specific fork (`amariichi/supersplat` `sbs-spike`) via npm, which tracks upstream playcanvas/supersplat.
1. (Optional) Use `scripts/dev.sh` to start backend and frontend together.
   - Set `BACKEND_PORT` or `FRONTEND_PORT` if you need non-default ports.
   - If you prefer tmux (two panes), run `scripts/dev_tmux.sh` (requires tmux installed).
1. Upload an image via the frontend. The app will POST `/api/upload`, then poll `/api/scene/{jobId}/status`.
1. After status `done`, the page will render the generated PLY in SuperSplat and provide download/log links. You can also save params.json or capture PNG/JPG of the current mono/SBS view.

### Demo input (not included)
This repo does not ship sample images. Use your own images:
- Standard images: any JPG/PNG.
- 360 images: 2:1 equirectangular named `*.360.jpg` or `*.360.png`.
If you need public-domain material, search for 360 equirectangular test images (public domain/CC0) and confirm the license yourself before use.

### Viewer controls

- LMB drag: Orbit (rotate)
- Shift + LMB drag: Pan
- Wheel: Dolly zoom
- Ctrl + LMB drag (vertical): Adjust FOV (20–110° clamp)
- Double click: Set pivot (target) to the clicked point
- Context menu is disabled on the canvas
- SBS preview toggle + baseline, compression (reduce parallax strength), clamp (max parallax in pixels; lower = safer) controls
- Zero-parallax mode: pivot / double click (pivot uses the current camera target; double click uses the last double-click pivot)
- Framing lock: compensates camera distance while adjusting FOV to reduce framing drift
- Comfort lock: auto-scales baseline based on zoom distance, with adjustable strength
- SBS fullscreen button (enters fullscreen for the preview canvas)
- Load local `.ply` files directly (skips ml-sharp; preview only)
- Save/Load params.json for viewer state (job metadata + stereo controls + toggles)
- Save PNG/JPG of the current preview canvas (mono or SBS)

### 360 image workflow (preview)

- Upload `*.360.jpg` / `*.360.png` (2:1 equirectangular).
- Backend cuts 6 cube faces with overscan FOV, runs ml-sharp per face, and applies known rotations.
  - Because ml-sharp runs once per face, 360 processing typically takes ~6× longer than a normal image (hardware-dependent).
- If a merge CLI is available, it produces `<input-stem>.ply` (example: `abc.360.ply`).
- Optional merge CLI: `setup_wsl.sh` attempts a best-effort install of `@playcanvas/splat-transform` and `scripts/dev.sh` auto-detects it. If it fails, set `SPLAT_MERGE_CLI` or install `splat-transform` in `PATH`. The merge command is expected to accept:
  `splat-transform -w <face_0.ply> ... <face_5.ply> <abc.360.ply>`

## Limitations / notes
- Requires an external ml-sharp installation and suitable GPU/CPU resources.
- 360 mode is a convenience pipeline and may show alignment artifacts, especially for near objects.
- SBS output is intended for stereo viewing; extreme parallax settings can be uncomfortable.

## Contributing
- Keep `docs/THIRD_PARTY_NOTICES.md` updated when adding dependencies.
- Respect the “no third-party code bundling” requirement.

## Acknowledgements
- ml-sharp (Apple Machine Learning Research) for the core single-image splat generation pipeline.
- SuperSplat (PlayCanvas) for the Gaussian splat viewer foundation and embed runtime.

---

## 日本語

StereoSplatViewer は、外部の `ml-sharp` を使って単一画像から 3D Gaussian Splat（PLY）を生成し、ブラウザ上でステレオパラメータを調整して SBS 画像を保存できるローカルWebアプリです。本リポジトリは第三者コードやモデル重みを同梱せず、依存関係はパッケージマニフェスト経由で参照します。

## リポジトリ構成

- `backend/`: FastAPI バックエンド（アップロード → ml-sharp → PLY）。
- `frontend/`: Vite + React + TypeScript UI。
- `docs/`: サードパーティ通知。
- `scripts/`: 環境ヘルパ。

## 外部依存ポリシー

- **ml-sharp 本体やモデル重みは同梱しません。** `ml-sharp` は別リポジトリであり、`scripts/setup_wsl.sh` がクローンと導入を行えますが、実行前にユーザーがライセンス/利用条件を確認し同意する必要があります。バックエンドは `ML_SHARP_CLI` もしくは `PATH` 上の `sharp` を利用します。
- レンダラー依存（SuperSplat フォーク）は npm 経由で導入し、同梱しません。
  - `scripts/setup_wsl.sh` は `third_party/` に ml-sharp をクローンできますが、フォルダは gitignored です。
  - `scripts/ml_sharp_wrapper.sh` が存在する場合、バックエンドは自動的にそれを使用します（環境変数不要）。

## クイックスタート

### 前提
- Python 3.10+
- Node.js 18+（または 20+）
- Git
- 動作する `ml-sharp` のインストール（別リポジトリ。下記参照）

任意:
- `uv`（高速な venv + pip）
- CUDA 対応 GPU（ml-sharp の高速化）

### インストールと起動

SuperSplat は上流の https://github.com/playcanvas/supersplat を amariichi がフォークし、このアプリ専用に `sbs-spike` ブランチで拡張しています。setup スクリプトは最新の `sbs-spike` を取得します。

1. セットアップスクリプトを実行（Ubuntu / WSL）: `scripts/setup_wsl.sh`
1. スクリプトは ml-sharp とバックエンドの venv を作成し、依存を導入します（`uv` があれば優先）。
1. バックエンド起動: `uvicorn backend.app.main:app --reload`
1. フロントエンド起動: `cd frontend && npm install && npm run dev`
   - フロントはデフォルトで `http://localhost:8000` をバックエンドに使います。
   - 別ポートの場合は `VITE_API_BASE=http://localhost:<port>` を設定してください。
   - SuperSplat レンダラーはアプリ専用フォーク（`amariichi/supersplat` の `sbs-spike`）を npm 経由で取得します。
1. （任意）`scripts/dev.sh` で backend + frontend を同時起動できます。
1. 画像をアップロードすると `/api/upload` に POST され、`/api/scene/{jobId}/status` をポーリングします。
1. `done` になると PLY が表示され、Download / logs も利用可能になります。mono/SBS の PNG/JPG 保存や params.json 保存が可能です。

### デモ入力（同梱なし）
このリポジトリはサンプル画像を同梱しません。ご自身の画像を使ってください。
- 通常画像: 任意の JPG/PNG。
- 360 画像: 2:1 の equirectangular で、`*.360.jpg` / `*.360.png` という名前。
公開素材が必要な場合は、360 equirectangular の public domain / CC0 画像を探し、必ずライセンスを確認してください。

### Viewer 操作

- LMB drag: Orbit（回転）
- Shift + LMB drag: Pan（平行移動）
- Wheel: Dolly zoom
- Ctrl + LMB drag（上下）: FOV 調整（20–110°）
- Double click: Pivot（注視点）をクリック位置へ
- キャンバス上のコンテキストメニューは無効
- SBS プレビュー切替 + baseline, compression（視差の圧縮）, clamp（視差の最大px）を調整
- Zero-parallax mode: pivot / double click（pivot は現在のカメラターゲット、double click は最後のダブルクリック地点）
- Framing lock: FOV 調整時のフレーミング崩れを抑制
- Comfort lock: ズーム距離に応じて baseline を自動スケール
- SBS fullscreen ボタン（プレビューキャンバスを全画面）
- ローカルの `.ply` を直接ロード（ml-sharp なしのプレビュー）
- params.json の Save/Load
- 表示中の mono / SBS 画像を PNG/JPG 保存

### 360 画像ワークフロー（プレビュー）

- `*.360.jpg` / `*.360.png` をアップロード（2:1 equirectangular）。
- Backend が 6 面を overscan FOV で切り出し、面ごとに ml-sharp を実行して既知回転を適用します。
  - ml-sharp を 6 回実行するため、通常画像よりおおむね 6 倍時間がかかります（環境依存）。
- merge CLI が利用可能なら `<input-stem>.ply`（例: `abc.360.ply`）を生成します。
- Optional merge CLI: `setup_wsl.sh` は `@playcanvas/splat-transform` をベストエフォートで導入し、`scripts/dev.sh` が自動検出します。失敗した場合は `SPLAT_MERGE_CLI` を設定するか `splat-transform` を `PATH` に入れてください。想定コマンドは以下:
  `splat-transform -w <face_0.ply> ... <face_5.ply> <abc.360.ply>`

## 制限 / 注意
- 外部の ml-sharp インストールが必須で、GPU/CPU 環境によって処理時間が大きく変わります。
- 360 モードは簡易パイプラインのため、特に近距離では継ぎ目のアーティファクトが出る場合があります。
- SBS 出力は立体視向けです。視差設定を極端にすると見づらくなります。

## Contributing
- 依存追加時は `docs/THIRD_PARTY_NOTICES.md` を更新してください。
- 「第三者コード同梱なし」の方針を守ってください。

## Acknowledgements
- ml-sharp（Apple Machine Learning Research）: 単一画像からのスプラット生成の中核。
- SuperSplat（PlayCanvas）: ガウシアンスプラットビューアと埋め込みランタイムの基盤。
