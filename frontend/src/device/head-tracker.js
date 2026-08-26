import { MAX_SUPPORTED_EYE_Z } from '../viewer/off-axis';

export const MEDIAPIPE_TASKS_VERSION = '1.0.0';
export const MEDIAPIPE_MODULE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_TASKS_VERSION}/vision_bundle.mjs`;
export const MEDIAPIPE_WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_TASKS_VERSION}/wasm`;
export const FACE_LANDMARKER_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

const LEFT_IRIS = [473, 474, 475, 476, 477];
const RIGHT_IRIS = [468, 469, 470, 471, 472];
const LEFT_EYE_FALLBACK = [362, 385, 387, 263, 373, 380];
const RIGHT_EYE_FALLBACK = [33, 160, 158, 133, 153, 144];

const CALIBRATION_SAMPLE_COUNT = 5;
const TRACKING_INTERVAL_MS = 50;
const LOST_FACE_GRACE_MS = 700;

// MediaPipe observes the unmirrored user-facing camera. A positive image-X
// delta therefore points opposite display-space +X.
//
// These gains are only used by the legacy landmark-ratio fallback, which runs
// when a device does not deliver the metric face transformation matrix. The
// metric path needs no gain at all: it converts real millimetres of head
// movement into world units using the device's physical screen size.
export const DEFAULT_XY_GAIN = 0.325;
export const DEFAULT_Z_GAIN = 0.1;

// MediaPipe reports the facial transformation matrix in centimetres, in a
// camera space whose origin is the camera itself.
const MM_PER_CM = 10;

