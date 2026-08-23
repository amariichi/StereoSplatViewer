// Fitting a metric scene into a window.
//
// A head-coupled view works in units where the virtual screen is two units
// tall, because that is what turns millimetres of measured head movement into
// world units with no tunable gain. A scene from SHARP is in metres, and a
// person standing two and a half metres away is nowhere near a two-unit screen.
// Something has to map one onto the other.
//
// The mapping that reproduces the original photograph is the one that puts the
// subject exactly where the camera saw it: scale so that the frame at the
// subject's distance is as wide as the screen, and slide the scene so that the
// subject's distance lands in the plane of the screen. Then looking at the
// window straight on shows what the photograph showed, and moving your head
// reveals the relief.

export type Vec3 = { x: number; y: number; z: number };

/**
 * Half the angular height of the reconstruction, as a tangent.
 *
 * The capture camera's field of view is not recorded in the file, but the
 * gaussians remember it: they were unprojected from the frame, so the extreme
 * ones sit on its edge. Taking a high percentile rather than the maximum keeps
 * a few strays from widening the estimate.
 */
export function estimateCaptureTangent(
  centers: Float32Array | undefined,
  { stride = 64, percentile = 0.98 }: { stride?: number; percentile?: number } = {},
): number | null {
  if (!centers || centers.length < 3) return null;
  const ratios: number[] = [];
  for (let i = 0; i + 2 < centers.length; i += 3 * stride) {
    const y = centers[i + 1];
    const z = centers[i + 2];
    const depth = Math.abs(z);
    // Very near the camera the ratio explodes and means nothing.
    if (depth > 1e-3) ratios.push(Math.abs(y) / depth);
  }
  if (ratios.length === 0) return null;
  ratios.sort((a, b) => a - b);
  const value = ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * percentile))];
  return Number.isFinite(value) && value > 0 ? value : null;
}

export type WindowPlacement = {
  /** Uniform scale applied to the scene. */
  scale: number;
  /** Translation applied after scaling, in window units. */
  translation: Vec3;
  /** Half the height of the window, in window units. */
  windowHalfHeight: number;
  /** Where the anchored depth ends up: 0 is in the plane of the window. */
  anchorDepth: number;
  /** How much of the original frame is still visible, from 0 to 1. */
  visibleFraction: number;
};

export const MIN_DEPTH_SCALE = 0.15;
export const MAX_DEPTH_SCALE = 6;

// Zoom of 1 shows the whole photograph. Above that it crops in, which is the
// only way to make the picture look life-sized on a screen this small.
/**
 * How close the effective eye may come to the window, as a fraction of the apex.
 *
 * Approaching the glass magnifies whatever is nearest much faster than the
 * rest, which on a face reads as the forehead stretching away from the mouth.
 * It is real -- a window does that -- but the tracker also *reports* the head
 * as closer when the device is merely rotated, so the effect arrives without
 * the viewer having moved. A floor bounds the damage at the cost of the view
 * stopping short when someone really does lean right in.
 */
export const MIN_EYE_FRACTION = 0.6;

/**
 * How much the miniature turns for a given turn of the fingers.
 *
 * At 1 the scene follows the fingers exactly, which sounds right and is far too
 * slow in the hand: a comfortable two-finger turn is about 60 degrees, so
 * seeing the back of something took four separate strokes. At 3 one comfortable
 * stroke carries it through half a turn, which is the movement people actually
 * make when they turn an object over to look at it.
 */
export const TWIST_GAIN = 3;

/** The same gearing for tipping, so both turns respond alike. */
export const TIP_GAIN = 3;

/**
 * How far the miniature may be tipped, in degrees.
 *
 * A scene made from one photograph has surfaces only where the camera could see
 * them: there is nothing on top of anything and nothing underneath. Past about
 * this much the view is mostly the absence rather than the object, so the tip
 * stops rather than letting the scene be turned inside out.
 */
export const MAX_TIP_DEG = 55;

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

/**
 * How far away the picture looks life-sized, in millimetres.
 *
 * The rendered image spans a half-angle of `windowHalfHeight / eyeDistance` and
 * fills the screen, so it looks its natural size where the screen subtends the
 * same angle. Showing the whole photograph on a phone puts that at around
 * 120 to 170 mm, which is closer than anyone wants to hold one.
 *
 * There is no way round it by scaling anything: to show a 44-degree frame
 * life-sized at 350 mm you need a screen 280 mm tall, and a phone is 134. The
 * only lever is how much of the frame to show, which is what `zoom` is.
 */
export function lifeSizeDistanceMm(
  windowHalfHeight: number,
  eyeDistance: number,
  screenHalfHeightMm: number,
): number {
  if (!(windowHalfHeight > 0) || !(eyeDistance > 0) || !(screenHalfHeightMm > 0)) {
    throw new Error('Life-size distance needs positive window, eye distance and screen size.');
  }
  return screenHalfHeightMm / (windowHalfHeight / eyeDistance);
}

