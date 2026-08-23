import { expect, test } from 'vitest';

// node:assert/strict, expressed through vitest. The assertions in this file are
// copied unchanged from the project these modules came from, so the harness is
// adapted rather than the tests.
const assert = Object.assign(
  (value, message) => expect(value, message).toBeTruthy(),
  {
    ok: (value, message) => expect(value, message).toBeTruthy(),
    equal: (actual, expected, message) => expect(actual, message).toBe(expected),
    notEqual: (actual, expected, message) => expect(actual, message).not.toBe(expected),
    deepEqual: (actual, expected, message) => expect(actual, message).toEqual(expected),
    throws: (fn, _expected, message) => expect(fn, message).toThrow(),
    rejects: async (fn, _expected, message) => await expect(
      typeof fn === 'function' ? fn() : fn, message).rejects.toThrow(),
    match: (actual, re, message) => expect(actual, message).toMatch(re),
    doesNotThrow: (fn, message) => expect(fn, message).not.toThrow(),
  },
);


import {
  DEFAULT_TILT_GAIN,
  MAX_TILT_CORRECTION_RAD,
  clampTiltCorrection,
  computeScreenRoll,
  createRollFilter,
  createTiltTracker,
  removeOrientationOffset,
  requestTiltPermission,
  wrapAngle,
} from '../device-tilt.js';

const G = 9.81;
const deg = (radians) => (radians * 180) / Math.PI;


test('the reported vector points away from gravity, not along it', () => {
  // An accelerometer at rest measures the reaction holding the device up, so a
  // device stood upright in portrait reads about +9.81 on y. Reading it as
  // though it pointed downwards put portrait at 180 degrees and landscape at
  // -90, pinning the correction at its cap in opposite directions: the view
  // tilted left in portrait and right in landscape, never level.
  assert.equal(computeScreenRoll({ x: 0, y: G, z: 0 }), 0);

  // A modest, realistic roll.
  const roll = computeScreenRoll({ x: -G * Math.sin(Math.PI / 9), y: G * Math.cos(Math.PI / 9), z: 0 });
  assert.ok(Math.abs(deg(roll) - 20) < 1e-6, `expected 20 degrees, got ${deg(roll)}`);
  const other = computeScreenRoll({ x: G * Math.sin(Math.PI / 9), y: G * Math.cos(Math.PI / 9), z: 0 });
  assert.ok(Math.abs(deg(other) + 20) < 1e-6);
});


test('a device pointing straight up or down reports no usable roll', () => {
  // Lying flat on a table, the vector is almost entirely along the screen
  // normal, so its direction within the screen plane is meaningless rather than
  // merely noisy.
  assert.equal(computeScreenRoll({ x: 0.1, y: -0.2, z: G }), null);
  assert.equal(computeScreenRoll({ x: Number.NaN, y: G, z: 0 }), null);
  assert.equal(computeScreenRoll(null), null);
});


test('holding the device in any orientation reads as level', () => {
  // The offset from orientation is always a multiple of a quarter turn, so it
  // is removed by rounding rather than by consulting screen.orientation.angle.
  // Three attempts to derive that angle's convention failed on hardware, in
  // opposite directions on different devices.
  const held = (degrees) => ({
    x: -G * Math.sin((degrees * Math.PI) / 180),
    y: G * Math.cos((degrees * Math.PI) / 180),
    z: 0,
  });
  for (const orientation of [0, 90, 180, 270, -90]) {
    const roll = computeScreenRoll(held(orientation));
    assert.ok(Math.abs(deg(roll)) < 1e-6, `orientation ${orientation} read as ${deg(roll)}`);
  }

  // A real roll on top of any orientation survives.
  for (const orientation of [0, 90, 180, 270]) {
    const roll = computeScreenRoll(held(orientation + 12));
    assert.ok(Math.abs(deg(roll) - 12) < 1e-6, `orientation ${orientation} + 12 read as ${deg(roll)}`);
  }
});