function finitePoint(point) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function averageLandmarks(landmarks, primaryIndices, fallbackIndices) {
  let points = primaryIndices.map((index) => landmarks[index]).filter(finitePoint);
  if (points.length < 2) {
    points = fallbackIndices.map((index) => landmarks[index]).filter(finitePoint);
  }
  if (points.length < 2) {
    throw new Error('Face landmarks do not include stable eye points.');
  }
  const sum = points.reduce((result, point) => ({
    x: result.x + point.x,
    y: result.y + point.y,
  }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

export function computeEyeObservation(landmarks, videoWidth, videoHeight) {
  if (!Array.isArray(landmarks)) {
    throw new Error('Face landmarks are required.');
  }
  if (!(videoWidth > 0) || !(videoHeight > 0)) {
    throw new Error('Actual camera video dimensions are required.');
  }
  const leftNormalized = averageLandmarks(landmarks, LEFT_IRIS, LEFT_EYE_FALLBACK);
  const rightNormalized = averageLandmarks(landmarks, RIGHT_IRIS, RIGHT_EYE_FALLBACK);
  const left = { x: leftNormalized.x * videoWidth, y: leftNormalized.y * videoHeight };
  const right = { x: rightNormalized.x * videoWidth, y: rightNormalized.y * videoHeight };
  const eyeDistance = Math.hypot(right.x - left.x, right.y - left.y);
  if (!Number.isFinite(eyeDistance) || eyeDistance <= 1e-6) {
    throw new Error('Apparent eye distance is invalid.');
  }
  return {
    left,
    right,
    center: {
      x: (left.x + right.x) / 2,
      y: (left.y + right.y) / 2,
    },
    eyeDistance,
    videoWidth,
    videoHeight,
  };
}

export function averageObservations(observations) {
  if (!Array.isArray(observations) || observations.length === 0) {
    throw new Error('Calibration observations are required.');
  }
  const sums = observations.reduce((result, observation) => ({
    centerX: result.centerX + observation.center.x,
    centerY: result.centerY + observation.center.y,
    eyeDistance: result.eyeDistance + observation.eyeDistance,
  }), { centerX: 0, centerY: 0, eyeDistance: 0 });
  const count = observations.length;
  const average = {
    center: { x: sums.centerX / count, y: sums.centerY / count },
    eyeDistance: sums.eyeDistance / count,
  };
  const metricSamples = observations.map((observation) => observation.metric).filter(Boolean);
  if (metricSamples.length > 0 && metricSamples.length === observations.length) {
    const metricSums = metricSamples.reduce((result, metric) => ({
      xMm: result.xMm + metric.xMm,
      yMm: result.yMm + metric.yMm,
      distanceMm: result.distanceMm + metric.distanceMm,
    }), { xMm: 0, yMm: 0, distanceMm: 0 });
    average.metric = {
      xMm: metricSums.xMm / metricSamples.length,
      yMm: metricSums.yMm / metricSamples.length,
      distanceMm: metricSums.distanceMm / metricSamples.length,
    };
  }
  return average;
}

export function observationsAreStable(observations, {
  maxCenterJitterRatio = 0.08,
  maxEyeDistanceVariation = 0.08,
} = {}) {
  if (!Array.isArray(observations) || observations.length < CALIBRATION_SAMPLE_COUNT) return false;
  const average = averageObservations(observations);
  if (!(average.eyeDistance > 0)) return false;
  return observations.every((observation) => {
    const centerJitter = Math.hypot(
      observation.center.x - average.center.x,
      observation.center.y - average.center.y,
    ) / average.eyeDistance;
    const distanceVariation = Math.abs(observation.eyeDistance - average.eyeDistance)
      / average.eyeDistance;
    return centerJitter <= maxCenterJitterRatio
      && distanceVariation <= maxEyeDistanceVariation;
  });
}

export function createEyeCalibration(observation, { baselineEyeZ = 2.5 } = {}) {
  if (!observation?.center || !(observation.eyeDistance > 0) || !(baselineEyeZ > 0)) {
    throw new Error('A valid eye observation and baselineEyeZ are required for calibration.');
  }
  return {
    center: { ...observation.center },
    eyeDistance: observation.eyeDistance,
    baselineEyeZ,
    metric: observation.metric ? { ...observation.metric } : null,
  };
}

export function mapObservationToEyePose(observation, calibration, {
  xGain = DEFAULT_XY_GAIN,
  yGain = DEFAULT_XY_GAIN,
  zGain = DEFAULT_Z_GAIN,
  mirrorX = true,
  minX = -1.5,
  maxX = 1.5,
  minY = -1.5,
  maxY = 1.5,
  minZ,
  maxZ,
} = {}) {
  if (!observation?.center || !(observation.eyeDistance > 0)
      || !calibration?.center || !(calibration.eyeDistance > 0)) {
    throw new Error('Valid observation and calibration eye distances are required.');
  }
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  const horizontalDirection = mirrorX ? -1 : 1;
  const x = clamp(
    ((observation.center.x - calibration.center.x) / calibration.eyeDistance)
      * xGain * horizontalDirection,
    minX,
    maxX,
  );
  const y = clamp(
    -((observation.center.y - calibration.center.y) / calibration.eyeDistance) * yGain,
    minY,
    maxY,
  );
  const rawZ = calibration.baselineEyeZ * (calibration.eyeDistance / observation.eyeDistance);
  const safeZGain = clamp(Number.isFinite(zGain) ? zGain : DEFAULT_Z_GAIN, 0, 1);
  const dampedZ = calibration.baselineEyeZ
    + (rawZ - calibration.baselineEyeZ) * safeZGain;
  const safeMinZ = Number.isFinite(minZ) ? minZ : calibration.baselineEyeZ * 0.6;
  const safeMaxZ = Number.isFinite(maxZ) ? maxZ : calibration.baselineEyeZ * 1.6;
  return {
    x: x || 0,
    y: y || 0,
    z: clamp(dampedZ, safeMinZ, safeMaxZ),
    confidence: 1,
    timestamp: 0,
  };
}

// MediaPipe's facial transformation matrix is a column-major 4x4 that maps the
// canonical face model into camera space. Its translation column is the head
// position in centimetres: +x to the camera's right, +y up, and -z away from
// the camera. Reading it directly removes the guessed gains entirely.
export function extractMetricHeadTranslation(matrixData) {
  const data = matrixData?.data ?? matrixData;
  if (!data || data.length !== 16) return null;
  const x = Number(data[12]);
  const y = Number(data[13]);
  const z = Number(data[14]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  const distanceMm = Math.abs(z) * MM_PER_CM;
  if (!(distanceMm > 1)) return null;
  return { xMm: x * MM_PER_CM, yMm: y * MM_PER_CM, distanceMm };
}

// Converts a metric head position into the virtual screen's world units.
//
// `worldUnitMm` is half the physical height of the canvas, because the virtual
// screen is always two world units tall, so millimetres of real head movement
// convert into world units with no tunable gain anywhere in the path.
//
// X and Y are referenced to the calibration pose so that "recenter" still puts
// the viewer straight ahead. That also absorbs the fact that the front camera
// sits above the middle of the picture, so no separate camera offset is needed.
// Z stays absolute, because the metric distance is exactly the quantity the
// off-axis frustum needs and it no longer has to be damped to hide a scale
// error.
export function mapMetricPoseToEyePose(metric, calibration, {
  worldUnitMm,
  mirrorX = true,
  minX = -2.5,
  maxX = 2.5,
  minY = -2.5,
  maxY = 2.5,
  minZ = 1.2,
  maxZ = MAX_SUPPORTED_EYE_Z,
} = {}) {
  if (!metric || !(metric.distanceMm > 0)) {
    throw new Error('A metric head position is required.');
  }
  if (!Number.isFinite(worldUnitMm) || !(worldUnitMm > 0)) {
    throw new Error('worldUnitMm must be positive to convert metric head motion.');
  }
  const clampValue = (value, min, max) => Math.min(Math.max(value, min), max);
  const centerX = Number(calibration?.metric?.xMm) || 0;
  const centerY = Number(calibration?.metric?.yMm) || 0;
  const horizontalDirection = mirrorX ? -1 : 1;
  const x = clampValue(
    ((metric.xMm - centerX) * horizontalDirection) / worldUnitMm,
    minX,
    maxX,
  );
  // Negated, which is what makes tipping the device change the view the way
  // round a person expects. Tipping moves the head up or down in the screen's
  // own frame, and that is what skews the view volume -- far more than the
  // levelling does, which is why reversing the levelling instead only
  // cancelled part of this and made the picture stop responding at all.
  //
  // Note that this is the opposite of what the comment above
  // extractMetricHeadTranslation claims about MediaPipe's axes, and the
  // opposite of what the landmark fallback below does. Neither disagreement is
  // explained. What can be said is that the claim there was never checked, that
  // MediaPipe is loaded at runtime and ships no documentation here to check it
  // against, and that the sign a viewer actually sees is the product of this
  // one, the frustum's, and the screen's -- so no single link in that chain
  // settles it. It was settled by looking at a phone, twice.
  //
  // The fallback runs only for the frame or two before MediaPipe returns its
  // matrix, so the disagreement is not visible in use. It is left alone rather
  // than flipped to match, because nobody has reported it wrong.
  //
  // The sideways axis has the same question and answers it with a button,
  // "Reverse tracking", because there it does depend on the device.
  const y = clampValue(
    -(metric.yMm - centerY) / worldUnitMm,
    minY,
    maxY,
  );
  return {
    x: x || 0,
    y: y || 0,
    z: clampValue(metric.distanceMm / worldUnitMm, minZ, maxZ),
    confidence: 1,
    timestamp: 0,
  };
}

export function createPoseFilter({ xyTimeConstantMs = 90, zTimeConstantMs = 160 } = {}) {
  let filtered = null;
  let lastTimestamp = null;
  return {
    reset(pose = null, timestamp = null) {
      filtered = pose ? { ...pose } : null;
      lastTimestamp = timestamp;
      return filtered ? { ...filtered } : null;
    },
    update(pose, timestamp) {
      if (!filtered || !Number.isFinite(lastTimestamp) || !Number.isFinite(timestamp)) {
        filtered = { ...pose, timestamp };
        lastTimestamp = timestamp;
        return { ...filtered };
      }
      const delta = Math.max(0, Math.min(timestamp - lastTimestamp, 250));
      const xyAlpha = 1 - Math.exp(-delta / Math.max(xyTimeConstantMs, 1));
      const zAlpha = 1 - Math.exp(-delta / Math.max(zTimeConstantMs, 1));
      filtered = {
        x: filtered.x + (pose.x - filtered.x) * xyAlpha,
        y: filtered.y + (pose.y - filtered.y) * xyAlpha,
        z: filtered.z + (pose.z - filtered.z) * zAlpha,
        confidence: pose.confidence,
        timestamp,
      };
      lastTimestamp = timestamp;
      return { ...filtered };
    },
    get: () => (filtered ? { ...filtered } : null),
  };
}

export function stopMediaStream(stream) {
  if (!stream || typeof stream.getTracks !== 'function') return;
  stream.getTracks().forEach((track) => track.stop());
}

// Which processor runs the model, in the order they are tried.
//
// Measured on an iPhone 17: 16 to 17 ms per inference on CPU, 19.1 to 20 ms on
// GPU, and leaving it unstated gave the CPU figure — so the runtime already
// chose CPU and naming GPU was a regression. Fewer draw calls were competing for
// the GPU during the slower measurement than the faster one, so it was not
// contention. The face landmarker is a small model, and for small models the
// delegate's texture upload and readback can cost more than the compute it
// saves. CPU is therefore tried first, with GPU kept as a fallback for devices
// where that is not true.
//
// `?delegate=gpu` or `?delegate=cpu` forces one, so the two can be compared on a
// device rather than argued about.
export const FACE_LANDMARKER_DELEGATES = ['CPU', 'GPU'];
let activeDelegate = null;

export function getActiveDelegate() {
  return activeDelegate;
}

export function preferredDelegates(requested) {
  const wanted = String(requested ?? '').toUpperCase();
  if (wanted === 'GPU' || wanted === 'CPU') {
    return [wanted, ...FACE_LANDMARKER_DELEGATES.filter((name) => name !== wanted)];
  }
  return [...FACE_LANDMARKER_DELEGATES];
}

export async function createMediaPipeFaceLandmarker({ delegate: delegateOverride = null } = {}) {
  const { FaceLandmarker, FilesetResolver } = await import(MEDIAPIPE_MODULE_URL);
  const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_URL);
  let lastError = null;
  for (const delegate of preferredDelegates(delegateOverride)) {
    try {
      const landmarker = await createFaceLandmarkerWithDelegate(FaceLandmarker, vision, delegate);
      activeDelegate = delegate;
      return landmarker;
    } catch (error) {
      lastError = error;
      console.warn(`Face Landmarker ${delegate} delegate unavailable`, error);
    }
  }
  throw lastError ?? new Error('Face Landmarker could not be created.');
}

function createFaceLandmarkerWithDelegate(FaceLandmarker, vision, delegate) {
  return FaceLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: FACE_LANDMARKER_MODEL_URL, delegate },
    runningMode: 'VIDEO',
    numFaces: 1,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    outputFaceBlendshapes: false,
    // The metric head pose lives in this matrix. It is what lets the viewer
    // convert real head movement into world units without a tuned gain, and it
    // is also the only signal that separates leaning closer from turning the
    // head, which apparent eye spacing alone cannot distinguish.
    outputFacialTransformationMatrixes: true,
  });
}

