import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LEVELLING_GAIN,
  MAX_LEVELLING_RAD,
  TRUE_WINDOW_LEVELLING_GAIN,
  computeLevelling,
  counterRotateEye,
  eyeInYawReferenceFrame,
  rotateVectorByQuaternion,
  sceneYawForDevice,
  sceneRotationForMode,
  toQuaternion,
  type Vec3,
  upInDeviceFrame,
} from '../levelling';
import { computeScreenRoll } from '../device-tilt.js';

const G = 9.81;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** The accelerometer reading for a device rolled within its own plane. */
const rolled = (degrees: number) => ({
  x: -G * Math.sin(rad(degrees)),
  y: G * Math.cos(rad(degrees)),
  z: 0,
});

/** The reading for a device tipped back towards horizontal, no roll. */
const tippedBack = (degrees: number) => ({
  x: 0,
  y: G * Math.cos(rad(degrees)),
  z: G * Math.sin(rad(degrees)),
});

describe('measuring from where the device was, not from vertical', () => {
  it('has nothing to correct at the posture levelling began in', () => {
    // A tablet is read tipped 20 to 60 degrees back, so measuring from vertical
    // had the correction pinned at its cap before anyone had moved, and only
    // the two extremes were reachable.
    for (const posture of [tippedBack(0), tippedBack(30), tippedBack(55), rolled(20)]) {
      const reference = upInDeviceFrame(posture)!;
      expect(computeLevelling(posture, { reference })).toBe(null);
    }
  });

  it('grows from nothing as the device turns away from that posture', () => {
    const reference = upInDeviceFrame(tippedBack(45))!;
    const at = (d: number) => computeLevelling(tippedBack(45 + d), { reference });
    expect(at(0)).toBe(null);
    expect(deg(Math.abs(at(4)!.tip))).toBeCloseTo(2, 6);
    expect(deg(Math.abs(at(20)!.tip))).toBeCloseTo(10, 6);
  });

  it('was pinned at the cap for an ordinary reading posture without one', () => {
    expect(deg(Math.abs(computeLevelling(tippedBack(45))!.tip)))
      .toBeCloseTo(deg(MAX_LEVELLING_RAD), 6);
  });
});

describe('the two turns, which need opposite signs', () => {
  const upright = upInDeviceFrame(tippedBack(0))!;

  it('always turns a roll back towards level, never further over', () => {
    // Established by holding a device: there is no reason to want the scene to
    // lean further than the device does, and anyone who does can turn the
    // correction off and tilt as far as they like.
    for (const d of [10, 25, 40]) {
      const r = computeLevelling(rolled(d), { reference: upright })!;
      // The device rolled by +d in the sense computeScreenRoll reports; the
      // correction carries the same sign, which is what turned it back on the
      // sibling project's hardware.
      expect(Math.sign(r.roll)).toBe(Math.sign(computeScreenRoll(rolled(d))!));
      expect(deg(Math.abs(r.roll))).toBeCloseTo(Math.min(d / 2, 18), 6);
      expect(r.tip).toBeCloseTo(0, 9);
    }
  });

  it('stands the model up when the device is tipped up, which is the other sense', () => {
    const back = computeLevelling(tippedBack(30), { reference: upright })!;
    const forward = computeLevelling(tippedBack(-30), { reference: upright })!;
    expect(back.roll).toBeCloseTo(0, 9);
    expect(Math.sign(back.tip)).toBe(-Math.sign(forward.tip));
    expect(deg(Math.abs(back.tip))).toBeCloseTo(15, 6);
    // The sign was settled on hardware, and separately from the roll's: a
    // single axis-angle could not have expressed the two independently.
    expect(Math.sign(back.tip)).toBe(1);
  });

  it('handles the two together, each keeping its own sign', () => {
    const r = computeLevelling({ x: -G * 0.3, y: G * 0.8, z: G * 0.5 }, { reference: upright })!;
    expect(Math.abs(r.roll)).toBeGreaterThan(0);
    expect(Math.abs(r.tip)).toBeGreaterThan(0);
  });

  it('keeps working as the screen turns to face the ceiling', () => {
    // A roll angle stops meaning anything there; the tip is perfectly defined.
    const r = computeLevelling(tippedBack(85), { reference: upright })!;
    expect(r).not.toBe(null);
    expect(deg(Math.abs(r.tip))).toBeCloseTo(18, 6);
  });

  it('halves each and caps both at eighteen degrees', () => {
    const r = computeLevelling(rolled(60), { reference: upright })!;
    expect(deg(Math.abs(r.roll))).toBeCloseTo(18, 6);
    expect(DEFAULT_LEVELLING_GAIN).toBe(0.5);
  });
});

