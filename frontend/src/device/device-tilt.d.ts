// Types for the copied module; see device-metrics.d.ts for why.

export const DEFAULT_TILT_TIME_CONSTANT_MS: number;
export const DEFAULT_TILT_GAIN: number;
export const MAX_TILT_CORRECTION_RAD: number;
export const QUARTER_TURN: number;

export function removeOrientationOffset(roll: number): number;
export function computeScreenRoll(gravity: { x?: number; y?: number; z?: number } | null): number | null;
export function wrapAngle(angle: number): number;
export function clampTiltCorrection(
  roll: number,
  options?: { gain?: number; maxCorrection?: number; invert?: boolean },
): number;

export function createRollFilter(options?: { timeConstantMs?: number }): {
  reset(): void;
  get(): number | null;
  update(roll: number, timestamp: number): number | null;
};

export function requestTiltPermission(options?: { motionEvent?: unknown }): Promise<string>;

export function createTiltTracker(options?: {
  target?: EventTarget;
  screen?: Screen;
  now?: () => number;
  timeConstantMs?: number;
  onRoll?: (roll: number) => void;
}): {
  readonly running: boolean;
  getRawRoll(): number | null;
  getReading(): { x: number; y: number; z: number; screenAngle: number } | null;
  getRoll(): number | null;
  start(): Promise<string>;
  stop(): void;
};
