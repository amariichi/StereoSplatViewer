import { useEffect, useRef, useState } from "react";
import "./app.css";
import {
  cleanupCache,
  fetchLogs,
  fetchMetadata,
  fetchStatus,
  resolveAssetUrl,
  uploadFile,
} from "./api";
import type { JobStatus, SceneMetadata } from "./api";
import type { ViewerHandle } from "./viewer/PLYViewer";
import { SuperSplatViewer } from "./viewer/SuperSplatViewer";
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
  zeroParallaxMode: "pivot" | "click";
  zeroParallaxDistance: number;
  compression: number;
  clampPx: number;
  framingLock: boolean;
  comfortLock: boolean;
  comfortStrength: number;
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
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [logs, setLogs] = useState<{ stdout: string; stderr: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [meta, setMeta] = useState<SceneMetadata | null>(null);
  const [mode, setMode] = useState<"mono" | "sbs">("mono");
  const [baseline, setBaseline] = useState(0.12);
  const [fovDeg, setFovDeg] = useState(65);
  const [zeroParallaxMode, setZeroParallaxMode] = useState<"pivot" | "click">(
    "click",
  );
  const [zeroParallaxDistance, setZeroParallaxDistance] = useState(2.0);
  const [compression, setCompression] = useState(1.0);
  const [clampPx, setClampPx] = useState(0);
  const [framingLock, setFramingLock] = useState(false);
  const [comfortLock, setComfortLock] = useState(false);
  const [comfortStrength, setComfortStrength] = useState(1.0);
  const [hiResReady, setHiResReady] = useState(false);
  const viewerParams: ViewerParams = {
    mode,
    baseline,
    fovDeg,
    zeroParallaxMode,
    zeroParallaxDistance,
    compression,
    clampPx,
    framingLock,
    comfortLock,
    comfortStrength,
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
      const res = await uploadFile(file);
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
    try {
      await cleanupCache();
    } catch (err) {
      console.warn("Cache cleanup failed", err);
    }
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
          if (parsed.viewer.zeroParallaxMode === "pivot" || parsed.viewer.zeroParallaxMode === "click") {
            setZeroParallaxMode(parsed.viewer.zeroParallaxMode);
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
          if (typeof parsed.viewer.framingLock === "boolean") {
            setFramingLock(parsed.viewer.framingLock);
          }
          if (typeof parsed.viewer.comfortLock === "boolean") {
            setComfortLock(parsed.viewer.comfortLock);
          }
          if (typeof parsed.viewer.comfortStrength === "number") {
            setComfortStrength(parsed.viewer.comfortStrength);
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

  const handleResetViewer = () => {
    setMode("mono");
    setBaseline(0.12);
    setFovDeg(65);
    setZeroParallaxMode("click");
    setZeroParallaxDistance(2.0);
    setCompression(1.0);
    setClampPx(0);
    setFramingLock(false);
    setComfortLock(false);
    setComfortStrength(1.0);
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
    viewerRef.current?.setZeroParallaxFromPivot();
  };

  const handleFovChange = (next: number) => {
    const clamped = clampFov(next);
    setFovDeg((prev) => (Math.abs(prev - clamped) < 0.01 ? prev : clamped));
  };

  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">Alpha</p>
          <h1>StereoSplatViewer</h1>
          <p className="lede">
            Upload a single image, run ml-sharp via the backend, and preview the generated PLY.
            Frontend rendering currently uses a basic Three.js PLY point-cloud view; SuperSplat-based
            stereo/SBS controls will follow.
          </p>
        </div>
      </header>

      <section className="panel">
        <h2>1. Upload image</h2>
        <form onSubmit={handleSubmit} className="upload-form">
          <input
            type="file"
            accept="image/*"
            required
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            disabled={isUploading}
          />
          <button type="submit" disabled={!file || isUploading}>
            {isUploading ? "Uploading…" : "Upload & Run ml-sharp"}
          </button>
        </form>
        <div className="row">
          <label className="field">
            <span>Or load local PLY</span>
            <input type="file" accept=".ply" onChange={handleLocalPlyChange} />
          </label>
        </div>
        {error && <p className="error">Error: {error}</p>}
      </section>

      {job && (
        <section className="panel">
          <h2>2. Job status</h2>
          <p>
            <strong>ID:</strong> {job.jobId}
          </p>
          <p>
            <strong>Status:</strong> {status?.status ?? "pending"}
            {status?.message ? ` — ${status.message}` : ""}
          </p>
          <div className="row">
            <button onClick={() => setStatus(null)} disabled={!job}>
              Refresh status
            </button>
            <button onClick={handleFetchLogs} disabled={!job}>
              Fetch logs
            </button>
            {viewerPlyUrl && (
              <a href={viewerPlyUrl} download>
                Download PLY
              </a>
            )}
          </div>
          {logs && (
            <details className="logs">
              <summary>Logs</summary>
              <pre>
                stdout:
                {"\n"}
                {logs.stdout || "(empty)"}
              </pre>
              <pre>
                stderr:
                {"\n"}
                {logs.stderr || "(empty)"}
              </pre>
            </details>
          )}
        </section>
      )}

      {canPreview && (
        <section className="panel">
          <h2>3. Preview PLY</h2>
          <div className="row">
            <label className="field">
              <span>Mode</span>
              <select value={mode} onChange={(e) => setMode(e.target.value as "mono" | "sbs")}>
                <option value="mono">Mono</option>
                <option value="sbs">SBS</option>
              </select>
            </label>
            <label className="field">
              <span>Baseline</span>
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
              <span>FOV ({Math.round(fovDeg)}°)</span>
              <input
                type="range"
                min="20"
                max="110"
                step="1"
                value={fovDeg}
                onChange={(e) => setFovDeg(clampFov(Number(e.target.value)))}
              />
            </label>
            <label className="field">
              <span>Compression</span>
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
              <span>Clamp (px)</span>
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
              <span>Zero parallax</span>
              <select
                value={zeroParallaxMode}
                onChange={(e) =>
                  setZeroParallaxMode(e.target.value as "pivot" | "click")
                }
              >
                <option value="pivot">Pivot only</option>
                <option value="click">Double click</option>
              </select>
            </label>
            <button type="button" onClick={handleZeroParallaxFromPivot}>
              Set ZP from pivot
            </button>
            <label className="field checkbox">
              <span>Framing lock</span>
              <input
                type="checkbox"
                checked={framingLock}
                onChange={(e) => setFramingLock(e.target.checked)}
              />
            </label>
            <label className="field checkbox">
              <span>Comfort lock</span>
              <input
                type="checkbox"
                checked={comfortLock}
                onChange={(e) => setComfortLock(e.target.checked)}
              />
            </label>
            <label className="field">
              <span>Comfort strength</span>
              <input
                type="number"
                step="0.1"
                min="0"
                max="2"
                value={comfortStrength}
                onChange={(e) => setComfortStrength(Number(e.target.value))}
              />
            </label>
            <button type="button" onClick={handleResetViewer}>
              Reset view params
            </button>
            <div className="row gap-sm">
              <button type="button" onClick={handleExportParams}>
                Save params.json
              </button>
              <label className="field file-button">
                <span>Load params.json</span>
                <input type="file" accept="application/json" onChange={handleImportParams} />
              </label>
              <button type="button" onClick={() => handleExportImage("image/png")}>
                Save PNG
              </button>
              <button type="button" onClick={() => handleExportImage("image/jpeg")}>
                Save JPG
              </button>
              {mode === "sbs" && (
                <>
                  <button type="button" onClick={handleFullscreenSbs}>
                    SBS Fullscreen
                  </button>
                  <span className="status-pill">
                    {hiResReady ? "Hi-res ready" : "Hi-res pending"}
                  </span>
                </>
              )}
            </div>
          </div>
          <div className="viewer-wrapper">
            <SuperSplatViewer
              ref={viewerRef}
              plyUrl={viewerPlyUrl ?? ""}
              mode={mode}
              baseline={baseline}
              fovDeg={fovDeg}
              zeroParallaxMode={zeroParallaxMode}
              zeroParallaxDistance={zeroParallaxDistance}
              compression={compression}
              clampPx={clampPx}
              onFovChange={handleFovChange}
              onOffscreenReadyChange={setHiResReady}
            />
          </div>
          <p className="hint">
            Tip: LMB orbit, Shift+LMB pan, Ctrl+LMB adjust FOV, wheel zoom. SuperSplat now supports
            SBS rendering; the Three.js viewer remains in the codebase as a fallback (not exposed in
            the UI).
          </p>
          {meta?.mode360?.enabled && !meta?.mode360?.mergedPly && (
            <p className="hint">
              360 merge is not available. Install `splat-transform` or set `SPLAT_MERGE_CLI` to
              enable merged PLY downloads.
            </p>
          )}
        </section>
      )}
    </main>
  );
}

export default App;
