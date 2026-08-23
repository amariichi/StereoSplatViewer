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
  DEFAULT_XY_GAIN,
  DEFAULT_Z_GAIN,
  FACE_LANDMARKER_MODEL_URL,
  HeadTracker,
  MEDIAPIPE_TASKS_VERSION,
  averageObservations,
  computeEyeObservation,
  createEyeCalibration,
  createPoseFilter,
  FACE_LANDMARKER_DELEGATES,
  extractMetricHeadTranslation,
  mapMetricPoseToEyePose,
  preferredDelegates,
  mapObservationToEyePose,
  observationsAreStable,
} from '../head-tracker.js';
import {
  MAX_SUPPORTED_EYE_Z,
  sanitizeEye,
} from '../../viewer/off-axis';


const LEFT_IRIS = [473, 474, 475, 476, 477];
const RIGHT_IRIS = [468, 469, 470, 471, 472];

function landmarks({ leftX = 0.4, rightX = 0.6, y = 0.5 } = {}) {
  const result = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  LEFT_IRIS.forEach((index) => { result[index] = { x: leftX, y }; });
  RIGHT_IRIS.forEach((index) => { result[index] = { x: rightX, y }; });
  return result;
}


test('uses a pinned official MediaPipe package and model', () => {
  assert.equal(MEDIAPIPE_TASKS_VERSION, '1.0.0');
  assert.match(FACE_LANDMARKER_MODEL_URL, /face_landmarker\/float16\/1\/face_landmarker\.task$/);
});


test('computes eye centers with actual camera dimensions', () => {
  const observation = computeEyeObservation(landmarks(), 640, 480);
  assert.deepEqual(observation.center, { x: 320, y: 240 });
  assert.ok(Math.abs(observation.eyeDistance - 128) < 1e-6);
});


test('calibration maps baseline and relative XYZ with expected depth direction', () => {
  const baseline = computeEyeObservation(landmarks(), 640, 480);
  const calibration = createEyeCalibration(baseline, { baselineEyeZ: 2.5 });
  const centered = mapObservationToEyePose(baseline, calibration);
  assert.deepEqual({ x: centered.x, y: centered.y, z: centered.z }, { x: 0, y: 0, z: 2.5 });

  const closer = computeEyeObservation(landmarks({ leftX: 0.35, rightX: 0.65 }), 640, 480);
  const farther = computeEyeObservation(landmarks({ leftX: 0.45, rightX: 0.55 }), 640, 480);
  assert.ok(mapObservationToEyePose(closer, calibration).z < 2.5);
  assert.ok(mapObservationToEyePose(farther, calibration).z > 2.5);
  assert.equal(DEFAULT_Z_GAIN, 0.1);
  assert.ok(mapObservationToEyePose(closer, calibration).z > 2.35);
  assert.ok(mapObservationToEyePose(farther, calibration).z < 3.0);
});


test('maps unmirrored front-camera X into display-space handedness with a conservative gain', () => {
  const baseline = computeEyeObservation(landmarks(), 640, 480);
  const calibration = createEyeCalibration(baseline, { baselineEyeZ: 2.5 });
  const oneEyeDistanceRightInCamera = computeEyeObservation(
    landmarks({ leftX: 0.6, rightX: 0.8 }),
    640,
    480,
  );
  const pose = mapObservationToEyePose(oneEyeDistanceRightInCamera, calibration);
  assert.equal(DEFAULT_XY_GAIN, 0.325);
  assert.ok(Math.abs(pose.x + DEFAULT_XY_GAIN) < 1e-6);

  const unmirroredOverride = mapObservationToEyePose(
    oneEyeDistanceRightInCamera,
    calibration,
    { mirrorX: false },
  );
  assert.ok(Math.abs(unmirroredOverride.x - DEFAULT_XY_GAIN) < 1e-6);
});


test('tracker can change horizontal handedness and forces a fresh calibration', () => {
  const tracker = new HeadTracker({
    video: {},
    mirrorX: true,
  });
  tracker.calibration = { center: { x: 1, y: 1 }, eyeDistance: 1, baselineEyeZ: 2.5 };
  tracker.setMirrorX(false);
  assert.equal(tracker.mirrorX, false);
  assert.equal(tracker.calibration, null);
});


