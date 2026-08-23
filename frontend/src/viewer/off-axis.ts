// Two eye views that a person can actually fuse.
//
// There are two ways to make a stereo pair, and only one of them works.
//
// Toe-in places two cameras apart and rotates each one inward so that their
// axes cross at a chosen distance. It is the obvious construction and it is
// wrong: because the two cameras are rotated relative to one another, a point
// away from the centre of the frame lands at a *different height* in the two
// images. Eyes cannot fuse a vertical difference. It is nearly absent at the
// centre and grows towards the corners, which is why toe-in looks acceptable
// on a test object in the middle of the frame and hurts on a real photograph.
//
// Off-axis keeps both cameras pointing the same way, moves them apart, and
// skews each one's view volume so that a chosen plane lands identically in
// both. The difference between the images is then horizontal everywhere, which
// is the only difference a viewer's eyes are built to interpret.
//
// The arithmetic below is the same construction used by the head-tracked depth
// viewer in the sibling project, where the eye position comes from a camera
// rather than from a fixed separation. Only the way the eye position is
// obtained differs.

// Eye distance is measured, in world units where one unit is half the screen's
// physical height. Holding a phone at arm's length is already past 10 units, so
// the ceiling has to clear what a metric tracker can legitimately report rather
// than silently clamping a real measurement.
export const MAX_SUPPORTED_EYE_Z = 16;

export type Frustum = {
  left: number;
  right: number;
  bottom: number;
  top: number;
  near: number;
  far: number;
};

export type EyeView = {
  /** How far this eye sits along the camera's own right axis. */
  offsetX: number;
  frustum: Frustum;
};

