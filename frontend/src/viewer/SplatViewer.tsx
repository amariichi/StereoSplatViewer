// The scene, drawn by PlayCanvas directly.
//
// This replaces a component that reached into a personal fork of the SuperSplat
// editor through `import("supersplat/src/embed")`. That pulled 4.2 MB of editor
// in to obtain six functions, and pinned the project to an experimental branch.
// Everything needed is in the engine: `GSplatComponent` draws the splats and
// `CameraComponent.calculateProjection` is where off-axis stereo will attach.

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as pc from 'playcanvas';

import type { StereoSettings, ViewerHandle } from '../types';
import { computeOffAxisFrustum, computeStereoEye, effectiveBaseline, sanitizeEye } from './off-axis';
import {
  apexDistance,
  computeWindowPlacement,
  estimateCaptureAspect,
  estimateCaptureTangent,
  mapTrackedEye,
} from './window-placement';
import {
  type OrbitState,
  applyDolly,
  applyOrbitDrag,
  applyPan,
  createOrbitState,
  orbitChanged,
  orbitToPosition,
} from './camera-orbit';

/**
 * Where the viewer's eye is, when a camera is watching their head.
 *
 * `eye` is in world units where one unit is half the height of the virtual
 * screen, which is the same convention the device metrics module produces. The
 * screen is a fixed plane `screenDistance` in front of the scene's capture
 * viewpoint; the eye moves in front of that plane and the view volume is skewed
 * to suit, exactly as for one eye of a stereo pair.
 *
 * Supplying this switches the viewer from orbiting to a window. The camera then
 * never rotates: a head-coupled view that rotated its camera would swim,
 * because rotation and translation produce different parallax.
 */
export type HeadPose = {
  eye: { x: number; y: number; z: number };
  /**
   * The distance the device is comfortably held at, in window units.
   *
   * The depth axis is shifted so that this lands on the apex. Sideways and
   * vertical positions are used exactly as measured.
   */
  screenDistance: number;

  /**
   * How to turn the scene so that it stands upright in the room while the
   * device turns around it, as a quaternion. Two axes: gravity gives the tip
   * and the roll, and heading would need a magnetometer that wanders indoors.
   */
  levelling?: { x: number; y: number; z: number; w: number } | null;
  /** How large to make the miniature. Larger is bigger, and flatter. */
  sizeScale?: number;
  /** How far into the frame to crop. 1 shows the whole photograph. */
  zoom?: number;
  /** Sideways and vertical shift of the miniature, in window units. */
  pan?: { x: number; y: number };
  /**
   * How far the miniature has been turned about its own upright axis, in
   * degrees.
   *
   * This turns the scene, not the camera. A window cannot be orbited -- the
   * viewpoint is wherever the viewer's head is -- but the thing behind the
   * glass can be put on a turntable, which is how you would look at the back of
   * something you were holding.
   */
  spin?: number;
  /**
   * How far the miniature has been tipped toward or away from the viewer, in
   * degrees. Positive brings the top toward the glass, so you look down on it.
   *
   * Like the spin, this turns the scene rather than the camera, and it is
   * clamped: a scene made from one photograph has nothing underneath, so
   * tipping past a certain point only shows the absence.
   */
  tip?: number;
  /**
   * Build the view volume from where the eye actually is.
   *
   * The alternative, and the older behaviour, is to move the eye onto the
   * apex -- the point from which the reconstruction reproduces its source
   * photograph -- so that the whole frame is on screen at every depth. That
   * costs the one property a window has to have: the pre-distortion a flat
   * off-axis projection puts into the picture is cancelled by looking at the
   * screen from the angle it was built for, and only then. The angle it is
   * built for is the photograph's own, which is wide -- a phone held at arm's
   * length spans a small fraction of it -- so most of the pre-distortion
   * survives, and it survives hardest where the angle is largest. That is why
   * a face stretches as it moves toward an edge.
   *
   * With this set the eye is used as measured. Nothing is pre-distorted that
   * the viewing angle will not undo. The price is that the frame is no longer
   * whole at every depth: content on the glass is all there, and the further
   * back it sits the more the window crops it, which is what a window does.
   */
  trueWindow?: boolean;
  /**
   * How far behind the glass to slide the whole miniature, in window units.
   *
   * The nearest content is placed on the glass by default. Sliding it back
   * lets the view volume, which widens with depth, take in more of the scene,
   * and settles how widely the miniature swings when it is turned, since it is
   * turned about the centre of the window rather than about itself. It costs
   * apparent size.
   *
   * It is not a depth control, whatever it looks like. Moving the whole scene
   * away raises how far everything in it travels when the head moves, and
   * lowers the DIFFERENCE between what near and far parts travel -- and only
   * that difference reads as depth. A scene slid back is flatter, not deeper.
   *
   * Nothing is scaled: this is a translation, which is why it is not
   * `sizeScale` -- that grows the miniature as it moves it back, and the growth
   * outruns the extra room.
   */
  pushBack?: number;
};

