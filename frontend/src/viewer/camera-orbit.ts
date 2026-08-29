// Where the camera is, kept as numbers rather than as engine state.
//
// The camera controller used to come from the SuperSplat fork. Holding the
// orbit as plain values here means the arithmetic can be tested without a
// graphics device, which is the only part of the viewer that can be.

export type Vec3 = { x: number; y: number; z: number };

export type OrbitState = {
  /** Rotation about the world up axis, in radians. */
  yaw: number;
  /** Rotation above and below the horizon, in radians. */
  pitch: number;
  /** How far the camera sits from the point it is looking at, in scene units. */
  distance: number;
  /** The point the camera looks at and orbits around. */
  target: Vec3;
};

// Looking exactly along the up axis leaves the camera's roll undefined, and the
// view flips as it crosses. Stopping just short keeps the horizon stable.
export const MAX_PITCH = Math.PI / 2 - 0.001;

export const MIN_DISTANCE = 0.05;
export const MAX_DISTANCE = 5000;

// One full turn for a drag across the width of a 1000 pixel viewport. Chosen so
// that an ordinary drag rotates a comfortable amount rather than spinning.
const RADIANS_PER_PIXEL = (Math.PI * 2) / 1000;

// A notch of the wheel changes distance by a fixed proportion rather than a
// fixed amount, so that zooming feels the same close up and far away.
const DOLLY_PER_WHEEL_UNIT = 0.0015;

// How much faster than the drag itself the nearest gaussian may sweep across
// the frame. The camera swings on a radius of the orbit distance, so a point at
// the near anchor moves by exactly the ratio between the two. Four puts the
// pivot around the middle of the nearest object rather than at its front.
export const MAX_ORBIT_MAGNIFICATION = 4;

/**
 * How far away to put the point the camera orbits.
 *
 * The median gaussian distance is right when the subject fills the frame and
 * wrong when it does not. A measured photograph with a distant background put
 * its median at 57.8 units while the nearest splat sat at 1.20: the camera
 * swung on a radius forty-eight times the distance to the subject, and a ten
 * pixel drag moved it three times further than the subject was away. The
 * subject left the frame before the mouse had travelled a centimetre.
 *
 * Detecting the subject instead was tried and abandoned. These scenes are not
 * bimodal but multimodal -- that same photograph has humps at roughly 2, 8, 30
 * and 60 units -- so there is no single boundary to find, and no empty gap to
 * find it by: the largest step between adjacent sampled distances across the
 * middle nine tenths of that scene is 2.5 per cent, which is noise.
 *
 * So the pivot is bounded rather than detected. What makes a distant pivot
 * unusable is not its distance but its ratio to the nearest thing on screen,
 * because that ratio is the magnification. A scene that is entirely far away is
 * left alone: everything in it is distant, the ratio is small, and the median
 * stands.
 *
 * `medianDistance` is expected to carry the caller's own fallback already.
 */
export function orbitPivotDistance(
  medianDistance: number,
  nearestDistance: number | null,
): number {
  if (nearestDistance === null
    || !Number.isFinite(nearestDistance)
    || nearestDistance <= 0
    || !Number.isFinite(medianDistance)) {
    return medianDistance;
  }
  return Math.min(medianDistance, nearestDistance * MAX_ORBIT_MAGNIFICATION);
}

export function createOrbitState(overrides: Partial<OrbitState> = {}): OrbitState {
  return {
    yaw: 0,
    pitch: 0,
    distance: 4,
    target: { x: 0, y: 0, z: 0 },
    ...overrides,
    // A caller passing a partial target would otherwise lose the other axes.
    ...(overrides.target ? { target: { x: 0, y: 0, z: 0, ...overrides.target } } : {}),
  };
}

export function clampPitch(pitch: number): number {
  if (!Number.isFinite(pitch)) return 0;
  return Math.min(Math.max(pitch, -MAX_PITCH), MAX_PITCH);
}

export function clampDistance(distance: number): number {
  // Only a value that is not a number at all is meaningless. An infinity has a
  // direction and belongs at the corresponding end: a fast enough wheel makes
  // the exponential overflow, and rejecting that as invalid sent the camera to
  // its closest position instead of its furthest -- a scroll away from the
  // subject slammed into it.
  if (Number.isNaN(distance)) return MIN_DISTANCE;
  return Math.min(Math.max(distance, MIN_DISTANCE), MAX_DISTANCE);
}

