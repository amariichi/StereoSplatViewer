export type SceneParams = {
  mode: "mono" | "sbs";
  fovDeg: number;
  pivot: {
    point?: { x: number; y: number; z: number };
    screen?: { u: number; v: number };
  };
  stereo: {
    zeroParallax: {
      mode: "pivot" | "fixed";
      value?: number;
      point?: { x: number; y: number; z: number };
    };
    baseline: number;
    compression: number;
    clampPx: number;
  };
  camera: {
    orbitEnabled: boolean;
    panEnabled: boolean;
    dollyEnabled: boolean;
  };
  zoom: {
    dollySpeed: number;
    zoomFactor: number;
  };
};

/** What the editor can ask the viewer to do. */
export type ViewerHandle = {
  capture: (format?: "image/png" | "image/jpeg") => string | null;
  captureAsync?: (
    format?: "image/png" | "image/jpeg",
    options?: { width: number; height: number },
  ) => Promise<string | null>;
  enterFullscreen: () => void;
  /** How far the camera currently is from the point it orbits, in metres. */
  pivotDistance: () => number;
};

/** The stereo settings the viewer is driven by. */
export type StereoSettings = {
  mode: "mono" | "sbs";
  baseline: number;
  compression: number;
  clampPx: number;
  zeroParallaxMode: "pivot" | "fixed";
  zeroParallaxDistance: number;
  /** Draw the left eye into the right half, for cross-eyed free viewing. */
  swapLR: boolean;
};