test('tracker accepts a browser-specific XY gain without changing projection math', () => {
  const tracker = new HeadTracker({
    video: { videoWidth: 640, videoHeight: 480 },
    mirrorX: true,
    xyGain: 0.65,
  });
  tracker.calibration = createEyeCalibration(
    computeEyeObservation(landmarks(), 640, 480),
    { baselineEyeZ: 2.5 },
  );
  let observed = null;
  tracker.onPose = (pose) => { observed = pose; };
  tracker.processResult({
    faceLandmarks: [landmarks({ leftX: 0.6, rightX: 0.8 })],
  }, 100);
  assert.ok(Math.abs(observed.x + 0.65) < 1e-6);
});


test('rejects zero eye distance and clamps extreme relative poses', () => {
  assert.throws(
    () => computeEyeObservation(landmarks({ leftX: 0.5, rightX: 0.5 }), 640, 480),
    /eye distance/,
  );
  const baseline = computeEyeObservation(landmarks(), 640, 480);
  const calibration = createEyeCalibration(baseline);
  const extreme = {
    ...baseline,
    center: { x: 10000, y: -10000 },
    eyeDistance: 100000,
  };
  const pose = mapObservationToEyePose(extreme, calibration);
  assert.equal(pose.x, -1.5);
  assert.equal(pose.y, 1.5);
  assert.ok(pose.z > 2.2 && pose.z < 2.3);
});


test('accepts stable calibration samples and rejects jitter', () => {
  const samples = Array.from({ length: 5 }, (_, index) => ({
    center: { x: 320 + index * 0.2, y: 240 - index * 0.1 },
    eyeDistance: 128 + index * 0.1,
  }));
  assert.equal(observationsAreStable(samples), true);
  assert.deepEqual(averageObservations(samples).center, { x: 320.4, y: 239.8 });
  samples[4] = { center: { x: 500, y: 240 }, eyeDistance: 80 };
  assert.equal(observationsAreStable(samples), false);
});


test('time-based pose filter uses different XY and Z response constants', () => {
  const filter = createPoseFilter({ xyTimeConstantMs: 50, zTimeConstantMs: 200 });
  filter.reset({ x: 0, y: 0, z: 2.5, confidence: 1, timestamp: 0 }, 0);
  const result = filter.update({ x: 1, y: 1, z: 1.5, confidence: 1, timestamp: 50 }, 50);
  assert.ok(result.x > 0.6);
  assert.ok(result.z > 2.2);
});


test('stopping a tracker closes the landmarker and every camera track', async () => {
  let stopped = 0;
  let closed = 0;
  let cancelled = 0;
  const stream = { getTracks: () => [{ stop: () => { stopped += 1; } }, { stop: () => { stopped += 1; } }] };
  const video = {
    readyState: 4,
    videoWidth: 640,
    videoHeight: 480,
    currentTime: 0,
    srcObject: null,
    play: async () => {},
    pause: () => {},
  };
  const tracker = new HeadTracker({
    video,
    mediaDevices: { getUserMedia: async () => stream },
    landmarkerFactory: async () => ({ close: () => { closed += 1; }, detectForVideo: () => ({}) }),
    schedule: () => 42,
    cancelSchedule: () => { cancelled += 1; },
  });
  await tracker.start();
  tracker.stop();
  assert.equal(stopped, 2);
  assert.equal(closed, 1);
  assert.equal(cancelled, 1);
  assert.equal(video.srcObject, null);
});


test('tracker metrics expose actual camera size and time to first stable pose', async () => {
  const times = [100, 280];
  const stream = { getTracks: () => [{ stop: () => {} }] };
  const video = {
    readyState: 4,
    videoWidth: 1280,
    videoHeight: 720,
    currentTime: 0,
    srcObject: null,
    play: async () => {},
    pause: () => {},
  };
  const tracker = new HeadTracker({
    video,
    mediaDevices: { getUserMedia: async () => stream },
    landmarkerFactory: async () => ({ close: () => {}, detectForVideo: () => ({}) }),
    schedule: () => 42,
    cancelSchedule: () => {},
    now: () => times.shift() ?? 280,
  });
  await tracker.start();
  for (let sample = 0; sample < 5; sample += 1) {
    tracker.processResult({ faceLandmarks: [landmarks()] }, 1000 + sample * 50);
  }
  assert.deepEqual(tracker.getMetrics(), {
    startedAt: 100,
    firstTrackedPoseMs: 180,
    cameraWidth: 1280,
    cameraHeight: 720,
    metricAvailable: false,
    headDistanceMm: 0,
    rawHeadXMm: 0,
    calibratedHeadXMm: 0,
    poseSource: 'none',
    inferenceCount: 0,
    inferenceHz: 0,
    inferenceDurationMs: 0,
  });
  tracker.stop();
});


