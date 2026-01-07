const API_BASE =
  import.meta.env.VITE_API_BASE || (import.meta.env.DEV ? "http://localhost:8000" : "");

export type UploadResponse = {
  jobId: string;
  plyUrl: string;
  statusUrl: string;
  logsUrl: string;
  metaUrl?: string;
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

export async function uploadFile(file: File): Promise<UploadResponse> {
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch(`${API_BASE}/api/upload`, {
    method: "POST",
    body: formData,
  });
  if (!res.ok) {
    throw new Error(`Upload failed with status ${res.status}`);
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