describe('refusing to act on a reading that means nothing', () => {
  it('says nothing when the reading is hand movement rather than gravity', () => {
    expect(upInDeviceFrame({ x: 0.1, y: 0.2, z: 0.1 })).toBe(null);
    expect(computeLevelling({ x: 0.1, y: 0.2, z: 0.1 })).toBe(null);
    expect(computeLevelling({ x: Number.NaN, y: G, z: 0 })).toBe(null);
    expect(computeLevelling(null)).toBe(null);
  });

  it('reads the accelerometer as pointing away from gravity, not along it', () => {
    expect(upInDeviceFrame({ x: 0, y: G, z: 0 })!.y).toBeCloseTo(1, 9);
  });

  it('turns off entirely when the gain is zero', () => {
    const reference = upInDeviceFrame(tippedBack(0))!;
    expect(computeLevelling(rolled(20), { reference, gain: 0 })).toBe(null);
  });
});

describe('as a quaternion', () => {
  it('is a unit quaternion', () => {
    const reference = upInDeviceFrame(tippedBack(0))!;
    const q = toQuaternion(computeLevelling(rolled(20), { reference })!);
    expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 12);
  });

  it('carries a pure roll onto the view axis and a pure tip onto the sideways one', () => {
    const reference = upInDeviceFrame(tippedBack(0))!;
    const qRoll = toQuaternion(computeLevelling(rolled(20), { reference })!);
    expect(Math.abs(qRoll.z)).toBeGreaterThan(0.05);
    expect(Math.abs(qRoll.x)).toBeCloseTo(0, 9);
    const qTip = toQuaternion(computeLevelling(tippedBack(20), { reference })!);
    expect(Math.abs(qTip.x)).toBeGreaterThan(0.05);
    expect(Math.abs(qTip.z)).toBeCloseTo(0, 9);
  });
});

describe('fusing gravity attitude with the tracked eye', () => {
  const upright = upInDeviceFrame(tippedBack(0))!;

  it('uses full response in True Window while retaining the finite-scene cap', () => {
    const ordinary = computeLevelling(tippedBack(12), {
      reference: upright,
      gain: TRUE_WINDOW_LEVELLING_GAIN,
    })!;
    expect(deg(ordinary.tip)).toBeCloseTo(12, 6);

    const beyondCoverage = computeLevelling(tippedBack(40), {
      reference: upright,
      gain: TRUE_WINDOW_LEVELLING_GAIN,
    })!;
    expect(deg(beyondCoverage.tip)).toBeCloseTo(18, 6);
  });

  it('removes the device-attitude component from a tracked eye', () => {
    const attitude = toQuaternion(computeLevelling(tippedBack(12), {
      reference: upright,
      gain: TRUE_WINDOW_LEVELLING_GAIN,
    })!);
    const baselineEye = { x: 0.25, y: -0.15, z: 5.5 };
    const eyeReportedInTurnedDevice = rotateVectorByQuaternion(baselineEye, attitude);
    const fused = counterRotateEye(eyeReportedInTurnedDevice, attitude);
    expect(fused.x).toBeCloseTo(baselineEye.x, 10);
    expect(fused.y).toBeCloseTo(baselineEye.y, 10);
    expect(fused.z).toBeCloseTo(baselineEye.z, 10);
  });

  it('preserves real head translation while changing its coordinate frame', () => {
    const attitude = toQuaternion(computeLevelling({
      x: -G * 0.25,
      y: G * 0.9,
      z: G * 0.35,
    }, {
      reference: upright,
      gain: TRUE_WINDOW_LEVELLING_GAIN,
    })!);
    const baseline = { x: 0, y: 0, z: 6 };
    const moved = { x: 0.4, y: -0.25, z: 5.7 };
    const reportedBaseline = rotateVectorByQuaternion(baseline, attitude);
    const reportedMoved = rotateVectorByQuaternion(moved, attitude);
    const fusedBaseline = counterRotateEye(reportedBaseline, attitude);
    const fusedMoved = counterRotateEye(reportedMoved, attitude);
    expect(fusedMoved.x - fusedBaseline.x).toBeCloseTo(moved.x - baseline.x, 10);
    expect(fusedMoved.y - fusedBaseline.y).toBeCloseTo(moved.y - baseline.y, 10);
    expect(fusedMoved.z - fusedBaseline.z).toBeCloseTo(moved.z - baseline.z, 10);
  });

  it('turns a former steady-state cancellation into a cue matching Hold level off', () => {
    const attitude = toQuaternion(computeLevelling(tippedBack(12), {
      reference: upright,
      gain: TRUE_WINDOW_LEVELLING_GAIN,
    })!);
    const baselineEye = { x: 0, y: 0, z: 6 };
    const subject = { x: 0, y: 0, z: -3 };
    const reportedEye = rotateVectorByQuaternion(baselineEye, attitude);
    const formerlyTurnedSubject = rotateVectorByQuaternion(subject, attitude);
    const projectY = (eye: Vec3, point: Vec3) => (
      (eye.z * point.y - point.z * eye.y) / (eye.z - point.z)
    );

    // Applying the same rotation to both was the spring-cancelled state.
    expect(projectY(reportedEye, formerlyTurnedSubject)).toBeCloseTo(0, 10);

    const withoutHoldLevel = projectY(reportedEye, subject);
    const sceneAttitude = sceneRotationForMode(attitude, { trueWindow: true })!;
    const withHoldLevel = projectY(
      counterRotateEye(reportedEye, attitude),
      rotateVectorByQuaternion(subject, sceneAttitude),
    );
    expect(Math.abs(withHoldLevel)).toBeGreaterThan(0.1);
    expect(Math.sign(withHoldLevel)).toBe(Math.sign(withoutHoldLevel));
  });

  it('leaves the eye untouched without a usable attitude', () => {
    const eye = { x: 0.2, y: -0.1, z: 5 };
    expect(counterRotateEye(eye, null)).toEqual(eye);
    expect(counterRotateEye(eye, { x: 0, y: Number.NaN, z: 0, w: 1 })).toEqual(eye);
  });
});

