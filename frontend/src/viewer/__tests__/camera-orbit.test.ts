import { describe, expect, it } from 'vitest';

import {
  MAX_PITCH,
  MAX_DISTANCE,
  MIN_DISTANCE,
  applyDolly,
  applyOrbitDrag,
  applyPan,
  cameraForward,
  cameraRight,
  cameraUp,
  MAX_ORBIT_MAGNIFICATION,
  createOrbitState,
  orbitChanged,
  orbitPivotDistance,
  orbitToPosition,
} from '../camera-orbit';

const length = (v: { x: number; y: number; z: number }) => Math.hypot(v.x, v.y, v.z);
const dot = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
  a.x * b.x + a.y * b.y + a.z * b.z;

describe('the camera frame', () => {
  it('is orthonormal at every orientation', () => {
    // A frame that drifts from orthonormal shears the picture, and the error is
    // easy to introduce and hard to see until something is measured against it.
    for (const yaw of [0, 0.7, 2.1, -1.3, Math.PI]) {
      for (const pitch of [0, 0.5, -0.9, 1.2]) {
        const state = createOrbitState({ yaw, pitch });
        const f = cameraForward(state);
        const r = cameraRight(state);
        const u = cameraUp(state);
        expect(length(f)).toBeCloseTo(1, 10);
        expect(length(r)).toBeCloseTo(1, 10);
        expect(length(u)).toBeCloseTo(1, 10);
        expect(dot(f, r)).toBeCloseTo(0, 10);
        expect(dot(f, u)).toBeCloseTo(0, 10);
        expect(dot(r, u)).toBeCloseTo(0, 10);
      }
    }
  });

  it('looks down the negative z axis when untouched, which is what the engine expects', () => {
    const f = cameraForward(createOrbitState());
    expect(f.x).toBeCloseTo(0, 10);
    expect(f.y).toBeCloseTo(0, 10);
    expect(f.z).toBeCloseTo(-1, 10);
  });

  it('never rolls, so the horizon stays level', () => {
    for (const pitch of [0, 0.8, -1.4]) {
      expect(cameraRight(createOrbitState({ yaw: 1.1, pitch })).y).toBeCloseTo(0, 10);
    }
  });
});

describe('orbiting', () => {
  it('keeps the camera at the set distance from the target', () => {
    const state = createOrbitState({ yaw: 0.9, pitch: -0.4, distance: 7, target: { x: 2, y: 1, z: -3 } });
    const p = orbitToPosition(state);
    expect(Math.hypot(p.x - 2, p.y - 1, p.z + 3)).toBeCloseTo(7, 10);
  });

  it('stops just short of the pole rather than flipping through it', () => {
    // Looking exactly along the up axis leaves roll undefined and the view
    // flips as it crosses, which reads as the scene jumping.
    const state = applyOrbitDrag(createOrbitState(), 0, -100000);
    expect(state.pitch).toBe(MAX_PITCH);
    expect(state.pitch).toBeLessThan(Math.PI / 2);
    expect(applyOrbitDrag(createOrbitState(), 0, 100000).pitch).toBe(-MAX_PITCH);
  });

  it('yaw is free to wrap, because there is no pole to hit sideways', () => {
    const spun = applyOrbitDrag(createOrbitState(), 100000, 0);
    expect(Number.isFinite(spun.yaw)).toBe(true);
    expect(Math.abs(spun.yaw)).toBeGreaterThan(Math.PI * 2);
  });

  it('ignores a non-finite drag rather than destroying the state', () => {
    const state = createOrbitState({ yaw: 0.5 });
    expect(applyOrbitDrag(state, Number.NaN, 10)).toBe(state);
  });
});

describe('dollying', () => {
  it('changes distance by a proportion, so it feels the same close up and far away', () => {
    const near = applyDolly(createOrbitState({ distance: 1 }), 100);
    const far = applyDolly(createOrbitState({ distance: 100 }), 100);
    expect(near.distance / 1).toBeCloseTo(far.distance / 100, 10);
  });

  it('cannot pass through the target or escape to infinity', () => {
    expect(applyDolly(createOrbitState({ distance: 1 }), -1e6).distance).toBe(MIN_DISTANCE);
    expect(applyDolly(createOrbitState({ distance: 1 }), 1e6).distance).toBe(MAX_DISTANCE);
    expect(applyDolly(createOrbitState(), -1e6).distance).toBeGreaterThan(0);
  });
});

