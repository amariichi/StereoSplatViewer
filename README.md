# StereoSplatViewer

<p align="center">
  <img src="https://github.com/user-attachments/assets/a0371180-8eaf-400b-8feb-8a040a95d32a" width="300" alt="A phone showing the scene from the position of the viewer's head, the view shifting as the phone moves">
</p>

<p align="center"><em>One photograph, on a phone that knows where your head is.</em></p>

<p align="center">
  <img src="https://github.com/user-attachments/assets/2dd27858-d322-4d18-8c58-66933b5f48dd" width="400" alt="The editor in side-by-side mode, the same scene drawn twice for stereo viewing">
  <img src="https://github.com/user-attachments/assets/d8023745-95d4-4e22-bac3-2207cb6e17f3" width="400" alt="The editor in mono mode, the scene drawn once">
</p>

<p align="center"><em>The editor, side by side and mono.</em></p>

<p align="center">
  <img src="https://github.com/user-attachments/assets/f7ab7dc2-3806-4197-b205-f81c08223d9e" width="400" alt="The scene turning under the orbit camera">
  <img src="https://github.com/user-attachments/assets/091536f2-6cdb-4b71-92b0-1bfe98e89fb9" width="400" alt="Stereo parameters being adjusted and the depth changing with them">
</p>

---

