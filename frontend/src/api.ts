// Same origin by default. The dev server proxies /api to the backend, so the
// request carries the page's own scheme and host and there is no mixed-content
// or CORS question to answer. Set VITE_API_BASE to reach a backend elsewhere.
const API_BASE = import.meta.env.VITE_API_BASE ?? "";

export type SkyReport = {
  /** How much of the frame is overexposed to white. */
  blownFraction: number;
  /** How much of the top edge that white reaches. */
  topEdgeFraction: number;
  /** How flat it is, in levels out of 255. Below about 1.5 is featureless. */
  textureInBlown: number;
  /** Whether this looks like the case where treating the sky helps. */
  looksBlownOut: boolean;
  /** Present when treatment was asked for; whether it changed the image. */
  treated?: boolean;
};

export type UploadResponse = {
  jobId: string;
  plyUrl: string;
  statusUrl: string;
  logsUrl: string;
  metaUrl?: string;
  sky?: SkyReport;
};

export type JobStatus = {
  status: "pending" | "running" | "done" | "error";
  message?: string;
};

export type SceneMetadata = {
  mode360?: {
    enabled?: boolean;
    mergedPly?: string | null;
  };
};

export async function uploadFile(
  file: File,
  focalLength35mm?: number | null,
  treatSky = false,
): Promise<UploadResponse> {
  const formData = new FormData();
  formData.append("file", file);
  // ml-sharp reads the lens from EXIF and assumes 30 mm when there is none.
  // That sets the field of view the scene is unprojected through, so it decides
  // both the shape of the reconstruction and how far away it can comfortably be
  // looked at: 30 mm puts the natural viewing distance around 11 cm, and 85 mm
  // around 31 cm, which is arm's length.
  if (focalLength35mm && Number.isFinite(focalLength35mm) && focalLength35mm > 0) {
    formData.append("focal_length_35mm", String(focalLength35mm));
  }
  // A sky overexposed to flat white gives the depth model nothing to measure,
  // and a quarter of it can be placed at the subject's own distance. Asking for
  // it to be treated fixes that where it happens; where the sky was already
  // readable it makes things slightly worse, so it is never assumed.
  if (treatSky) {
    formData.append("treat_sky", "true");
  }
  const res = await fetch(`${API_BASE}/api/upload`, {
    method: "POST",
    body: formData,
  });
  if (!res.ok) {
    throw new Error(`Upload failed with status ${res.status}`);
  }
  return res.json();
}

/**
 * Build the scene the server is holding again, through a different lens.
 *
 * The source photograph is still in the job directory, so this needs only the
 * number: no second upload, and the scene keeps its job id rather than becoming
 * a new one. Worth having because the lens cannot be judged before the scene
 * exists -- a photograph recording none is unprojected through SHARP's 30 mm
 * default, and if that is wrong the depth is wrong with it, visibly. The only
 * way to find the right one is to try it and look.
 */
export async function rebuildWithLens(
  jobId: string,
  focalLength35mm: number,
): Promise<{ jobId: string; focalUsed: number; statusUrl: string }> {
  const formData = new FormData();
  formData.append("focal_length_35mm", String(focalLength35mm));
  const res = await fetch(`${API_BASE}/api/scene/${jobId}/relens`, {
    method: "POST",
    body: formData,
  });
  if (!res.ok) {
    // The refusals are specific and worth repeating rather than reducing to a
    // number: a 360 is six reconstructions and cannot be rebuilt as one image,
    // a build already running must not be raced, and a job whose photograph is
    // gone cannot be rebuilt at all.
    const detail = await res
      .json()
      .then((body) => body?.detail)
      .catch(() => null);
    throw new Error(
      typeof detail === "string" ? detail : `The server answered ${res.status}`,
    );
  }
  return res.json();
}

export async function fetchStatus(statusUrl: string): Promise<JobStatus> {
  const res = await fetch(`${API_BASE}${statusUrl}`);
  if (!res.ok) {
    throw new Error(`Status check failed with ${res.status}`);
  }
  return res.json();
}

export async function fetchLogs(logsUrl: string): Promise<{ stdout: string; stderr: string }> {
  const res = await fetch(`${API_BASE}${logsUrl}`);
  if (!res.ok) {
    throw new Error(`Logs fetch failed with ${res.status}`);
  }
  return res.json();
}

export async function fetchMetadata(metaUrl: string): Promise<SceneMetadata> {
  const res = await fetch(`${API_BASE}${metaUrl}`);
  if (!res.ok) {
    throw new Error(`Metadata fetch failed with ${res.status}`);
  }
  return res.json();
}

export type LatestScene = {
  jobId: string;
  name: string;
  plyUrl: string;
};

/**
 * The scene the server is holding, if it is holding one.
 *
 * Scenes now survive a restart of the backend, and the phone viewer picks the
 * held one up by itself. The editor had no way to reach it: its preview appears
 * only for a job uploaded in this browser session, so after a reload the scene
 * was on disk, served to the phone, and invisible here.
 *
 * Returns null when there is nothing to open, which is an ordinary state and
 * not an error.
 */
export async function fetchLatestScene(): Promise<LatestScene | null> {
  const res = await fetch(`${API_BASE}/api/scene/latest`);
  if (!res.ok) return null;
  const payload = await res.json();
  if (!payload || typeof payload.jobId !== "string" || typeof payload.plyUrl !== "string") {
    return null;
  }
  return payload as LatestScene;
}

export async function cleanupCache(): Promise<void> {
  const res = await fetch(`${API_BASE}/api/cleanup`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`Cache cleanup failed with ${res.status}`);
  }
}

export function resolveAssetUrl(path: string): string {
  if (!path.startsWith("/")) return path;
  return `${API_BASE}${path}`;
}