function waitForVideo(video, timeoutMs = 6000) {
  if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Front camera did not produce video frames.'));
    }, timeoutMs);
    const onLoaded = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('Front camera video failed to load.'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener('loadeddata', onLoaded);
      video.removeEventListener('error', onError);
    };
    video.addEventListener('loadeddata', onLoaded, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
}

export class HeadTracker {
  constructor({
    video,
    baselineEyeZ = 4.5,
    worldUnitMm = null,
    mirrorX = true,
    xyGain = DEFAULT_XY_GAIN,
    mediaDevices = globalThis.navigator?.mediaDevices,
    landmarkerFactory = createMediaPipeFaceLandmarker,
    delegate = null,
    schedule = globalThis.requestAnimationFrame?.bind(globalThis),
    cancelSchedule = globalThis.cancelAnimationFrame?.bind(globalThis),
    now = globalThis.performance?.now?.bind(globalThis.performance) || Date.now,
    onStatus = () => {},
    onPose = () => {},
  }) {
    this.video = video;
    this.baselineEyeZ = baselineEyeZ;
    // Overridden by setPositionBound once the page knows its metric correction.
    this.positionBound = 2.5;
    this.worldUnitMm = Number.isFinite(worldUnitMm) && worldUnitMm > 0 ? worldUnitMm : null;
    this.mirrorX = Boolean(mirrorX);
    this.xyGain = Number.isFinite(xyGain) && xyGain > 0 ? xyGain : DEFAULT_XY_GAIN;
    this.mediaDevices = mediaDevices;
    this.landmarkerFactory = landmarkerFactory;
    this.delegate = delegate;
    this.schedule = schedule || ((callback) => setTimeout(() => callback(performance.now()), 16));
    this.cancelSchedule = cancelSchedule || clearTimeout;
    this.now = now;
    this.onStatus = onStatus;
    this.onPose = onPose;
    this.stream = null;
    this.landmarker = null;
    this.running = false;
    this.frameHandle = null;
    this.lastInferenceAt = -Infinity;
    this.lastVideoTime = -1;
    this.lastStatusCode = null;
    this.calibration = null;
    this.calibrationSamples = [];
    this.filter = createPoseFilter();
    this.lostSince = null;
    this.metrics = this.createMetrics();
    this.tick = this.tick.bind(this);
  }

