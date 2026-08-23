// Turning a gravity reading into a correction that does not lurch.
//
// The reading itself is fine; two pieces of arithmetic around it were not.
//
// The first is the quarter-turn removal. A device held in landscape reports a
// roll ninety degrees from the same device held in portrait, and rounding to
// the nearest quarter turn and subtracting absorbs that without having to ask
// the operating system which way round the screen is -- an angle whose sign
// convention was found to differ between devices. But rounding is a step: at
// exactly forty-five degrees the answer jumps by ninety, and since the
// correction is half the angle and capped at eighteen, the picture snaps
// through thirty-six degrees. Reported from a device as the correction
// "suddenly cutting in" once it was tilted far enough. Rotation lock, or
// tilting about an axis the operating system does not rotate for, puts a
// viewer right on that boundary with nothing else changing to explain it.
//
// The second is the cutoff. As the screen turns to face upwards the component
// of gravity lying in it shrinks to nothing, and which way is up on the screen
// stops being defined -- that part is physics, not a bug. It was handled by
// rejecting readings below a fixed threshold, which is a cliff: the correction
// held its last value and then stopped. Fading it out over the range where the
// reading is going bad says the same thing without the lurch.

/** Gravity in the plane of the screen, below which its direction means nothing. */
export const FADE_START = 4.0;
export const FADE_END = 1.5;

/** How far past a quarter turn the reading must go before the quadrant changes. */
export const QUADRANT_HYSTERESIS_RAD = (12 * Math.PI) / 180;

export const QUARTER_TURN = Math.PI / 2;

export function wrapAngle(angle: number): number {
  let wrapped = angle;
  while (wrapped > Math.PI) wrapped -= Math.PI * 2;
  while (wrapped < -Math.PI) wrapped += Math.PI * 2;
  return wrapped;
}

/**
 * How much of the correction to apply, given how much gravity lies in the screen.
 *
 * One at a comfortable angle, nothing once the screen is near enough to level
 * that up has no meaning on it, and a smooth ramp between.
 */
export function tiltConfidence(inPlaneGravity: number): number {
  if (!Number.isFinite(inPlaneGravity)) return 0;
  if (inPlaneGravity >= FADE_START) return 1;
  if (inPlaneGravity <= FADE_END) return 0;
  const t = (inPlaneGravity - FADE_END) / (FADE_START - FADE_END);
  // Smoothstep, so the correction neither starts nor stops abruptly.
  return t * t * (3 - 2 * t);
}

/**
 * Which quarter turn the device is being held at, changed only with hysteresis.
 *
 * Rounding to the nearest quadrant flips exactly on the boundary, and a hand is
 * never quite still. Requiring the reading to go a little past before the
 * quadrant changes, and a little back before it changes again, means a viewer
 * sitting near forty-five degrees stays where they were put.
 */
export function chooseQuadrant(roll: number, previous: number | null): number {
  if (!Number.isFinite(roll)) return previous ?? 0;
  const nearest = Math.round(roll / QUARTER_TURN);
  if (previous === null) return nearest;
  if (nearest === previous) return previous;
  // How far past the boundary between the two the reading has gone.
  const boundary = ((nearest + previous) / 2) * QUARTER_TURN;
  const past = Math.abs(roll - boundary);
  return past >= QUADRANT_HYSTERESIS_RAD ? nearest : previous;
}

export function removeQuadrant(roll: number, quadrant: number): number {
  return wrapAngle(roll - quadrant * QUARTER_TURN);
}
