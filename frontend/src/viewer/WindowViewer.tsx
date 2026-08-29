// The screen as a window onto the scene.
//
// The front camera measures where the viewer's head is, in centimetres, and the
// picture is drawn from that point of view. Moving your head reveals the shape
// the way moving your head past a real window does.
//
// Three pieces make that work and each is here for a reason a guess would get
// wrong. A CSS pixel has no fixed physical size, and assuming the usual 96 dots
// per inch is wrong by about 60 per cent on these panels, so the real
// millimetres set the eye distance and the field of view. Gravity is read from
// the accelerometer so that tilting the device does not tilt the scene. And the
// picture is drawn only when an input has moved far enough to change a pixel,
// because a continuous loop is what empties a battery.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { SplatViewer, type HeadPose } from './SplatViewer';
import type { ViewerHandle } from '../types';
import {
  MAX_TIP_DEG, MAX_ZOOM, MIN_ZOOM, TIP_GAIN, TWIST_GAIN, lifeSizeDistanceMm,
} from './window-placement';
import {
  DEVICE_SIZE_STORAGE_KEY,
  VIEWING_DISTANCE_STORAGE_KEY,
  computeViewingGeometry,
  loadStoredNumber,
  mmPerCssPxFromPanelLongSide,
  preservePhysicalPoint,
  resolveScreenMetrics,
  saveStoredNumber,
} from '../device/device-metrics.js';
import {
  DEFAULT_ORIENTATION_SETTLE_MS,
  createTiltTracker,
  wrapAngle,
} from '../device/device-tilt.js';
import {
  TRUE_WINDOW_LEVELLING_GAIN,
  computeLevelling,
  toQuaternion,
  upInDeviceFrame,
  type Vec3,
} from '../device/levelling';
import { imageFromPasteEvent, readImageFromClipboard } from '../device/clipboard-image';
import { HeadTracker } from '../device/head-tracker.js';
import {
  distanceScaleFrom,
  loadDistanceScale,
  saveDistanceScale,
} from '../device/head-distance-calibration';

const MIRROR_STORAGE_KEY = 'stereosplat-window-mirror-x-v1';

/**
 * How far the eye may be reported from where it was calibrated, in window
 * units, where one unit is half the screen's height.
 *
 * A bound rather than a judgement about people: a tracker that has lost the
 * face can report anything, and an eye a long way off the axis makes a very
 * skewed view volume.
 *
 * The tracker is given this divided by the distance correction, because it
 * clamps the uncorrected reading and this page clamps the corrected one.
 * Applied in that order two bounds of the same size compose into a tighter
 * one: a correction of a half would leave half the range.
 */
const EYE_BOUND = 2.5;

/**
 * Read a focal length someone typed on a phone.
 *
 * A Japanese keyboard in its usual state produces full-width digits, so `５０`
 * arrives where `50` was meant and `Number` makes NaN of it. Translating the
 * block is a subtraction; the alternative is telling people to switch input
 * mode to type two digits.
 *
 * Returns null for anything that is not a usable 35 mm equivalent. The server
 * bounds it again -- this is only so the field can say so before asking.
 */
export function parseFocalMm(text: string): number | null {
  const half = text.replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  const value = Number(half.trim());
  if (!Number.isFinite(value) || value < 10 || value > 800) return null;
  return value;
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    // Private browsing refuses it; every stored preference then falls back to
    // its default and the session still works.
    return null;
  }
}

type Status = { code: string; message: string };
type CaptureProjection = { captureTangent: number; captureAspect: number };
type ViewportSize = { width: number; height: number; devicePixelRatio: number };

function currentViewportSize(): ViewportSize {
  return {
    width: Math.max(1, window.innerWidth),
    height: Math.max(1, window.innerHeight),
    devicePixelRatio: window.devicePixelRatio || 1,
  };
}

export function captureProjectionFrom(value: unknown): CaptureProjection | null {
  const candidate = value as Partial<CaptureProjection> | null;
  const captureTangent = Number(candidate?.captureTangent);
  const captureAspect = Number(candidate?.captureAspect);
  if (!(captureTangent > 0) || !Number.isFinite(captureTangent)
      || !(captureAspect > 0) || !Number.isFinite(captureAspect)) return null;
  return { captureTangent, captureAspect };
}

function readMirrorPreference(): boolean {
  try {
    const stored = window.localStorage?.getItem(MIRROR_STORAGE_KEY);
    if (stored === 'true') return true;
    if (stored === 'false') return false;
  } catch {
    // Private browsing can refuse storage; the default still works.
  }
  return true;
}

/**
 * What this job's photograph said about its lens.
 *
 * Only needed for an address that names a scene: that turns the poll off, and
 * the poll is otherwise where this is learned. Without it, opening a flat
 * scene by its job identifier offered no way to fix it.
 */
async function lensMissingFor(jobId: string): Promise<boolean> {
  try {
    const response = await fetch(`/api/scene/${jobId}/lens`);
    if (!response.ok) return false;
    const body = await response.json();
    return body?.recorded === true && body?.fromExif == null;
  } catch {
    return false;
  }
}

async function captureProjectionFor(jobId: string): Promise<CaptureProjection | null> {
  try {
    const response = await fetch(`/api/scene/${jobId}/projection`);
    if (!response.ok) return null;
    return captureProjectionFrom(await response.json());
  } catch {
    return null;
  }
}

/** Which scene to show, when the address names one. */
function sceneUrlFromLocation(): string | null {
  const params = new URLSearchParams(window.location.search);
  const explicit = params.get('scene') ?? params.get('ply');
  if (explicit) return explicit;
  const job = params.get('job');
  const name = params.get('name');
  if (job && name) return `/api/scene/${job}/${name}`;
  return null;
}

