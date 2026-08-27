// Holding the scene still in the room while the device turns around it.
//
// A window shows a world that stays where it is; turning the frame changes
// which part of it you see, not where it is. A scene placed behind the glass in
// the *screen's* coordinates does the opposite -- it is carried around with the
// device, like a snow globe glued to the back of the phone -- and then the
// viewer's eye, which really has moved relative to the turning screen,
// produces parallax across the whole depth of it. Turning the device 20 degrees
// slides the background nearly twice a half-frame past the subject, which reads
// as the scene swinging about.
//
// The cure is to turn the scene the other way, by however much the device
// turned. Gravity gives two of the three axes, which happen to be the two a
// hand-held device actually moves through: heading is the missing one and needs
// a magnetometer that wanders indoors.
//
// It cannot be done in full. The scene is a photograph with edges, not a room,
// so turning it all the way back swings its corners into view and exposes the
// nothing behind them. The correction is therefore scaled and capped, exactly
// as the roll-only version it replaces was.

export type Vec3 = { x: number; y: number; z: number };
export type Quaternion = { x: number; y: number; z: number; w: number };

/** Photo mode's deliberately partial response. */
export const DEFAULT_LEVELLING_GAIN = 0.5;
/** True Window uses the measured pitch/roll without scaling. */
export const TRUE_WINDOW_LEVELLING_GAIN = 1;
export const MAX_LEVELLING_RAD = (18 * Math.PI) / 180;

/** Below this the reading is hand movement rather than gravity. */
const MIN_GRAVITY = 2;

export type AxisAngle = { axis: Vec3; angle: number };

/** The filtered phone attitude relative to the posture captured at start. */
export type Levelling = {
  /** About the view axis: the device rolled left or right. */
  roll: number;
  /** About the sideways axis: the device tipped towards or away from you. */
  tip: number;
};