describe('panning', () => {
  const viewport = { width: 800, height: 600 };

  it('moves the target across the screen plane, never along the view direction', () => {
    const state = createOrbitState({ yaw: 0.6, pitch: 0.3, distance: 5 });
    const panned = applyPan(state, 40, -25, viewport, 50);
    const moved = {
      x: panned.target.x - state.target.x,
      y: panned.target.y - state.target.y,
      z: panned.target.z - state.target.z,
    };
    // Any component along the view direction would change the subject's size
    // while panning, which reads as the scene lurching.
    expect(dot(moved, cameraForward(state))).toBeCloseTo(0, 10);
  });

  it('scales with distance, so a feature stays under the pointer', () => {
    const near = applyPan(createOrbitState({ distance: 2 }), 100, 0, viewport, 50);
    const far = applyPan(createOrbitState({ distance: 20 }), 100, 0, viewport, 50);
    expect(Math.abs(far.target.x) / Math.abs(near.target.x)).toBeCloseTo(10, 6);
  });

  it('survives a zero-sized viewport during layout', () => {
    const state = createOrbitState();
    expect(applyPan(state, 10, 10, { width: 0, height: 0 }, 50)).toBe(state);
  });
});

describe('deciding whether to redraw', () => {
  it('draws the first frame', () => {
    expect(orbitChanged(null, createOrbitState())).toBe(true);
  });

  it('skips a change too small to move a pixel', () => {
    // Redrawing when the picture cannot differ is the whole cost of a
    // continuous render loop, and on a phone it is the battery.
    const a = createOrbitState();
    expect(orbitChanged(a, { ...a, yaw: a.yaw + 1e-6 })).toBe(false);
  });

  it('notices a real move', () => {
    const a = createOrbitState();
    expect(orbitChanged(a, { ...a, yaw: a.yaw + 0.01 })).toBe(true);
    expect(orbitChanged(a, { ...a, distance: a.distance * 1.05 })).toBe(true);
    expect(orbitChanged(a, { ...a, target: { ...a.target, x: 0.01 } })).toBe(true);
  });

  it('judges distance in proportion, not in absolute units', () => {
    // A millimetre matters at arm's length and does not at a hundred metres.
    const near = createOrbitState({ distance: 0.5 });
    const far = createOrbitState({ distance: 500 });
    expect(orbitChanged(near, { ...near, distance: 0.5 + 0.01 })).toBe(true);
    expect(orbitChanged(far, { ...far, distance: 500 + 0.01 })).toBe(false);
  });
});


describe('choosing what to orbit', () => {
  // Measured from one held scene: 1,179,648 gaussians, nearest 1.20 units,
  // median 57.83. The numbers are kept rather than rounded because they are
  // what the bound exists for.
  const MEASURED_NEAREST = 1.20;
  const MEASURED_MEDIAN = 57.83;

  it('bounds a photograph whose background fills most of the frame', () => {
    const pivot = orbitPivotDistance(MEASURED_MEDIAN, MEASURED_NEAREST);
    expect(pivot).toBeCloseTo(MEASURED_NEAREST * MAX_ORBIT_MAGNIFICATION, 9);
    // Which is the whole point: a drag magnified forty-eight times at the
    // subject is magnified four times instead.
    expect(MEASURED_MEDIAN / MEASURED_NEAREST).toBeGreaterThan(45);
    expect(pivot / MEASURED_NEAREST).toBeCloseTo(MAX_ORBIT_MAGNIFICATION, 9);
  });

  it('leaves a scene alone when the subject fills it', () => {
    // Nearest 1.2, median 3.6: the subject is the scene, and three is already
    // inside the bound.
    expect(orbitPivotDistance(3.6, 1.2)).toBeCloseTo(3.6, 9);
  });

  it('leaves a scene alone when everything in it is distant', () => {
    // A landscape with nothing near: the ratio is what matters, not the
    // distance, and orbiting eighty units away is comfortable when the nearest
    // thing is fifty.
    expect(orbitPivotDistance(80, 50)).toBeCloseTo(80, 9);
  });

  it('never moves the pivot further away than the median', () => {
    for (const [median, nearest] of [[3, 1], [10, 4], [57.83, 1.2], [80, 50]]) {
      expect(orbitPivotDistance(median, nearest)).toBeLessThanOrEqual(median);
    }
  });

  it('keeps the median when there is no usable nearest distance', () => {
    for (const nearest of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(orbitPivotDistance(12, nearest)).toBe(12);
    }
  });
});