describe('mode-specific scene rotation', () => {
  const upright = upInDeviceFrame(tippedBack(0))!;

  it('changes only the pitch sign in True Window, including the cross term', () => {
    const levelling = { roll: rad(13), tip: rad(-9) };
    const scene = sceneRotationForMode(toQuaternion(levelling), { trueWindow: true })!;
    const expected = toQuaternion({ roll: levelling.roll, tip: -levelling.tip });
    expect(scene.x).toBeCloseTo(expected.x, 12);
    expect(scene.y).toBeCloseTo(expected.y, 12);
    expect(scene.z).toBeCloseTo(expected.z, 12);
    expect(scene.w).toBeCloseTo(expected.w, 12);
  });

  it('aligns model up with measured up for either direction of roll', () => {
    // Stay below the deliberate 18-degree finite-scene coverage cap so this
    // checks direction and exact response rather than saturation.
    for (const degrees of [-15, -10, 10, 15]) {
      const reading = rolled(degrees);
      const attitude = toQuaternion(computeLevelling(reading, {
        reference: upright,
        gain: TRUE_WINDOW_LEVELLING_GAIN,
      })!);
      const scene = sceneRotationForMode(attitude, { trueWindow: true })!;
      const modelUp = rotateVectorByQuaternion({ x: 0, y: 1, z: 0 }, scene);
      const measuredUp = upInDeviceFrame(reading)!;
      expect(modelUp.x).toBeCloseTo(measuredUp.x, 9);
      expect(modelUp.y).toBeCloseTo(measuredUp.y, 9);
      expect(modelUp.z).toBeCloseTo(0, 9);
    }
  });

  it('reduces rather than amplifies either direction of photo-mode roll', () => {
    for (const degrees of [-15, -8, 8, 15]) {
      const reading = rolled(degrees);
      const attitude = toQuaternion(computeLevelling(reading, { reference: upright })!);
      const scene = sceneRotationForMode(attitude, { trueWindow: false })!;
      const modelUp = rotateVectorByQuaternion({ x: 0, y: 1, z: 0 }, scene);
      const measuredUp = upInDeviceFrame(reading)!;
      expect(Math.sign(modelUp.x)).toBe(Math.sign(measuredUp.x));
      expect(Math.abs(modelUp.x)).toBeLessThan(Math.abs(measuredUp.x));
    }
  });

  it('does not let photo-mode Hold level interfere with pitch viewpoint', () => {
    const reading = tippedBack(12);
    const fullAttitude = toQuaternion(computeLevelling(reading, {
      reference: upright,
      gain: TRUE_WINDOW_LEVELLING_GAIN,
    })!);
    const photoAttitude = toQuaternion(computeLevelling(reading, { reference: upright })!);
    const photoScene = sceneRotationForMode(photoAttitude, { trueWindow: false });
    expect(photoScene).toBe(null);

    const baselineEye = { x: 0, y: 0, z: 6 };
    const subject = { x: 0, y: 0, z: -3 };
    const reportedEye = rotateVectorByQuaternion(baselineEye, fullAttitude);
    const projectY = (eye: Vec3, point: Vec3) => (
      (eye.z * point.y - point.z * eye.y) / (eye.z - point.z)
    );
    // With no photo-mode pitch model turn, Hold level cannot cancel or reverse
    // the up/down camera cue supplied by the face tracker.
    const subjectWithHold = photoScene
      ? rotateVectorByQuaternion(subject, photoScene)
      : subject;
    expect(projectY(reportedEye, subjectWithHold))
      .toBeCloseTo(projectY(reportedEye, subject), 12);
  });

  it('keeps only roll from a combined photo-mode reading', () => {
    const levelling = { roll: rad(11), tip: rad(8) };
    const attitude = toQuaternion(levelling);
    const scene = sceneRotationForMode(attitude, { trueWindow: false })!;
    const expected = toQuaternion({ roll: levelling.roll, tip: 0 });
    expect(scene.x).toBeCloseTo(expected.x, 12);
    expect(scene.y).toBeCloseTo(expected.y, 12);
    expect(scene.z).toBeCloseTo(expected.z, 12);
    expect(scene.w).toBeCloseTo(expected.w, 12);
  });
});