/** The direction of up in the device's own axes, or null if the reading is noise. */
export function upInDeviceFrame(gravity: Partial<Vec3> | null | undefined): Vec3 | null {
  const x = Number(gravity?.x);
  const y = Number(gravity?.y);
  const z = Number(gravity?.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  const magnitude = Math.hypot(x, y, z);
  if (!(magnitude >= MIN_GRAVITY)) return null;
  return { x: x / magnitude, y: y / magnitude, z: z / magnitude };
}

function damp(angle: number, gain: number, limit: number): number {
  const safeGain = Number.isFinite(gain) && gain >= 0 ? gain : DEFAULT_LEVELLING_GAIN;
  const safeLimit = Number.isFinite(limit) && limit >= 0 ? limit : MAX_LEVELLING_RAD;
  const scaled = angle * safeGain;
  return Math.min(Math.max(scaled, -safeLimit), safeLimit);
}

/**
 * How far the phone moved from its reference posture on gravity's two axes.
 *
 * They stay separate because the scene needs a different mapping for each mode:
 *
 *  - **Roll** is measured from model-up to the gravity-derived world-up in the
 *    phone's screen plane. Applying it directly keeps the model level.
 *  - **Tip** says how far the screen turned toward the ceiling. True Window
 *    applies its inverse to the model; photo mode leaves it to the tracked eye.
 *
 * Both are measured from the posture levelling began in, not from vertical: a
 * tablet is read tipped well back, and measuring from vertical put the
 * correction at its cap before anyone had moved.
 *
 * Both measurements are scaled and capped before the mode mapping, because the
 * scene is a photograph with edges and turning it too far exposes missing data.
 * True Window uses a gain of one while photo mode retains half-strength roll.
 */
export function computeLevelling(
  gravity: Partial<Vec3> | null | undefined,
  {
    reference = null,
    gain = DEFAULT_LEVELLING_GAIN,
    maxAngle = MAX_LEVELLING_RAD,
  }: {
    reference?: Vec3 | null;
    gain?: number;
    maxAngle?: number;
  } = {},
): Levelling | null {
  const up = upInDeviceFrame(gravity);
  if (!up) return null;
  const from = reference ?? { x: 0, y: 1, z: 0 };

  // Roll: how far gravity has swung within the plane of the screen. The sign
  // follows the roll-only version that was settled on two devices.
  const rollNow = Math.atan2(-up.x, up.y);
  const rollWas = Math.atan2(-from.x, from.y);
  let rollDelta = rollNow - rollWas;
  while (rollDelta > Math.PI) rollDelta -= Math.PI * 2;
  while (rollDelta < -Math.PI) rollDelta += Math.PI * 2;

  // Tip: how far the screen has turned to face the ceiling. Its sign is the
  // same as the roll's rather than opposite, which is the way round it was
  // wanted on hardware; the two were separated precisely because they need
  // deciding independently.
  const tipDelta = Math.asin(Math.min(Math.max(up.z, -1), 1))
    - Math.asin(Math.min(Math.max(from.z, -1), 1));

  const roll = damp(rollDelta, gain, maxAngle);
  const tip = damp(tipDelta, gain, maxAngle);
  if (Math.abs(roll) < 1e-6 && Math.abs(tip) < 1e-6) return null;
  return { roll, tip };
}

/**
 * The two attitude components as one quaternion, tip first and then roll.
 *
 * The order matters only at large angles, and both are capped at eighteen
 * degrees, so it is chosen for the reading it gives rather than forced: the
 * the axes are composed consistently.
 */
export function toQuaternion({ roll, tip }: Levelling): Quaternion {
  const hx = tip / 2;
  const hz = roll / 2;
  const sx = Math.sin(hx), cx = Math.cos(hx);
  const sz = Math.sin(hz), cz = Math.cos(hz);
  // q = qz * qx, with qx about (1,0,0) and qz about (0,0,1).
  return {
    x: cz * sx,
    y: sz * sx,
    z: sz * cx,
    w: cz * cx,
  };
}

/** Rotate a vector by a quaternion, accepting small normalisation drift. */
export function rotateVectorByQuaternion(vector: Vec3, rotation: Quaternion): Vec3 {
  if (![vector?.x, vector?.y, vector?.z].every(Number.isFinite)) return { ...vector };
  const magnitude = Math.hypot(rotation?.x, rotation?.y, rotation?.z, rotation?.w);
  if (!(magnitude > 1e-9) || !Number.isFinite(magnitude)) return { ...vector };
  const x = rotation.x / magnitude;
  const y = rotation.y / magnitude;
  const z = rotation.z / magnitude;
  const w = rotation.w / magnitude;

  // q * v * conjugate(q), written as two cross products to avoid temporary
  // quaternion allocations on every motion/head-tracking update.
  const tx = 2 * (y * vector.z - z * vector.y);
  const ty = 2 * (z * vector.x - x * vector.z);
  const tz = 2 * (x * vector.y - y * vector.x);
  return {
    x: vector.x + w * tx + (y * tz - z * ty),
    y: vector.y + w * ty + (z * tx - x * tz),
    z: vector.z + w * tz + (x * ty - y * tx),
  };
}

/** The unit inverse of a rotation quaternion, or null for unusable input. */
export function inverseRotation(
  rotation: Quaternion | null | undefined,
): Quaternion | null {
  if (!rotation) return null;
  const magnitude = Math.hypot(rotation.x, rotation.y, rotation.z, rotation.w);
  if (!(magnitude > 1e-9) || !Number.isFinite(magnitude)) return null;
  return {
    x: -rotation.x / magnitude,
    y: -rotation.y / magnitude,
    z: -rotation.z / magnitude,
    w: rotation.w / magnitude,
  };
}

/**
 * Turn the model with the per-axis signs each viewing mode needs.
 *
 * `attitude` is `qz(roll) * qx(tip)`. In True Window the model must follow the
 * measured roll so its up axis agrees with gravity, but use the opposite tip so
 * looking over/under the phone agrees with the unassisted head-tracked view.
 * Negating x and y changes only `tip` for this composition. Photo mode keeps
 * the roll stabiliser but leaves pitch entirely to the tracked eye; otherwise
 * its half-strength model turn cancels that camera movement.
 */
export function sceneRotationForMode(
  attitude: Quaternion | null | undefined,
  { trueWindow }: { trueWindow: boolean },
): Quaternion | null {
  if (!attitude) return null;
  const magnitude = Math.hypot(attitude.x, attitude.y, attitude.z, attitude.w);
  if (!(magnitude > 1e-9) || !Number.isFinite(magnitude)) return null;
  const q = {
    x: attitude.x / magnitude,
    y: attitude.y / magnitude,
    z: attitude.z / magnitude,
    w: attitude.w / magnitude,
  };
  if (trueWindow) return { x: -q.x, y: -q.y, z: q.z, w: q.w };

  // For qz(roll) * qx(tip), atan2(z, w) is roll/2 regardless of tip.
  const halfRoll = Math.atan2(q.z, q.w);
  const z = Math.sin(halfRoll);
  if (Math.abs(z) < 1e-9) return null;
  return { x: 0, y: 0, z, w: Math.cos(halfRoll) };
}

/**
 * Express a camera-reported eye in the posture captured by Hold level.
 *
 * A phone pitch rotates both the gravity attitude and the metric eye reported
 * in camera coordinates. Applying the attitude to the scene while using that
 * raw eye made the two visual changes cancel at rest. Counter-rotating the eye
 * removes only the predictable device-attitude component; real translation of
 * the observer remains in the returned reference-frame vector.
 */
export function counterRotateEye(
  eye: Vec3,
  attitude: Quaternion | null | undefined,
): Vec3 {
  const inverse = inverseRotation(attitude);
  return inverse ? rotateVectorByQuaternion(eye, inverse) : { ...eye };
}

/** A right-handed turn about screen-up, with identity for unusable input. */
function yawRotation(angle: number): Quaternion {
  if (!Number.isFinite(angle)) return { x: 0, y: 0, z: 0, w: 1 };
  const half = angle / 2;
  return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
}

/**
 * Express a camera-frame eye in the heading reference captured by Hold level.
 *
 * Turning the phone by `yaw` makes a fixed observer appear through the inverse
 * turn in camera coordinates. Applying the device-to-reference turn removes
 * that phone motion. A real translation is carried through the rotation rather
 * than negated, so Reverse tracking remains solely the front-camera axis
 * calibration it was meant to be.
 */
export function eyeInYawReferenceFrame(eye: Vec3, yaw: number): Vec3 {
  return Number.isFinite(yaw)
    ? rotateVectorByQuaternion(eye, yawRotation(yaw))
    : { ...eye };
}

/** A stationary world behind the glass, expressed in the turned phone frame. */
export function sceneYawForDevice(yaw: number): Quaternion {
  return yawRotation(-yaw);
}
