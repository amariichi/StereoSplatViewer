// Keeping the miniature upright in the room while the phone rolls.
//
// The relief currently shares the screen's up axis, so rolling the device rolls
// the whole scene with it. A real object behind glass does not do that: the
// frame turns and the view stays upright. Correcting for it needs only which
// way is down, which is the one thing inertial sensing gives away for free.
//
// Gravity is read from `accelerationIncludingGravity` rather than from the
// Euler angles of `deviceorientation`. The Euler route needs a sign convention
// that differs between platforms and degenerates when the device points
// straight up or down; a vector has neither problem. It does pick up real hand
// acceleration, but gravity is a constant and hand motion is not, so a low-pass
// filter separates them.
//
// That vector points *away* from gravity, not along it: an accelerometer at
// rest measures the reaction holding the device up, so a device stood upright in
// portrait reads about +9.81 on y, not -9.81. Reading it as though it pointed
// downwards put portrait at 180 degrees and landscape at -90, which pinned the
// correction at its cap in opposite directions -- the device tilted left in
// portrait and right in landscape, never level.
//
// Gravity cannot distinguish a turn about world-up. That last axis is read
// separately from DeviceOrientation: only the change since Hold level began is
// used, so no claim is made about magnetic north and Recenter can discard drift.

export const DEFAULT_TILT_TIME_CONSTANT_MS = 220;

// Full-vector smoothing for the two-axis levelling path. Kept shorter than the
// legacy roll filter so deliberate turns still feel immediate, while the
// accelerometer noise visible in a nominally still hand is attenuated.
export const DEFAULT_GRAVITY_TIME_CONSTANT_MS = 120;
export const DEFAULT_GRAVITY_DEADBAND_RAD = (0.2 * Math.PI) / 180;
export const DEFAULT_HEADING_TIME_CONSTANT_MS = 100;
export const DEFAULT_HEADING_DEADBAND_RAD = (0.2 * Math.PI) / 180;

// The scene is not infinite: it is a picture with edges, so counter-rotating it
// fully would swing its corners into view and expose the background behind
// them. A partial, bounded correction gives the cue without the reveal.
export const DEFAULT_TILT_GAIN = 0.5;
export const MAX_TILT_CORRECTION_RAD = (18 * Math.PI) / 180;

// A screen orientation change is reported when the layout crosses the
// boundary, which is before the hand has finished turning the phone. Adopting
// the very first sample after that would make a mid-turn attitude the new
// definition of level, or drive the correction straight to its cap. Discarding
// a fifth of a second of samples costs nothing a hand can notice.
export const DEFAULT_ORIENTATION_SETTLE_MS = 250;

const MIN_GRAVITY_MAGNITUDE = 2;

// The offset introduced by the device being held in a different orientation is
// always a multiple of a quarter turn, so it can be removed without knowing
// which frame a platform reports the vector in.
//
// Three attempts to derive that from `screen.orientation.angle` all failed on
// hardware, and in opposite directions on different devices: iPhone Safari
// needed one sign in landscape, iPad Chrome neither, and iPad portrait neither.
// A real roll is small -- the correction is capped at 18 degrees and a device
// held past 45 would have changed orientation anyway -- so rounding to the
// nearest quarter turn and subtracting it leaves the roll and removes the
// orientation, whatever the convention.
export const QUARTER_TURN = Math.PI / 2;

export function removeOrientationOffset(roll) {
  if (!Number.isFinite(roll)) return roll;
  return wrapAngle(roll - Math.round(roll / QUARTER_TURN) * QUARTER_TURN);
}