test('the quarter-turn offset is removed without swallowing a real roll', () => {
  const q = Math.PI / 2;
  assert.ok(Math.abs(removeOrientationOffset(0.3) - 0.3) < 1e-9);
  assert.ok(Math.abs(removeOrientationOffset(q + 0.3) - 0.3) < 1e-9);
  assert.ok(Math.abs(removeOrientationOffset(-q + 0.3) - 0.3) < 1e-9);
  assert.ok(Math.abs(removeOrientationOffset(Math.PI - 0.3) + 0.3) < 1e-9);

  // The residual can never exceed half a quarter turn, which is well past the
  // 18 degree cap, so nothing usable is lost.
  for (let a = -Math.PI; a <= Math.PI; a += 0.05) {
    assert.ok(Math.abs(removeOrientationOffset(a)) <= q / 2 + 1e-9);
  }
});


test('the correction is scaled and bounded because the picture has edges', () => {
  // Counter-rotating fully would swing the picture's corners into view, so the
  // cue is given partially and capped.
  assert.ok(Math.abs(clampTiltCorrection(0.4) - 0.4 * DEFAULT_TILT_GAIN) < 1e-9);
  assert.equal(clampTiltCorrection(Math.PI / 2), MAX_TILT_CORRECTION_RAD);
  assert.equal(clampTiltCorrection(-Math.PI / 2), -MAX_TILT_CORRECTION_RAD);
  assert.equal(clampTiltCorrection(Number.NaN), 0);

  // Handedness is left correctable, as it is for the front camera.
  assert.ok(clampTiltCorrection(0.3, { invert: true }) < 0);
  assert.equal(clampTiltCorrection(0.3, { gain: 0 }), 0);
});


test('the roll filter follows the shortest way round rather than unwinding', () => {
  const filter = createRollFilter({ timeConstantMs: 100 });
  assert.equal(filter.get(), null);
  filter.update(Math.PI - 0.05, 0);

  // Crossing the wrap boundary is a small move, not a near-full turn.
  const crossed = filter.update(-Math.PI + 0.05, 1000);
  assert.ok(Math.abs(wrapAngle(crossed - (-Math.PI + 0.05))) < 0.02);

  // Smoothing really is applied rather than the newest value being taken.
  const fresh = createRollFilter({ timeConstantMs: 1000 });
  fresh.update(0, 0);
  const damped = fresh.update(1, 100);
  assert.ok(damped > 0 && damped < 0.2, `expected a damped step, got ${damped}`);

  fresh.reset();
  assert.equal(fresh.get(), null);
});


test('the tracker starts only with permission and stops listening cleanly', async () => {
  const listeners = new Map();
  const target = {
    addEventListener: (type, handler) => listeners.set(type, handler),
    removeEventListener: (type) => listeners.delete(type),
  };
  const rolls = [];
  const tracker = createTiltTracker({
    target,
    screen: { orientation: { angle: 0 } },
    now: () => 0,
    onRoll: (roll) => rolls.push(roll),
  });

  assert.equal(await tracker.start(), 'granted');
  assert.equal(tracker.running, true);
  listeners.get('devicemotion')({ accelerationIncludingGravity: { x: G, y: 0, z: 0 } });

  // The raw inputs are kept so a device can be read rather than reasoned about.
  assert.deepEqual(tracker.getReading(), { x: G, y: 0, z: 0, screenAngle: 0 });
  // 90 degrees of orientation is removed, leaving no roll.
  assert.ok(Math.abs(deg(tracker.getRawRoll())) < 1e-6);

  // A reading with no usable in-plane component must be ignored, not reported.
  const before = rolls.length;
  listeners.get('devicemotion')({ accelerationIncludingGravity: { x: 0, y: 0, z: G } });
  assert.equal(rolls.length, before);

  tracker.stop();
  assert.equal(tracker.running, false);
  assert.equal(listeners.has('devicemotion'), false);
  assert.equal(tracker.getRoll(), null);
});


test('a refused motion permission leaves the tracker stopped', async () => {
  const tracker = createTiltTracker({
    target: { addEventListener: () => {}, removeEventListener: () => {} },
    screen: { orientation: { angle: 0 } },
  });
  const original = globalThis.DeviceMotionEvent;
  globalThis.DeviceMotionEvent = { requestPermission: async () => 'denied' };
  try {
    assert.equal(await tracker.start(), 'denied');
    assert.equal(tracker.running, false);
  } finally {
    globalThis.DeviceMotionEvent = original;
  }
});


test('platforms without a permission gate report granted', async () => {
  assert.equal(await requestTiltPermission({ motionEvent: undefined }), 'granted');
  assert.equal(await requestTiltPermission({
    motionEvent: { requestPermission: async () => { throw new Error('blocked'); } },
  }), 'denied');
});