type Props = {
  plyUrl: string;
  mode: 'mono' | 'sbs';
  baseline: number;
  fovDeg: number;
  zeroParallaxMode: 'pivot' | 'fixed';
  zeroParallaxDistance: number;
  compression: number;
  clampPx: number;
  swapLR: boolean;
  onFovChange?: (fovDeg: number) => void;
  onOffscreenReadyChange?: (ready: boolean) => void;
  /** When given, the viewer becomes a window onto the scene rather than an orbit. */
  headPose?: HeadPose | null;
  /** Touch and wheel gestures, which in window mode the page has to interpret. */
  onGesture?: (gesture: {
    pinch?: number; panX?: number; panY?: number; twistDeg?: number; tipDeg?: number;
  }) => void;
  /** Reports the window the scene was fitted into, so the page can describe it. */
  onPlacement?: (placement: {
    windowHalfHeight: number; visibleFraction: number; eyeDistance: number;
  }) => void;
  /**
   * How far through downloading the scene we are, 0 to 1, and null when there
   * is nothing in flight.
   *
   * A compressed scene is still about eleven megabytes, which over a mobile
   * connection is long enough that a viewer with no indication of progress
   * reasonably concludes the thing is broken. It was reported exactly that
   * way: "still black".
   */
  onSceneProgress?: (fraction: number | null) => void;
  /**
   * How wide the photograph is against how tall, once a scene has loaded.
   *
   * The window is fitted to the frame's height, so a page that knows this can
   * open at a zoom that shows the width as well instead of cutting it.
   */
  onSceneAspect?: (aspect: number | null) => void;
};

/**
 * The engine's name for "a render would now show something new".
 *
 * Drawing happens on demand here, so something has to say when a frame is worth
 * drawing. Splats are drawn back to front and that ordering is produced off the
 * main thread, so it lands a frame or more after the camera moves; streamed
 * levels of detail arrive later still. PlayCanvas raises this event once per
 * frame when either has produced something a render would show, which is
 * exactly the cue this viewer needs. Its own documentation gives setting
 * `renderNextFrame` from it as the intended use of `autoRender = false`.
 *
 * Taken from the engine's constant rather than written out, so that a rename
 * upstream is a build error here instead of a silently blank canvas. That is
 * the failure this replaces: before unified rendering the cue was read off an
 * undocumented `instance.sorter`, a cast that kept compiling after the property
 * went away.
 */
const FRAME_REQUEST = pc.GSplatComponentSystem.EVENT_FRAMEREQUEST;

/**
 * What to tell someone when that cue cannot be subscribed to.
 *
 * Without it nothing would ask for a frame after the first, so the fallback is
 * to draw every frame: wasteful, and visible, which beats correct and blank.
 */
const FRAME_REQUEST_MISSING_ADVICE = [
  'PlayCanvas: could not subscribe to the gsplat system\'s',
  `'${FRAME_REQUEST}' event, so this is drawing every frame instead of only`,
  'when there is something new to show. It still works and costs more battery.',
  'Check what replaced that event in the installed engine version and rewire',
  'render scheduling in SplatViewer.tsx to it.',
].join(' ');

// Used when the gaussian positions cannot be read, so that a scene is still
// framed at a plausible arm's length rather than at zero.
const DEFAULT_SUBJECT_DISTANCE = 3;

// Effectively the nearest gaussian, sampled densely enough that a lone stray
// cannot set the placement for the whole scene.
//
// Two per cent was tried and is too many. Anything in front of the glass
// magnifies faster than the rest as the eye approaches, without bound, and a
// face is not deep: at half the apex distance the front of a face grew 2.19
// times against 1.80 for the back of the head, which is seen as the forehead
// and crown stretching away from the mouth. With the near edge on the glass the
// same movement gives 2.00 against 1.80.
const NEAR_ANCHOR_QUANTILE = 0.001;
const NEAR_ANCHOR_STRIDE = 16;

/**
 * The median distance of the gaussians from the capture viewpoint.
 *
 * The median rather than the mean, because these scenes are strongly bimodal:
 * a subject a few metres away and a background a hundred or more. A mean would
 * land in the empty space between them, where nothing is.
 *
 * Sampled rather than read in full: at over a million gaussians the answer does
 * not change and the work would be noticeable on a phone.
 */
export function splatDistanceQuantile(
  centers?: Float32Array,
  quantile = 0.5,
  stride = 64,
): number | null {
  if (!centers || centers.length < 3) return null;
  const distances: number[] = [];
  for (let i = 0; i + 2 < centers.length; i += 3 * stride) {
    distances.push(Math.hypot(centers[i], centers[i + 1], centers[i + 2]));
  }
  if (distances.length === 0) return null;
  distances.sort((a, b) => a - b);
  const at = distances[Math.min(distances.length - 1, Math.floor(distances.length * quantile))];
  return Number.isFinite(at) && at > 0 ? at : null;
}

/**
 * The depth to put in the plane of the window.
 *
 * A low quantile rather than the middle: everything nearer than the window
 * plane appears in front of the glass, and parallax is fiercest there. A
 * quantile rather than the true minimum, because a handful of stray gaussians
 * closer than the subject would otherwise set the whole placement.
 */
export function nearSplatDistance(centers?: Float32Array): number | null {
  return splatDistanceQuantile(centers, NEAR_ANCHOR_QUANTILE, NEAR_ANCHOR_STRIDE);
}