/**
 * Where this page should fetch the scene from.
 *
 * Opening this page on a phone should mean typing its address, not copying a
 * hexadecimal job identifier across by hand. Every upload clears the previous
 * one, so there is at most one scene and no ambiguity about which is meant.
 *
 * The server offers the same scene twice: a PLY, which is what the editor uses
 * and what exports come from, and a SOG bundle, which is about a sixth of the
 * size. This is the page that is opened over a mobile connection, so it takes
 * the small one whenever there is one. `sogUrl` is absent when the compressor
 * could not run, and then this falls back to what it always used.
 */
async function latestScene(): Promise<
  {
    url: string;
    jobId: string;
    lensMissing: boolean;
    projection: CaptureProjection | null;
  } | null> {
  try {
    const response = await fetch('/api/scene/latest');
    if (!response.ok) return null;
    const body = await response.json();
    const url = typeof body?.sogUrl === 'string' ? body.sogUrl
      : typeof body?.plyUrl === 'string' ? body.plyUrl : null;
    if (!url || typeof body?.jobId !== 'string') return null;
    // `lensRecorded` false means nobody wrote it down -- a scene from before
    // this was kept -- which is not the same as knowing there was no lens.
    return {
      url,
      jobId: body.jobId,
      lensMissing: body.lensRecorded === true && body.fromExif == null,
      projection: captureProjectionFrom(body.projection),
    };
  } catch {
    return null;
  }
}

