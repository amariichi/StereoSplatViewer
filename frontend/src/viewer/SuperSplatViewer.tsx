import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { ViewerHandle } from "./PLYViewer";

type Props = {
  plyUrl: string;
  mode: "mono" | "sbs";
  baseline: number;
  fovDeg: number;
  zeroParallaxMode: "pivot" | "click";
  zeroParallaxDistance: number;
  compression: number;
  clampPx: number;
  onFovChange?: (fovDeg: number) => void;
  onOffscreenReadyChange?: (ready: boolean) => void;
};

type EmbeddedViewer = {
  canvas: HTMLCanvasElement;
  scene?: {
    app?: { renderNextFrame?: boolean };
    canvasResize?: { width: number; height: number };
    forceRender?: boolean;
  };
  events: {
    on: (name: string, handler: (value: number) => void) => void;
    off: (name: string, handler: (value: number) => void) => void;
    fire?: (name: string, payload?: unknown) => void;
    invoke?: (name: string, ...args: unknown[]) => unknown;
    functions?: Map<string, unknown>;
  };
  loadPly: (source: { url: string; filename?: string }) => Promise<void>;
  setStereo?: (settings: {
    mode: "mono" | "sbs";
    baseline: number;
    compression: number;
    clampPx: number;
    zeroParallaxMode: "pivot" | "click";
    zeroParallaxDistance: number;
  }) => void;
  setFov?: (fovDeg: number) => void;
  setZeroParallaxFromPivot?: () => void;
  destroy: () => void;
};

