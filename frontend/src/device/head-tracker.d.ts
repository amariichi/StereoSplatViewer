// Types for the copied module; see device-metrics.d.ts for why.

export const MEDIAPIPE_TASKS_VERSION: string;
export const MEDIAPIPE_MODULE_URL: string;
export const MEDIAPIPE_WASM_URL: string;
export const FACE_LANDMARKER_MODEL_URL: string;
export const DEFAULT_XY_GAIN: number;
export const DEFAULT_Z_GAIN: number;
export const FACE_LANDMARKER_DELEGATES: readonly string[];

export type EyePose = { x: number; y: number; z: number; timestamp?: number };

export function getActiveDelegate(): string | null;
export function preferredDelegates(requested?: string | null): string[];
export function stopMediaStream(stream: MediaStream | null | undefined): void;

export type HeadTrackerMetrics = {
  startedAt: number | null;
  firstTrackedPoseMs: number | null;
  poseSource: 'metric' | 'landmark' | null;
  videoWidth?: number;
  videoHeight?: number;
  [key: string]: unknown;
};

export class HeadTracker {
  constructor(options: {
    video: HTMLVideoElement;
    baselineEyeZ?: number;
    worldUnitMm?: number | null;
    mirrorX?: boolean;
    xyGain?: number;
    mediaDevices?: MediaDevices;
    landmarkerFactory?: unknown;
    delegate?: string | null;
    /** Called with one object, not two arguments. */
    onStatus?: (status: { code: string; message: string }) => void;
    onPose?: (pose: EyePose) => void;
  });
  running: boolean;
  start(): Promise<void>;
  stop(options?: { emit?: boolean }): void;
  recenter(): void;
  setMirrorX(mirrorX: boolean): void;
  setViewingGeometry(input: { worldUnitMm?: number | null; baselineEyeZ?: number }): void;
  /** Widen the bound on reported sideways and vertical position. */
  setPositionBound(bound: number): void;
  getMetrics(): HeadTrackerMetrics;
}
