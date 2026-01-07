import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  AmbientLight,
  MOUSE,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";

type Props = {
  plyUrl: string;
  mode: "mono" | "sbs";
  baseline: number;
  zeroParallaxMode: "pivot" | "click";
  compression: number;
  clampPx: number;
  framingLock: boolean;
  comfortLock: boolean;
  comfortStrength: number;
};

export type ViewerHandle = {
  capture: (format?: "image/png" | "image/jpeg") => string | null;
  captureAsync?: (
    format?: "image/png" | "image/jpeg",
    options?: { width: number; height: number },
  ) => Promise<string | null>;
  enterFullscreen: () => void;
  setZeroParallaxFromPivot: () => void;
};

export const PLYViewer = forwardRef<ViewerHandle, Props>(function PLYViewer(
  {
    plyUrl,
    mode,
    baseline,
    zeroParallaxMode,
    compression,
    clampPx,
    framingLock,
    comfortLock,
    comfortStrength,
  },
  ref,
) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const modeRef = useRef<Props["mode"]>(mode);
  const baselineRef = useRef<number>(baseline);
  const zeroParallaxModeRef = useRef<Props["zeroParallaxMode"]>(zeroParallaxMode);
  const compressionRef = useRef<number>(compression);
  const clampPxRef = useRef<number>(clampPx);
  const framingLockRef = useRef<boolean>(framingLock);
  const comfortLockRef = useRef<boolean>(comfortLock);
  const comfortStrengthRef = useRef<number>(comfortStrength);
  const rendererRef = useRef<WebGLRenderer | null>(null);
  const cameraRef = useRef<PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const baseDistanceRef = useRef<number | null>(null);
  const zeroParallaxPointRef = useRef<Vector3 | null>(null);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    baselineRef.current = baseline;
  }, [baseline]);


  useEffect(() => {
    zeroParallaxModeRef.current = zeroParallaxMode;
  }, [zeroParallaxMode]);


  useEffect(() => {
    compressionRef.current = compression;
  }, [compression]);

  useEffect(() => {
    clampPxRef.current = clampPx;
  }, [clampPx]);

  useEffect(() => {
    framingLockRef.current = framingLock;
  }, [framingLock]);

  useEffect(() => {
    comfortLockRef.current = comfortLock;
    if (comfortLock) {
      const camera = cameraRef.current;
      const controls = controlsRef.current;
      if (camera && controls) {
        baseDistanceRef.current = camera.position.distanceTo(controls.target);
      }
    }
  }, [comfortLock]);

  useEffect(() => {
    comfortStrengthRef.current = comfortStrength;
  }, [comfortStrength]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    setError(null);
    zeroParallaxPointRef.current = null;
    baseDistanceRef.current = null;

    const scene = new Scene();
    const renderer = new WebGLRenderer({ antialias: true });
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    rendererRef.current = renderer;
    mount.appendChild(renderer.domElement);

    const camera = new PerspectiveCamera(60, mount.clientWidth / mount.clientHeight, 0.01, 1000);
    camera.position.set(0, 0, 2);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controlsRef.current = controls;
    controls.mouseButtons = {
      LEFT: MOUSE.ROTATE,
      MIDDLE: MOUSE.DOLLY,
      RIGHT: MOUSE.ROTATE,
    };
    controls.enableDamping = true;

    scene.add(new AmbientLight(0xffffff, 1));

    const loader = new PLYLoader();
    let points: Points | null = null;
    const raycaster = new Raycaster();
    const pointer = new Vector2();
    const leftCamera = camera.clone();
    const rightCamera = camera.clone();
    let lastPointer: { x: number; y: number } | null = null;
    let framingBase = {
      distance: 0,
      fov: 0,
    };
    loader.load(
      plyUrl,
      (geometry) => {
        geometry.computeVertexNormals();
        const material = new PointsMaterial({ color: 0x66ccff, size: 0.01 });
        points = new Points(geometry, material);
        // ml-sharp PLY appears to be Y-up and X mirrored relative to Three.js.
        points.scale.y = -1;
        points.scale.x = -1;

        geometry.computeBoundingBox();
        const bbox = geometry.boundingBox;
        if (bbox) {
          const center = new Vector3();
          bbox.getCenter(center);
          points.position.sub(center);
          const size = bbox.getSize(new Vector3()).length();
          const radius = size * 0.5;
          const dist = radius / Math.sin((camera.fov * Math.PI) / 360);
          camera.position.set(0, 0, dist * 1.2 || 2);
          controls.update();
          baseDistanceRef.current = camera.position.distanceTo(controls.target);
        }

        scene.add(points);
      },
      undefined,
      (err) => {
        setError(`Failed to load PLY: ${err?.message ?? err}`);
      },
    );

    const resolveZeroParallaxPoint = (cam: PerspectiveCamera, fallbackTarget: Vector3) => {
      const modeValue = zeroParallaxModeRef.current;
      if (modeValue === "pivot") {
        return fallbackTarget.clone();
      }
      if (modeValue === "click" && zeroParallaxPointRef.current) {
        return zeroParallaxPointRef.current.clone();
      }
      return fallbackTarget.clone();
    };

    let frameId: number;
    const renderLoop = () => {
      controls.update();
      const currentMode = modeRef.current;
      const baseBaseline = baselineRef.current || 0;
      const width = mount.clientWidth;
      const height = mount.clientHeight;
      const comfortActive = comfortLockRef.current;
      const compressionValue = compressionRef.current || 1;
      const clampValue = clampPxRef.current || 0;
      const comfortStrengthValue = comfortStrengthRef.current || 0;
      const currentDistance = camera.position.distanceTo(controls.target);

      let baselineValue = baseBaseline * compressionValue;
      if (comfortActive && baseDistanceRef.current) {
        const ratio = currentDistance / baseDistanceRef.current;
        const scale = 1 + (ratio - 1) * comfortStrengthValue;
        baselineValue *= scale;
      }
      if (baselineValue < 0) {
        baselineValue = 0;
      }

      if (currentMode === "sbs") {
        renderer.setScissorTest(true);
        const halfWidth = Math.floor(width / 2);

        const rightVec = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
        let offsetBaseline = baselineValue;

        if (clampValue > 0) {
          const f = (halfWidth / 2) / Math.tan((camera.fov * Math.PI) / 360);
          const zPoint = resolveZeroParallaxPoint(camera, controls.target);
          const zDistance = camera.position.distanceTo(zPoint);
          if (zDistance > 0 && Number.isFinite(f)) {
            const maxBaseline = (clampValue * zDistance) / f;
            offsetBaseline = Math.min(offsetBaseline, maxBaseline);
          }
        }

        const offset = rightVec.multiplyScalar(offsetBaseline * 0.5);

        leftCamera.copy(camera);
        rightCamera.copy(camera);

        leftCamera.position.copy(camera.position).sub(offset);
        rightCamera.position.copy(camera.position).add(offset);
        const zeroParallaxPoint = resolveZeroParallaxPoint(camera, controls.target);
        leftCamera.lookAt(zeroParallaxPoint);
        rightCamera.lookAt(zeroParallaxPoint);

        leftCamera.aspect = halfWidth / height;
        rightCamera.aspect = halfWidth / height;
        leftCamera.updateProjectionMatrix();
        rightCamera.updateProjectionMatrix();

        renderer.setViewport(0, 0, halfWidth, height);
        renderer.setScissor(0, 0, halfWidth, height);
        renderer.render(scene, leftCamera);

        renderer.setViewport(halfWidth, 0, width - halfWidth, height);
        renderer.setScissor(halfWidth, 0, width - halfWidth, height);
        renderer.render(scene, rightCamera);

        renderer.setScissorTest(false);
      } else {
        renderer.setViewport(0, 0, width, height);
        renderer.render(scene, camera);
      }

      frameId = requestAnimationFrame(renderLoop);
    };
    renderLoop();

    let adjustingFov = false;
    let lastY = 0;
    const minFov = 20;
    const maxFov = 90;

    const setPivotFromEvent = (event: MouseEvent) => {
      if (!points) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObject(points, true);
      if (hits.length > 0) {
        controls.target.copy(hits[0].point);
        camera.lookAt(controls.target);
        zeroParallaxPointRef.current = hits[0].point.clone();
      }
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      if (event.shiftKey) {
        controls.mouseButtons.LEFT = MOUSE.PAN;
      } else {
        controls.mouseButtons.LEFT = MOUSE.ROTATE;
      }
      if (event.ctrlKey) {
        adjustingFov = true;
        controls.enabled = false;
        lastY = event.clientY;
        framingBase = {
          distance: camera.position.distanceTo(controls.target),
          fov: camera.fov,
        };
        renderer.domElement.setPointerCapture(event.pointerId);
      }
    };

    const handlePointerMove = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      lastPointer = {
        x: (event.clientX - rect.left) / rect.width,
        y: (event.clientY - rect.top) / rect.height,
      };
      if (!adjustingFov) return;
      const dy = event.clientY - lastY;
      lastY = event.clientY;
      const nextFov = Math.min(maxFov, Math.max(minFov, camera.fov + dy * 0.1));
      camera.fov = nextFov;
      if (framingLockRef.current && framingBase.distance > 0 && framingBase.fov > 0) {
        const framingScale =
          framingBase.distance * Math.tan((framingBase.fov * Math.PI) / 360);
        const nextDistance = framingScale / Math.tan((nextFov * Math.PI) / 360);
        const direction = camera.position.clone().sub(controls.target).normalize();
        camera.position.copy(controls.target).add(direction.multiplyScalar(nextDistance));
      }
      camera.updateProjectionMatrix();
    };

    const handlePointerUp = (event: PointerEvent) => {
      controls.mouseButtons.LEFT = MOUSE.ROTATE;
      if (adjustingFov) {
        adjustingFov = false;
        controls.enabled = true;
        renderer.domElement.releasePointerCapture(event.pointerId);
      }
    };

    const handleWheel = () => {
      if (!points || !lastPointer) return;
      pointer.x = lastPointer.x * 2 - 1;
      pointer.y = -(lastPointer.y * 2 - 1);
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObject(points, true);
      if (hits.length > 0) {
        controls.target.copy(hits[0].point);
        camera.lookAt(controls.target);
      }
    };

    const handleDblClick = (event: MouseEvent) => {
      setPivotFromEvent(event);
    };

    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
    };

    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("pointermove", handlePointerMove);
    renderer.domElement.addEventListener("pointerup", handlePointerUp);
    renderer.domElement.addEventListener("wheel", handleWheel, { passive: true });
    renderer.domElement.addEventListener("dblclick", handleDblClick);
    renderer.domElement.addEventListener("contextmenu", handleContextMenu);

    const handleResize = () => {
      if (!mount) return;
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };
    window.addEventListener("resize", handleResize);
    document.addEventListener("fullscreenchange", handleResize);

    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener("resize", handleResize);
      document.removeEventListener("fullscreenchange", handleResize);
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("pointermove", handlePointerMove);
      renderer.domElement.removeEventListener("pointerup", handlePointerUp);
      renderer.domElement.removeEventListener("wheel", handleWheel);
      renderer.domElement.removeEventListener("dblclick", handleDblClick);
      renderer.domElement.removeEventListener("contextmenu", handleContextMenu);
      controls.dispose();
      cameraRef.current = null;
      controlsRef.current = null;
      renderer.dispose();
      if (points) {
        points.geometry.dispose();
      }
      mount.removeChild(renderer.domElement);
      rendererRef.current = null;
    };
  }, [plyUrl]);

  useImperativeHandle(
    ref,
    () => ({
      capture: (format: "image/png" | "image/jpeg" = "image/png") => {
        if (!rendererRef.current) return null;
        try {
          return rendererRef.current.domElement.toDataURL(format);
        } catch (err) {
          setError(`Failed to capture image: ${(err as Error).message}`);
          return null;
        }
      },
      enterFullscreen: () => {
        rootRef.current?.requestFullscreen?.();
      },
      setZeroParallaxFromPivot: () => {
        const controls = controlsRef.current;
        if (!controls) return;
        zeroParallaxPointRef.current = controls.target.clone();
      },
    }),
    [],
  );

  return (
    <div className="viewer" ref={rootRef}>
      <div ref={mountRef} className="viewer-canvas" />
      {error && <div className="viewer-error">{error}</div>}
    </div>
  );
});