test('metric head translation is read from the facial transformation matrix', () => {
  // Column-major 4x4; the translation column holds centimetres in camera space
  // with -z pointing away from the camera.
  const matrix = new Float32Array(16);
  matrix[0] = 1; matrix[5] = 1; matrix[10] = 1; matrix[15] = 1;
  matrix[12] = 3.5;
  matrix[13] = -1.25;
  matrix[14] = -34;
  const metric = extractMetricHeadTranslation({ data: matrix });
  assert.ok(Math.abs(metric.xMm - 35) < 1e-6);
  assert.ok(Math.abs(metric.yMm + 12.5) < 1e-6);
  assert.ok(Math.abs(metric.distanceMm - 340) < 1e-6);

  assert.equal(extractMetricHeadTranslation(null), null);
  assert.equal(extractMetricHeadTranslation({ data: new Float32Array(9) }), null);
  const tooClose = new Float32Array(16);
  tooClose[14] = 0;
  assert.equal(extractMetricHeadTranslation({ data: tooClose }), null);
});


test('metric head motion converts to world units with no tunable gain', () => {
  // An iPhone 17 canvas is about 130 mm tall, so one world unit is about 65 mm.
  // Moving the head one interpupillary distance (63 mm) must move the virtual
  // eye by very nearly one world unit, not by a hand-tuned fraction of it.
  const worldUnitMm = 65;
  const calibration = {
    center: { x: 0, y: 0 },
    eyeDistance: 60,
    baselineEyeZ: 4.6,
    metric: { xMm: 0, yMm: 0, distanceMm: 300 },
  };
  const moved = mapMetricPoseToEyePose(
    { xMm: 63, yMm: 0, distanceMm: 300 },
    calibration,
    { worldUnitMm, mirrorX: false },
  );
  assert.ok(Math.abs(moved.x - 63 / 65) < 1e-6);
  assert.ok(Math.abs(moved.z - 300 / 65) < 1e-6);

  // The horizontal flip is the only handedness control; it must not touch Y or Z.
  const mirrored = mapMetricPoseToEyePose(
    { xMm: 63, yMm: 0, distanceMm: 300 },
    calibration,
    { worldUnitMm, mirrorX: true },
  );
  assert.ok(Math.abs(mirrored.x + moved.x) < 1e-6);
  assert.equal(mirrored.z, moved.z);
});


test('metric eye distance is absolute rather than damped toward a guess', () => {
  const worldUnitMm = 65;
  const calibration = {
    center: { x: 0, y: 0 },
    eyeDistance: 60,
    baselineEyeZ: 4.6,
    metric: { xMm: 0, yMm: 0, distanceMm: 350 },
  };
  const leanedIn = mapMetricPoseToEyePose(
    { xMm: 0, yMm: 0, distanceMm: 250 },
    calibration,
    { worldUnitMm },
  );
  // The old landmark-ratio path damped this to ten percent of the observed
  // change to hide a scale error. A measured distance needs no damping.
  assert.ok(Math.abs(leanedIn.z - 250 / 65) < 1e-6);
  assert.ok(Math.abs(leanedIn.y) < 1e-9);
  assert.throws(() => mapMetricPoseToEyePose(null, calibration, { worldUnitMm }));
  assert.throws(() => mapMetricPoseToEyePose(
    { xMm: 0, yMm: 0, distanceMm: 300 },
    calibration,
    { worldUnitMm: 0 },
  ));
});


test('calibration averaging carries the metric pose only when every sample has one', () => {
  const withMetric = (xMm) => ({
    center: { x: 100, y: 100 },
    eyeDistance: 60,
    metric: { xMm, yMm: 0, distanceMm: 300 },
  });
  const averaged = averageObservations([withMetric(0), withMetric(20)]);
  assert.ok(Math.abs(averaged.metric.xMm - 10) < 1e-6);

  const partial = averageObservations([
    withMetric(0),
    { center: { x: 100, y: 100 }, eyeDistance: 60 },
  ]);
  assert.equal(partial.metric, undefined);
});


