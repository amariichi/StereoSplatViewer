export type SceneParams = {
  mode: "mono" | "sbs";
  fovDeg: number;
  framingLock: boolean;
  pivot: {
    point?: { x: number; y: number; z: number };
    screen?: { u: number; v: number };
  };
  stereo: {
    zeroParallax: {
      mode: "pivot" | "click";
      value?: number;
      point?: { x: number; y: number; z: number };
    };
    baseline: number;
    compression: number;
    clampPx: number;
    comfortLock: boolean;
    comfortStrength: number;
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