export type StereoOptions = {
  /** Distance between the two eyes, in scene units. */
  baseline: number;
  /** The distance that lands in the plane of the screen, with no parallax. */
  zeroParallaxDistance: number;
  /** Vertical field of view of the centre camera, in degrees. */
  fovYDeg: number;
  /** Viewport width divided by height, for one eye. */
  aspect: number;
  near: number;
  far: number;
};

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`);
  return value;
}

export type Eye = { x: number; y: number; z: number };

/**
 * An eye position that a projection can actually be built from.
 *
 * A tracker can report a head that has left the frame or moved implausibly far,
 * and a degenerate eye produces a degenerate frustum rather than an obvious
 * failure. The distance is clamped; the sideways position is not, because a
 * viewer really can look in from the side.
 */
export function sanitizeEye(
  eye: Partial<Eye> | null | undefined,
  { minEyeZ = 0.2, maxEyeZ = MAX_SUPPORTED_EYE_Z }: { minEyeZ?: number; maxEyeZ?: number } = {},
): Eye {
  const x = finite(eye?.x as number, 'eye.x');
  const y = finite(eye?.y as number, 'eye.y');
  const z = finite(eye?.z as number, 'eye.z');
  if (!(z > 0)) {
    throw new Error('eye.z must be positive and in front of the virtual screen.');
  }
  return { x, y, z: Math.min(Math.max(z, minEyeZ), maxEyeZ) };
}

/**
 * A view volume that is not symmetric about the view direction.
 *
 * The eye sits at `eyeX`, `eyeY` in the plane of the screen's coordinates and
 * at `eyeZ` in front of it. The screen keeps its position; the frustum is
 * whatever reaches the eye from the screen's edges.
 */
export function computeOffAxisFrustum({
  eyeX,
  eyeY,
  eyeZ,
  screenHalfWidth,
  screenHalfHeight,
  near,
  far,
}: {
  eyeX: number;
  eyeY: number;
  eyeZ: number;
  screenHalfWidth: number;
  screenHalfHeight: number;
  near: number;
  far: number;
}): Frustum {
  finite(eyeX, 'eyeX');
  finite(eyeY, 'eyeY');
  finite(eyeZ, 'eyeZ');
  if (!(eyeZ > 0)) throw new Error('eyeZ must be positive and in front of the screen.');
  if (!(screenHalfWidth > 0) || !(screenHalfHeight > 0)) {
    throw new Error('Screen half extents must be positive.');
  }
  if (!(near > 0) || !(far > near)) throw new Error('Projection requires 0 < near < far.');

  const scale = near / eyeZ;
  const frustum: Frustum = {
    left: (-screenHalfWidth - eyeX) * scale,
    right: (screenHalfWidth - eyeX) * scale,
    bottom: (-screenHalfHeight - eyeY) * scale,
    top: (screenHalfHeight - eyeY) * scale,
    near,
    far,
  };
  if (!(frustum.right > frustum.left) || !(frustum.top > frustum.bottom)) {
    throw new Error('Eye position produced a degenerate frustum.');
  }
  return frustum;
}

/** Half the size of the zero-parallax plane, in scene units. */
export function screenHalfExtents(zeroParallaxDistance: number, fovYDeg: number, aspect: number) {
  finite(zeroParallaxDistance, 'zeroParallaxDistance');
  finite(fovYDeg, 'fovYDeg');
  finite(aspect, 'aspect');
  if (!(zeroParallaxDistance > 0)) throw new Error('zeroParallaxDistance must be positive.');
  if (!(fovYDeg > 0) || fovYDeg >= 180) throw new Error('fovYDeg must be between 0 and 180.');
  if (!(aspect > 0)) throw new Error('aspect must be positive.');
  const halfHeight = zeroParallaxDistance * Math.tan((fovYDeg * Math.PI) / 360);
  return { halfWidth: halfHeight * aspect, halfHeight };
}

/**
 * One eye of a stereo pair.
 *
 * The camera is displaced sideways and *not rotated*. Note that `bottom` and
 * `top` come out independent of the displacement, which is precisely why this
 * construction has no vertical disparity: both eyes are given the same vertical
 * extent, so a feature sits at the same height in both images by construction
 * rather than by approximation.
 */
export function computeStereoEye(
  eye: 'left' | 'right' | 'centre',
  { baseline, zeroParallaxDistance, fovYDeg, aspect, near, far }: StereoOptions,
): EyeView {
  finite(baseline, 'baseline');
  if (baseline < 0) throw new Error('baseline must not be negative.');
  const { halfWidth, halfHeight } = screenHalfExtents(zeroParallaxDistance, fovYDeg, aspect);
  const offsetX = eye === 'centre' ? 0 : (eye === 'left' ? -baseline / 2 : baseline / 2);
  return {
    offsetX,
    frustum: computeOffAxisFrustum({
      eyeX: offsetX,
      eyeY: 0,
      eyeZ: zeroParallaxDistance,
      screenHalfWidth: halfWidth,
      screenHalfHeight: halfHeight,
      near,
      far,
    }),
  };
}

/**
 * Where a point lands on screen, in normalised device coordinates.
 *
 * Exposed so that the property this module exists for -- no vertical
 * difference between the eyes -- can be measured rather than asserted.
 * The point is given in the centre camera's space, looking along -z.
 */
export function projectThroughEye(
  view: EyeView,
  point: { x: number; y: number; z: number },
): { x: number; y: number } | null {
  const { left, right, bottom, top, near } = view.frustum;
  // Into this eye's space: a displacement, with no rotation.
  const x = point.x - view.offsetX;
  const y = point.y;
  const z = point.z;
  if (!(z < 0)) return null; // behind the eye, or exactly in its plane
  const w = -z;
  const xClip = (2 * near * x) / (right - left) + ((right + left) / (right - left)) * z;
  const yClip = (2 * near * y) / (top - bottom) + ((top + bottom) / (top - bottom)) * z;
  return { x: xClip / w, y: yClip / w };
}

/**
 * The same point through a toe-in pair, for comparison only.
 *
 * Kept so the defect this module replaces stays measurable. Each camera is
 * displaced and then rotated inward by the angle that brings its axis through
 * the convergence point, and given a symmetric view volume.
 */
export function projectThroughToeInEye(
  eye: 'left' | 'right',
  { baseline, zeroParallaxDistance, fovYDeg, aspect, near }: StereoOptions,
  point: { x: number; y: number; z: number },
): { x: number; y: number } | null {
  const offsetX = eye === 'left' ? -baseline / 2 : baseline / 2;
  // Rotate about the vertical axis so the axis passes through (0, 0, -zp).
  const theta = Math.atan2(offsetX, zeroParallaxDistance);
  const dx = point.x - offsetX;
  const dz = point.z;
  const cos = Math.cos(-theta);
  const sin = Math.sin(-theta);
  const x = dx * cos + dz * sin;
  const z = -dx * sin + dz * cos;
  const y = point.y;
  if (!(z < 0)) return null;
  const top = near * Math.tan((fovYDeg * Math.PI) / 360);
  const right = top * aspect;
  return { x: (near * x) / right / -z, y: (near * y) / top / -z };
}

/**
 * How far apart the eyes should actually be placed.
 *
 * The two controls carried over from the previous renderer, `compression` and
 * `clampPx`, were corrections applied after a toe-in pair had been made. Under
 * this construction they act on the input instead, which is both simpler and
 * exact.
 *
 * Working out the horizontal separation of a point between the two eyes gives
 * a short closed form. For a point at distance `d`, with baseline `b` and a
 * zero-parallax plane of half-width `W` at distance `zp`, the separation in
 * normalised device coordinates is
 *
 *     (b / W) * (1 - zp / d)
 *
 * which is zero at the screen, negative in front of it, and tends to `b / W`
 * for anything far away. So the worst separation the background can ever
 * produce is fixed by the baseline alone, and capping it is a matter of
 * capping the baseline.
 *
 * `compression` scales the baseline. That is geometrically exact rather than a
 * fudge: a smaller separation is what a smaller viewer would see, and it
 * flattens the scene without distorting it.
 *
 * `clampPx` limits how far apart the background may appear, in pixels of one
 * eye's viewport. Note that it bounds the far field only. Something very close
 * to the viewer produces unbounded separation in the other direction, and no
 * choice of baseline fixes that; handling it means moving the zero-parallax
 * plane or not showing the object that close.
 */
export function effectiveBaseline({
  baseline,
  compression = 1,
  clampPx = 0,
  eyeViewportWidthPx,
  zeroParallaxDistance,
  fovYDeg,
  aspect,
}: {
  baseline: number;
  compression?: number;
  clampPx?: number;
  eyeViewportWidthPx: number;
  zeroParallaxDistance: number;
  fovYDeg: number;
  aspect: number;
}): number {
  finite(baseline, 'baseline');
  const scaled = Math.max(0, baseline * (Number.isFinite(compression) ? Math.max(0, compression) : 1));
  if (!(clampPx > 0) || !(eyeViewportWidthPx > 0)) return scaled;

  const { halfWidth } = screenHalfExtents(zeroParallaxDistance, fovYDeg, aspect);
  // Separation in normalised coordinates spans 2 units across the viewport.
  const maxSeparationNdc = (2 * clampPx) / eyeViewportWidthPx;
  const maxBaseline = maxSeparationNdc * halfWidth;
  return Math.min(scaled, maxBaseline);
}