test('a measured eye distance survives the projection instead of being clamped', () => {
  // One world unit is half the physical screen height, so holding a phone at
  // arm's length is already past the old ceiling of ten units. Clamping there
  // would quietly discard a distance the metric tracker measured correctly.
  const worldUnitMm = 65;
  const calibration = {
    center: { x: 0, y: 0 },
    eyeDistance: 60,
    baselineEyeZ: 4.6,
    metric: { xMm: 0, yMm: 0, distanceMm: 300 },
  };
  const armsLength = mapMetricPoseToEyePose(
    { xMm: 0, yMm: 0, distanceMm: 700 },
    calibration,
    { worldUnitMm },
  );
  assert.ok(Math.abs(armsLength.z - 700 / 65) < 1e-6);
  assert.equal(sanitizeEye(armsLength).z, armsLength.z);
  assert.ok(armsLength.z > 10, 'the case only matters above the old ceiling');

  // The ceiling still exists; it just clears the real measurement range.
  const absurd = sanitizeEye({ x: 0, y: 0, z: 500 });
  assert.equal(absurd.z, MAX_SUPPORTED_EYE_Z);
});


test('a calibration without a metric pose never drives the metric path', () => {
  // MediaPipe can return landmarks a frame or two before it returns the
  // transformation matrix. A calibration averaged over those frames has no
  // metric centre, and using it would put the zero point on the camera axis
  // rather than on the viewer, shifting every later pose sideways by however
  // far off-axis they were sitting.
  const tracker = new HeadTracker({
    video: { videoWidth: 640, videoHeight: 480 },
    worldUnitMm: 65,
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
    schedule: () => 1,
    cancelSchedule: () => {},
  });
  tracker.worldUnitMm = 65;

  tracker.calibration = { center: { x: 0, y: 0 }, eyeDistance: 60, baselineEyeZ: 4.6, metric: null };
  tracker.metrics.metricAvailable = true;
  assert.equal(tracker.usesMetricPose(), false, 'a metric-less calibration must not be used');

  tracker.calibration = {
    center: { x: 0, y: 0 },
    eyeDistance: 60,
    baselineEyeZ: 4.6,
    metric: { xMm: -30, yMm: 0, distanceMm: 300 },
  };
  assert.equal(tracker.usesMetricPose(), true);

  // With a proper metric centre, sitting still at the calibration pose reports
  // zero rather than the viewer's offset from the camera axis.
  const still = mapMetricPoseToEyePose(
    { xMm: -30, yMm: 0, distanceMm: 300 },
    tracker.calibration,
    { worldUnitMm: 65 },
  );
  assert.ok(Math.abs(still.x) < 1e-9);
});


test('the delegate order can be forced, and defaults to the measured-faster one', () => {
  // Asking for GPU explicitly measured slower than leaving it unstated on an
  // iPhone 17 -- 19.1 to 20 ms against 16 to 17, with fewer draw calls
  // competing for the GPU, so it was not contention. The face model is small,
  // and small models can lose more to texture upload and readback than the GPU
  // saves in compute.
  assert.deepEqual(preferredDelegates(null), FACE_LANDMARKER_DELEGATES);
  assert.equal(preferredDelegates(null)[0], 'CPU');

  // Either can be forced for comparison, and the other stays as a fallback so a
  // device that cannot provide the requested one still tracks.
  assert.deepEqual(preferredDelegates('gpu'), ['GPU', 'CPU']);
  assert.deepEqual(preferredDelegates('CPU'), ['CPU', 'GPU']);
  assert.deepEqual(preferredDelegates('nonsense'), FACE_LANDMARKER_DELEGATES);
});


test('the tracker passes its delegate choice to the landmarker factory', async () => {
  let received = 'not called';
  const tracker = new HeadTracker({
    video: { readyState: 4, videoWidth: 640, videoHeight: 480, currentTime: 0, srcObject: null, play: async () => {}, pause: () => {} },
    delegate: 'GPU',
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => {} }] }) },
    landmarkerFactory: async (options) => {
      received = options?.delegate;
      return { close: () => {}, detectForVideo: () => ({}) };
    },
    schedule: () => 1,
    cancelSchedule: () => {},
  });
  await tracker.start();
  assert.equal(received, 'GPU');
  tracker.stop({ emit: false });
});