export function applyOrbitDrag(state: OrbitState, dxPixels: number, dyPixels: number): OrbitState {
  if (!Number.isFinite(dxPixels) || !Number.isFinite(dyPixels)) return state;
  return {
    ...state,
    yaw: state.yaw - dxPixels * RADIANS_PER_PIXEL,
    pitch: clampPitch(state.pitch - dyPixels * RADIANS_PER_PIXEL),
  };
}

export function applyDolly(state: OrbitState, wheelDelta: number): OrbitState {
  if (!Number.isFinite(wheelDelta)) return state;
  // Exponential in the wheel amount, which is what makes the step proportional.
  return { ...state, distance: clampDistance(state.distance * Math.exp(wheelDelta * DOLLY_PER_WHEEL_UNIT)) };
}

/**
 * Slide the point being looked at across the screen plane.
 *
 * The amount is scaled by distance and by the vertical field of view so that a
 * dragged feature stays under the pointer whether the camera is close or far.
 */
export function applyPan(
  state: OrbitState,
  dxPixels: number,
  dyPixels: number,
  viewport: { width: number; height: number },
  fovDegrees: number,
): OrbitState {
  if (!Number.isFinite(dxPixels) || !Number.isFinite(dyPixels)) return state;
  if (!(viewport.height > 0) || !(viewport.width > 0)) return state;

  const worldPerPixel =
    (2 * state.distance * Math.tan((fovDegrees * Math.PI) / 360)) / viewport.height;
  const right = cameraRight(state);
  const up = cameraUp(state);
  const dx = -dxPixels * worldPerPixel;
  const dy = dyPixels * worldPerPixel;

  return {
    ...state,
    target: {
      x: state.target.x + right.x * dx + up.x * dy,
      y: state.target.y + right.y * dx + up.y * dy,
      z: state.target.z + right.z * dx + up.z * dy,
    },
  };
}

/** The direction the camera looks along, pointing from the camera to the target. */
export function cameraForward(state: OrbitState): Vec3 {
  const cp = Math.cos(state.pitch);
  return {
    x: -Math.sin(state.yaw) * cp,
    y: -Math.sin(state.pitch),
    z: -Math.cos(state.yaw) * cp,
  };
}

export function cameraRight(state: OrbitState): Vec3 {
  // Independent of pitch, because the camera is never rolled.
  return { x: Math.cos(state.yaw), y: 0, z: -Math.sin(state.yaw) };
}

export function cameraUp(state: OrbitState): Vec3 {
  const f = cameraForward(state);
  const r = cameraRight(state);
  // up = right x forward, for a right-handed frame looking down -z.
  return {
    x: r.y * f.z - r.z * f.y,
    y: r.z * f.x - r.x * f.z,
    z: r.x * f.y - r.y * f.x,
  };
}

export function orbitToPosition(state: OrbitState): Vec3 {
  const f = cameraForward(state);
  return {
    x: state.target.x - f.x * state.distance,
    y: state.target.y - f.y * state.distance,
    z: state.target.z - f.z * state.distance,
  };
}

/** Degrees for PlayCanvas, which takes euler angles in that unit. */
export function orbitToEulerDegrees(state: OrbitState): { pitch: number; yaw: number } {
  return {
    pitch: (state.pitch * 180) / Math.PI,
    yaw: (state.yaw * 180) / Math.PI,
  };
}

/**
 * How far apart two orbit states are, in the units each quantity is measured in.
 *
 * Used to decide whether the picture would actually differ. Drawing only when
 * an input has moved enough to shift a pixel is what keeps a phone's battery
 * alive; the sibling depth viewer measured sixty unconditional frames a second
 * falling to twenty-odd real ones.
 */
export function orbitChanged(a: OrbitState | null, b: OrbitState): boolean {
  if (!a) return true;
  const ANGLE_EPSILON = 0.0002;
  const RELATIVE_DISTANCE_EPSILON = 0.001;
  const TARGET_EPSILON = 0.0005;
  if (Math.abs(a.yaw - b.yaw) > ANGLE_EPSILON) return true;
  if (Math.abs(a.pitch - b.pitch) > ANGLE_EPSILON) return true;
  if (Math.abs(a.distance - b.distance) > b.distance * RELATIVE_DISTANCE_EPSILON) return true;
  if (Math.abs(a.target.x - b.target.x) > TARGET_EPSILON) return true;
  if (Math.abs(a.target.y - b.target.y) > TARGET_EPSILON) return true;
  if (Math.abs(a.target.z - b.target.z) > TARGET_EPSILON) return true;
  return false;
}
