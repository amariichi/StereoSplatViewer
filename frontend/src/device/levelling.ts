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

/** Half of the device's turn is given back, which was arrived at on hardware. */
export const DEFAULT_LEVELLING_GAIN = 0.5;
export const MAX_LEVELLING_RAD = (18 * Math.PI) / 180;

/** Below this the reading is hand movement rather than gravity. */
const MIN_GRAVITY = 2;

export type AxisAngle = { axis: Vec3; angle: number };

/** The two turns, kept apart because they need opposite signs. */
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
 * How far to turn the scene, split into the two turns a hand actually makes.
 *
 * They are kept apart because they want opposite signs, which is not something
 * that could be reasoned to and was established by holding a device:
 *
 *  - **Rolling** the device left or right should always turn the scene *back*.
 *    There is no reason to want the scene to lean further than the device does;
 *    anyone who wants a leaning picture can turn the correction off and tilt
 *    the device as far as they like.
 *  - **Tipping** it towards or away should stand the model up, which is the
 *    opposite sense.
 *
 * Both are measured from the posture levelling began in, not from vertical: a
 * tablet is read tipped well back, and measuring from vertical put the
 * correction at its cap before anyone had moved.
 *
 * Both are halved and capped, because the scene is a photograph with edges and
 * turning it all the way back swings its corners into view.
 */
export function computeLevelling(
  gravity: Partial<Vec3> | null | undefined,
  {
    reference = null,
    gain = DEFAULT_LEVELLING_GAIN,
    maxAngle = MAX_LEVELLING_RAD,
  }: { reference?: Vec3 | null; gain?: number; maxAngle?: number } = {},
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
 * The two turns as one quaternion, tip first and then roll.
 *
 * The order matters only at large angles, and both are capped at eighteen
 * degrees, so it is chosen for the reading it gives rather than forced: the
 * scene is stood up, then levelled.
 */
export function toQuaternion({ roll, tip }: Levelling): { x: number; y: number; z: number; w: number } {
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