/**
 * Where the picture appears life-sized to a real eye.
 *
 * The rendered image spans a half-angle of `captureTangent` and fills the
 * physical screen, so it looks its natural size when the screen subtends that
 * angle -- one screen half-height divided by `captureTangent` away. On a phone
 * that is around 120 mm, which is closer than anyone holds one.
 *
 * This is a viewing preference, not a constraint on the geometry, and it was
 * once mistaken for one: the apex was moved here, which left a viewer whose
 * tracked distance was the ordinary 350 mm permanently behind it, and the far
 * field blew up exactly as it had when the apex was wrong sideways. The apex
 * belongs at the eye. This function only reports a comfortable distance to hold
 * the device.
 */
export function apexDistance(captureTangent: number): number {
  if (!(captureTangent > 0) || !Number.isFinite(captureTangent)) {
    throw new Error('captureTangent must be a positive, finite number.');
  }
  return 1 / captureTangent;
}

/**
 * Move the tracked head position so the comfortable distance lands on the apex.
 *
 * The apex -- where the eye must be for the picture to be the photograph -- is
 * a property of the photograph and the screen, and for a phone and a
 * wide-angle source it comes out around 11 centimetres. Nobody holds a phone
 * there, and leaving the viewer permanently off-apex is what makes the far
 * field wrong. So the whole head position is mapped: holding the device at a
 * comfortable distance *is* being at the apex.
 *
 * **All three axes are scaled by the same factor.** Mapping the depth alone was
 * tried and is wrong. It leaves sideways movement measured against an apex two
 * and a half times nearer than the device is really held, so every head
 * movement produces two and a half times the parallax it should. That was
 * introduced deliberately, on the theory that a small object needs exaggerated
 * relief to read as solid, and reported from hardware as depth that felt
 * "strangely exaggerated" and "unpleasant" on every image tried. Scaling all
 * three restores exactly the parallax a window gives.
 *
 * The scaling is proportional rather than a subtraction. A subtraction lands
 * the right distance on the apex too, but changes the *relative* movement:
 * leaning back a tenth of the way would move the effective eye by a third, and
 * the view would zoom half again as much as a window does. Multiplying keeps
 * the ratio, and cannot reach zero, so the degenerate frustum a subtraction has
 * to be clamped away from never arises.
 */
export function mapTrackedEye({
  eye,
  nominalZ,
  apex,
  minFraction = MIN_EYE_FRACTION,
  maxFraction = 6,
}: {
  /** The head position the tracker reports, in window units. */
  eye: { x: number; y: number; z: number };
  /** The distance the device is comfortably held at, in window units. */
  nominalZ: number;
  /** Where the eye has to be for the picture to be the photograph. */
  apex: number;
  minFraction?: number;
  maxFraction?: number;
}): { x: number; y: number; z: number } {
  if (!(apex > 0) || !Number.isFinite(apex)) {
    throw new Error('apex must be a positive, finite number.');
  }
  if (!(nominalZ > 0) || !Number.isFinite(nominalZ)) {
    throw new Error('nominalZ must be a positive, finite number.');
  }
  const factor = apex / nominalZ;
  const x = Number.isFinite(eye?.x) ? eye.x * factor : 0;
  const y = Number.isFinite(eye?.y) ? eye.y * factor : 0;
  const z = Number.isFinite(eye?.z) && eye.z > 0
    ? Math.min(Math.max(eye.z * factor, apex * minFraction), apex * maxFraction)
    : apex;
  return { x, y, z };
}

export function lifeSizeViewingDistance(captureTangent: number): number {
  if (!(captureTangent > 0) || !Number.isFinite(captureTangent)) {
    throw new Error('captureTangent must be a positive, finite number.');
  }
  return 1 / captureTangent;
}

/**
 * Place a metric scene behind the window.
 *
 * The rule is one line: **put the capture camera where the viewer's eye is.**
 * Two cones with different apexes diverge with distance, so any gap between
 * them shows up as the far field being the wrong size -- correct at the
 * subject and worse the further back you look.
 *
 * The window is then `eyeDistance * captureTangent` tall on each side, which is
 * whatever the photograph's own field of view fills. That is a choice: showing
 * the whole frame, rather than the crop a screen-sized window would give at an
 * ordinary viewing distance.
 *
 * A consequence worth understanding: at the apex the picture is the photograph
 * *whatever the scale is*, because scaling moves every point along its own line
 * of sight. Scale sets how large the miniature is and, inversely, how far
 * through it runs -- so a larger one is flatter.
 */
