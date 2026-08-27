// Making the tracker's distance agree with a tape measure.
//
// The head tracker's distance comes from MediaPipe's facial transformation
// matrix, which is fitted against a canonical face of assumed size, seen
// through a camera of assumed field of view. Neither assumption is checked
// against the device it is running on, and on hardware the result was reported
// as about 300 mm while the eye was really 150 from the glass -- a factor of
// two.
//
// The error is a scale rather than an offset: both the assumed face size and
// the assumed focal length enter as a ratio, so a face that is half the assumed
// size, or a lens twice the assumed focal length, multiplies every distance by
// the same amount. One number therefore corrects it at every distance, and the
// honest way to obtain that number is to ask.

// v2 starts with the cyclopean eye rather than the canonical face origin.
// A scale measured against the old point carries a different additive depth
// offset, so it must not silently survive that geometry change.
export const HEAD_DISTANCE_SCALE_STORAGE_KEY = 'stereosplat-head-distance-scale-v2';

// A tracker that disagreed with reality by more than this is not miscalibrated,
// it is broken, and silently scaling by such a factor would hide that.
export const MIN_DISTANCE_SCALE = 0.2;
export const MAX_DISTANCE_SCALE = 5;

export function clampDistanceScale(scale: number | null | undefined): number {
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) return 1;
  return Math.min(Math.max(scale, MIN_DISTANCE_SCALE), MAX_DISTANCE_SCALE);
}

/**
 * The correction that makes a reported distance equal a measured one.
 *
 * Returns 1 -- no correction -- rather than throwing, because this runs from a
 * button on a phone and a tracker that has not settled yet reports nonsense.
 */
export function distanceScaleFrom(reportedMm: number, actualMm: number): number {
  if (!Number.isFinite(reportedMm) || !Number.isFinite(actualMm)) return 1;
  if (!(reportedMm > 0) || !(actualMm > 0)) return 1;
  return clampDistanceScale(actualMm / reportedMm);
}

export function loadDistanceScale(storage: Storage | null | undefined): number {
  try {
    const raw = storage?.getItem?.(HEAD_DISTANCE_SCALE_STORAGE_KEY);
    return raw === null || raw === undefined ? 1 : clampDistanceScale(Number(raw));
  } catch {
    return 1;
  }
}

export function saveDistanceScale(storage: Storage | null | undefined, scale: number): void {
  try {
    const value = clampDistanceScale(scale);
    if (value === 1) storage?.removeItem?.(HEAD_DISTANCE_SCALE_STORAGE_KEY);
    else storage?.setItem?.(HEAD_DISTANCE_SCALE_STORAGE_KEY, String(value));
  } catch {
    // Private browsing can refuse storage; the current session still works.
  }
}