export function WindowViewer() {
  const viewerRef = useRef<ViewerHandle>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const trackerRef = useRef<InstanceType<typeof HeadTracker> | null>(null);
  const tiltRef = useRef<ReturnType<typeof createTiltTracker> | null>(null);

  const [sceneUrl, setSceneUrl] = useState<string | null>(() => sceneUrlFromLocation());
  const [captureProjection, setCaptureProjection] = useState<CaptureProjection | null>(null);
  const [viewport, setViewport] = useState<ViewportSize>(currentViewportSize);
  const [measuredMmPerCssPx, setMeasuredMmPerCssPx] = useState<number | null>(
    () => loadStoredNumber(safeStorage(), DEVICE_SIZE_STORAGE_KEY),
  );
  const [panelLongSideText, setPanelLongSideText] = useState(() => {
    const stored = loadStoredNumber(safeStorage(), DEVICE_SIZE_STORAGE_KEY);
    const panelCssLongSide = Math.max(window.screen?.width ?? 0, window.screen?.height ?? 0);
    return stored && panelCssLongSide ? (stored * panelCssLongSide).toFixed(1) : '';
  });
  const [status, setStatus] = useState<Status>({ code: 'idle', message: 'Ready.' });
  const [tracking, setTracking] = useState(false);
  const [levelled, setLevelled] = useState(false);
  const [mirrorX, setMirrorX] = useState<boolean>(readMirrorPreference);
  const [error, setError] = useState<string | null>(null);
  const [pose, setPose] = useState<HeadPose | null>(null);

  // The screen's real size decides the whole viewing geometry. The physical
  // panel scale is stable, but the visible canvas height changes on rotation
  // and when mobile browser chrome expands or collapses.
  const geometry = useMemo(() => {
    const storage = safeStorage();
    const metrics = resolveScreenMetrics({
      screenWidth: window.screen?.width,
      screenHeight: window.screen?.height,
      devicePixelRatio: viewport.devicePixelRatio,
      measuredMmPerCssPx,
    });
    const viewing = computeViewingGeometry({
      canvasCssHeight: viewport.height,
      mmPerCssPx: metrics.mmPerCssPx,
      viewingDistanceMm: loadStoredNumber(storage, VIEWING_DISTANCE_STORAGE_KEY)
        ?? metrics.defaultViewingDistanceMm,
    });
    return { metrics, viewing };
  }, [measuredMmPerCssPx, viewport.devicePixelRatio, viewport.height]);

  useEffect(() => {
    const update = () => {
      const rect = stageRef.current?.getBoundingClientRect();
      const fallback = currentViewportSize();
      const next = {
        width: Math.max(1, rect?.width || fallback.width),
        height: Math.max(1, rect?.height || fallback.height),
        devicePixelRatio: fallback.devicePixelRatio,
      };
      setViewport((previous) => (
        previous.width === next.width
          && previous.height === next.height
          && previous.devicePixelRatio === next.devicePixelRatio
          ? previous : next
      ));
    };
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    const observer = typeof ResizeObserver === 'undefined' || !stageRef.current
      ? null : new ResizeObserver(update);
    if (stageRef.current) observer?.observe(stageRef.current);
    update();
    return () => {
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
      observer?.disconnect();
    };
  }, []);

  const viewingRef = useRef(geometry.viewing);
  viewingRef.current = geometry.viewing;

  const levellingRef = useRef<{ x: number; y: number; z: number; w: number } | null>(null);
  // Where up was when levelling began. The correction is measured from there,
  // not from vertical: a tablet is read tipped well back, and measuring from
  // vertical pinned the correction at its cap before anyone had moved.
  const levelReferenceRef = useRef<Vec3 | null>(null);
  // DeviceOrientation supplies the one axis gravity cannot: a turn about
  // world-up. Only the wrapped delta from the Hold-level/Recenter posture is
  // published, never an absolute compass bearing.
  const headingReferenceRef = useRef<number | null>(null);
  const deviceYawRef = useRef(0);
  const eyeRef = useRef({ x: 0, y: 0, z: geometry.viewing.baselineEyeZ });
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const spinRef = useRef(0);
  const tipRef = useRef(0);
  const [zoom, setZoom] = useState(1);
  // Null when nothing is downloading. A compressed scene is still about
  // eleven megabytes and a mobile connection makes that a long silence.
  const [sceneProgress, setSceneProgress] = useState<number | null>(null);
  // Null when the photograph recorded its own lens, or when there is no scene
  // from this session to know about. Set only when it did not, which is the
  // one case worth interrupting anybody for.
  const [lensJobId, setLensJobId] = useState<string | null>(null);
  const [lensText, setLensText] = useState('');
  // True while a pasted picture is waiting to be told its lens: nothing is
  // building and there is nothing to look at until it is answered.
  const [lensPending, setLensPending] = useState(false);
  // Two controls for the projection itself, so the difference can be judged on
  // a device rather than argued about. See HeadPose#trueWindow and #pushBack.
  const [trueWindow, setTrueWindow] = useState(true);
  // Sliding the miniature back settles how it sits behind the glass and how
  // wide it swings when a finger turns it; 25 mm was chosen on a device for
  // that. It does not make the scene look deeper -- moving a whole scene away
  // flattens it, because the DIFFERENCE in how two depths move is what reads
  // as relief and that difference shrinks. Deeper steps come first, since that
  // is the direction anyone pressing this is going.
  const PUSH_STEPS_MM = [25, 50, 100, 200, 0];
  const [pushMm, setPushMm] = useState(25);
  const [placement, setPlacement] = useState<
    { windowHalfHeight: number; visibleFraction: number; eyeDistance: number } | null>(null);
  // What the tracker says the head is at, so a distance judged by eye can be
  // checked against the number the geometry is using rather than guessed at.
  const [headMm, setHeadMm] = useState<number | null>(null);
  // MediaPipe's distance is fitted against a canonical face seen through an
  // assumed lens, and on hardware it read 300 mm with the eye really 150 from
  // the glass. The error is a scale, so one measured number corrects it at
  // every distance.
  const [distanceScale, setDistanceScale] = useState<number>(
    () => loadDistanceScale(safeStorage()));
  const distanceScaleRef = useRef(distanceScale);
  const rawHeadMmRef = useRef<number | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  // Double tap anywhere to clear the controls and the readout out of the way,
  // and again to bring them back.
  const [chromeHidden, setChromeHidden] = useState(false);
  // What the backend is doing, shown over the whole screen rather than in a
  // line of small text at the top. Building a scene takes tens of seconds, and
  // leaving the previous one on screen through it looked like nothing had
  // happened.
  const [building, setBuilding] = useState<string | null>(null);

  // Filled in below, so that one of these callbacks can reach another without
  // either having to be declared first.
  const startLevellingRef = useRef<(() => Promise<void>) | null>(null);
  const startTrackingRef = useRef<(() => Promise<void>) | null>(null);

  // Bumped by everything that chooses a scene, so an answer to an older
  // request can tell that it has been overtaken.
  const sceneGenerationRef = useRef(0);
  const lensJobIdRef = useRef<string | null>(null);
  const lensTextRef = useRef('');
  const buildingRef = useRef<string | null>(null);
  const trueWindowRef = useRef(true);
  const pushMmRef = useRef(0);
  const worldUnitMmRef = useRef(geometry.viewing.worldUnitMm);
  const portraitRef = useRef(viewport.height >= viewport.width);
  useEffect(() => { trueWindowRef.current = trueWindow; }, [trueWindow]);
  useEffect(() => { pushMmRef.current = pushMm; }, [pushMm]);
  useEffect(() => { lensJobIdRef.current = lensJobId; }, [lensJobId]);
  useEffect(() => { lensTextRef.current = lensText; }, [lensText]);
  useEffect(() => { buildingRef.current = building; }, [building]);

  const publishPose = useCallback(() => {
    const viewing = viewingRef.current;
    setPose({
      eye: { ...eyeRef.current },
      // How far the eye is from the glass, measured rather than assumed.
      screenDistance: viewing.baselineEyeZ,
      levelling: levellingRef.current,
      deviceYaw: deviceYawRef.current,
      zoom: zoomRef.current,
      pan: { ...panRef.current },
      spin: spinRef.current,
      tip: tipRef.current,
      trueWindow: trueWindowRef.current,
      pushBack: pushMmRef.current / viewing.worldUnitMm,
    });
  }, []);

  useEffect(() => {
    const previousUnitMm = worldUnitMmRef.current;
    const nextUnitMm = geometry.viewing.worldUnitMm;
    if (Math.abs(previousUnitMm - nextUnitMm) > 1e-9) {
      // Preserve the same physical millimetre eye point while changing the
      // number of millimetres represented by one world unit.
      eyeRef.current = preservePhysicalPoint(eyeRef.current, previousUnitMm, nextUnitMm);
      worldUnitMmRef.current = nextUnitMm;
    }
    trackerRef.current?.setViewingGeometry?.({
      worldUnitMm: nextUnitMm,
      baselineEyeZ: geometry.viewing.baselineEyeZ,
    });
    const portrait = viewport.height >= viewport.width;
    if (portrait !== portraitRef.current) {
      // Camera axes and the camera's offset from the canvas centre rotate with
      // the device. The old lateral calibration cannot be transformed from
      // viewport dimensions alone, so take a fresh one and hold a centred view
      // during its five stable samples.
      trackerRef.current?.recenter();
      eyeRef.current = { ...eyeRef.current, x: 0, y: 0 };
      // The sensor path is stale for the same reason, and in the same instant:
      // its filters, deadband baselines and reference attitudes were all
      // learned in the screen frame that has just been replaced. Hold level
      // stays on and keeps its granted permissions and its listeners; only
      // what they measured is discarded, and only until the turn settles.
      if (tiltRef.current?.running) {
        tiltRef.current.recenter({ settleMs: DEFAULT_ORIENTATION_SETTLE_MS });
      }
      // Until the first settled sample arrives there is no reference to
      // measure from, so no correction is shown. Publishing the old one for a
      // quarter of a second would be showing the previous orientation's idea
      // of upright.
      levellingRef.current = null;
      levelReferenceRef.current = null;
      headingReferenceRef.current = null;
      deviceYawRef.current = 0;
      portraitRef.current = portrait;
    }
    publishPose();
  }, [
    geometry.viewing.baselineEyeZ,
    geometry.viewing.worldUnitMm,
    publishPose,
    pushMm,
    trueWindow,
    viewport.height,
    viewport.width,
  ]);

  // Nothing in the address: ask the editor what it is holding, and keep
  // asking. A scene made on the desktop lands under a new job id, so the URL
  // changes and this picks it up without anyone reloading the page by hand.
  // The poll is one small JSON request; the scene itself is only fetched when
  // the answer is different from what is already on screen.
  useEffect(() => {
    // An address that names a scene means it: nothing here overrides it. The
    // lens still has to be asked after, though, because this is where it would
    // otherwise have been learned.
    if (sceneUrlFromLocation()) {
      const params = new URLSearchParams(window.location.search);
      const named = params.get('job');
      if (named) {
        lensMissingFor(named).then((missing) => setLensJobId(missing ? named : null));
        captureProjectionFor(named).then(setCaptureProjection);
      }
      return undefined;
    }
    let cancelled = false;
    const check = () => {
      // A poll that is still out cannot be allowed to answer for a scene
      // chosen since it left -- pasting one sets the scene directly, and the
      // reply to a request made before that would put the old one back.
      const mine = ++sceneGenerationRef.current;
      latestScene().then((scene) => {
        if (cancelled || mine !== sceneGenerationRef.current || !scene) return;
        // Offered whenever the scene on the server was made without a lens,
        // whoever made it -- a photograph pasted here, or one built on the
        // desktop and found to look flat from the sofa.
        setLensJobId(scene.lensMissing ? scene.jobId : null);
        setCaptureProjection(scene.projection);
        setSceneUrl((current) => (scene.url === current ? current : scene.url));
      });
    };
    check();
    const timer = window.setInterval(check, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  // A development hook for driving the eye without a camera, so the parallax
  // can be checked from a script. Vite strips this from a production build.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as Record<string, unknown>).__setEye = (x: number, y: number, z?: number) => {
      eyeRef.current = { x, y, z: z ?? eyeRef.current.z };
      publishPose();
    };
  }, [publishPose]);

  const startTracking = useCallback(async () => {
    setError(null);
    const video = videoRef.current;
    if (!video) return;
    const viewing = viewingRef.current;
    const tracker = new HeadTracker({
      video,
      baselineEyeZ: viewing.baselineEyeZ,
      worldUnitMm: viewing.worldUnitMm,
      mirrorX,
      onStatus: (next: { code: string; message: string }) => setStatus(next),
      onPose: (next: { x: number; y: number; z: number }) => {
        // All three axes are corrected, not just the distance.
        //
        // This used to correct the distance alone, reasoning that sideways and
        // vertical positions are differences from the calibration pose so an
        // error in the absolute distance could not reach them. That holds for
        // an error that is an offset. The one being corrected here is not:
        // head-distance-calibration.ts says so in its first line, because the
        // tracker infers distance from an assumed face size and getting that
        // size wrong scales everything it reports. A scale survives the
        // subtraction --  (c*y - c*y_ref) is c*(y - y_ref) --  so correcting z
        // alone left the ratio |y|/z wrong by 1/scale, and that ratio is
        // exactly what decides how far off the view axis the eye is, and so
        // how much the picture is stretched at the edges.
        const scale = distanceScaleRef.current;
        // The bound the tracker applies is on the eye's position, so it is
        // reapplied here rather than left behind by the correction.
        const bound = (v: number) => Math.min(Math.max(v * scale, -EYE_BOUND), EYE_BOUND);
        const corrected = next.z * scale;
        eyeRef.current = { x: bound(next.x), y: bound(next.y), z: corrected };
        const currentWorldUnitMm = viewingRef.current.worldUnitMm;
        rawHeadMmRef.current = next.z * currentWorldUnitMm;
        setHeadMm(corrected * currentWorldUnitMm);
        publishPose();
      },
    });
    // The bound on sideways movement has to be applied once, and after the
    // metric correction below, or the two compose into a tighter one. It has
    // to be kept up to date as well: calibrating happens while the tracker is
    // already running, so a bound set only at creation is the wrong one from
    // the first time anyone presses the button.
    tracker.setPositionBound?.(EYE_BOUND / Math.max(distanceScaleRef.current, 1e-3));
    try {
      // Kept out of the ref until it is actually running. Assigning first left
      // a half-started tracker behind whenever the camera was refused or the
      // permission prompt went unanswered, and everything that asks "is it
      // tracking?" -- including the automatic start after a paste -- then
      // believed that it was.
      await tracker.start();
      trackerRef.current = tracker;
      setTracking(true);
      // Ask for motion in the same gesture that asked for the camera. iOS only
      // grants it from a user action, so leaving it to a second button meant
      // levelling was off until someone found that button.
      if (!tiltRef.current) await startLevellingRef.current?.();
    } catch (err) {
      tracker.stop?.({ emit: false });
      trackerRef.current = null;
      setError(`Could not start the camera: ${(err as Error).message}`);
      setTracking(false);
    }
  }, [mirrorX, publishPose]);

  startTrackingRef.current = startTracking;


  const startLevelling = useCallback(async () => {
    setError(null);
    headingReferenceRef.current = null;
    deviceYawRef.current = 0;
    const tilt = createTiltTracker({
      onRoll: (_roll: number, smoothedReading) => {
        // Use the filtered three-axis gravity vector supplied with this event.
        // The roll-only filter was already present, but reading getReading()
        // here bypassed it and fed raw accelerometer tremor into both axes.
        const reading = smoothedReading ?? tiltRef.current?.getSmoothedReading();
        if (!reading) return;
        if (!levelReferenceRef.current) {
          levelReferenceRef.current = upInDeviceFrame(reading);
        }
        // Photo mode uses only this attitude's half-strength roll; pitch stays
        // entirely in its raw tracked eye. True Window uses full pitch/roll
        // within the finite-scene cap and fuses the eye into this same
        // Hold-level reference. SplatViewer resolves the per-axis scene signs.
        const levelling = computeLevelling(reading, {
          reference: levelReferenceRef.current,
          gain: trueWindowRef.current ? TRUE_WINDOW_LEVELLING_GAIN : undefined,
        });
        levellingRef.current = levelling ? toQuaternion(levelling) : null;
        publishPose();
      },
      onHeading: (heading: number) => {
        if (headingReferenceRef.current === null) {
          headingReferenceRef.current = heading;
          deviceYawRef.current = 0;
        } else {
          deviceYawRef.current = wrapAngle(heading - headingReferenceRef.current);
        }
        publishPose();
      },
    });
    const outcome = await tilt.start();
    if (outcome === 'granted') {
      tiltRef.current = tilt;
      setLevelled(true);
    } else {
      setError('Motion access was refused. The view still works; it will not damp the tilt when the device is turned.');
    }
  }, [publishPose]);

  startLevellingRef.current = startLevelling;

  /** Stop holding the scene level, and put it back square to the screen. */
  const stopLevelling = useCallback(() => {
    tiltRef.current?.stop();
    tiltRef.current = null;
    levellingRef.current = null;
    levelReferenceRef.current = null;
    headingReferenceRef.current = null;
    deviceYawRef.current = 0;
    setLevelled(false);
    publishPose();
  }, [publishPose]);

  const stopEverything = useCallback(() => {
    trackerRef.current?.stop();
    trackerRef.current = null;
    tiltRef.current?.stop();
    tiltRef.current = null;
    levellingRef.current = null;
    levelReferenceRef.current = null;
    headingReferenceRef.current = null;
    deviceYawRef.current = 0;
    eyeRef.current = { x: 0, y: 0, z: viewingRef.current.baselineEyeZ };
    publishPose();
    setTracking(false);
    setLevelled(false);
    setStatus({ code: 'idle', message: 'Stopped.' });
  }, [publishPose]);

  useEffect(() => () => {
    trackerRef.current?.stop();
    tiltRef.current?.stop();
  }, []);

  const handleGesture = useCallback((gesture: {
    pinch?: number; panX?: number; panY?: number; twistDeg?: number; tipDeg?: number;
  }) => {
    if (gesture.pinch) {
      // In True Window this is a physical uniform model scale; the screen
      // aperture stays fixed. Photo mode retains its older crop semantics.
      zoomRef.current = Math.min(Math.max(zoomRef.current * gesture.pinch, MIN_ZOOM), MAX_ZOOM);
      setZoom(zoomRef.current);
    }
    if (gesture.twistDeg) {
      // Sliding one finger sideways turns the miniature about its upright
      // axis. The head keeps deciding where the view is from; this decides
      // which side of the thing is facing the glass. Geared up, because a
      // comfortable stroke is shorter than the turn people want from it.
      spinRef.current = (spinRef.current + gesture.twistDeg * TWIST_GAIN) % 360;
    }
    if (gesture.tipDeg) {
      // Clamped rather than wrapped: there is no underside to see, so running
      // past the limit would only show where the photograph had no view.
      const next = tipRef.current + gesture.tipDeg * TIP_GAIN;
      tipRef.current = Math.min(Math.max(next, -MAX_TIP_DEG), MAX_TIP_DEG);
    }
    if (gesture.panX || gesture.panY) {
      panRef.current = {
        x: panRef.current.x + (gesture.panX ?? 0),
        y: panRef.current.y + (gesture.panY ?? 0),
      };
    }
    publishPose();
  }, [publishPose]);

  const resetView = useCallback(() => {
    zoomRef.current = 1;
    setZoom(1);
    panRef.current = { x: 0, y: 0 };
    spinRef.current = 0;
    tipRef.current = 0;
    publishPose();
  }, [publishPose]);

  const toggleTrueWindow = useCallback(() => {
    const next = !trueWindowRef.current;
    trueWindowRef.current = next;
    setTrueWindow(next);
    // The same gesture has deliberately different meanings in the two modes,
    // so never carry a crop factor into the physical model scale or vice versa.
    zoomRef.current = 1;
    setZoom(1);
    publishPose();
  }, [publishPose]);

  const savePanelSize = useCallback(() => {
    const half = panelLongSideText.replace(
      /[０-９．]/g,
      (character) => String.fromCharCode(character.charCodeAt(0) - 0xFEE0),
    );
    const panelLongSideMm = Number(half.trim());
    try {
      const mmPerCssPx = mmPerCssPxFromPanelLongSide({
        panelLongSideMm,
        screenWidth: window.screen?.width,
        screenHeight: window.screen?.height,
      });
      // Phones and small tablets only. This catches centimetres entered as mm
      // and accidental zeroes without pretending to identify the device.
      if (panelLongSideMm < 80 || panelLongSideMm > 400) {
        throw new Error('Panel long side must be between 80 and 400 mm.');
      }
      saveStoredNumber(safeStorage(), DEVICE_SIZE_STORAGE_KEY, mmPerCssPx);
      setMeasuredMmPerCssPx(mmPerCssPx);
      setError(null);
    } catch (calibrationError) {
      setError(`Could not use that screen size: ${(calibrationError as Error).message}`);
    }
  }, [panelLongSideText]);

  const clearPanelSize = useCallback(() => {
    saveStoredNumber(safeStorage(), DEVICE_SIZE_STORAGE_KEY, null);
    setMeasuredMmPerCssPx(null);
    setPanelLongSideText('');
    setError(null);
  }, []);

  /**
   * Tell the tracker how far away you actually are.
   *
   * Pressed while holding the device where it is comfortable, this makes the
   * reported distance equal that. One number, because the error is a scale.
   */
  const calibrateDistance = useCallback((actualMm: number) => {
    const reported = rawHeadMmRef.current;
    if (!reported) {
      setError('Press Start 3D and wait for tracking before calibrating the distance.');
      return;
    }
    const next = distanceScaleFrom(reported, actualMm);
    distanceScaleRef.current = next;
    setDistanceScale(next);
    saveDistanceScale(safeStorage(), next);
    // The tracker's own bound is expressed against the uncorrected reading, so
    // it moves with this. Without it, correcting by a half leaves half the
    // sideways range, and the first calibration always happens after the
    // tracker was created.
    trackerRef.current?.setPositionBound?.(EYE_BOUND / Math.max(next, 1e-3));
    setError(null);
  }, []);

  /**
   * Turn whatever is on the clipboard into a scene.
   *
   * Shorter than saving a picture and finding it again in a file picker, and on
   * a phone there is no comfortable file manager to find it in.
   */
  const buildSceneFrom = useCallback(async (file: File) => {
    setBuilding('Sending the image');
    setError(null);
    try {
      const response = await fetch('/api/upload', {
        method: 'POST',
        body: (() => {
          const form = new FormData();
          form.append('file', file);
          // Stop before building if the photograph does not say what lens took
          // it. Guessing means building twice, and building is twenty seconds
          // and eleven megabytes.
          form.append('hold_for_lens', 'true');
          return form;
        })(),
      });
      if (!response.ok) throw new Error(`the server answered ${response.status}`);
      const job = await response.json();
      if (job.needsLens) {
        // Nothing is running. The field below starts it, with whatever is
        // typed there or with the 30 mm SHARP would have assumed anyway.
        setBuilding(null);
        setLensJobId(job.jobId);
        setLensText('');
        setLensPending(true);
        return;
      }
      setBuilding('Generating the scene');

      // ml-sharp takes a few seconds on a graphics card and considerably longer
      // without one, so this waits rather than assuming.
      const deadline = Date.now() + 10 * 60 * 1000;
      for (;;) {
        if (Date.now() > deadline) throw new Error('the scene took too long');
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const status = await (await fetch(job.statusUrl)).json();
        if (status.status === 'done') break;
        if (status.status === 'error') throw new Error(status.message || 'the backend failed');
      }
      setBuilding('Loading the scene');
      // Ask what the server would serve rather than taking the upload's own
      // answer. The upload replies before the scene exists and so can only name
      // the full PLY; by now the compressed copy is beside it, and on a phone
      // the difference is about eleven megabytes against sixty-six. Without
      // this the page loads the large one and the poll then replaces it with
      // the small one, downloading the scene twice.
      sceneGenerationRef.current += 1;
      const published = await latestScene();
      setCaptureProjection(published?.projection ?? null);
      setSceneUrl(published?.url ?? job.plyUrl);
      // Whether to offer the lens is decided from the scene itself, by the
      // poll above, so that it does not depend on who made it.
      setLensText('');

      // Somebody who pasted a picture in order to look at it in three
      // dimensions does not also need to say so. This only reaches the camera
      // when permission has already been given: iOS grants it from a user
      // action, and the tap that started this expired during the tens of
      // seconds the scene took to build. The first time round the button is
      // still there; every time after, it is not needed.
      if (!trackerRef.current) {
        try {
          await startTrackingRef.current?.();
        } catch {
          // Refused, or wanting a fresh tap. The button says so.
        }
      }
    } catch (err) {
      setError(`Could not use that image: ${(err as Error).message}`);
    } finally {
      setBuilding(null);
    }
  }, []);

  const pasteFromClipboard = useCallback(async () => {
    const result = await readImageFromClipboard();
    if (result.ok === true) {
      await buildSceneFrom(result.file);
      return;
    }
    setError(result.reason === 'unsupported'
      ? 'This browser will not let a page read the clipboard. Copy the image and use the editor instead.'
      : result.reason === 'empty'
        ? 'There is no image on the clipboard.'
        : 'Reading the clipboard was refused.');
  }, [buildSceneFrom]);

  // A desktop pastes with the keyboard, which needs no permission at all.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const file = imageFromPasteEvent(event);
      if (!file) return;
      event.preventDefault();
      void buildSceneFrom(file);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [buildSceneFrom]);

  /**
   * Open showing the whole frame, not just its middle.
   *
   * The scene is fitted to the frame's height, so the window keeps the screen's
   * own proportions and a photograph wider than the screen loses its sides
   * before anything else happens -- a third of the width for a landscape
   * photograph held upright.
   *
   * Zooming out grows the virtual window past the physical glass until the
   * width fits. That is a real departure from a literal window and not a small
   * correction to one: the picture is built for a larger pane and shown on a
   * smaller, so everything on it, the response to head movement included, is
   * scaled down with it. It is a trade -- the whole frame against exactness --
   * and worth making when the alternative is losing a third of the picture.
   *
   * The estimate it works from is a heuristic. It measures how far the
   * surviving gaussians spread sideways against how far they spread vertically,
   * which is the photograph's shape only to the extent that the reconstruction
   * fills its frame; on the sample used to develop this it came out about eight
   * per cent wide. Erring that way costs a little extra margin, not content.
   *
   * Only the opening view. A pinch afterwards is the viewer's own choice and
   * this does not fight it, because it runs when a scene arrives and not again.
   */
  const fitZoomToAspect = useCallback((aspect: number | null) => {
    if (!aspect || !Number.isFinite(aspect)) return;
    if (trueWindowRef.current) {
      if (zoomRef.current !== 1) {
        zoomRef.current = 1;
        setZoom(1);
        publishPose();
      }
      return;
    }
    const canvasAspect = viewport.width / Math.max(1, viewport.height);
    const fitted = Math.min(1, canvasAspect / aspect);
    const clamped = Math.min(Math.max(fitted, MIN_ZOOM), MAX_ZOOM);
    if (Math.abs(clamped - zoomRef.current) < 1e-3) return;
    zoomRef.current = clamped;
    setZoom(clamped);
    publishPose();
  }, [publishPose, viewport.height, viewport.width]);

  /**
   * Build the scene again through a different lens.
   *
   * The lens cannot be judged before the scene exists -- a wrong one shows up
   * as depth pressed flat or drawn out, and there is no way to see that except
   * to look. So this exists to look again, and it runs only when a value has
   * been typed and this is pressed. Nothing re-runs on its own.
   */
  const rebuildWithLens = useCallback(async () => {
    if (buildingRef.current) return;
    const jobId = lensJobIdRef.current;
    // Blank is an answer too: it means the 30 mm SHARP would have assumed, and
    // saying it outright is the same picture as saying nothing.
    const focal = lensTextRef.current.trim() === '' ? 30 : parseFocalMm(lensTextRef.current);
    if (!jobId || focal === null) return;
    setError(null);
    setLensPending(false);
    setBuilding(`Building at ${focal.toFixed(0)} mm`);
    try {
      const form = new FormData();
      form.append('focal_length_35mm', String(focal));
      const response = await fetch(`/api/scene/${jobId}/relens`, { method: 'POST', body: form });
      if (!response.ok) throw new Error(`the server answered ${response.status}`);

      const deadline = Date.now() + 10 * 60 * 1000;
      for (;;) {
        if (Date.now() > deadline) throw new Error('the scene took too long');
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const status = await (await fetch(`/api/scene/${jobId}/status`)).json();
        if (status.status === 'done') break;
        if (status.status === 'error') throw new Error(status.message || 'the backend failed');
      }
      // The server stamps a revision into the URL, so a rebuilt scene is a
      // different address and both the cache and this effect notice. Setting
      // the same string twice did not: React collapses that to one update, and
      // the picture stayed on screen while the new one sat on disk.
      sceneGenerationRef.current += 1;
      const published = await latestScene();
      setCaptureProjection(published?.projection ?? null);
      setSceneUrl(published?.url ?? null);
    } catch (err) {
      setError(`Could not rebuild at that lens: ${(err as Error).message}`);
    } finally {
      setBuilding(null);
    }
  }, []);

  const toggleMirror = useCallback(() => {
    setMirrorX((previous) => {
      const next = !previous;
      try { window.localStorage?.setItem(MIRROR_STORAGE_KEY, String(next)); } catch { /* refused */ }
      trackerRef.current?.setMirrorX(next);
      return next;
    });
  }, []);

  const geometryNote = `${geometry.metrics.label} · ${geometry.viewing.screenHeightMm.toFixed(0)} mm tall`
    + (headMm !== null ? ` · head at ${headMm.toFixed(0)} mm` : ` · assuming ${geometry.viewing.viewingDistanceMm.toFixed(0)} mm`)
    + (placement
      ? ` · far field ${(placement.visibleFraction * 100).toFixed(0)}% tall`
        + ` · life-sized at ${lifeSizeDistanceMm(
          placement.windowHalfHeight,
          placement.eyeDistance,
          geometry.viewing.screenHeightMm / 2,
        ).toFixed(0)} mm`
      : '');

  return (
    <div
      className={`window-viewer${chromeHidden ? ' window-viewer--bare' : ''}`}
      onDoubleClick={() => {
        // Clearing the screen and putting the view back belong together: the
        // gesture means "start again from a clean picture".
        setChromeHidden((v) => !v);
        resetView();
      }}
    >
      <div ref={stageRef}
        className={`window-viewer__stage${building ? ' window-viewer__stage--hidden' : ''}`}>
        {sceneUrl ? (
          <SplatViewer
            ref={viewerRef}
            plyUrl={sceneUrl}
            mode="mono"
            baseline={0}
            fovDeg={geometry.viewing.verticalFovDeg}
            zeroParallaxMode="pivot"
            zeroParallaxDistance={geometry.viewing.baselineEyeZ}
            compression={1}
            clampPx={0}
            swapLR={false}
            headPose={pose}
            captureTangentHint={captureProjection?.captureTangent}
            captureAspectHint={captureProjection?.captureAspect}
            onGesture={handleGesture}
            onPlacement={setPlacement}
            onSceneProgress={setSceneProgress}
            onSceneAspect={fitZoomToAspect}
          />
        ) : null}
      </div>

      {/* Off-screen: the tracker reads frames from it, nobody looks at it. */}
      <video ref={videoRef} playsInline muted
        style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }} />

      <button
        type="button"
        className="window-viewer__status"
        title="Tap for the numbers the geometry is using"
        onClick={() => setShowDetail((v) => !v)}
      >
        {sceneUrl ? `${status.message}\n${geometryNote}` : 'No scene yet. Make one in the editor and it will appear here, or paste a picture below.'}
        {showDetail && (
          '\n\n' + [
            `screen  ${geometry.metrics.source} · ${geometry.metrics.mmPerCssPx.toFixed(4)} mm per css px`,
            `canvas  ${viewport.width} x ${viewport.height} css · dpr ${viewport.devicePixelRatio}`,
            `panel   ${window.screen?.width} x ${window.screen?.height} css`,
            `world   1 unit = ${geometry.viewing.worldUnitMm.toFixed(2)} mm`,
            `head    raw ${rawHeadMmRef.current?.toFixed(0) ?? '-'} mm`
              + ` · x${distanceScale.toFixed(3)} · corrected ${headMm?.toFixed(0) ?? '-'} mm`,
            placement
              ? `scene   eye ${(placement.eyeDistance * geometry.viewing.worldUnitMm).toFixed(0)} mm`
                + ` · window ${placement.windowHalfHeight.toFixed(3)}`
                + ` · fov ${(2 * Math.atan(placement.windowHalfHeight / placement.eyeDistance) * 180 / Math.PI).toFixed(1)}°`
              : 'scene   not loaded',
          ].join('\n')
        )}
      </button>

      {(building || sceneProgress !== null) && (
        <div className="window-viewer__building">
          <div className="window-viewer__spinner" />
          <div className="window-viewer__building-text">
            {building ?? 'Downloading the scene'}
          </div>
          <div className="window-viewer__building-note">
            {building
              ? 'This takes a little while.'
              : `${Math.round((sceneProgress ?? 0) * 100)}%`}
          </div>
        </div>
      )}

      {/* Several of these are notices rather than failures -- refused motion
          access, for one, which leaves the view working. All of them used to
          stay on screen for the rest of the session with no way to clear them. */}
      {error && (
        <div
          className="window-viewer__error"
          role="button"
          tabIndex={0}
          title="Tap to dismiss"
          onClick={() => setError(null)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setError(null); }}
        >
          {error}
        </div>
      )}

      <div className="window-viewer__bar">
        {!tracking ? (
          <button className="primary" type="button" onClick={startTracking} disabled={!sceneUrl}>
            Start 3D
          </button>
        ) : (
          <>
            <button type="button" onClick={() => {
              trackerRef.current?.recenter();
              // Wherever the device is being held now becomes the posture the
              // scene is held level against.
              levelReferenceRef.current = null;
              levellingRef.current = null;
              headingReferenceRef.current = null;
              deviceYawRef.current = 0;
              publishPose();
            }}>Recenter</button>
            <button type="button" onClick={stopEverything}>Stop</button>
          </>
        )}
        <button type="button" className={levelled ? 'on' : ''}
          title="Filter sensor jitter and hold the model in the room. True Window uses pitch/roll and relative phone yaw; Recenter captures a fresh reference."
          onClick={levelled ? stopLevelling : startLevelling}>
          Hold level {levelled ? 'on' : 'off'}
        </button>
        <button type="button" className={mirrorX ? 'on' : ''} onClick={toggleMirror}
          title="Correct the front-camera horizontal axis. Leave this on when real head motion looks correct; phone rotation is handled separately.">
          Reverse tracking {mirrorX ? 'on' : 'off'}
        </button>
        {tracking && (
          <button type="button"
            title="Press this while holding the device where it is comfortable, and the tracker's distance is corrected to match"
            onClick={() => calibrateDistance(geometry.viewing.viewingDistanceMm)}>
            I am at {geometry.viewing.viewingDistanceMm.toFixed(0)} mm
          </button>
        )}
        {showDetail && (
          <span className="window-viewer__calibration">
            <input
              type="text"
              inputMode="decimal"
              value={panelLongSideText}
              placeholder="panel long side mm"
              aria-label="Physical panel long side in millimetres"
              title="Measure the lit panel's longer side in millimetres. This calibrates the physical window scale on an unknown device."
              onChange={(event) => setPanelLongSideText(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') savePanelSize(); }}
            />
            <button type="button" onClick={savePanelSize}>Set screen size</button>
            {measuredMmPerCssPx !== null && (
              <button type="button" onClick={clearPanelSize}>Use device default</button>
            )}
          </span>
        )}
        <button type="button" className={trueWindow ? 'on' : ''}
          title="Build the view from where your eye actually is. Faces stop stretching toward the edges; the frame is cropped with depth, as a window crops it."
          onClick={toggleTrueWindow}>
          True window {trueWindow ? 'on' : 'off'}
        </button>
        <button type="button" className={pushMm ? 'on' : ''}
          title="Slide the whole miniature further behind the glass. More of it fits and it swings less when you turn it, at the cost of apparent size. It does not make the scene deeper."
          onClick={() => setPushMm((v) => {
            const i = PUSH_STEPS_MM.indexOf(v);
            return PUSH_STEPS_MM[(i < 0 ? 0 : i + 1) % PUSH_STEPS_MM.length];
          })}>
          Depth {pushMm ? `${pushMm} mm` : 'off'}
        </button>
        <button type="button" onClick={pasteFromClipboard} disabled={building !== null}
          title="Turn the image on the clipboard into a scene">
          Paste image
        </button>
        {/* Only when the photograph did not record its own lens. When it did,
            that value is right and there is nothing to ask. */}
        {lensJobId && (
          <span className="window-viewer__lens">
            {lensPending && (
              <span className="window-viewer__lens-note">
                No lens in this picture — 30 mm is assumed. A portrait is 50 to 85.
              </span>
            )}
            <input
              type="text"
              inputMode="decimal"
              value={lensText}
              placeholder="lens mm"
              aria-label="Lens, 35 mm equivalent"
              title="This photograph did not say what lens took it, so 30 mm was assumed. If the depth looks pressed flat, a portrait is usually 50 to 85."
              onChange={(e) => setLensText(e.target.value)}
              onKeyDown={(e) => {
                // The button is disabled while one is building; Enter has to
                // respect that too, or holding it queues rebuilds.
                if (e.key === 'Enter' && building === null) void rebuildWithLens();
              }}
            />
            <button type="button"
              disabled={building !== null
                || (lensText.trim() !== '' && parseFocalMm(lensText) === null)}
              onClick={() => void rebuildWithLens()}>
              {lensPending ? 'Build' : 'Rebuild'}
            </button>
          </span>
        )}
        {(zoom !== 1 || pose?.pan?.x || pose?.pan?.y || pose?.spin || pose?.tip) ? (
          <button type="button" onClick={resetView}>Reset view</button>
        ) : null}
      </div>
    </div>
  );
}