  createMetrics() {
    return {
      startedAt: null,
      firstTrackedPoseMs: null,
      cameraWidth: 0,
      cameraHeight: 0,
      inferenceCount: 0,
      inferenceHz: 0,
      inferenceDurationMs: 0,
      inferenceTimestamps: [],
      metricAvailable: false,
      headDistanceMm: 0,
      rawHeadXMm: 0,
      calibratedHeadXMm: 0,
      poseSource: 'none',
    };
  }

  getMetrics() {
    return {
      startedAt: this.metrics.startedAt,
      firstTrackedPoseMs: this.metrics.firstTrackedPoseMs,
      cameraWidth: this.metrics.cameraWidth,
      cameraHeight: this.metrics.cameraHeight,
      inferenceCount: this.metrics.inferenceCount,
      inferenceHz: this.metrics.inferenceHz,
      inferenceDurationMs: this.metrics.inferenceDurationMs,
      metricAvailable: this.metrics.metricAvailable,
      headDistanceMm: this.metrics.headDistanceMm,
      rawHeadXMm: this.metrics.rawHeadXMm,
      calibratedHeadXMm: this.metrics.calibratedHeadXMm,
      poseSource: this.metrics.poseSource,
    };
  }

  /**
   * Widen the bound on the reported sideways and vertical position.
   *
   * The page corrects the tracker's metric scale afterwards, and a bound
   * applied before that correction is a different bound: clamping to 2.5 and
   * then multiplying by 0.5 stops at 1.25, not at 2.5. The page passes the
   * reciprocal of its correction so the only bound that binds is the one it
   * applies itself, on the corrected value.
   */
  setPositionBound(bound) {
    if (Number.isFinite(bound) && bound > 0) this.positionBound = bound;
  }

