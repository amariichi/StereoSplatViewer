// Types for the copied module; see device-metrics.d.ts for why.

export const DEFAULT_TILT_TIME_CONSTANT_MS: number;
export const DEFAULT_GRAVITY_TIME_CONSTANT_MS: number;
export const DEFAULT_GRAVITY_DEADBAND_RAD: number;
export const DEFAULT_HEADING_TIME_CONSTANT_MS: number;
export const DEFAULT_HEADING_DEADBAND_RAD: number;
export const DEFAULT_TILT_GAIN: number;
export const MAX_TILT_CORRECTION_RAD: number;
export const DEFAULT_ORIENTATION_SETTLE_MS: number;
export const QUARTER_TURN: number;

export function removeOrientationOffset(roll: number): number;
export function computeScreenRoll(gravity: { x?: number; y?: number; z?: number } | null): number | null;
export function wrapAngle(angle: number): number;
export function computeScreenHeading(orientation: {
  alpha?: number | null;
  beta?: number | null;
  gamma?: number | null;
} | null): number | null;
export function clampTiltCorrection(
  roll: number,
  options?: { gain?: number; maxCorrection?: number; invert?: boolean },
): number;

export function createRollFilter(options?: { timeConstantMs?: number }): {
  reset(): void;
  get(): number | null;
  update(roll: number, timestamp: number): number | null;
};

export type TiltReading = { x: number; y: number; z: number; screenAngle: number };

export function createGravityFilter(options?: { timeConstantMs?: number }): {
  reset(): void;
  get(): { x: number; y: number; z: number } | null;
  update(
    gravity: { x?: number; y?: number; z?: number } | null,
    timestamp: number,
  ): { x: number; y: number; z: number } | null;
};

export function requestTiltPermission(options?: { motionEvent?: unknown }): Promise<string>;
export function requestOrientationPermission(options?: { orientationEvent?: unknown }): Promise<string>;

export function createTiltTracker(options?: {
  target?: EventTarget;
  screen?: Screen;
  now?: () => number;
  timeConstantMs?: number;
  gravityTimeConstantMs?: number;
  gravityDeadbandRad?: number;
  headingTimeConstantMs?: number;
  headingDeadbandRad?: number;
  motionEvent?: unknown;
  orientationEvent?: unknown;
  onRoll?: (roll: number, reading: TiltReading) => void;
  onHeading?: (heading: number) => void;
}): {
  readonly running: boolean;
  getRawRoll(): number | null;
  getReading(): TiltReading | null;
  getSmoothedReading(): TiltReading | null;
  getRoll(): number | null;
  getRawHeading(): number | null;
  getHeading(): number | null;
  start(): Promise<string>;
  recenter(options?: { settleMs?: number }): void;
  stop(): void;
};