describe('fusing device yaw separately from face translation', () => {
  it('moves a camera-frame eye back into the heading reference frame', () => {
    const yaw = rad(14);
    const baseline = { x: 0.25, y: -0.1, z: 6 };
    // A fixed world-space eye is seen through the inverse of the phone turn.
    const reported = rotateVectorByQuaternion(baseline, sceneYawForDevice(yaw));
    const fused = eyeInYawReferenceFrame(reported, yaw);
    expect(fused.x).toBeCloseTo(baseline.x, 10);
    expect(fused.y).toBeCloseTo(baseline.y, 10);
    expect(fused.z).toBeCloseTo(baseline.z, 10);
  });

  it('preserves a real head translation while removing phone yaw', () => {
    const yaw = rad(-17);
    const baseline = { x: 0, y: 0, z: 6 };
    const moved = { x: 0.45, y: -0.2, z: 5.7 };
    const phoneFrame = sceneYawForDevice(yaw);
    const fusedBaseline = eyeInYawReferenceFrame(
      rotateVectorByQuaternion(baseline, phoneFrame), yaw,
    );
    const fusedMoved = eyeInYawReferenceFrame(
      rotateVectorByQuaternion(moved, phoneFrame), yaw,
    );
    expect(fusedMoved.x - fusedBaseline.x).toBeCloseTo(moved.x - baseline.x, 10);
    expect(fusedMoved.y - fusedBaseline.y).toBeCloseTo(moved.y - baseline.y, 10);
    expect(fusedMoved.z - fusedBaseline.z).toBeCloseTo(moved.z - baseline.z, 10);
  });

  it('uses inverse turns for the eye frame and the world behind the glass', () => {
    const yaw = rad(12);
    const forward = { x: 0, y: 0, z: 1 };
    const worldInPhone = rotateVectorByQuaternion(forward, sceneYawForDevice(yaw));
    const recovered = eyeInYawReferenceFrame(worldInPhone, yaw);
    expect(Math.sign(worldInPhone.x)).toBe(-1);
    expect(recovered.x).toBeCloseTo(0, 10);
    expect(recovered.z).toBeCloseTo(1, 10);
  });

  it('is harmless without a finite heading', () => {
    const eye = { x: 0.2, y: -0.1, z: 5 };
    expect(eyeInYawReferenceFrame(eye, Number.NaN)).toEqual(eye);
    expect(sceneYawForDevice(Number.NaN)).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  });
});