  setViewingGeometry({ worldUnitMm, baselineEyeZ }) {
    if (Number.isFinite(worldUnitMm) && worldUnitMm > 0) this.worldUnitMm = worldUnitMm;
    if (Number.isFinite(baselineEyeZ) && baselineEyeZ > 0) this.baselineEyeZ = baselineEyeZ;
  }

  usesMetricPose() {
    // The metric path measures head movement from the calibration pose, so it
    // must not run against a calibration that has no metric pose of its own.
    // MediaPipe can return landmarks a frame or two before it returns the
    // transformation matrix; a calibration averaged over those frames would
    // leave the centre at the camera axis instead of at the viewer, shifting
    // every later pose sideways by however far off-axis they were sitting.
    return Boolean(this.worldUnitMm && this.calibration?.metric);
  }

  emitStatus(code, message) {
    if (code === this.lastStatusCode) return;
    this.lastStatusCode = code;
    this.onStatus({ code, message });
  }

  async start() {
    if (this.running) return;
    if (!this.mediaDevices || typeof this.mediaDevices.getUserMedia !== 'function') {
      throw new Error('Front camera access is unavailable in this browser.');
    }
    try {
      this.metrics = this.createMetrics();
      this.metrics.startedAt = this.now();
      this.emitStatus('requesting-camera', 'Requesting front camera…');
      this.stream = await this.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: 'user',
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 24, max: 30 },
        },
      });
      this.video.srcObject = this.stream;
      await this.video.play();
      await waitForVideo(this.video);
      this.metrics.cameraWidth = this.video.videoWidth;
      this.metrics.cameraHeight = this.video.videoHeight;
      this.emitStatus('initializing', 'Loading local face tracker…');
      this.landmarker = await this.landmarkerFactory({ delegate: this.delegate });
      this.running = true;
      this.lastInferenceAt = -Infinity;
      this.lastVideoTime = -1;
      this.recenter();
      this.frameHandle = this.schedule(this.tick);
    } catch (error) {
      this.stop({ emit: false });
      throw error;
    }
  }

  tick(timestamp) {
    if (!this.running) return;
    if (timestamp - this.lastInferenceAt >= TRACKING_INTERVAL_MS
        && this.video.currentTime !== this.lastVideoTime
        && this.video.readyState >= 2) {
      this.lastInferenceAt = timestamp;
      this.lastVideoTime = this.video.currentTime;
      try {
        const inferenceStartedAt = this.now();
        const result = this.landmarker.detectForVideo(this.video, timestamp);
        const duration = Math.max(0, this.now() - inferenceStartedAt);
        this.metrics.inferenceCount += 1;
        this.metrics.inferenceDurationMs = this.metrics.inferenceCount === 1
          ? duration
          : this.metrics.inferenceDurationMs * 0.85 + duration * 0.15;
        this.metrics.inferenceTimestamps.push(timestamp);
        this.metrics.inferenceTimestamps = this.metrics.inferenceTimestamps
          .filter((sample) => sample >= timestamp - 2000);
        const inferenceSpan = timestamp - this.metrics.inferenceTimestamps[0];
        this.metrics.inferenceHz = inferenceSpan > 0
          ? ((this.metrics.inferenceTimestamps.length - 1) * 1000) / inferenceSpan
          : 0;
        this.processResult(result, timestamp);
      } catch (error) {
        console.error('Face Landmarker inference failed', error);
        this.emitStatus('inference-error', 'Face tracking paused after an inference error.');
      }
    }
    this.frameHandle = this.schedule(this.tick);
  }

  processResult(result, timestamp) {
    const landmarks = result?.faceLandmarks?.[0];
    if (!landmarks) {
      this.handleLostFace(timestamp);
      return;
    }
    let observation;
    try {
      observation = computeEyeObservation(
        landmarks,
        this.video.videoWidth,
        this.video.videoHeight,
      );
    } catch {
      this.handleLostFace(timestamp);
      return;
    }
    const metric = extractMetricHeadTranslation(result?.facialTransformationMatrixes?.[0]);
    if (metric) {
      observation.metric = metric;
      this.metrics.metricAvailable = true;
      this.metrics.headDistanceMm = metric.distanceMm;
      this.metrics.rawHeadXMm = metric.xMm;
      this.metrics.calibratedHeadXMm = metric.xMm - (Number(this.calibration?.metric?.xMm) || 0);
    }
    this.lostSince = null;

    if (!this.calibration) {
      // Once the device is known to deliver metric poses, only samples carrying
      // one may calibrate, so the calibration and the live poses always come
      // from the same measurement.
      if (!this.metrics.metricAvailable || observation.metric) {
        this.calibrationSamples.push(observation);
      }
      this.calibrationSamples = this.calibrationSamples.slice(-CALIBRATION_SAMPLE_COUNT);
      this.emitStatus('calibrating', 'Hold still for calibration…');
      if (!observationsAreStable(this.calibrationSamples)) return;
      const average = averageObservations(this.calibrationSamples);
      this.calibration = createEyeCalibration(average, { baselineEyeZ: this.baselineEyeZ });
      const baselinePose = {
        x: 0,
        y: 0,
        // In metric mode the calibration pose already carries a real measured
        // distance, so the neutral view starts from where the viewer actually
        // is rather than from an assumed holding distance.
        z: this.worldUnitMm && average.metric
          ? mapMetricPoseToEyePose(average.metric, this.calibration, {
            worldUnitMm: this.worldUnitMm,
            mirrorX: this.mirrorX,
          }).z
          : this.baselineEyeZ,
        confidence: 1,
        timestamp,
      };
      this.filter.reset(baselinePose, timestamp);
      if (this.metrics.firstTrackedPoseMs === null && this.metrics.startedAt !== null) {
        this.metrics.firstTrackedPoseMs = Math.max(0, this.now() - this.metrics.startedAt);
      }
      this.onPose(baselinePose);
      this.emitStatus('tracking', 'Head tracking active.');
      return;
    }

    this.metrics.poseSource = this.usesMetricPose() && observation.metric ? 'metric' : 'landmark';
    const pose = this.usesMetricPose() && observation.metric
      ? mapMetricPoseToEyePose(observation.metric, this.calibration, {
        worldUnitMm: this.worldUnitMm,
        mirrorX: this.mirrorX,
        minX: -this.positionBound, maxX: this.positionBound,
        minY: -this.positionBound, maxY: this.positionBound,
      })
      : mapObservationToEyePose(observation, this.calibration, {
        mirrorX: this.mirrorX,
        xGain: this.xyGain,
        yGain: this.xyGain,
      });
    pose.timestamp = timestamp;
    this.onPose(this.filter.update(pose, timestamp));
    this.emitStatus('tracking', 'Head tracking active.');
  }

  handleLostFace(timestamp) {
    if (this.lostSince === null) this.lostSince = timestamp;
    if (!this.calibration) {
      this.emitStatus('face-not-found', 'Center your face in front of the camera.');
      return;
    }
    if (timestamp - this.lostSince <= LOST_FACE_GRACE_MS) return;
    const calibratedDistance = this.usesMetricPose() && this.calibration?.metric
      ? this.calibration.metric.distanceMm / this.worldUnitMm
      : this.baselineEyeZ;
    const centered = {
      x: 0,
      y: 0,
      z: calibratedDistance,
      confidence: 0,
      timestamp,
    };
    this.onPose(this.filter.update(centered, timestamp));
    this.emitStatus('face-not-found', 'Face not found · using centered view.');
  }

  recenter() {
    this.calibration = null;
    this.calibrationSamples = [];
    this.filter.reset();
    this.lostSince = null;
    this.lastStatusCode = null;
    this.emitStatus('calibrating', 'Hold still for calibration…');
  }

  setMirrorX(mirrorX) {
    this.mirrorX = Boolean(mirrorX);
    this.recenter();
  }

  stop({ emit = true } = {}) {
    this.running = false;
    if (this.frameHandle !== null) {
      this.cancelSchedule(this.frameHandle);
      this.frameHandle = null;
    }
    if (this.landmarker) {
      this.landmarker.close?.();
      this.landmarker = null;
    }
    stopMediaStream(this.stream);
    this.stream = null;
    if (this.video) {
      this.video.pause?.();
      this.video.srcObject = null;
    }
    this.calibration = null;
    this.calibrationSamples = [];
    this.filter.reset();
    this.lostSince = null;
    if (emit) {
      this.lastStatusCode = null;
      this.emitStatus('stopped', 'Camera stopped · static view active.');
    }
  }
}