export function computeWindowPlacement({
  captureTangent,
  anchorDistance,
  sizeScale = 1,
  zoom = 1,
}: {
  /** Tangent of half the capture camera's vertical field of view. */
  captureTangent: number;
  /**
   * The depth that lands in the plane of the window, in the scene's own units.
   *
   * Anchor the *nearest* content here, not the subject. Anchoring the median
   * put the front of the scene 26 to 31 per cent of the way from the window to
   * the eye, and parallax is fiercest in front of the glass, so the near relief
   * came out violently exaggerated -- reported from a device as exactly that.
   * With the near edge on the glass the whole miniature sits behind it, which
   * is what a window is.
   */
  anchorDistance: number;
  /** How large to make the miniature. Larger is bigger, and flatter. */
  sizeScale?: number;
  /**
   * How far into the frame to crop. 1 shows the whole photograph; above that
   * the picture grows towards life-sized and the edges of the frame go.
   */
  zoom?: number;
}): WindowPlacement {
  if (!(captureTangent > 0) || !Number.isFinite(captureTangent)) {
    throw new Error('captureTangent must be a positive, finite number.');
  }
  if (!(anchorDistance > 0) || !Number.isFinite(anchorDistance)) {
    throw new Error('anchorDistance must be a positive, finite number.');
  }
  const size = Math.min(
    Math.max(Number.isFinite(sizeScale) && sizeScale > 0 ? sizeScale : 1, MIN_DEPTH_SCALE),
    MAX_DEPTH_SCALE,
  );
  const crop = Math.min(Math.max(Number.isFinite(zoom) && zoom > 0 ? zoom : 1, MIN_ZOOM), MAX_ZOOM);

  // The capture camera goes where the photograph's viewpoint belongs. The
  // tracked head position is mapped onto it by `mapTrackedEye`, so a
  // comfortable holding distance *is* the apex rather than a place the viewer
  // never reaches.
  const apex = apexDistance(captureTangent);
  const scale = (apex / anchorDistance) * size;
  return {
    scale,
    translation: { x: 0, y: 0, z: apex },
    // Which comes out as exactly the physical screen, one unit on each side:
    // apex * captureTangent is (1/t) * t. The construction closes on itself,
    // and head movement is no longer silently rescaled.
    windowHalfHeight: 1 / crop,
    anchorDepth: apex - scale * anchorDistance,
    /** The fraction of the original frame still visible. */
    visibleFraction: 1 / crop,
  };
}

/**
 * Where to stop showing the scene, so it is a miniature and not a portal.
 *
 * These reconstructions are extremely deep: half the gaussians within three
 * metres and a tail running out to a hundred and seventy. Behind a small window
 * that reads as a hole into a vast space, and moving your head swings the
 * distant parts far more than anything a miniature would do.
 *
 * The depth histogram is not smooth, though. A photograph of a subject in front
 * of a landscape leaves a band with almost nothing in it between the two, and
 * cutting there removes the tail without cutting through anything. The measured
 * scene had 53 per cent of its gaussians within three metres, 20 per cent from
 * three to ten, then only 2.5 per cent from ten to thirty before the background
 * resumed.
 *
 * Returns null when there is no such gap, which is the honest answer for a
 * scene that is evenly filled: cutting one of those would slice through
 * something.
 */
export function findFarFieldCut(
  centers: Float32Array | undefined,
  { stride = 64, bins = 24 }: { stride?: number; bins?: number } = {},
): number | null {
  if (!centers || centers.length < 3) return null;
  const distances: number[] = [];
  for (let i = 0; i + 2 < centers.length; i += 3 * stride) {
    const d = Math.hypot(centers[i], centers[i + 1], centers[i + 2]);
    if (d > 1e-3 && Number.isFinite(d)) distances.push(d);
  }
  if (distances.length < bins * 4) return null;
  distances.sort((a, b) => a - b);

  const at = (q: number) => distances[Math.min(distances.length - 1, Math.floor(distances.length * q))];
  // Only look for a gap beyond the subject and before the far tail: cutting
  // nearer would remove the subject, and further would leave the tail.
  const low = at(0.55);
  const high = at(0.95);
  if (!(high > low * 1.2)) return null;

  // Logarithmic bins, because the range spans two orders of magnitude and even
  // bins would put the whole subject in the first one.
  const logLow = Math.log(low);
  const logHigh = Math.log(high);
  const counts = new Array(bins).fill(0);
  for (const d of distances) {
    if (d < low || d > high) continue;
    const index = Math.min(bins - 1, Math.floor(((Math.log(d) - logLow) / (logHigh - logLow)) * bins));
    counts[index] += 1;
  }

  let emptiest = 0;
  for (let i = 1; i < bins; i++) if (counts[i] < counts[emptiest]) emptiest = i;

  // A gap worth cutting at has to be genuinely empty compared with the rest.
  const mean = counts.reduce((a, b) => a + b, 0) / bins;
  if (!(counts[emptiest] < mean * 0.5)) return null;

  return Math.exp(logLow + ((emptiest + 0.5) / bins) * (logHigh - logLow));
}
