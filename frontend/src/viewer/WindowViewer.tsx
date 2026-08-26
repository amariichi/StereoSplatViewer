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
  resolveScreenMetrics,
} from '../device/device-metrics.js';
import { createTiltTracker } from '../device/device-tilt.js';
import { computeLevelling, toQuaternion, upInDeviceFrame, type Vec3 } from '../device/levelling';
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
async function latestSceneUrl(): Promise<string | null> {
  try {
    const response = await fetch('/api/scene/latest');
    if (!response.ok) return null;
    const body = await response.json();
    if (typeof body?.sogUrl === 'string') return body.sogUrl;
    return typeof body?.plyUrl === 'string' ? body.plyUrl : null;
  } catch {
    return null;
  }
}

export function WindowViewer() {
  const viewerRef = useRef<ViewerHandle>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const trackerRef = useRef<InstanceType<typeof HeadTracker> | null>(null);
  const tiltRef = useRef<ReturnType<typeof createTiltTracker> | null>(null);

  const [sceneUrl, setSceneUrl] = useState<string | null>(() => sceneUrlFromLocation());
  const [status, setStatus] = useState<Status>({ code: 'idle', message: 'Ready.' });
  const [tracking, setTracking] = useState(false);
  const [levelled, setLevelled] = useState(false);
  const [mirrorX, setMirrorX] = useState<boolean>(readMirrorPreference);
  const [error, setError] = useState<string | null>(null);
  const [pose, setPose] = useState<HeadPose | null>(null);

  // The screen's real size decides the whole viewing geometry, so it is
  // resolved once from a table of known devices, or from a value the viewer
  // measured themselves, which always wins.
  const geometry = useMemo(() => {
    const storage = safeStorage();
    const metrics = resolveScreenMetrics({
      screenWidth: window.screen?.width,
      screenHeight: window.screen?.height,
      devicePixelRatio: window.devicePixelRatio,
      measuredMmPerCssPx: loadStoredNumber(storage, DEVICE_SIZE_STORAGE_KEY),
    });
    const viewing = computeViewingGeometry({
      canvasCssHeight: window.innerHeight,
      mmPerCssPx: metrics.mmPerCssPx,
      viewingDistanceMm: loadStoredNumber(storage, VIEWING_DISTANCE_STORAGE_KEY)
        ?? metrics.defaultViewingDistanceMm,
    });
    return { metrics, viewing };
  }, []);

  const levellingRef = useRef<{ x: number; y: number; z: number; w: number } | null>(null);
  // Where up was when levelling began. The correction is measured from there,
  // not from vertical: a tablet is read tipped well back, and measuring from
  // vertical pinned the correction at its cap before anyone had moved.
  const levelReferenceRef = useRef<Vec3 | null>(null);
  const eyeRef = useRef({ x: 0, y: 0, z: geometry.viewing.baselineEyeZ });
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const spinRef = useRef(0);
  const tipRef = useRef(0);
  const [zoom, setZoom] = useState(1);
  // Null when nothing is downloading. A compressed scene is still about
  // eleven megabytes and a mobile connection makes that a long silence.
  const [sceneProgress, setSceneProgress] = useState<number | null>(null);
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
  const trueWindowRef = useRef(true);
  const pushMmRef = useRef(0);
  useEffect(() => { trueWindowRef.current = trueWindow; }, [trueWindow]);
  useEffect(() => { pushMmRef.current = pushMm; }, [pushMm]);

  const publishPose = useCallback(() => {
    setPose({
      eye: { ...eyeRef.current },
      // How far the eye is from the glass, measured rather than assumed.
      screenDistance: geometry.viewing.baselineEyeZ,
      levelling: levellingRef.current,
      zoom: zoomRef.current,
      pan: { ...panRef.current },
      spin: spinRef.current,
      tip: tipRef.current,
      trueWindow: trueWindowRef.current,
      pushBack: pushMmRef.current / geometry.viewing.worldUnitMm,
    });
  }, [geometry.viewing.baselineEyeZ, geometry.viewing.worldUnitMm]);

  useEffect(() => {
    publishPose();
  }, [publishPose, trueWindow, pushMm]);

  // Nothing in the address: ask the editor what it is holding, and keep
  // asking. A scene made on the desktop lands under a new job id, so the URL
  // changes and this picks it up without anyone reloading the page by hand.
  // The poll is one small JSON request; the scene itself is only fetched when
  // the answer is different from what is already on screen.
  useEffect(() => {
    // An address that names a scene means it: nothing here overrides it.
    if (sceneUrlFromLocation()) return undefined;
    let cancelled = false;
    const check = () => {
      // A poll that is still out cannot be allowed to answer for a scene
      // chosen since it left -- pasting one sets the scene directly, and the
      // reply to a request made before that would put the old one back.
      const mine = ++sceneGenerationRef.current;
      latestSceneUrl().then((url) => {
        if (cancelled || mine !== sceneGenerationRef.current || !url) return;
        setSceneUrl((current) => (url === current ? current : url));
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
    const tracker = new HeadTracker({
      video,
      baselineEyeZ: geometry.viewing.baselineEyeZ,
      worldUnitMm: geometry.viewing.worldUnitMm,
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
        rawHeadMmRef.current = next.z * geometry.viewing.worldUnitMm;
        setHeadMm(corrected * geometry.viewing.worldUnitMm);
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
  }, [geometry.viewing.baselineEyeZ, geometry.viewing.worldUnitMm, mirrorX, publishPose]);

  startTrackingRef.current = startTracking;


  const startLevelling = useCallback(async () => {
    setError(null);
    const tilt = createTiltTracker({
      onRoll: () => {
        const reading = tiltRef.current?.getReading();
        if (!reading) return;
        if (!levelReferenceRef.current) {
          levelReferenceRef.current = upInDeviceFrame(reading);
        }
        // Two axes from one gravity vector, rather than the roll alone. Tipping
        // the screen up towards the ceiling was the movement that swung the
        // scene about worst, and a roll-only correction does nothing about it.
        // The axis-angle form also has no cliff near horizontal: the turn
        // needed there is a pure tip, which is perfectly well defined even
        // though a roll angle is not.
        // Two turns with opposite signs: a roll is always turned back towards
        // level, while tipping the device up stands the model up. One axis-angle
        // could not express that, and a single flip control could not either.
        const levelling = computeLevelling(reading, { reference: levelReferenceRef.current });
        levellingRef.current = levelling ? toQuaternion(levelling) : null;
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
    setLevelled(false);
    publishPose();
  }, [publishPose]);

  const stopEverything = useCallback(() => {
    trackerRef.current?.stop();
    trackerRef.current = null;
    tiltRef.current?.stop();
    tiltRef.current = null;
    levellingRef.current = null;
    eyeRef.current = { x: 0, y: 0, z: geometry.viewing.baselineEyeZ };
    publishPose();
    setTracking(false);
    setLevelled(false);
    setStatus({ code: 'idle', message: 'Stopped.' });
  }, [geometry.viewing.baselineEyeZ, publishPose]);

  useEffect(() => () => {
    trackerRef.current?.stop();
    tiltRef.current?.stop();
  }, []);

  const handleGesture = useCallback((gesture: {
    pinch?: number; panX?: number; panY?: number; twistDeg?: number; tipDeg?: number;
  }) => {
    if (gesture.pinch) {
      // Spreading crops into the frame, which is what pinching means and is
      // also the only lever a small screen leaves. The whole photograph is
      // life-sized about 12 cm away, which is no way to hold a phone; cropping
      // brings that out to arm's length at the cost of the edges of the frame.
      // The apex does not move, so the geometry stays exact throughout.
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
        body: (() => { const form = new FormData(); form.append('file', file); return form; })(),
      });
      if (!response.ok) throw new Error(`the server answered ${response.status}`);
      const job = await response.json();
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
      setSceneUrl((await latestSceneUrl()) ?? job.plyUrl);

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
    const canvasAspect = window.innerWidth / Math.max(1, window.innerHeight);
    const fitted = Math.min(1, canvasAspect / aspect);
    const clamped = Math.min(Math.max(fitted, MIN_ZOOM), MAX_ZOOM);
    if (Math.abs(clamped - zoomRef.current) < 1e-3) return;
    zoomRef.current = clamped;
    setZoom(clamped);
    publishPose();
  }, [publishPose]);

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
      <div className={`window-viewer__stage${building ? ' window-viewer__stage--hidden' : ''}`}>
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
            `canvas  ${window.innerWidth} x ${window.innerHeight} css · dpr ${window.devicePixelRatio}`,
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
            }}>Recenter</button>
            <button type="button" onClick={stopEverything}>Stop</button>
          </>
        )}
        <button type="button" className={levelled ? 'on' : ''}
          title="Hold the scene still in the room, part-way, while the device turns around it"
          onClick={levelled ? stopLevelling : startLevelling}>
          Hold level {levelled ? 'on' : 'off'}
        </button>
        <button type="button" className={mirrorX ? 'on' : ''} onClick={toggleMirror}
          title="Reverse which way the view moves when you move your head">
          Reverse tracking {mirrorX ? 'on' : 'off'}
        </button>
        {tracking && (
          <button type="button"
            title="Press this while holding the device where it is comfortable, and the tracker's distance is corrected to match"
            onClick={() => calibrateDistance(geometry.viewing.viewingDistanceMm)}>
            I am at {geometry.viewing.viewingDistanceMm.toFixed(0)} mm
          </button>
        )}
        <button type="button" className={trueWindow ? 'on' : ''}
          title="Build the view from where your eye actually is. Faces stop stretching toward the edges; the frame is cropped with depth, as a window crops it."
          onClick={() => setTrueWindow((v) => !v)}>
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
        {(zoom !== 1 || pose?.pan?.x || pose?.pan?.y || pose?.spin || pose?.tip) ? (
          <button type="button" onClick={resetView}>Reset view</button>
        ) : null}
      </div>
    </div>
  );
}