[English](#english) / [日本語](#%E6%97%A5%E6%9C%AC%E8%AA%9E)

---

## English

StereoSplatViewer is a local web app that turns a single photograph into a 3D Gaussian splat (PLY) using an external `ml-sharp` installation. There are two ways to look at what comes out. On this machine, the browser draws it side by side, with stereo parameters you can adjust and save as SBS images. On a phone, `/viewer.html` uses the front camera to follow your head and turns the screen into a window onto the scene, which you look around by moving rather than by dragging. This repository intentionally avoids bundling any third-party code or model weights; it only references dependencies via package manifests.

## Repository layout

- `backend/`: FastAPI backend (upload → ml-sharp → PLY).
- `frontend/`: Vite + React + TypeScript UI.
- `docs/`: Third-party notices.
- `scripts/`: Environment helpers.

## External dependency policy

- **Do not vendor ml-sharp or model weights.** `ml-sharp` is a separate repository; `scripts/setup_wsl.sh` can clone and install it, but users must review and accept its license/terms before running the script. The backend uses `ML_SHARP_CLI` or `sharp` on `PATH`.
- Renderer dependencies are installed via npm, not vendored.
  - This repo can clone ml-sharp into `third_party/` via `scripts/setup_wsl.sh`, but the folder remains gitignored.
  - When `scripts/ml_sharp_wrapper.sh` exists, the backend uses it automatically (no env var needed).

Two conditions are worth knowing before you start, and both are set by other
people, not by this project. Apple releases the ml-sharp **model weights** for
research: `LICENSE_MODEL` in that clone says "for the sole purpose of scientific
research of artificial intelligence and machine-learning technology", so read it
before using the output for anything else. And the phone viewer downloads
Google's MediaPipe from a CDN when it starts, so that one page needs an internet
connection and tells two hosts it was opened, while everything else here stays
on your machine. [docs/THIRD_PARTY_NOTICES.md](docs/THIRD_PARTY_NOTICES.md) has
the detail.

## The lens matters more than it looks

`ml-sharp` reads the focal length from the image's EXIF, and assumes 30 mm when it finds none. That assumption is not a detail: it is the field of view the scene is unprojected through, so it sets the shape of the reconstruction and how far away everything ends up. On one measured photograph the subject sat at 2.66 metres under the 30 mm default and at 7.00 under 85 mm, which is where a portrait taken with that lens actually was.

It also decides how the result can be looked at. A scene keeps the field of view it was made with, so the picture appears at its natural size only where the screen subtends that angle:

    assumed lens    natural viewing distance
    30 mm                     111 mm
    50 mm                     184 mm
    85 mm                     313 mm

Eleven centimetres is no way to hold a phone. If your image has no EXIF, put the lens in the **Lens (35 mm equiv.)** field before uploading — an ordinary portrait is 50 to 85 mm — and the scene will be both correctly shaped and comfortable to view at arm's length.

## The viewer page

Alongside the editor there is a second page, `/viewer.html`, meant for a phone. It uses the front camera to find where your head is and draws the scene from that point of view, so the screen behaves like a window onto a miniature standing just behind the glass. Moving your head reveals the shape.

Open it on the phone at the address printed by `scripts/dev.sh`:

    https://<this machine>:5173/viewer.html

It shows whatever the editor last produced, and keeps up with it: make a new scene on the desktop and the phone picks it up within a few seconds, with no reload. To pin it to one scene instead, add `?job=<jobId>&name=<file>.ply`, or point it at any file with `?scene=<url>`; an address that names a scene is never overridden.

Left to find the scene itself, the phone downloads a compressed copy, roughly a sixth of the size of the PLY the editor uses, so it is usable over mobile data. (An address that pins a particular `.ply` downloads that file, as asked.) The page shows how far through it is. The editor keeps the full file, so exported images never come from the compressed one. The copy is made with `splat-transform`, which arrives with the frontend's dependencies; if it cannot be run the phone is given the full file instead and the job log says why.

**This has to be HTTPS.** Browsers only give a page the camera on a secure origin, and a plain `http://` address on a local network is not one. (`localhost` counts as secure, but on the phone that means the phone itself, not the machine running the server.) Three ways to get it, and the script prints the exact address to open whichever you use.

If `tailscale serve` already proxies port 5173 on this machine, use no option at all:

    scripts/dev.sh

Tailscale terminates TLS on 443 with its own genuine certificate, so the phone opens `https://<this machine>.ts.net/viewer.html` -- no port number, no warning, mobile data included. The script detects the mapping and prints that address first. Do not add `--https` or `--tailscale` here: they make the dev server speak HTTPS while `serve` still forwards plain HTTP to it, and the mismatch answers 502. The script says so when it sees it, and names the two ways out.

    scripts/dev.sh --https

issues a self-signed certificate naming every address this machine answers to, including its tailnet address when Tailscale is running. Nothing leaves this machine. The phone warns about the certificate once; continue past the warning, which is this machine vouching for itself.

    scripts/dev.sh --tailscale

asks `tailscale cert` for a genuine certificate for this machine's tailnet name. No warning on the phone, and it works from anywhere signed into your tailnet, mobile data included, without opening a port on your router.

The cost of `--tailscale` is worth stating plainly: certificates issued by a public authority are written into Certificate Transparency logs, which are public and permanent. What gets published is the name — `my-laptop.tail1234.ts.net` — and nothing else: not the machine's addresses, not what it serves, not that any of this exists. If you would rather publish nothing at all, use `--https` and accept one warning on the phone. The `tailscale serve` route above uses the same kind of certificate and carries the same cost, but it was already paid when `serve` was set up rather than by this script.

### Using it

Press **Start 3D** and hold still while it calibrates. iOS asks for the camera, gravity motion, and orientation access in that one press. Refusing gravity motion costs only levelling; refusing orientation still leaves pitch/roll levelling available, but disables phone-yaw separation. After that, pasting a picture starts the tracking by itself.

**Paste image** turns whatever is on the clipboard into a scene, which is shorter than saving a picture and finding it again in a file picker. On a desktop you can paste with the keyboard instead. The scene takes a little while to build and the page says so while it does.

**I am at N mm** corrects the tracker's idea of how far away you are. Press it while holding the device at the distance it names, measured however you like. The tracker fits a canonical face seen through an assumed lens, and neither assumption is checked against your device -- on one it read 300 mm with the eye really 150 from the glass. The error is a scale, so this one number fixes it at every distance, and it is remembered.

**Hold level** holds the model's horizon level, and uses gravity to relate the phone's pitch and roll to the posture the button was pressed in. In True Window, roll aligns model-up with gravity and inverse pitch reveals over/under the phone in the same direction as the unassisted view; both respond at 100%, up to 18 degrees. The tracked eye is transformed into the same reference posture so the cues do not spring-cancel. Photo mode applies only half-strength roll: forward/back movement remains entirely head-tracked and therefore keeps the same direction with Hold level on or off. Turning the phone is corrected whether Hold level is on or off, because which way the glass is turned is not a stabiliser but what makes the window a window. Device orientation supplies the phone's relative yaw for as long as the camera runs: the viewer removes the apparent sideways face motion caused by turning the phone and turns the world behind the glass the other way. This preserves real head translation instead of using the same sign switch for both motions. Without it a face tracker cannot tell a turned phone from a moved head, and the scene swings far enough to show the wrong edge of the splat. Both gravity and heading are lightly smoothed, and tiny angular sensor jitter is ignored. Absolute compass north is never used. The pitch/roll cap remains because turning a finite single-image reconstruction farther can expose missing edges. **Recenter** captures all sensor references again along with the head calibration.

**Reverse tracking** corrects the horizontal axis of a device's front camera. Leave it in the setting where moving your actual head looks right (ON on the tested phone); phone rotation is handled separately and does not change this setting. It is remembered.

A **pinch** has mode-specific meaning. With **True window** on it uniformly changes the miniature's physical size while the phone glass remains the same physical aperture. With **True window** off it crops into or out of the source frame; this is how the photo-preserving mode trades edge content against apparent size. Switching modes resets the pinch value so a crop factor is never reused as a physical scale. **Reset view** also returns it to one.

**Lens** appears when the photograph did not record what took it. `ml-sharp` assumes 30 mm in that case, and that assumption sets the shape of the scene, not just its scale -- on one measured image the subject sat 2.5 metres away at 30 mm and 6.9 at 85, with the depth stretched to match. A portrait built at 30 mm when it was taken at 85 comes out pressed flat.

So a picture pasted here that says nothing about its lens is not built straight away: the field is offered first, and building starts when you answer it. Leave it blank to accept the 30 mm that would have been assumed anyway. Full-width digits are read as ordinary ones, so there is no need to change keyboards for two characters.

The lens cannot be judged before the scene exists, so the field stays afterwards: type a different number and press **Rebuild**. That runs `ml-sharp` again, which takes about as long as the first time. Nothing rebuilds on its own -- only when you press it. A scene whose photograph did record its lens is never asked about, and a 360 scene cannot be rebuilt this way at all, being six reconstructions merged rather than one.

**True window** decides where the picture is drawn from. On, it is drawn from where your eye actually is through a fixed physical aperture: shapes hold as you tilt the device, and what the glass shows is cropped as it goes deeper, the way a real window crops it. PLY camera intrinsics are used when present; the splats' angular spread is only the fallback. Off, the whole photograph stays on screen at every depth, and the cost is that shapes stretch towards the edges. On is the default.

**Depth** slides the miniature further behind the glass, in steps. It sets how far back it sits and how widely it swings when you turn it with a finger -- nearer values keep the swing tight. It is not a depth-strength control: moving a whole scene away flattens it rather than deepening it.

**Double tap** anywhere clears the controls and the readout away, and again brings them back. **Tap the readout** for the numbers the geometry is using, which is where to look if something seems wrong. The detail view also accepts the lit panel's measured long side in millimetres. Use that on an unknown device if the status says `estimated`; the saved measurement overrides the device-density estimate.

## Quick start

### Prerequisites
- Python 3.10+
- Node.js 20.19+ (22 or 24 recommended; 18 and 20.x before 20.19 have reached end of life). CI runs on 24.
- Git
- A working `ml-sharp` installation (separate repo; see below)

Optional:
- `uv` (faster venv + pip)
- CUDA-capable GPU (ml-sharp performance)

### Install and run

The scene is drawn by the PlayCanvas engine, which is the only rendering dependency.

1. Run the setup script to fetch ml-sharp locally (Ubuntu or WSL): `scripts/setup_wsl.sh`.
1. The script also creates venvs for ml-sharp and the backend, installing deps (prefers `uv` if available).
1. Start backend: `uvicorn backend.app.main:app --reload`.
1. Start frontend: `cd frontend && npm ci && npm run dev`.
   - `npm ci` installs exactly what `package-lock.json` records, which is what CI does. `npm install` also works but may quietly move a dependency.
   - The backend has the same thing in `backend/uv.lock`. `scripts/setup_wsl.sh` installs from it when `uv` is present, so you get the versions this was tested with; without `uv` it resolves the ranges instead and says so. After changing a backend dependency, run `uv lock --project backend` — CI checks the lock matches and fails if it does not.
   - The frontend reaches the backend through its own address, proxied by the dev server; nothing needs configuring for the default ports.
   - To point at a backend elsewhere, set `SSV_BACKEND_ORIGIN=http://host:port` before starting it.
1. Open `http://localhost:5173/` in your browser (default Vite dev server URL).
1. (Optional) Use `scripts/dev.sh` to start backend and frontend together.
   - Set `BACKEND_PORT` or `FRONTEND_PORT` if you need non-default ports.
   - If you prefer tmux (two panes), run `scripts/dev_tmux.sh` (requires tmux installed).
1. Upload an image via the frontend. The app will POST `/api/upload`, then poll `/api/scene/{jobId}/status`.
1. After status `done`, the page renders the generated PLY and offers download and log links. You can also save params.json or capture PNG/JPG of the current mono/SBS view.

### Demo input (not included)
This repo does not ship sample images. Use your own images:
- Standard images: any JPG/PNG.
- 360 images: 2:1 equirectangular named `*.360.jpg` or `*.360.png`.
If you need public-domain material, search for 360 equirectangular test images (public domain/CC0) and confirm the license yourself before use.

### Controls

In the editor, the camera orbits the scene:

- Drag: turn around what you are looking at
- Shift + drag: slide it within the frame
- Wheel: move closer or further away

On the phone, at `/viewer.html`, the camera is your head, so the scene is moved
instead of the viewpoint:

- One finger: turn the miniature. Sideways spins it about its upright axis; up and down tips it toward or away from you, up to 55°. A diagonal does both at once.
- Two fingers apart or together: show less or more of the frame
- Two fingers slid together: slide the miniature within the frame
- Double tap: hide or show the controls, and put the view back to where it started

The stereo settings, which appear in side-by-side mode:

- **Eye separation** — metres between the two eyes. Larger means more depth, and more strain.
- **Depth compression** — below 1 flattens the scene, above 1 exaggerates it.
- **Disparity limit** — pixels. Caps how far apart the two eyes may put a point; 0 is no limit.
- **Screen plane** — the depth that sits in the glass. Either follows what you look at, or a fixed distance you type in.
- **Swap left and right** — off suits a side-by-side display or a headset; on is for free viewing cross-eyed, which is the only way a pair wider than your eyes can be fused. Exports follow it too.
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

## Speed

The first scene of a session takes about sixteen seconds; every one after it takes about three and a half.

Almost all of that first figure is preparation rather than work. `sharp predict` imports torch, builds two vision transformers, loads the checkpoint and moves it onto the GPU, and only then spends about a second on the image. Running it once per upload pays that cost every time, which is why a 360 job -- six cube faces -- used to take a hundred seconds to do seven seconds of work.

The backend therefore starts one long-lived ml-sharp process (`scripts/sharp_worker.py`) when it boots, and keeps the model in memory. Startup is not delayed by this: the server answers straight away and the model loads behind it, so it is normally warm before anyone has chosen a photograph. Measured here, the same image took 16.5 seconds through the command line and 3.4 seconds through a warm worker, and the two PLY files were byte-identical. A 360 job went from about a hundred seconds to thirty.

Nothing depends on it. If the worker cannot start, dies, or reports a failure, that image goes through the command line exactly as before. To turn it off, set `SHARP_WORKER=0`. If `ML_SHARP_CLI` points at an ml-sharp installation outside this repository, the worker stands aside rather than quietly using a different one -- name its interpreter with `SHARP_WORKER_PYTHON` if you do want both.

## Limitations / notes
- Requires an external ml-sharp installation and suitable GPU/CPU resources.
- 360 mode is a convenience pipeline and may show alignment artifacts, especially for near objects.
- SBS output is intended for stereo viewing; extreme parallax settings can be uncomfortable.

## Contributing
- Keep `docs/THIRD_PARTY_NOTICES.md` updated when adding dependencies.
- Respect the “no third-party code bundling” requirement.

## Acknowledgements
- ml-sharp (Apple Machine Learning Research) for the core single-image splat generation pipeline.
- PlayCanvas for the engine that renders the gaussian splats.

---

## 日本語

StereoSplatViewer は、外部の `ml-sharp` を使って単一の写真から 3D Gaussian Splat（PLY）を生成するローカル Web アプリです。できたものの見方は2通りあります。**PC のブラウザ**では左右並置で描き、ステレオパラメータを調整して SBS 画像として保存できます。**スマートフォン**では `/viewer.html` が前面カメラで頭の位置を追い、画面をシーンへの窓に変えます。こちらはドラッグではなく、自分が動くことで見回します。本リポジトリは第三者コードやモデル重みを同梱せず、依存関係はパッケージマニフェスト経由で参照します。

## リポジトリ構成

- `backend/`: FastAPI バックエンド（アップロード → ml-sharp → PLY）。
- `frontend/`: Vite + React + TypeScript UI。
- `docs/`: サードパーティ通知。
- `scripts/`: 環境ヘルパ。

## 外部依存ポリシー

- **ml-sharp 本体やモデル重みは同梱しません。** `ml-sharp` は別リポジトリであり、`scripts/setup_wsl.sh` がクローンと導入を行えますが、実行前にユーザーがライセンス/利用条件を確認し同意する必要があります。バックエンドは `ML_SHARP_CLI` もしくは `PATH` 上の `sharp` を利用します。
- レンダラー依存は npm 経由で導入し、同梱しません。
  - `scripts/setup_wsl.sh` は `third_party/` に ml-sharp をクローンできますが、フォルダは gitignored です。
  - `scripts/ml_sharp_wrapper.sh` が存在する場合、バックエンドは自動的にそれを使用します（環境変数不要）。

始める前に知っておくべき条件が2つあります。どちらもこのプロジェクトではなく、
他者が定めたものです。ml-sharp の**モデル重み**は研究目的で公開されており、
クローン内の `LICENSE_MODEL` に「人工知能および機械学習技術の科学的研究のみを
目的として」とあります。出力をそれ以外に使うなら、まずその条文を読んでください。
またスマートフォン向けビューアは起動時に Google の MediaPipe を CDN から取得する
ため、**このページだけはインターネット接続が必要**で、2つのホストに接続の事実が
伝わります。それ以外はすべて手元で完結します。詳細は
[docs/THIRD_PARTY_NOTICES.md](docs/THIRD_PARTY_NOTICES.md) にあります。

## レンズの指定は見た目以上に効きます

`ml-sharp` は画像の EXIF から焦点距離を読み、無ければ 30mm と仮定します。これは細部ではありません。**シーンを逆投影する画角そのもの**なので、再構成の形と、すべての距離が決まります。実測した写真では、30mm の既定で被写体が 2.66m、85mm を指定すると 7.00m になりました。後者が、そのレンズで撮ったポートレートが実際に立っていた距離です。

見え方も決まります。シーンは作られたときの画角を持ち続けるので、画面がその角度を張る距離でしか実物大に見えません。

    仮定したレンズ    実物大に見える距離
    30 mm                  111 mm
    50 mm                  184 mm
    85 mm                  313 mm

11センチはスマートフォンの持ち方ではありません。EXIF の無い画像なら、アップロード前に **Lens (35 mm equiv.)** 欄にレンズを入れてください（普通のポートレートなら 50〜85mm）。形が正しくなり、腕の長さで無理なく見られるようになります。

## ビューアページ

エディタとは別に、スマートフォン向けのページ `/viewer.html` があります。前面カメラで頭の位置を測り、そこから見た絵を描くので、**画面がガラス窓のようになり、その奥にミニチュアが置かれている**ように見えます。頭を動かすと立体だと分かります。

`scripts/dev.sh` が表示するアドレスをスマートフォンで開いてください:

    https://<このマシン>:5173/viewer.html

エディタが最後に作ったシーンが出ます。**その後も追従します** — PC で新しいシーンを作れば、数秒でスマホ側にも切り替わります。リロードは不要です。1つに固定したいときは `?job=<jobId>&name=<file>.ply`、任意のファイルなら `?scene=<url>` を付けます。アドレスでシーンを指定した場合、自動追従に上書きされることはありません。

シーンを自動で見つけさせた場合、スマホがダウンロードするのは圧縮版で、エディタが使う PLY のおよそ6分の1です。モバイル回線でも実用になります。（アドレスで `.ply` を名指しした場合は、指定どおりそのファイルを落とします。）進捗はページに出ます。エディタ側は元のファイルを使い続けるので、**書き出した画像が圧縮版を経由することはありません**。圧縮には `splat-transform` を使います。フロントエンドの依存関係に含まれているので追加インストールは不要ですが、実行できない場合はスマホにも元のファイルが渡り、理由がジョブのログに残ります。

**HTTPS が必須です。** ブラウザはセキュアオリジンでしかカメラを許可せず、LAN の素の `http://` はこれに当たりません（`localhost` は例外ですが、スマートフォンで開いた `localhost` はそのスマートフォン自身です）。方法は3つあり、どれも開くべきアドレスがそのまま表示されます。

このマシンで既に `tailscale serve` がポート 5173 を張っている場合は、オプション無しが最良です。

    scripts/dev.sh

TLS は Tailscale が 443 で正規の証明書のまま終端するので、スマートフォンでは `https://<このマシン>.ts.net/viewer.html` を開くだけです。ポート番号も警告も不要で、モバイル回線からも届きます。スクリプトはこのマッピングを検出し、そのアドレスを最初に表示します。ここで `--https` や `--tailscale` を付けてはいけません。dev サーバが HTTPS を喋り始める一方 `serve` は素の HTTP を転送し続けるため、食い違って 502 になります。スクリプトはそれを検出したら警告し、2つの直し方を示します。

    scripts/dev.sh --https

このマシンが応答する全アドレス（Tailscale が動いていれば tailnet アドレスも）を記した自己署名証明書を作ります。何も外には出ません。スマートフォンでは警告が1度出ますが、これはこのマシンが自分自身を保証しているだけなので、そのまま進んでください。

    scripts/dev.sh --tailscale

`tailscale cert` で、このマシンの tailnet 名に対する正規の証明書を取得します。警告は出ず、tailnet にサインインしていればモバイル回線からでも開けます。ルーターのポートを開ける必要もありません。

`--tailscale` の代償は明記しておきます。公的な認証局が発行した証明書は Certificate Transparency ログに記録され、これは公開かつ恒久です。公開されるのは `my-laptop.tail1234.ts.net` という**名前だけ**で、それ以外は何も出ません（アドレスも、何を配信しているかも、そもそもこれが存在することも）。何一つ公開したくない場合は `--https` を使い、警告を1度受け入れてください。なお上の `tailscale serve` 経路も同じ種類の証明書を使うので代償は同じですが、それはこのスクリプトではなく `serve` を設定した時点で既に払われています。

### 使い方

**Start 3D** を押し、キャリブレーション中は静止します。iOS はこの1回の操作でカメラとモーションの許可を求めます。モーションを拒否しても失われるのは水平維持だけです。以降、画像を貼り付ければ追跡は自動で始まります。

**Paste image** はクリップボードの画像をそのままシーンにします。保存してファイル選択でまた探すより短く、スマートフォンには快適なファイル管理がないので特に効きます。デスクトップではキーボードでも貼り付けられます。生成には少し時間がかかり、その間はその旨を表示します。

**I am at N mm** は追跡の距離感を較正します。ボタンが示す距離で端末を持ち、その状態で押してください。追跡は「想定サイズの標準顔」を「想定画角のカメラ」で見た前提で当てはめており、**どちらの想定も実機で検証されていません** — ある端末では実際 150mm なのに 300mm と報告しました。誤差は倍率なので、この1つの数字で全距離が直り、記憶されます。

**Hold level** はモデルの水平を保つ機能で、ボタンを押したときの持ち方を基準に、重力から端末の前後傾斜とロールを求めます。True Window では、ロールはモデルの上を重力由来の上方向へ合わせ、前後傾斜はモデルへ逆向きに与えることで、OFF時と同じ方向へ上下を覗けるようにします。どちらも **100%（最大18°）** です。追跡した目位置も同じ基準姿勢へ変換するため、バネのような相殺は起こしません。写真モードで補正するのは半分のロールだけです。前後方向はすべて顔追跡へ任せるため、Hold level のON/OFFで上下方向が変わりません。スマホを回したときの補正は Hold level の ON/OFF に関わらず効きます。ガラスがどちらを向いているかは安定化機能ではなく、窓が窓であるための情報だからです。カメラが動いている間は端末姿勢から相対ヨーを取得し続け、スマホを左右へ回したために生じた見かけの顔移動だけを除き、ガラスの奥の世界を逆向きに変換します。実際に顔を上下左右へ動かした成分は残ります。これが無いと、顔追跡は「スマホが回った」と「顔が動いた」を区別できず、シーンが振れてスプラットの逆側の端が見えてしまいます。重力とヨーはいずれも軽く平滑化し、微小な角度揺れだけを無視します。絶対方位（北）は使いません。18°の上限は前後傾斜・ロールで未撮影の端が露出するのを防ぐためです。**Recenter** で顔・重力・ヨーの基準を取り直せます。

**Reverse tracking** は端末ごとの前面カメラの水平軸を合わせる校正です。実際に頭を動かして正しく見える側（確認した端末では ON）のまま使ってください。スマホ自体の左右旋回は別に処理されるため、この設定を切り替えません。設定は記憶されます。

**ピンチ**の意味はモードで分かれます。**True window** がオンなら、スマホのガラスを同じ物理開口のまま保ち、奥のミニチュアだけを一様に拡大縮小します。オフなら元画像のフレームを寄り引きし、写真整合モードで端の情報量と見かけの大きさを交換します。モード切替時には値を1へ戻すため、切り取り倍率が物理スケールとして持ち越されることはありません。**Reset view** でも1へ戻ります。

**Lens** は、写真がレンズを記録していなかったときだけ出ます。その場合 `ml-sharp` は 30 mm と仮定しますが、これは大きさだけでなく**形**を決めます — 実測した1枚では、被写体が 30 mm で 2.5 m、85 mm で 6.9 m の位置に置かれ、奥行きもそれに応じて伸びました。85 mm で撮ったポートレートを 30 mm で組むと、**平たく潰れます**。

そのため、レンズ情報の無い画像をここに貼っても**すぐには生成しません**。先に入力欄が出て、答えたところで生成が始まります。空欄のままでも構いません（どのみち仮定される 30 mm を選んだことになります）。**全角の数字はそのまま読めます**ので、2文字のために入力モードを切り替える必要はありません。

レンズはシーンを見るまで判断できないので、欄は生成後も残ります。別の数値を入れて **Rebuild** を押せば作り直します。`ml-sharp` を回し直すので、初回と同じくらいの時間がかかります。**押したときだけ**走り、勝手に再生成されることはありません。レンズを記録していた写真では一度も聞きません。360 のシーンは6つの復元を合成したものなので、この方法では作り直せません。

**True window** は、絵をどこから描くかを決めます。オンなら**実際のあなたの目の位置**から固定された物理開口を通して描きます。端末を傾けても形が崩れず、ガラスの先は奥へ行くほど切り取られます — 本物の窓がそうであるように。PLY に撮影内部パラメータがあればそれを使い、無い場合だけ splat の角度分布から推定します。オフなら写真全体がどの奥行きでも画面に収まりますが、代わりに端に近いほど形が伸びます。既定はオンです。

**Depth** はミニチュアをガラスの奥へ、段階的に滑らせます。どれだけ奥に座るかと、指で回したときにどれだけ大きく振れるかが決まります。手前寄りの値ほど振れが小さくなります。立体感のつまみではありません — シーン全体を遠ざけると、深くなるのではなく平たくなります。

**ダブルタップ**でボタンと表示が消え、もう一度で戻ります。**表示をタップ**すると幾何が使っている数値が出ます。詳細表示には、発光しているパネル長辺の実測 mm も入力できます。表示が `estimated` の未知端末でスケールがおかしい場合に使ってください。保存した実測値が端末密度の推定より優先されます。

## クイックスタート

### 前提
- Python 3.10+
- Node.js 20.19 以上（22 か 24 を推奨。18 と 20.19 未満は既にサポート終了）。CI は 24 で動かしています。
- Git
- 動作する `ml-sharp` のインストール（別リポジトリ。下記参照）

任意:
- `uv`（高速な venv + pip）
- CUDA 対応 GPU（ml-sharp の高速化）

### インストールと起動

シーンの描画は PlayCanvas エンジンがおこないます。描画まわりの依存はこれ1つだけです。

1. セットアップスクリプトを実行（Ubuntu / WSL）: `scripts/setup_wsl.sh`
1. スクリプトは ml-sharp とバックエンドの venv を作成し、依存を導入します（`uv` があれば優先）。
1. バックエンド起動: `uvicorn backend.app.main:app --reload`
1. フロントエンド起動: `cd frontend && npm ci && npm run dev`
   - フロントはデフォルトで `http://localhost:8000` をバックエンドに使います。
   - `npm ci` は `package-lock.json` の内容そのままを入れます（CI と同じ）。`npm install` でも動きますが、依存が黙って動くことがあります。
   - バックエンドにも同じものが `backend/uv.lock` としてあります。`uv` があれば `scripts/setup_wsl.sh` がそこから入れるので、検証済みの版が入ります。`uv` が無い場合はバージョン範囲から解決し、その旨を表示します。バックエンドの依存を変えたら `uv lock --project backend` を実行してください。CI がロックとの一致を検査し、ずれていれば失敗します。
   - フロントエンドは自分と同じアドレス経由でバックエンドに届くよう開発サーバーが中継するので、既定のポートなら設定は不要です。
   - 別のホストのバックエンドを見る場合は `SSV_BACKEND_ORIGIN=http://host:port` を設定してください。
1. ブラウザで `http://localhost:5173/` を開きます（Vite dev server の既定 URL）。
1. （任意）`scripts/dev.sh` で backend + frontend を同時起動できます。
1. 画像をアップロードすると `/api/upload` に POST され、`/api/scene/{jobId}/status` をポーリングします。
1. `done` になると PLY が表示され、Download / logs も利用可能になります。mono/SBS の PNG/JPG 保存や params.json 保存が可能です。

### デモ入力（同梱なし）
このリポジトリはサンプル画像を同梱しません。ご自身の画像を使ってください。
- 通常画像: 任意の JPG/PNG。
- 360 画像: 2:1 の equirectangular で、`*.360.jpg` / `*.360.png` という名前。
公開素材が必要な場合は、360 equirectangular の public domain / CC0 画像を探し、必ずライセンスを確認してください。

### 操作

エディタでは、カメラがシーンの周りを回ります。

- ドラッグ: 見ているものを中心に回る
- Shift + ドラッグ: フレーム内で位置をずらす
- ホイール: 近づく・遠ざかる

スマートフォンの `/viewer.html` では、カメラはあなたの頭です。視点ではなく**シーンの側**を動かします。

- 一本指: ミニチュアを回す。横で縦軸まわりに、上下で手前／奥へ倒します（±55°まで）。斜めなら両方同時に効きます。
- 二本指を広げる／狭める: フレームに寄る／引く
- 二本指を揃えて動かす: フレーム内で位置をずらす
- ダブルタップ: ボタン類の表示を切り替え、同時に視点を初期状態へ戻す

SBS 表示のときに出るステレオ設定は以下です。

- **Eye separation** — 両眼間の距離（メートル）。大きいほど立体感が強く、目も疲れます。
- **Depth compression** — 1 未満で奥行きが平たく、1 超で誇張されます。
- **Disparity limit** — ピクセル。左右のずれの上限。0 は無制限。
- **Screen plane** — ガラス面と一致する奥行き。注視点に追従させるか、距離を直接指定します。
- **Swap left and right** — オフは SBS 対応機器やゴーグル向け、オンは大画面での交差法向け（画面の幅が目の間隔を超えると平行法は成立しません）。書き出しにも反映されます。

`.ply` をローカルから直接開くこともできます（ml-sharp なしでプレビュー）。
- params.json の Save/Load
- 表示中の mono / SBS 画像を PNG/JPG 保存

### 360 画像ワークフロー（プレビュー）

- `*.360.jpg` / `*.360.png` をアップロード（2:1 equirectangular）。
- Backend が 6 面を overscan FOV で切り出し、面ごとに ml-sharp を実行して既知回転を適用します。
  - ml-sharp を 6 回実行するため、通常画像よりおおむね 6 倍時間がかかります（環境依存）。
- merge CLI が利用可能なら `<input-stem>.ply`（例: `abc.360.ply`）を生成します。
- Optional merge CLI: `setup_wsl.sh` は `@playcanvas/splat-transform` をベストエフォートで導入し、`scripts/dev.sh` が自動検出します。失敗した場合は `SPLAT_MERGE_CLI` を設定するか `splat-transform` を `PATH` に入れてください。想定コマンドは以下:
  `splat-transform -w <face_0.ply> ... <face_5.ply> <abc.360.ply>`

## 速度

セッションで最初の1枚は約16秒、2枚目以降は約3.5秒です。

最初の16秒はほとんどが準備で、実際の仕事ではありません。`sharp predict` は torch を読み込み、2つの Vision Transformer を構築し、チェックポイントを読んで GPU に載せ、そのあと1秒ほど画像を処理します。アップロードのたびにこれを繰り返していたため、360（6面）のジョブは7秒分の推論に100秒かかっていました。

そこでバックエンドは起動時に ml-sharp の常駐プロセス（`scripts/sharp_worker.py`）を1つ立ち上げ、モデルをメモリに保持します。**起動は待たされません** — サーバーは即座に応答を返し、モデルはその裏で読み込まれるので、写真を選ぶ頃にはたいてい暖まっています。実測では、同じ画像がコマンドライン経由で16.5秒、暖まったワーカー経由で3.4秒、出力 PLY は**バイト単位で同一**でした。360 は約100秒から30秒になりました。

依存はしていません。ワーカーが起動できない・落ちた・失敗を返した場合、その画像は従来どおりコマンドライン経由で処理されます。止めるには `SHARP_WORKER=0` を設定してください。`ML_SHARP_CLI` がこのリポジトリ外の ml-sharp を指している場合、ワーカーは黙って別のモデルを使うことを避けて手を引きます。両方使いたい場合は `SHARP_WORKER_PYTHON` でインタプリタを明示してください。

## 制限 / 注意
- 外部の ml-sharp インストールが必須で、GPU/CPU 環境によって処理時間が大きく変わります。
- 360 モードは簡易パイプラインのため、特に近距離では継ぎ目のアーティファクトが出る場合があります。
- SBS 出力は立体視向けです。視差設定を極端にすると見づらくなります。

## Contributing
- 依存追加時は `docs/THIRD_PARTY_NOTICES.md` を更新してください。
- 「第三者コード同梱なし」の方針を守ってください。

## Acknowledgements
- ml-sharp（Apple Machine Learning Research）: 単一画像からのスプラット生成の中核。
- PlayCanvas: ガウシアンスプラットを描画するエンジン。