// The angle of "down" within the screen plane, measured from the screen's own
// downward direction.
export function computeScreenRoll(gravity) {
  const x = Number(gravity?.x);
  const y = Number(gravity?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  // Near-vertical device orientations leave almost nothing in the screen plane,
  // so the angle becomes meaningless rather than merely noisy.
  if (Math.hypot(x, y) < MIN_GRAVITY_MAGNITUDE) return null;
  // Measured from the screen's up axis to world up, both within the screen
  // plane. Upright portrait reads (0, +G) and must give zero.
  return removeOrientationOffset(Math.atan2(-x, y));
}

export function wrapAngle(angle) {
  let wrapped = angle;
  while (wrapped > Math.PI) wrapped -= Math.PI * 2;
  while (wrapped < -Math.PI) wrapped += Math.PI * 2;
  return wrapped;
}

/**
 * Horizontal direction of the glass normal from DeviceOrientation Euler data.
 *
 * The API's intrinsic order is Z-X'-Y'' (`alpha`, `beta`, `gamma`). `alpha`
 * alone is therefore a glass heading only for one special upright posture. We
 * rotate the positive screen normal `(0, 0, 1)` and take its horizontal
 * azimuth. When the phone lies flat that projection vanishes and yaw is
 * genuinely undefined, so no stale or noisy angle is invented.
 */
export function computeScreenHeading(orientation) {
  const values = [orientation?.alpha, orientation?.beta, orientation?.gamma];
  if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
  const [alpha, beta, gamma] = values.map((degrees) => (degrees * Math.PI) / 180);
  const normalX = Math.cos(alpha) * Math.sin(gamma)
    + Math.sin(alpha) * Math.sin(beta) * Math.cos(gamma);
  const normalY = Math.sin(alpha) * Math.sin(gamma)
    - Math.cos(alpha) * Math.sin(beta) * Math.cos(gamma);
  if (Math.hypot(normalX, normalY) < 1e-3) return null;
  return wrapAngle(Math.atan2(normalX, -normalY));
}

export function clampTiltCorrection(roll, {
  gain = DEFAULT_TILT_GAIN,
  maxCorrection = MAX_TILT_CORRECTION_RAD,
  invert = false,
} = {}) {
  if (!Number.isFinite(roll)) return 0;
  const safeGain = Number.isFinite(gain) ? gain : DEFAULT_TILT_GAIN;
  const limit = Number.isFinite(maxCorrection) && maxCorrection >= 0
    ? maxCorrection
    : MAX_TILT_CORRECTION_RAD;
  const scaled = roll * safeGain * (invert ? -1 : 1);
  return Math.min(Math.max(scaled, -limit), limit);
}

// Angles wrap, so they cannot be averaged directly: filtering the shortest
// signed difference keeps the filter stable across the boundary.
export function createRollFilter({ timeConstantMs = DEFAULT_TILT_TIME_CONSTANT_MS } = {}) {
  let filtered = null;
  let lastTimestamp = null;
  return {
    reset() {
      filtered = null;
      lastTimestamp = null;
    },
    get: () => filtered,
    update(roll, timestamp) {
      if (!Number.isFinite(roll)) return filtered;
      if (filtered === null || !Number.isFinite(lastTimestamp) || !Number.isFinite(timestamp)) {
        filtered = roll;
        lastTimestamp = timestamp;
        return filtered;
      }
      const delta = Math.max(0, Math.min(timestamp - lastTimestamp, 500));
      const alpha = 1 - Math.exp(-delta / Math.max(timeConstantMs, 1));
      filtered = wrapAngle(filtered + wrapAngle(roll - filtered) * alpha);
      lastTimestamp = timestamp;
      return filtered;
    },
  };
}

/** Time-based exponential smoothing for the complete gravity vector. */
export function createGravityFilter({
  timeConstantMs = DEFAULT_GRAVITY_TIME_CONSTANT_MS,
} = {}) {
  let filtered = null;
  let lastTimestamp = null;
  return {
    reset() {
      filtered = null;
      lastTimestamp = null;
    },
    get: () => (filtered ? { ...filtered } : null),
    update(gravity, timestamp) {
      const next = {
        x: Number(gravity?.x),
        y: Number(gravity?.y),
        z: Number(gravity?.z),
      };
      if (![next.x, next.y, next.z].every(Number.isFinite)
          || Math.hypot(next.x, next.y, next.z) < MIN_GRAVITY_MAGNITUDE) {
        return filtered ? { ...filtered } : null;
      }
      if (!filtered || !Number.isFinite(lastTimestamp) || !Number.isFinite(timestamp)) {
        filtered = next;
        lastTimestamp = timestamp;
        return { ...filtered };
      }
      const delta = Math.max(0, Math.min(timestamp - lastTimestamp, 500));
      const safeTimeConstant = Number.isFinite(timeConstantMs) && timeConstantMs > 0
        ? timeConstantMs : DEFAULT_GRAVITY_TIME_CONSTANT_MS;
      const alpha = 1 - Math.exp(-delta / safeTimeConstant);
      filtered = {
        x: filtered.x + (next.x - filtered.x) * alpha,
        y: filtered.y + (next.y - filtered.y) * alpha,
        z: filtered.z + (next.z - filtered.z) * alpha,
      };
      lastTimestamp = timestamp;
      return { ...filtered };
    },
  };
}

function unitDirection(vector) {
  const magnitude = Math.hypot(vector?.x, vector?.y, vector?.z);
  if (!(magnitude > 0) || !Number.isFinite(magnitude)) return null;
  return { x: vector.x / magnitude, y: vector.y / magnitude, z: vector.z / magnitude };
}

function angularDifference(a, b) {
  if (!a || !b) return Infinity;
  const dot = Math.min(Math.max(a.x * b.x + a.y * b.y + a.z * b.z, -1), 1);
  return Math.acos(dot);
}

// iOS gates motion events behind a call made from a user gesture. Everywhere
// else the events simply arrive.
export async function requestTiltPermission({ motionEvent = globalThis.DeviceMotionEvent } = {}) {
  if (typeof motionEvent?.requestPermission !== 'function') return 'granted';
  try {
    return await motionEvent.requestPermission();
  } catch {
    return 'denied';
  }
}

/** Orientation permission is optional: gravity levelling remains useful without it. */
export async function requestOrientationPermission({
  orientationEvent = globalThis.DeviceOrientationEvent,
} = {}) {
  if (typeof orientationEvent?.requestPermission !== 'function') return 'granted';
  try {
    return await orientationEvent.requestPermission();
  } catch {
    return 'denied';
  }
}

export function createTiltTracker({
  target = globalThis,
  screen = globalThis.screen,
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  timeConstantMs = DEFAULT_TILT_TIME_CONSTANT_MS,
  gravityTimeConstantMs = DEFAULT_GRAVITY_TIME_CONSTANT_MS,
  gravityDeadbandRad = DEFAULT_GRAVITY_DEADBAND_RAD,
  headingTimeConstantMs = DEFAULT_HEADING_TIME_CONSTANT_MS,
  headingDeadbandRad = DEFAULT_HEADING_DEADBAND_RAD,
  motionEvent = globalThis.DeviceMotionEvent,
  orientationEvent = globalThis.DeviceOrientationEvent,
  onRoll = () => {},
  onHeading = () => {},
} = {}) {
  const filter = createRollFilter({ timeConstantMs });
  const gravityFilter = createGravityFilter({ timeConstantMs: gravityTimeConstantMs });
  const headingFilter = createRollFilter({ timeConstantMs: headingTimeConstantMs });
  let running = false;
  let orientationListening = false;
  let lastRawRoll = null;
  let lastRawHeading = null;
  // Kept so the raw inputs can be read off a device, since which frame a
  // platform reports gravity in cannot be settled by reasoning about the spec.
  let lastReading = null;
  let lastSmoothedReading = null;
  let lastEmittedDirection = null;
  let lastEmittedScreenAngle = null;
  let lastEmittedHeading = null;
  let settleUntil = null;

  // Every value above describes one screen coordinate frame, so all of them go
  // out of date together. Clearing them is what start and stop already did by
  // hand; recenter needs the same clearance without the subscriptions and
  // permissions those two rebuild.
  function resetSamples() {
    filter.reset();
    gravityFilter.reset();
    headingFilter.reset();
    lastRawRoll = null;
    lastRawHeading = null;
    lastReading = null;
    lastSmoothedReading = null;
    lastEmittedDirection = null;
    lastEmittedScreenAngle = null;
    lastEmittedHeading = null;
    settleUntil = null;
  }

  // Samples arriving inside the settling window belong to the turn itself, not
  // to either posture. The deadline is a moment rather than a countdown, so a
  // sample exactly at it is already the first of the new frame.
  function settling() {
    if (settleUntil === null) return false;
    if (now() < settleUntil) return true;
    settleUntil = null;
    return false;
  }

  function handleMotion(event) {
    if (settling()) return;
    const gravity = event?.accelerationIncludingGravity;
    const screenAngle = screen?.orientation?.angle ?? 0;
    const roll = computeScreenRoll(gravity);
    lastReading = {
      x: Number(gravity?.x) || 0,
      y: Number(gravity?.y) || 0,
      z: Number(gravity?.z) || 0,
      screenAngle,
    };
    if (roll === null) return;
    lastRawRoll = roll;
    const timestamp = now();
    const smoothedRoll = filter.update(roll, timestamp);
    const smoothedGravity = gravityFilter.update(lastReading, timestamp);
    if (smoothedRoll === null || !smoothedGravity) return;
    lastSmoothedReading = { ...smoothedGravity, screenAngle };

    // Compare unit vectors so a small change in accelerometer magnitude does
    // not count as a rotation. The comparison is against the last EMITTED
    // direction, so slow intentional motion accumulates rather than being
    // swallowed one sub-threshold sample at a time.
    const direction = unitDirection(smoothedGravity);
    const threshold = Number.isFinite(gravityDeadbandRad) && gravityDeadbandRad >= 0
      ? gravityDeadbandRad : DEFAULT_GRAVITY_DEADBAND_RAD;
    const shouldEmit = screenAngle !== lastEmittedScreenAngle
      || angularDifference(direction, lastEmittedDirection) >= threshold;
    if (!shouldEmit) return;
    lastEmittedDirection = direction;
    lastEmittedScreenAngle = screenAngle;
    onRoll(smoothedRoll, lastSmoothedReading);
  }

  function handleOrientation(event) {
    if (settling()) return;
    const heading = computeScreenHeading(event);
    if (heading === null) return;
    lastRawHeading = heading;
    const smoothedHeading = headingFilter.update(heading, now());
    if (smoothedHeading === null) return;
    const threshold = Number.isFinite(headingDeadbandRad) && headingDeadbandRad >= 0
      ? headingDeadbandRad : DEFAULT_HEADING_DEADBAND_RAD;
    if (lastEmittedHeading !== null
        && Math.abs(wrapAngle(smoothedHeading - lastEmittedHeading)) < threshold) return;
    lastEmittedHeading = smoothedHeading;
    onHeading(smoothedHeading);
  }

  return {
    get running() {
      return running;
    },
    getRawRoll: () => lastRawRoll,
    getReading: () => lastReading,
    getSmoothedReading: () => lastSmoothedReading,
    getRoll: () => filter.get(),
    getRawHeading: () => lastRawHeading,
    getHeading: () => headingFilter.get(),
    async start() {
      if (running) return 'granted';
      // Invoke both gated APIs before the first await so iOS sees both requests
      // inside the same user activation. Heading is optional; refusing it must
      // not take the already-working gravity stabiliser away.
      const motionPermission = requestTiltPermission({ motionEvent });
      const orientationPermission = requestOrientationPermission({ orientationEvent });
      const [permission, headingPermission] = await Promise.all([
        motionPermission,
        orientationPermission,
      ]);
      if (permission !== 'granted') return permission;
      resetSamples();
      target.addEventListener('devicemotion', handleMotion);
      if (headingPermission === 'granted') {
        target.addEventListener('deviceorientation', handleOrientation);
        orientationListening = true;
      }
      running = true;
      return 'granted';
    },
    // Turning Hold level off and on repaired a portrait/landscape change
    // because it threw the whole tracker away. Only the samples were ever
    // wrong: the granted permissions and the live listeners describe no frame
    // at all, and asking iOS for them again needs a user gesture nobody made.
    recenter({ settleMs = 0 } = {}) {
      resetSamples();
      const delay = Number.isFinite(settleMs) && settleMs > 0 ? settleMs : 0;
      settleUntil = delay > 0 ? now() + delay : null;
    },
    stop() {
      if (!running) return;
      target.removeEventListener('devicemotion', handleMotion);
      if (orientationListening) target.removeEventListener('deviceorientation', handleOrientation);
      running = false;
      orientationListening = false;
      resetSamples();
    },
  };
}
