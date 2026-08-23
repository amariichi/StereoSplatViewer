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
import { apexDistance, computeWindowPlacement, estimateCaptureTangent, mapTrackedEye } from './window-placement';
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
};

/** The part of the engine's splat sorter this viewer needs, which its published types do not name. */
/**
 * What to tell someone when the splat sorter cannot be reached.
 *
 * Drawing happens on demand here, and the cue to draw is the sorter announcing
 * that it has finished putting the gaussians in back-to-front order. Without
 * that cue nothing would ever ask for a frame after the first, so the fallback
 * is to draw every frame: wasteful, and visible, which beats correct and blank.
 */
const SORTER_MISSING_ADVICE = [
  'PlayCanvas: could not reach the splat sorter, so this is drawing every frame',
  'instead of only when the ordering changes. It still works and costs more',
  'battery. This happens on PlayCanvas 2.21.4 and later, where unified',
  'rendering is the default and GSplatComponent#instance returns null. Moving',
  'to that API means changing how render scheduling works in SplatViewer.tsx.',
].join(' ');

type SorterEvents = {
  on(name: 'updated', handler: () => void): void;
  off(name: 'updated', handler: () => void): void;
};

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

function resolveFilename(url: string): string {
  try {
    return decodeURIComponent(new URL(url, window.location.href).pathname.split('/').pop() || 'scene.ply');
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
  const captureTangentRef = useRef<number | null>(null);
  const subjectDistanceRef = useRef(DEFAULT_SUBJECT_DISTANCE);
  const anchorDistanceRef = useRef(DEFAULT_SUBJECT_DISTANCE);
  const splatEntityRef = useRef<pc.Entity | null>(null);
  const assetRef = useRef<pc.Asset | null>(null);
  const sorterRef = useRef<SorterEvents | null>(null);
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
      placement.translation.z,
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
    const eye = sanitizeEye(tangent
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
    // The angle of the line between two touches. Turning that line turns the
    // miniature; the distance between them scales it. Both come from the same
    // pair of fingers without either getting in the other's way.
    const twistAngle = () => {
      const points = [...pointers.values()];
      if (points.length < 2) return null;
      return Math.atan2(points[1].y - points[0].y, points[1].x - points[0].x);
    };
    // Where the pair of touches sits as a whole. Sliding both fingers together
    // moves this without changing either their separation or their angle, so
    // tipping is independent of zooming and turning even when they overlap.
    const midpointY = () => {
      const points = [...pointers.values()];
      if (points.length < 2) return null;
      return (points[0].y + points[1].y) / 2;
    };

    const onMove = (event: PointerEvent) => {
      const previous = pointers.get(event.pointerId);
      if (!previous) return;
      const dx = event.clientX - previous.x;
      const dy = event.clientY - previous.y;
      const before = spread();
      const beforeAngle = twistAngle();
      const beforeMidY = midpointY();
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const rect = container.getBoundingClientRect();

      // A window cannot be orbited: the viewpoint is where the viewer's head
      // is. One finger slides the miniature within the frame, and a pinch
      // changes how much relief it has -- which is what scale means once the
      // capture camera sits on the eye.
      if (headPoseRef.current) {
        if (pointers.size >= 2) {
          const after = spread();
          const afterAngle = twistAngle();
          const afterMidY = midpointY();
          const gesture: { pinch?: number; twistDeg?: number; tipDeg?: number } = {};
          if (before > 0 && after > 0) gesture.pinch = after / before;
          if (beforeAngle !== null && afterAngle !== null) {
            // Unwrap across the half turn, or a hand crossing that boundary
            // would send the miniature spinning the long way round.
            let delta = afterAngle - beforeAngle;
            while (delta > Math.PI) delta -= 2 * Math.PI;
            while (delta < -Math.PI) delta += 2 * Math.PI;
            if (delta !== 0) gesture.twistDeg = (delta * 180) / Math.PI;
          }
          if (beforeMidY !== null && afterMidY !== null && rect.height > 0) {
            // Dragging the pair down tips the top toward you, which is the way
            // round it goes when you tilt something you are holding. A drag of
            // the full height is a quarter turn before the gain.
            const travel = (afterMidY - beforeMidY) / rect.height;
            if (travel !== 0) gesture.tipDeg = travel * 90;
          }
          if (
            gesture.pinch !== undefined
            || gesture.twistDeg !== undefined
            || gesture.tipDeg !== undefined
          ) {
            onGestureRef.current?.(gesture);
          }
        } else if (rect.height > 0) {
          onGestureRef.current?.({
            panX: (dx / rect.height) * 2 * windowHalfHeightRef.current,
            panY: (-dy / rect.height) * 2 * windowHalfHeightRef.current,
          });
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
    const asset = new pc.Asset(resolveFilename(plyUrl), 'gsplat', { url: plyUrl });
    asset.once('load', () => {
      if (cancelled) return;
      if (splat.gsplat) splat.removeComponent('gsplat');
      splat.addComponent('gsplat', { asset });

      // Splats have to be drawn back to front, and that ordering is produced in
      // a worker, so it lands a frame or more after the request. Drawing on
      // demand and stopping there showed nothing at all: the one frame drawn
      // after loading ran before the first ordering arrived, and nothing asked
      // for another. Every completed ordering is a reason to draw, both for the
      // first one and for each one that follows the camera moving.
      //
      // The sorter is not in the published types, hence the cast. That makes
      // this the one place a PlayCanvas upgrade can break without any check
      // noticing: on 2.21.4 `instance` returns null, because unified rendering
      // is the default there and the component no longer exposes one. The cast
      // still compiles, the sorter is simply never found, and with drawing on
      // demand nothing ever asks for the frame -- a blank canvas and not one
      // word anywhere. So say so, and keep drawing.
      const sorter = (splat.gsplat?.instance as unknown as { sorter?: SorterEvents })?.sorter;
      if (sorter) {
        sorter.on('updated', forceRender);
        sorterRef.current = sorter;
        app.autoRender = false;
      } else {
        // Every frame instead of only the ones that matter: more work than is
        // needed, and the scene appears, which is the right way round. See
        // SORTER_MISSING_ADVICE for what to do about it.
        console.warn(SORTER_MISSING_ADVICE);
        app.autoRender = true;
      }

      frameSceneToContent();
      forceRender();
      if (previous) {
        app.assets.remove(previous);
        previous.unload();
      }
      assetRef.current = asset;
    });
    asset.once('error', (err: string) => {
      if (!cancelled) setError(`Failed to load ${resolveFilename(plyUrl)}: ${err}`);
    });
    app.assets.add(asset);
    app.assets.load(asset);

    return () => {
      cancelled = true;
      sorterRef.current?.off('updated', forceRender);
      sorterRef.current = null;
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
    const instance = splat?.gsplat?.instance as { sorter?: { centers?: Float32Array } } | undefined;
    const centers = instance?.sorter?.centers;
    const distance = splatDistanceQuantile(centers, 0.5) ?? DEFAULT_SUBJECT_DISTANCE;
    anchorDistanceRef.current = nearSplatDistance(centers) ?? distance;

    captureTangentRef.current = estimateCaptureTangent(centers);
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