/**
 * A name for the scene, whose extension decides how it is read.
 *
 * PlayCanvas picks the parser for a `gsplat` asset from the extension of the
 * name it is given -- `ply`, `sog`, `json` -- so this is not cosmetic. Two
 * kinds of address reach here today: the backend's `/api/scene/.../scene.ply`,
 * whose last segment is already the right name, and a `blob:` URL the browser
 * makes for a file opened from this machine. A blob URL carries no name at all,
 * so it falls through to the default, which is right: the control that produces
 * one accepts only `.ply`. A SOGS `meta.json` would come through the first
 * case, named, when the backend starts serving one.
 *
 * Anything without an extension gets the same default rather than being passed
 * on bare, because a name the engine cannot place is refused outright with
 * "No parser found for resource".
 */
function resolveFilename(url: string): string {
  try {
    const last = decodeURIComponent(new URL(url, window.location.href).pathname.split('/').pop() || '');
    return /\.[^./]+$/.test(last) ? last : 'scene.ply';
  } catch {
    return 'scene.ply';
  }
}

export const SplatViewer = forwardRef<ViewerHandle, Props>(function SplatViewer(
  {
    plyUrl,
    mode,
    baseline,
    fovDeg,
    zeroParallaxMode,
    zeroParallaxDistance,
    compression,
    clampPx,
    swapLR,
    onFovChange,
    onOffscreenReadyChange,
    headPose = null,
    onGesture,
    onPlacement,
    onSceneProgress,
    onSceneAspect,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const appRef = useRef<pc.AppBase | null>(null);
  const cameraRef = useRef<pc.Entity | null>(null);
  const eyesRef = useRef<pc.Entity[]>([]);
  const sceneRootRef = useRef<pc.Entity | null>(null);
  const headPoseRef = useRef<HeadPose | null>(headPose);
  const windowHalfHeightRef = useRef(1);
  const onGestureRef = useRef(onGesture);
  onGestureRef.current = onGesture;
  const onPlacementRef = useRef(onPlacement);
  onPlacementRef.current = onPlacement;
  const onSceneProgressRef = useRef(onSceneProgress);
  onSceneProgressRef.current = onSceneProgress;
  const onSceneAspectRef = useRef(onSceneAspect);
  onSceneAspectRef.current = onSceneAspect;
  const captureTangentRef = useRef<number | null>(null);
  const subjectDistanceRef = useRef(DEFAULT_SUBJECT_DISTANCE);
  const anchorDistanceRef = useRef(DEFAULT_SUBJECT_DISTANCE);
  const splatEntityRef = useRef<pc.Entity | null>(null);
  const assetRef = useRef<pc.Asset | null>(null);
  const orbitRef = useRef<OrbitState>(createOrbitState());
  const drawnRef = useRef<OrbitState | null>(null);
  const stereoRef = useRef<StereoSettings>({
    mode,
    baseline,
    compression,
    clampPx,
    zeroParallaxMode,
    zeroParallaxDistance,
    swapLR,
  });
  const fovRef = useRef(fovDeg);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // Drawing only when something moved is what keeps a phone alive. The engine
  // would otherwise redraw sixty times a second whether or not the picture
  // could differ; the sibling depth viewer measured that falling to twenty-odd
  // real frames once gated, at no visible cost.
  /**
   * Put the scene behind the window, with the capture camera on the eye.
   *
   * Re-applied whenever the relief control moves, because scale is what that
   * control changes: at the calibrated eye the picture is the photograph
   * whatever the scale, so scaling only alters how much the view shifts when
   * the head does.
   */
  const applyWindowPlacement = useCallback(() => {
    const splat = splatEntityRef.current;
    const pose = headPoseRef.current;
    const tangent = captureTangentRef.current;
    if (!splat || !pose || !tangent) return;
    const placement = computeWindowPlacement({
      captureTangent: tangent,
      anchorDistance: anchorDistanceRef.current,
      sizeScale: pose.sizeScale ?? 1,
      zoom: pose.zoom ?? 1,
    });
    windowHalfHeightRef.current = placement.windowHalfHeight;

    splat.setLocalScale(placement.scale, placement.scale, placement.scale);
    splat.setLocalPosition(
      placement.translation.x + (pose.pan?.x ?? 0),
      placement.translation.y + (pose.pan?.y ?? 0),
      // Away from the eye, so the nearest content leaves the glass and the
      // whole miniature sits deeper behind it.
      //
      // Bounded short of the apex. Turning the miniature rotates it about the
      // centre of the window, so what this offset really sets is the radius of
      // that swing -- and past the apex the offset changes sign, which turns
      // the swing inside out and can bring the scene through the glass toward
      // the viewer. The deeper steps therefore saturate on a wide-angle scene,
      // whose apex is close in.
      placement.translation.z - Math.min(pose.pushBack ?? 0, placement.translation.z * 0.9),
    );
  }, []);

  /**
   * Put the single eye where the viewer's head is, and skew the view volume.
   *
   * The screen is a plane a fixed distance ahead of the scene's capture
   * viewpoint. The eye moves in front of it. Nothing rotates except the roll
   * that keeps the picture upright while the device is tilted, so what the
   * viewer sees changes only through parallax, which is what makes it read as
   * a window rather than as a scene being swung about.
   */
  const applyHeadPoseToEyes = useCallback((pose: HeadPose) => {
    const app = appRef.current;
    const rig = cameraRef.current;
    const eyes = eyesRef.current;
    if (!app || !rig || eyes.length !== 2) return;

    const width = app.graphicsDevice.width || 1;
    const height = app.graphicsDevice.height || 1;
    const aspect = width / height;

    const tangent = captureTangentRef.current;
    // The whole head position is mapped so that a comfortable holding distance
    // is the apex -- all three axes by the same factor. Scaling the depth alone
    // measures sideways movement against an apex nearer than the device really
    // is, which multiplies the parallax and was reported as depth that felt
    // exaggerated and unpleasant.
    const eye = sanitizeEye(tangent && !pose.trueWindow
      ? mapTrackedEye({
        eye: pose.eye,
        nominalZ: pose.screenDistance,
        apex: apexDistance(tangent),
      })
      : pose.eye);
    // The window's size comes from the placement: it is whatever the
    // photograph's own field of view fills, seen from the calibrated eye. The
    // scene is fitted behind it when it loads.
    const halfHeight = windowHalfHeightRef.current;
    const halfWidth = halfHeight * aspect;

    // The rig stays square to the world, so the head position keeps the meaning
    // the tracker gave it. The correction turns the scene about the origin,
    // which is the centre of the window -- the one plane that must stay put.
    rig.setPosition(0, 0, 0);
    rig.setEulerAngles(0, 0, 0);
    const q = pose.levelling;
    // The turntable acts after levelling, about the room's vertical, so the
    // miniature spins upright rather than about whatever axis the device
    // happens to be tilted along.
    const spin = new pc.Quat().setFromEulerAngles(0, pose.spin ?? 0, 0);
    const tip = new pc.Quat().setFromEulerAngles(pose.tip ?? 0, 0, 0);
    const level = q ? new pc.Quat(q.x, q.y, q.z, q.w) : pc.Quat.IDENTITY;
    // Read right to left: level it, turn it on its turntable, then tip the
    // whole turntable toward the viewer.
    sceneRootRef.current?.setLocalRotation(
      new pc.Quat().mul2(tip, new pc.Quat().mul2(spin, level)),
    );

    eyes.forEach((entity, index) => {
      const camera = entity.camera;
      if (!camera) return;
      camera.enabled = index === 0;
      if (!camera.enabled) return;
      camera.rect = new pc.Vec4(0, 0, 1, 1);
      // The window is at the origin, so the eye sits in front of it at eye.z.
      entity.setLocalPosition(eye.x, eye.y, eye.z);
      // Reach far enough to clear the scene from wherever the eye now is.
      camera.farClip = Math.max(1000, eye.z * 4 + 1000);
      const frustum = computeOffAxisFrustum({
        eyeX: eye.x,
        eyeY: eye.y,
        eyeZ: eye.z,
        screenHalfWidth: halfWidth,
        screenHalfHeight: halfHeight,
        near: camera.nearClip,
        far: camera.farClip,
      });
      camera.calculateProjection = (projectionMatrix: pc.Mat4) => {
        projectionMatrix.setFrustum(
          frustum.left, frustum.right, frustum.bottom, frustum.top, frustum.near, frustum.far);
      };
    });

    // Reported from here rather than from the placement, because how much of
    // the photograph is on screen depends on where the eye actually is. Taking
    // it from the zoom alone said "100% of the frame" while the viewer was at
    // half the apex distance and seeing considerably more than the frame.
    const viewTangent = halfHeight / eye.z;
    onPlacementRef.current?.({
      windowHalfHeight: halfHeight,
      visibleFraction: tangent ? Math.min(1, viewTangent / tangent) : 1,
      eyeDistance: eye.z,
    });
  }, []);

  /**
   * Place and shape both eyes from the current stereo settings.
   *
   * In mono only the first eye is enabled, at zero displacement and filling
   * the viewport. In side-by-side both are enabled, each taking half the
   * width, displaced by half the effective baseline and given its own skewed
   * view volume through the engine's `calculateProjection` hook -- which the
   * renderer calls with a matrix to write into, in place of building a
   * symmetric perspective itself.
   */
  const applyStereoToEyes = useCallback(() => {
    const eyes = eyesRef.current;
    const app = appRef.current;
    if (eyes.length !== 2 || !app) return;

    const pose = headPoseRef.current;
    if (pose) {
      applyWindowPlacement();
      applyHeadPoseToEyes(pose);
      return;
    }

    const settings = stereoRef.current;
    const sbs = settings.mode === 'sbs';

    const width = app.graphicsDevice.width || 1;
    const height = app.graphicsDevice.height || 1;
    const eyeWidthPx = sbs ? width / 2 : width;
    const aspect = eyeWidthPx / height;

    // In pivot mode the plane of the screen is put at whatever the camera is
    // orbiting, which is the thing being looked at.
    const zeroParallax = settings.zeroParallaxMode === 'pivot'
      ? orbitRef.current.distance
      : (Number.isFinite(settings.zeroParallaxDistance) && settings.zeroParallaxDistance > 0
        ? settings.zeroParallaxDistance
        : orbitRef.current.distance);

    const baseline = sbs
      ? effectiveBaseline({
        baseline: settings.baseline,
        compression: settings.compression,
        clampPx: settings.clampPx,
        eyeViewportWidthPx: eyeWidthPx,
        zeroParallaxDistance: zeroParallax,
        fovYDeg: fovRef.current,
        aspect,
      })
      : 0;

    eyes.forEach((eye, index) => {
      const camera = eye.camera;
      if (!camera) return;
      const side = index === 0 ? 'left' : 'right';
      camera.enabled = sbs || index === 0;
      if (!camera.enabled) return;

      const view = computeStereoEye(sbs ? side : 'centre', {
        baseline,
        zeroParallaxDistance: zeroParallax,
        fovYDeg: fovRef.current,
        aspect,
        near: camera.nearClip,
        far: camera.farClip,
      });

      eye.setLocalPosition(view.offsetX, 0, 0);
      // Only the half of the frame each eye is drawn into is swapped. Swapping
      // the eye positions instead would flip the sign of every off-axis shift
      // and put the whole scene behind the screen, mirrored; this leaves the
      // geometry alone and just exchanges where the two pictures land.
      const leftHalfFirst = !settings.swapLR;
      camera.rect = sbs
        ? new pc.Vec4((index === 0) === leftHalfFirst ? 0 : 0.5, 0, 0.5, 1)
        : new pc.Vec4(0, 0, 1, 1);
      // The renderer hands this a matrix and expects it filled in.
      camera.calculateProjection = (projectionMatrix: pc.Mat4) => {
        const f = view.frustum;
        projectionMatrix.setFrustum(f.left, f.right, f.bottom, f.top, f.near, f.far);
      };
    });
  }, [applyHeadPoseToEyes, applyWindowPlacement]);

  const applyOrbitToCamera = useCallback(() => {
    const rig = cameraRef.current;
    // A head-coupled view places the rig itself, so orbiting must not move it.
    if (!rig || headPoseRef.current) return;
    const state = orbitRef.current;
    const p = orbitToPosition(state);
    rig.setPosition(p.x, p.y, p.z);
    rig.lookAt(state.target.x, state.target.y, state.target.z);
  }, []);

  const forceRender = useCallback(() => {
    const app = appRef.current;
    if (!app) return;
    applyOrbitToCamera();
    // In pivot mode the plane of the screen sits at whatever is being orbited,
    // so dollying moves it and the view volumes have to be rebuilt.
    if (stereoRef.current.zeroParallaxMode === 'pivot') applyStereoToEyes();
    drawnRef.current = { ...orbitRef.current, target: { ...orbitRef.current.target } };
    app.renderNextFrame = true;
  }, [applyOrbitToCamera, applyStereoToEyes]);

  const requestRender = useCallback(() => {
    if (!appRef.current) return;
    if (!orbitChanged(drawnRef.current, orbitRef.current)) return;
    forceRender();
  }, [forceRender]);

  useEffect(() => {
    let disposed = false;
    const container = containerRef.current;
    if (!container) return;

    const canvas = document.createElement('canvas');
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    container.appendChild(canvas);
    canvasRef.current = canvas;

    const start = async () => {
      try {
        // The options object is handed straight to `canvas.getContext('webgl2', ...)`
        // by the engine, so `preserveDrawingBuffer` takes effect even though it
        // is absent from the published type. Without it the drawing buffer may
        // be cleared before `toDataURL` reads it, and the export comes back
        // blank on some drivers rather than failing.
        const deviceOptions = {
          deviceTypes: ['webgl2'],
          antialias: false,
          preserveDrawingBuffer: true,
        } as Parameters<typeof pc.createGraphicsDevice>[1];
        const device = await pc.createGraphicsDevice(canvas, deviceOptions);
        if (disposed) {
          device.destroy();
          return;
        }

        const app = new pc.AppBase(canvas);
        // AppOptions is a class with defaults for the parts not named here.
        // Listing only the systems this viewer uses keeps the bundle from
        // pulling in physics, audio, and the rest of the engine.
        const appOptions = new pc.AppOptions();
        appOptions.graphicsDevice = device;
        appOptions.componentSystems = [pc.CameraComponentSystem, pc.GSplatComponentSystem];
        appOptions.resourceHandlers = [pc.TextureHandler, pc.GSplatHandler];
        app.init(appOptions);
        app.setCanvasFillMode(pc.FILLMODE_NONE);
        app.setCanvasResolution(pc.RESOLUTION_AUTO);
        // Manual control: nothing is drawn until requestRender decides it would
        // look different.
        app.autoRender = false;
        appRef.current = app;

        // ...with one exception, which is the engine asking. Sorting and
        // streaming both finish after the frame that started them, so a scene
        // that has just been asked for is not the scene that can be drawn yet.
        // The gsplat system runs every frame whether or not one is rendered,
        // and raises this when it has produced something a render would show.
        // Without it the first frame lands before the first ordering does and
        // nothing asks for another: a blank canvas.
        const gsplatSystem = app.systems.gsplat;
        if (gsplatSystem && FRAME_REQUEST) {
          gsplatSystem.on(FRAME_REQUEST, forceRender);
        } else {
          // Every frame instead of only the ones that matter: more work than is
          // needed, and the scene appears, which is the right way round. See
          // FRAME_REQUEST_MISSING_ADVICE for what to do about it.
          console.warn(FRAME_REQUEST_MISSING_ADVICE);
          app.autoRender = true;
        }

        // A rig carrying two eyes. The rig holds the orbit position and
        // orientation; each eye is displaced sideways within it and is never
        // rotated relative to the other, which is what keeps the pair fusable.
        // Mono is the same rig with one eye at zero displacement, so there is
        // one code path rather than two.
        const rig = new pc.Entity('rig');
        app.root.addChild(rig);
        cameraRef.current = rig;

        const eyes: pc.Entity[] = ['eyeLeft', 'eyeRight'].map((name) => {
          const eye = new pc.Entity(name);
          eye.addComponent('camera', {
            clearColor: new pc.Color(0.05, 0.05, 0.06, 1),
            fov: fovRef.current,
            nearClip: 0.05,
            farClip: 5000,
          });
          rig.addChild(eye);
          return eye;
        });
        eyesRef.current = eyes;
        applyStereoToEyes();

        // The roll correction turns the *scene*, not the camera. Turning the
        // camera by the same angle rotates the picture the other way, which is
        // how the correction came to work backwards on hardware. Keeping it off
        // the camera also leaves the tracked head position in the screen's own
        // frame, where the tracker measured it -- rotating the rig instead
        // sheared up to 31 per cent of a sideways movement into a vertical one.
        const sceneRoot = new pc.Entity('sceneRoot');
        app.root.addChild(sceneRoot);
        sceneRootRef.current = sceneRoot;

        const splat = new pc.Entity('splat');
        // SHARP writes the OpenCV convention: x right, y *down*, z *forward*
        // into the scene. A WebGL camera has y up and looks down -z, so without
        // this the scene sits behind the camera and upside down -- verified on
        // hardware, where the viewport was simply black until the camera was
        // turned around, and then inverted. Converting a point is
        // (x, y, z) -> (x, -y, -z), which is a half turn about the x axis.
        splat.setEulerAngles(180, 0, 0);
        sceneRoot.addChild(splat);
        splatEntityRef.current = splat;

        app.start();
        // Lets a development harness reach the live scene. Vite strips this
        // branch from a production build.
        if (import.meta.env.DEV) {
          (canvas as HTMLCanvasElement & { __app?: pc.AppBase }).__app = app;
        }
        forceRender();
        if (!disposed) {
          setReady(true);
          // The old code probed the fork for an offscreen capability. Rendering
          // into a target of any size is always available here, so the answer
          // is unconditionally yes.
          onOffscreenReadyChange?.(true);
        }
      } catch (err) {
        if (!disposed) setError(`Failed to start the renderer: ${(err as Error).message}`);
      }
    };
    start();

    const resize = () => {
      const app = appRef.current;
      if (!app || !container) return;
      const rect = container.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        app.resizeCanvas(rect.width, rect.height);
        applyStereoToEyes();
        forceRender();
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    return () => {
      disposed = true;
      observer.disconnect();
      appRef.current?.destroy();
      appRef.current = null;
      cameraRef.current = null;
      splatEntityRef.current = null;
      sceneRootRef.current = null;
      canvas.remove();
    };
    // Started once for the life of the component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pointer handling. The fork brought its own camera controller; this is the
  // replacement, driving the tested state in camera-orbit.ts.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const pointers = new Map<number, { x: number; y: number }>();
    let panning = false;

    const onDown = (event: PointerEvent) => {
      // Record the touch before asking for capture. setPointerCapture throws
      // for a pointer the browser no longer knows about, and with the call
      // first that exception took the whole gesture with it -- silently, since
      // nothing downstream can tell a dropped finger from one never placed.
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      panning = event.button === 1 || event.button === 2 || event.shiftKey;
      try {
        container.setPointerCapture?.(event.pointerId);
      } catch {
        // Capture is an optimisation: it keeps a finger that slides off the
        // element still reporting here. The gesture works without it.
      }
    };
    const spread = () => {
      const points = [...pointers.values()];
      if (points.length < 2) return 0;
      return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
    };
    // Where the pair of touches sits as a whole. Sliding both fingers together
    // moves this without changing their separation, so sliding the miniature
    // within the frame is independent of zooming even when they overlap.
    const midpoint = () => {
      const points = [...pointers.values()];
      if (points.length < 2) return null;
      return { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
    };

    const onMove = (event: PointerEvent) => {
      const previous = pointers.get(event.pointerId);
      if (!previous) return;
      const dx = event.clientX - previous.x;
      const dy = event.clientY - previous.y;
      const before = spread();
      const beforeMid = midpoint();
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const rect = container.getBoundingClientRect();

      // A window cannot be orbited: the viewpoint is where the viewer's head
      // is. What one finger does instead is turn the thing behind the glass,
      // the way you would turn an object you were holding -- sideways for its
      // upright axis, up and down for its tip. One gesture, two axes, so a
      // diagonal does both at once without being a third thing to learn.
      //
      // This replaced turning two fingers against each other. A hand cannot
      // twist far, which needed a gain of three to reach half a turn, and it
      // shared the pair with the pinch, so turning and zooming interfered.
      // Both axes are scaled by the same span -- a drag of the frame's height
      // is a quarter turn before the gain -- so a diagonal is even-handed.
      if (headPoseRef.current) {
        if (pointers.size >= 2) {
          const after = spread();
          const afterMid = midpoint();
          const gesture: { pinch?: number; panX?: number; panY?: number } = {};
          if (before > 0 && after > 0) gesture.pinch = after / before;
          if (beforeMid && afterMid && rect.height > 0) {
            // Two fingers together slide the miniature within the frame, which
            // is where one finger used to do it.
            const px = (afterMid.x - beforeMid.x) / rect.height;
            const py = (afterMid.y - beforeMid.y) / rect.height;
            if (px !== 0) gesture.panX = px * 2 * windowHalfHeightRef.current;
            if (py !== 0) gesture.panY = -py * 2 * windowHalfHeightRef.current;
          }
          if (gesture.pinch !== undefined || gesture.panX !== undefined
            || gesture.panY !== undefined) {
            onGestureRef.current?.(gesture);
          }
        } else if (rect.height > 0) {
          const gesture: { twistDeg?: number; tipDeg?: number } = {};
          if (dx !== 0) gesture.twistDeg = (dx / rect.height) * 90;
          // Dragging down tips the top toward you, which is the way round it
          // goes when you tilt something you are holding.
          if (dy !== 0) gesture.tipDeg = (dy / rect.height) * 90;
          if (gesture.twistDeg !== undefined || gesture.tipDeg !== undefined) {
            onGestureRef.current?.(gesture);
          }
        }
        return;
      }

      orbitRef.current = panning
        ? applyPan(orbitRef.current, dx, dy, { width: rect.width, height: rect.height }, fovRef.current)
        : applyOrbitDrag(orbitRef.current, dx, dy);
      requestRender();
    };
    const onUp = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      if (pointers.size === 0) panning = false;
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (headPoseRef.current) {
        onGestureRef.current?.({ pinch: Math.exp(-event.deltaY * 0.0015) });
        return;
      }
      orbitRef.current = applyDolly(orbitRef.current, event.deltaY);
      requestRender();
    };
    const onContextMenu = (event: Event) => event.preventDefault();

    container.addEventListener('pointerdown', onDown);
    container.addEventListener('pointermove', onMove);
    container.addEventListener('pointerup', onUp);
    container.addEventListener('pointercancel', onUp);
    container.addEventListener('wheel', onWheel, { passive: false });
    container.addEventListener('contextmenu', onContextMenu);
    return () => {
      container.removeEventListener('pointerdown', onDown);
      container.removeEventListener('pointermove', onMove);
      container.removeEventListener('pointerup', onUp);
      container.removeEventListener('pointercancel', onUp);
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('contextmenu', onContextMenu);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Loading a scene. The same asset type reads a plain .ply, a .sog bundle, and
  // a SOGS meta.json, so the compressed form needs only a different URL.
  useEffect(() => {
    const app = appRef.current;
    const splat = splatEntityRef.current;
    if (!app || !splat || !ready || !plyUrl) return;
    let cancelled = false;

    const previous = assetRef.current;
    // `filename` is what the engine reads the extension off; `url` is only
    // where the bytes come from. Passing the URL alone leaves a blob: address
    // as the name, and the load fails with "No parser found for resource".
    const filename = resolveFilename(plyUrl);
    const asset = new pc.Asset(filename, 'gsplat', { url: plyUrl, filename });
    // The engine reports this from inside its own reader for both the plain
    // PLY and the compressed bundle, so it costs nothing to pass on. Every
    // handler checks `cancelled` first: a scene that has been replaced keeps
    // downloading until the browser drops it, and its eventual load, error or
    // last progress tick must not speak for the one now on screen.
    onSceneProgressRef.current?.(0);
    const onProgress = (received: number, total: number) => {
      if (cancelled) return;
      onSceneProgressRef.current?.(total > 0 ? Math.min(1, received / total) : 0);
    };
    const onLoad = () => {
      if (cancelled) return;
      onSceneProgressRef.current?.(null);
      // A scene that failed leaves its complaint on screen, and the next one
      // succeeding is the answer to it.
      setError(null);
      if (splat.gsplat) splat.removeComponent('gsplat');
      splat.addComponent('gsplat', { asset });

      // Nothing to subscribe to here: the cue to draw comes from the gsplat
      // system rather than from this asset, and was wired up once when the app
      // was created. The frame drawn just below will be the empty one -- the
      // ordering has not been computed yet -- and the frame that shows the
      // scene arrives when the engine asks for it.
      frameSceneToContent();
      forceRender();
      if (previous) {
        app.assets.remove(previous);
        previous.unload();
      }
      assetRef.current = asset;
    };
    const onLoadError = (err: string) => {
      if (cancelled) return;
      onSceneProgressRef.current?.(null);
      // The asset stays in the registry otherwise, holding whatever it read.
      app.assets.remove(asset);
      asset.unload();
      setError(`Failed to load ${resolveFilename(plyUrl)}: ${err}`);
    };
    asset.on('progress', onProgress);
    asset.once('load', onLoad);
    asset.once('error', onLoadError);
    app.assets.add(asset);
    app.assets.load(asset);

    return () => {
      cancelled = true;
      asset.off('progress', onProgress);
      asset.off('load', onLoad);
      asset.off('error', onLoadError);
      // Only if it never became the scene on screen: the one that did is owned
      // by assetRef and released when its replacement loads.
      //
      // This takes it out of the registry so nothing reaches it again. It does
      // not stop the download: PlayCanvas's `unload` returns immediately for an
      // asset that has not finished, and the engine offers no way to abandon a
      // request in flight. A scene replaced while it was still arriving
      // therefore goes on arriving, to nowhere.
      if (assetRef.current !== asset) {
        app.assets.remove(asset);
        asset.unload();
      }
      onSceneProgressRef.current?.(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plyUrl, ready]);

  /**
   * Open on the viewpoint the photograph was taken from.
   *
   * Framing the whole bounding box is the obvious thing and is wrong here. A
   * measured scene had a bounding radius of 103 units because a handful of
   * gaussians sit 169 metres away in the sky, while half of them are within
   * 2.7 metres; framing that put the camera 222 units back, where the subject
   * was a speck and the reconstruction showed as the cone of splats it is.
   *
   * A single-view reconstruction has one viewpoint that reproduces the source
   * photograph exactly, which is the one it was made from. After the
   * convention flip that is the world origin looking along -z. The distance to
   * the orbit target is set from the median gaussian distance so that turning
   * the view rotates about the subject rather than about the horizon.
   */
  function frameSceneToContent() {
    const splat = splatEntityRef.current;
    // The gaussian positions, xyz per splat, in the scene's own coordinates.
    // The engine keeps a CPU copy because the sorter needs one; before unified
    // rendering it was reachable only through that sorter, and is now a named
    // property of the resource. `hasCenters` is checked first because reading
    // `centers` on a resource that has none can allocate one.
    const resource = splat?.gsplat?.resource;
    const centers = resource?.hasCenters ? resource.centers : undefined;
    const distance = splatDistanceQuantile(centers, 0.5) ?? DEFAULT_SUBJECT_DISTANCE;
    anchorDistanceRef.current = nearSplatDistance(centers) ?? distance;

    captureTangentRef.current = estimateCaptureTangent(centers);
    onSceneAspectRef.current?.(estimateCaptureAspect(centers));
    subjectDistanceRef.current = distance;

    if (headPoseRef.current && splat) {
      applyWindowPlacement();
      drawnRef.current = null;
      return;
    }

    orbitRef.current = createOrbitState({
      distance,
      // Straight ahead of the capture viewpoint, which is the origin.
      target: { x: 0, y: 0, z: -distance },
    });
    drawnRef.current = null;
  }

  useEffect(() => {
    fovRef.current = fovDeg;
    for (const eye of eyesRef.current) {
      if (eye.camera) eye.camera.fov = fovDeg;
    }
    if (eyesRef.current.length > 0) {
      applyStereoToEyes();
      forceRender();
      onFovChange?.(fovDeg);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fovDeg]);

  // Held for Milestone 2, which gives these numbers their meaning by building
  // an off-axis projection from them. Storing them now keeps the interface
  // stable while the geometry is still the engine's symmetric default.
  useEffect(() => {
    headPoseRef.current = headPose;
    applyStereoToEyes();
    forceRender();
  }, [headPose, applyStereoToEyes, forceRender]);

  useEffect(() => {
    stereoRef.current = {
      mode, baseline, compression, clampPx, zeroParallaxMode, zeroParallaxDistance, swapLR,
    };
    applyStereoToEyes();
    forceRender();
  }, [mode, baseline, compression, clampPx, zeroParallaxMode, zeroParallaxDistance, swapLR,
    applyStereoToEyes, forceRender]);

  useImperativeHandle(
    ref,
    () => ({
      capture: (format: 'image/png' | 'image/jpeg' = 'image/png') => {
        const canvas = canvasRef.current;
        if (!canvas) return null;
        try {
          forceRender();
          appRef.current?.render();
          return canvas.toDataURL(format);
        } catch (err) {
          setError(`Failed to capture image: ${(err as Error).message}`);
          return null;
        }
      },
      captureAsync: async (
        format: 'image/png' | 'image/jpeg' = 'image/png',
        options?: { width: number; height: number },
      ) => {
        const app = appRef.current;
        const canvas = canvasRef.current;
        if (!app || !canvas) return null;
        const width = options?.width ?? canvas.width;
        const height = options?.height ?? canvas.height;
        const originalWidth = canvas.width;
        const originalHeight = canvas.height;
        try {
          // Draw at the requested size rather than scaling the on-screen
          // result, so an export is not limited by the size of the window.
          app.resizeCanvas(width, height);
          forceRender();
          app.render();
          return canvas.toDataURL(format);
        } catch (err) {
          setError(`Failed to capture image: ${(err as Error).message}`);
          return null;
        } finally {
          app.resizeCanvas(originalWidth, originalHeight);
          forceRender();
        }
      },
      enterFullscreen: () => {
        containerRef.current?.requestFullscreen?.().catch(() => {
          /* refused by the browser; the viewer keeps working windowed */
        });
      },
      // Reporting the distance rather than acting on it: the editor holds the
      // zero-parallax settings, and writing them into stereoRef here made a
      // change that the next prop update silently reverted, with the dropdown
      // showing something different from what was being rendered.
      pivotDistance: () => orbitRef.current.distance,
    }),
    [forceRender],
  );

  return (
    <div className="viewer-root" style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%', touchAction: 'none' }} />
      {error && <div className="viewer-error">{error}</div>}
    </div>
  );
});