export const SuperSplatViewer = forwardRef<ViewerHandle, Props>(function SuperSplatViewer(
  {
    plyUrl,
    mode,
    baseline,
    fovDeg,
    zeroParallaxMode,
    zeroParallaxDistance,
    compression,
    clampPx,
    onFovChange,
    onOffscreenReadyChange,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<EmbeddedViewer | null>(null);
  const plyUrlRef = useRef<string>(plyUrl);
  const fovRef = useRef<number>(fovDeg);
  const onFovChangeRef = useRef<((fovDeg: number) => void) | undefined>(onFovChange);
  const onOffscreenReadyChangeRef = useRef<((ready: boolean) => void) | undefined>(
    onOffscreenReadyChange,
  );
  const fovListenerRef = useRef<((fovDeg: number) => void) | null>(null);
  const stereoRef = useRef({
    mode,
    baseline,
    zeroParallaxMode,
    zeroParallaxDistance,
    compression,
    clampPx,
  });
  const [error, setError] = useState<string | null>(null);

  const captureWithOffscreen = async (
    format: "image/png" | "image/jpeg",
    width: number,
    height: number,
    silent?: boolean,
  ) => {
    try {
      const events = viewerRef.current?.events;
      if (!events?.invoke) {
        if (!silent) {
          setError("Failed to capture image: render.offscreen not available");
        }
        return null;
      }
      const data = (await Promise.resolve(
        events.invoke.call(events, "render.offscreen", width, height),
      )) as
        | Uint8Array
        | undefined;
      if (!data) {
        if (!silent) {
          setError("Failed to capture image: render.offscreen not registered");
        }
        return null;
      }
      let nonZero = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] || data[i + 1] || data[i + 2] || data[i + 3]) {
          nonZero += 1;
          if (nonZero > 16) break;
        }
      }
      if (nonZero === 0) {
        return null;
      }
      const pixels = new Uint8ClampedArray(data.length);
      pixels.set(data);
      const imageData = new ImageData(pixels, width, height);
      const temp = document.createElement("canvas");
      temp.width = width;
      temp.height = height;
      const ctx = temp.getContext("2d");
      if (!ctx) return null;
      ctx.putImageData(imageData, 0, 0);
      return temp.toDataURL(format);
    } catch (err) {
      setError(`Failed to capture image: ${(err as Error).message}`);
      return null;
    }
  };

  const resolveFilename = (url: string) => {
    const base = url.split("?")[0].split("#")[0];
    const last = base.split("/").pop() ?? "";
    if (last.endsWith(".ply") || last.endsWith(".splat") || last.endsWith(".lcc")) {
      return undefined;
    }
    if (url.startsWith("blob:")) {
      return `local-${Date.now()}.ply`;
    }
    return `scene-${Date.now()}.ply`;
  };

  useEffect(() => {
    plyUrlRef.current = plyUrl;
  }, [plyUrl]);

  useEffect(() => {
    onFovChangeRef.current = onFovChange;
  }, [onFovChange]);

  useEffect(() => {
    onOffscreenReadyChangeRef.current = onOffscreenReadyChange;
  }, [onOffscreenReadyChange]);

  useEffect(() => {
    fovRef.current = fovDeg;
    if (viewerRef.current) {
      if (viewerRef.current.setFov) {
        viewerRef.current.setFov(fovDeg);
      } else {
        viewerRef.current.events.fire?.("camera.setFov", fovDeg);
      }
    }
  }, [fovDeg]);

  useEffect(() => {
    stereoRef.current = {
      mode,
      baseline,
      zeroParallaxMode,
      zeroParallaxDistance,
      compression,
      clampPx,
    };
    if (viewerRef.current) {
      viewerRef.current.setStereo?.(stereoRef.current);
    }
  }, [mode, baseline, zeroParallaxMode, zeroParallaxDistance, compression, clampPx]);

  useEffect(() => {
    let disposed = false;
    const mount = async () => {
      if (!containerRef.current) return;
      setError(null);
      try {
        const mod = await import("supersplat/src/embed");
        if (disposed) return;
        viewerRef.current = await mod.createEmbeddedViewer({
          container: containerRef.current,
        });
        const offscreenReady = Boolean(viewerRef.current.events.functions?.has("render.offscreen"));
        onOffscreenReadyChangeRef.current?.(offscreenReady);
        viewerRef.current.setStereo?.(stereoRef.current);
        if (viewerRef.current.setFov) {
          viewerRef.current.setFov(fovRef.current);
        } else {
          viewerRef.current.events.fire?.("camera.setFov", fovRef.current);
        }
        const handleFov = (next: number) => {
          onFovChangeRef.current?.(next);
        };
        viewerRef.current.events.on("camera.fov", handleFov);
        fovListenerRef.current = handleFov;
        if (plyUrlRef.current) {
          await viewerRef.current.loadPly({
            url: plyUrlRef.current,
            filename: resolveFilename(plyUrlRef.current),
          });
        }
      } catch (err) {
        setError(`Failed to init SuperSplat: ${(err as Error).message}`);
      }
    };
    mount();
    return () => {
      disposed = true;
      if (viewerRef.current && fovListenerRef.current) {
        viewerRef.current.events.off("camera.fov", fovListenerRef.current);
      }
      viewerRef.current?.destroy();
      viewerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const load = async () => {
      if (!viewerRef.current) return;
      try {
        if (plyUrl) {
          await viewerRef.current.loadPly({
            url: plyUrl,
            filename: resolveFilename(plyUrl),
          });
        }
      } catch (err) {
        setError(`Failed to load PLY: ${(err as Error).message}`);
      }
    };
    load();
  }, [plyUrl]);

  useImperativeHandle(
    ref,
    () => ({
      capture: (format: "image/png" | "image/jpeg" = "image/png") => {
        const canvas = viewerRef.current?.canvas;
        if (!canvas) return null;
        try {
          return canvas.toDataURL(format);
        } catch (err) {
          setError(`Failed to capture image: ${(err as Error).message}`);
          return null;
        }
      },
      captureAsync: async (
        format: "image/png" | "image/jpeg" = "image/png",
        options?: { width: number; height: number },
      ) => {
        const canvas = viewerRef.current?.canvas;
        if (!canvas) return null;
        const width = options?.width ?? canvas.width;
        const height = options?.height ?? canvas.height;
        viewerRef.current?.setStereo?.(stereoRef.current);
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
        const offscreen = await captureWithOffscreen(format, width, height, true);
        if (offscreen) return offscreen;
        const scene = viewerRef.current?.scene;
        const container = containerRef.current;
        const originalWidth = canvas.width;
        const originalHeight = canvas.height;
        const originalContainerWidth = container?.style.width ?? "";
        const originalContainerHeight = container?.style.height ?? "";
        if (scene?.app && width && height) {
          if (container) {
            container.style.width = `${width}px`;
            container.style.height = `${height}px`;
          }
          scene.canvasResize = { width, height };
          scene.forceRender = true;
          scene.app.renderNextFrame = true;
        }
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
        let fallback: string | null = null;
        try {
          fallback = canvas.toDataURL(format);
        } catch (err) {
          setError(`Failed to capture image: ${(err as Error).message}`);
        }
        if (scene?.app && (canvas.width !== originalWidth || canvas.height !== originalHeight)) {
          scene.canvasResize = { width: originalWidth, height: originalHeight };
          scene.forceRender = true;
          scene.app.renderNextFrame = true;
        }
        if (container) {
          container.style.width = originalContainerWidth;
          container.style.height = originalContainerHeight;
        }
        return fallback;
      },
      enterFullscreen: () => {
        containerRef.current?.requestFullscreen?.();
      },
      setZeroParallaxFromPivot: () => {
        viewerRef.current?.setZeroParallaxFromPivot?.();
      },
    }),
    [],
  );

  return (
    <div className="viewer">
      <div ref={containerRef} className="viewer-canvas" />
      {error && <div className="viewer-error">{error}</div>}
    </div>
  );
});
