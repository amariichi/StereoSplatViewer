import { useEffect, useRef, useState } from "react";
import "./app.css";
import {
  cleanupCache,
  fetchLatestScene,
  fetchLogs,
  fetchMetadata,
  fetchStatus,
  resolveAssetUrl,
  uploadFile,
} from "./api";
import type { JobStatus, SceneMetadata } from "./api";
import type { ViewerHandle } from "./types";
import { imageFromPasteEvent, readImageFromClipboard } from "./device/clipboard-image";
import { SplatViewer } from "./viewer/SplatViewer";
import { fetchPlyCameraFov } from "./ply_meta";

type JobInfo = {
  jobId: string;
  plyUrl: string;
  statusUrl: string;
  logsUrl: string;
  metaUrl?: string;
};

type ViewerParams = {
  mode: "mono" | "sbs";
  baseline: number;
  fovDeg: number;
  zeroParallaxMode: "pivot" | "fixed";
  zeroParallaxDistance: number;
  compression: number;
  clampPx: number;
  swapLR: boolean;
};

const clampFov = (value: number) => {
  if (!Number.isFinite(value)) return 65;
  return Math.min(110, Math.max(20, value));
};

const stripExtension = (name: string) => {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
};

function App() {
  const [file, setFile] = useState<File | null>(null);
  const [localPlyUrl, setLocalPlyUrl] = useState<string | null>(null);
  const [job, setJob] = useState<JobInfo | null>(null);
  const [heldScene, setHeldScene] = useState<{ jobId: string; name: string; plyUrl: string } | null>(
    null,
  );
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [treatSky, setTreatSky] = useState(false);
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [logs, setLogs] = useState<{ stdout: string; stderr: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  // ml-sharp reads the lens from EXIF and falls back to 30 mm. That assumption
  // decides the field of view the scene is unprojected through, and so both its
  // shape and the distance it can comfortably be viewed from. Left empty, the
  // file's own EXIF is used if it has any.
  const [focalLength35mm, setFocalLength35mm] = useState<number | null>(null);
  const [pasteError, setPasteError] = useState<string | null>(null);

  // Pasting with the keyboard needs no permission at all, and is how a desktop
  // does it. The button is for phones, which have no keyboard to paste from.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const pasted = imageFromPasteEvent(event);
      if (!pasted) return;
      event.preventDefault();
      setPasteError(null);
      setFile(pasted);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);
  const [meta, setMeta] = useState<SceneMetadata | null>(null);
  const [mode, setMode] = useState<"mono" | "sbs">("mono");
  const [baseline, setBaseline] = useState(0.12);
  const [fovDeg, setFovDeg] = useState(65);
  const [zeroParallaxMode, setZeroParallaxMode] = useState<"pivot" | "fixed">(
    "fixed",
  );
  const [zeroParallaxDistance, setZeroParallaxDistance] = useState(2.0);
  const [compression, setCompression] = useState(1.0);
  const [clampPx, setClampPx] = useState(0);
  const [swapLR, setSwapLR] = useState(false);
  const [hiResReady, setHiResReady] = useState(false);
  const viewerParams: ViewerParams = {
    mode,
    baseline,
    fovDeg,
    zeroParallaxMode,
    zeroParallaxDistance,
    compression,
    clampPx,
    swapLR,
  };
  const viewerRef = useRef<ViewerHandle | null>(null);
  const lastPlyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!job || !job.statusUrl) return;
    if (status?.status === "done" || status?.status === "error") return;

    let timer: number | undefined;
    const poll = async () => {
      try {
        const res = await fetchStatus(job.statusUrl);
        setStatus(res);
        if (res.status === "done" || res.status === "error") return;
        timer = window.setTimeout(poll, 1500);
      } catch (err) {
        console.error(err);
        setError((err as Error).message);
      }
    };
    poll();
    return () => {
      if (timer) window.clearTimeout(timer);
    };
  }, [job, status?.status]);

  useEffect(() => {
    return () => {
      if (localPlyUrl) {
        URL.revokeObjectURL(localPlyUrl);
      }
    };
  }, [localPlyUrl]);

  const handleSubmit = async (evt: React.FormEvent<HTMLFormElement>) => {
    evt.preventDefault();
    if (!file) return;
    setIsUploading(true);
    setError(null);
    setLogs(null);
    setStatus(null);
    setJob(null);
    setMeta(null);
    try {
      await cleanupCache();
      const res = await uploadFile(file, focalLength35mm, treatSky);
      setJob(res);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsUploading(false);
    }
  };

  const handleLocalPlyChange = async (evt: React.ChangeEvent<HTMLInputElement>) => {
    const plyFile = evt.target.files?.[0];
    if (!plyFile) return;
    // Opening a file from this machine is a local act: the browser reads it
    // straight from disk and the server never sees it. Clearing the server's
    // scene here used to throw away whatever the phone was looking at.
    if (localPlyUrl) {
      URL.revokeObjectURL(localPlyUrl);
    }
    const url = URL.createObjectURL(plyFile);
    setLocalPlyUrl(url);
    setJob(null);
    setStatus(null);
    setLogs(null);
    setMeta(null);
    setError(null);
    evt.target.value = "";
  };

  const handleFetchLogs = async () => {
    if (!job) return;
    try {
      const res = await fetchLogs(job.logsUrl);
      setLogs(res);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const plyResolved = localPlyUrl ?? (job?.plyUrl ? resolveAssetUrl(job.plyUrl) : null);
  const mergedPlyUrl =
    job?.jobId && meta?.mode360?.mergedPly
      ? resolveAssetUrl(`/api/scene/${job.jobId}/${meta.mode360.mergedPly}`)
      : null;
  const viewerPlyUrl =
    localPlyUrl ??
    (meta?.mode360?.enabled ? mergedPlyUrl ?? null : mergedPlyUrl ?? plyResolved);
  const canPreview = Boolean(viewerPlyUrl && (localPlyUrl || status?.status === "done"));

  // The phone opens the same server, one page along. Saying so here saves
  // guessing at the address, which is the part that is easy to get wrong.
  const phoneViewerUrl =
    typeof window === "undefined" ? "/viewer.html" : `${window.location.origin}/viewer.html`;
  const phoneNeedsNetworkAddress =
    typeof window !== "undefined" &&
    ["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(window.location.hostname);

  useEffect(() => {
    const fovSource = viewerPlyUrl;
    if (!canPreview || !fovSource) return;
    if (lastPlyRef.current === fovSource) return;
    lastPlyRef.current = fovSource;
    let active = true;
    const loadFov = async () => {
      try {
        const fov = await fetchPlyCameraFov(fovSource);
        if (!active || fov == null) return;
        setFovDeg(clampFov(fov));
      } catch (err) {
        console.warn("Failed to load PLY FOV", err);
      }
    };
    loadFov();
    return () => {
      active = false;
    };
  }, [canPreview, viewerPlyUrl]);

  useEffect(() => {
    if (!job?.metaUrl || status?.status !== "done") return;
    let active = true;
    const loadMetadata = async () => {
      try {
        const payload = await fetchMetadata(job.metaUrl ?? "");
        if (!active) return;
        setMeta(payload);
      } catch (err) {
        if (!active) return;
        setMeta(null);
      }
    };
    loadMetadata();
    return () => {
      active = false;
    };
  }, [job?.metaUrl, job?.jobId, status?.status]);

  const handleExportParams = () => {
    const data = {
      job,
      viewer: viewerParams,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "params.json";
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleImportParams = (evt: React.ChangeEvent<HTMLInputElement>) => {
    const paramFile = evt.target.files?.[0];
    if (!paramFile) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string);
        if (parsed.viewer) {
          if (parsed.viewer.mode === "mono" || parsed.viewer.mode === "sbs") {
            setMode(parsed.viewer.mode);
          }
          if (typeof parsed.viewer.baseline === "number") {
            setBaseline(parsed.viewer.baseline);
          }
          if (typeof parsed.viewer.fovDeg === "number") {
            setFovDeg(clampFov(parsed.viewer.fovDeg));
          }
          if (parsed.viewer.zeroParallaxMode === "pivot" || parsed.viewer.zeroParallaxMode === "fixed") {
            setZeroParallaxMode(parsed.viewer.zeroParallaxMode);
          } else if (parsed.viewer.zeroParallaxMode === "click") {
            // Older files call the fixed-distance mode "click", from when it was
            // meant to be set by double-clicking the scene. It never was.
            setZeroParallaxMode("fixed");
          } else if (parsed.viewer.zeroParallaxMode === "slider") {
            setZeroParallaxMode("pivot");
          }
          if (typeof parsed.viewer.zeroParallaxDistance === "number") {
            setZeroParallaxDistance(parsed.viewer.zeroParallaxDistance);
          }
          if (typeof parsed.viewer.compression === "number") {
            setCompression(parsed.viewer.compression);
          }
          if (typeof parsed.viewer.clampPx === "number") {
            setClampPx(parsed.viewer.clampPx);
          }
          if (typeof parsed.viewer.swapLR === "boolean") {
            setSwapLR(parsed.viewer.swapLR);
          }
        }
        if (parsed.job) {
          setJob(parsed.job);
          setStatus(null);
          setLogs(null);
        }
      } catch (err) {
        setError(`Failed to import params: ${(err as Error).message}`);
      }
    };
    reader.readAsText(paramFile);
    evt.target.value = "";
  };

  // Ask the server what it is holding, so a scene that outlived a restart can
  // be opened here rather than only on the phone.
  useEffect(() => {
    let active = true;
    fetchLatestScene()
      .then((scene) => {
        if (active) setHeldScene(scene);
      })
      .catch(() => {
        if (active) setHeldScene(null);
      });
    return () => {
      active = false;
    };
  }, [job?.jobId, status?.status]);

  const handleOpenHeldScene = () => {
    if (!heldScene) return;
    if (localPlyUrl) {
      URL.revokeObjectURL(localPlyUrl);
      setLocalPlyUrl(null);
    }
    setJob({
      jobId: heldScene.jobId,
      plyUrl: heldScene.plyUrl,
      statusUrl: `/api/scene/${heldScene.jobId}/status`,
      logsUrl: `/api/scene/${heldScene.jobId}/logs`,
      metaUrl: `/api/scene/${heldScene.jobId}/metadata.json`,
    });
    setStatus({ status: "done", message: "held by the server" });
    setLogs(null);
    setError(null);
  };

  const handleRemoveHeldScene = async () => {
    // Two clicks rather than a dialog. The scene took minutes of GPU time to
    // make and there is no undo, so a single stray click should not end it.
    if (!confirmingRemove) {
      setConfirmingRemove(true);
      return;
    }
    setConfirmingRemove(false);
    try {
      await cleanupCache();
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    if (localPlyUrl) {
      URL.revokeObjectURL(localPlyUrl);
      setLocalPlyUrl(null);
    }
    setHeldScene(null);
    setJob(null);
    setStatus(null);
    setLogs(null);
    setMeta(null);
    setError(null);
  };

  const handleResetViewer = () => {
    setMode("mono");
    setBaseline(0.12);
    setFovDeg(65);
    setZeroParallaxMode("fixed");
    setZeroParallaxDistance(2.0);
    setCompression(1.0);
    setClampPx(0);
    setSwapLR(false);
  };

  const handleExportImage = async (format: "image/png" | "image/jpeg") => {
    const exportSize = { width: 1920, height: 1080 };
    const dataUrl =
      (await viewerRef.current?.captureAsync?.(format, exportSize)) ??
      viewerRef.current?.capture(format);
    if (!dataUrl) {
      setError("Failed to capture image");
      return;
    }
    const fallbackStem = job?.plyUrl
      ? stripExtension(job.plyUrl.split("/").pop() ?? "sbs")
      : "sbs";
    const stem = file?.name ? stripExtension(file.name) : fallbackStem;
    const link = document.createElement("a");
    link.href = dataUrl;
    link.download = `${stem}_sbs${format === "image/png" ? ".png" : ".jpg"}`;
    link.click();
  };

  const handleFullscreenSbs = () => {
    viewerRef.current?.enterFullscreen();
  };

  const handleZeroParallaxFromPivot = () => {
    // Freeze the plane of the screen at whatever the camera is looking at now.
    const distance = viewerRef.current?.pivotDistance();
    if (!distance || !Number.isFinite(distance) || distance <= 0) return;
    setZeroParallaxDistance(Number(distance.toFixed(3)));
    setZeroParallaxMode("fixed");
  };

  const handleFovChange = (next: number) => {
    const clamped = clampFov(next);
    setFovDeg((prev) => (Math.abs(prev - clamped) < 0.01 ? prev : clamped));
  };

  return (
    <div className="app">
      <header className="app__header">
        <h1>StereoSplatViewer</h1>
        <p className="lede">
          One photograph becomes a Gaussian splat scene &mdash; side by side on this screen, or
          a window on your phone that you look around by moving your head.
        </p>
      </header>

      <div className="app__body">
        <section className="stage">
          <div className="stage__frame">
            {(isUploading ||
              (status?.status && status.status !== "done" && status.status !== "error")) && (
              <div className="building-banner">
                <div className="building-banner__spinner" />
                <div className="building-banner__text">
                  {isUploading ? "Sending the image" : "Generating the scene"}
                </div>
                <div className="building-banner__note">This takes a little while.</div>
              </div>
            )}
            {canPreview ? (
              <SplatViewer
                ref={viewerRef}
                plyUrl={viewerPlyUrl ?? ""}
                mode={mode}
                baseline={baseline}
                fovDeg={fovDeg}
                zeroParallaxMode={zeroParallaxMode}
                zeroParallaxDistance={zeroParallaxDistance}
                compression={compression}
                clampPx={clampPx}
                swapLR={swapLR}
                onFovChange={handleFovChange}
                onOffscreenReadyChange={setHiResReady}
              />
            ) : (
              <div className="stage__empty">
                <p className="stage__empty-title">Nothing loaded yet</p>
                <p>
                  Choose a photograph on the right, or press <kbd>Ctrl</kbd>+<kbd>V</kbd> to
                  paste one straight from the clipboard.
                </p>
                {heldScene && (
                  <p className="stage__held">
                    The server is still holding <strong>{heldScene.name}</strong>.{" "}
                    <button type="button" className="btn btn--ghost" onClick={handleOpenHeldScene}>
                      Open it
                    </button>
                    <button
                      type="button"
                      className="btn btn--quiet"
                      onClick={handleRemoveHeldScene}
                      onBlur={() => setConfirmingRemove(false)}
                    >
                      {confirmingRemove ? "Really remove it?" : "Remove"}
                    </button>
                  </p>
                )}
              </div>
            )}
          </div>
          {canPreview && (
            <p className="stage__hint">
              Drag to orbit · Shift+drag to pan · Wheel to zoom
            </p>
          )}
        </section>

        <aside className="sidebar">
          <section className="card">
            <h2>Source</h2>
            <form onSubmit={handleSubmit} className="stack">
              <div className="source-pick">
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  disabled={isUploading}
                />
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={isUploading}
                  onClick={async () => {
                    setPasteError(null);
                    const result = await readImageFromClipboard();
                    if (result.ok === true) {
                      setFile(result.file);
                      return;
                    }
                    setPasteError(
                      result.reason === "unsupported"
                        ? "This browser will not let a page read the clipboard. Paste with the keyboard instead."
                        : result.reason === "empty"
                          ? "There is no image on the clipboard."
                          : "Reading the clipboard was refused.",
                    );
                  }}
                >
                  Paste
                </button>
              </div>
              {file && <p className="chosen">{file.name}</p>}
              {pasteError && <p className="paste-error">{pasteError}</p>}
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={treatSky}
                  onChange={(e) => setTreatSky(e.target.checked)}
                  disabled={isUploading}
                />
                <span>
                  Fix a blown-out sky
                  <em>
                    Where the sky is overexposed to flat white the depth model
                    has nothing to measure, and part of it lands at the
                    subject&apos;s own distance, as a white wall around the
                    head. This adds a faint gradient there, too slight to see.
                    It helps only when that is what went wrong, so try it if the
                    background looks wrong and leave it off otherwise.
                  </em>
                </span>
              </label>
              <div className="source-run">
                <label className="field">
                  <span>Lens (35 mm eq.)</span>
                  <input
                    type="number"
                    min={10}
                    max={800}
                    step={1}
                    placeholder="EXIF"
                    value={focalLength35mm ?? ""}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      setFocalLength35mm(Number.isFinite(next) && next > 0 ? next : null);
                    }}
                  />
                </label>
                <button type="submit" className="btn btn--primary" disabled={!file || isUploading}>
                  {isUploading ? "Uploading…" : "Generate"}
                </button>
              </div>
            </form>
            <details className="tucked">
              <summary>Open a .ply from this machine</summary>
              <input type="file" accept=".ply" onChange={handleLocalPlyChange} />
            </details>
            {error && <p className="error">{error}</p>}
          </section>

          {job && (
            <section className="card">
              <h2>Job</h2>
              <p className="kv">
                <span>Status</span>
                <strong>
                  {status?.status ?? "pending"}
                  {status?.message ? ` — ${status.message}` : ""}
                </strong>
              </p>
              <p className="kv">
                <span>Id</span>
                <code>{job.jobId}</code>
              </p>
              {status?.status === "done" && (
                <p className="phone-ready">
                  Ready on your phone. Open{" "}
                  <a href="/viewer.html" target="_blank" rel="noreferrer">
                    {phoneViewerUrl}
                  </a>{" "}
                  there and move your head to look around it.
                  {phoneNeedsNetworkAddress && (
                    <>
                      {" "}
                      This page is being browsed as{" "}
                      <code>{window.location.hostname}</code>, which means nothing on the phone.
                      Reach it by the network name or address of this machine instead.
                    </>
                  )}
                </p>
              )}
              {meta?.mode360?.enabled && !meta?.mode360?.mergedPly && status?.status === "done" && (
                <p className="error">
                  The six cube faces were generated but never merged into one scene, so there is
                  nothing to preview. The merge needs the <code>splat-transform</code> command:
                  install it with <code>npm install -g @playcanvas/splat-transform</code>, or point{" "}
                  <code>SPLAT_MERGE_CLI</code> at it, then restart the backend and upload again.
                  The faces are in the job folder as face_0.ply … face_5.ply.
                </p>
              )}
              <div className="row">
                <button className="btn btn--quiet" onClick={() => setStatus(null)}>
                  Refresh
                </button>
                <button className="btn btn--quiet" onClick={handleFetchLogs}>
                  Logs
                </button>
                {viewerPlyUrl && (
                  <a className="btn btn--quiet" href={viewerPlyUrl} download>
                    Download .ply
                  </a>
                )}
                <button
                  className="btn btn--quiet"
                  onClick={handleRemoveHeldScene}
                  onBlur={() => setConfirmingRemove(false)}
                  title="Delete the scene from the server. The phone viewer will have nothing to show."
                >
                  {confirmingRemove ? "Really remove it?" : "Remove from server"}
                </button>
              </div>
              {logs && (
                <details className="logs">
                  <summary>Output</summary>
                  <pre>{logs.stdout || "(stdout empty)"}</pre>
                  <pre>{logs.stderr || "(stderr empty)"}</pre>
                </details>
              )}
            </section>
          )}

          {canPreview && (
            <section className="card">
              <h2>View</h2>
              <div className="segmented" role="group" aria-label="Mode">
                <button
                  type="button"
                  className={mode === "mono" ? "is-on" : ""}
                  onClick={() => setMode("mono")}
                >
                  Mono
                </button>
                <button
                  type="button"
                  className={mode === "sbs" ? "is-on" : ""}
                  onClick={() => setMode("sbs")}
                >
                  Side by side
                </button>
              </div>
              <label className="field">
                <span>
                  Field of view
                  <output>{Math.round(fovDeg)}°</output>
                </span>
                <input
                  type="range"
                  min="20"
                  max="110"
                  step="1"
                  value={fovDeg}
                  onChange={(e) => setFovDeg(clampFov(Number(e.target.value)))}
                />
              </label>
            </section>
          )}

          {canPreview && mode === "sbs" && (
            <section className="card">
              <h2>Stereo</h2>
              <label className="field">
                <span>
                  Eye separation
                  <em>Metres between the two eyes. Larger means more depth, and more strain.</em>
                </span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="1"
                  value={baseline}
                  onChange={(e) => setBaseline(Number(e.target.value))}
                />
              </label>
              <label className="field">
                <span>
                  Depth compression
                  <em>Below 1 flattens the scene, above 1 exaggerates it.</em>
                </span>
                <input
                  type="number"
                  step="0.05"
                  min="0.1"
                  max="2"
                  value={compression}
                  onChange={(e) => setCompression(Number(e.target.value))}
                />
              </label>
              <label className="field">
                <span>
                  Disparity limit
                  <em>Pixels. Caps how far apart the two eyes may put a point. 0 is no limit.</em>
                </span>
                <input
                  type="number"
                  step="1"
                  min="0"
                  max="500"
                  value={clampPx}
                  onChange={(e) => setClampPx(Number(e.target.value))}
                />
              </label>
              <label className="field">
                <span>
                  Screen plane
                  <em>The depth that sits in the glass. Nearer things come out at you.</em>
                </span>
                <select
                  value={zeroParallaxMode}
                  onChange={(e) => setZeroParallaxMode(e.target.value as "pivot" | "fixed")}
                >
                  <option value="pivot">Follows what you look at</option>
                  <option value="fixed">Fixed distance</option>
                </select>
              </label>
              {zeroParallaxMode === "fixed" && (
                <label className="field">
                  <span>Distance (m)</span>
                  <input
                    type="number"
                    step="0.1"
                    min="0.1"
                    max="100"
                    value={zeroParallaxDistance}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      if (Number.isFinite(next) && next > 0) setZeroParallaxDistance(next);
                    }}
                  />
                </label>
              )}
              <button type="button" className="btn btn--ghost" onClick={handleZeroParallaxFromPivot}>
                Use the current distance
              </button>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={swapLR}
                  onChange={(e) => setSwapLR(e.target.checked)}
                />
                <span>
                  Swap left and right
                  <em>
                    Off suits a side-by-side display or a headset. On is for
                    free viewing cross-eyed, which is the only way a pair wider
                    than your eyes can be fused. Exports follow this too.
                  </em>
                </span>
              </label>
            </section>
          )}

          {canPreview && (
            <section className="card">
              <h2>Export</h2>
              <div className="row">
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => handleExportImage("image/png")}
                >
                  Save PNG
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => handleExportImage("image/jpeg")}
                >
                  Save JPG
                </button>
                {mode === "sbs" && (
                  <button type="button" className="btn btn--ghost" onClick={handleFullscreenSbs}>
                    Fullscreen
                  </button>
                )}
              </div>
              {mode === "sbs" && (
                <p className="status-pill">
                  {hiResReady ? "Hi-res export ready" : "Hi-res export warming up"}
                </p>
              )}
              <div className="row">
                <button type="button" className="btn btn--quiet" onClick={handleExportParams}>
                  Save settings
                </button>
                <label className="btn btn--quiet file-button">
                  <span>Load settings</span>
                  <input type="file" accept="application/json" onChange={handleImportParams} />
                </label>
                <button type="button" className="btn btn--quiet" onClick={handleResetViewer}>
                  Reset
                </button>
              </div>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}

export default App;
