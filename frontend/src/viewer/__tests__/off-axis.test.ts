import { describe, expect, it } from 'vitest';

import {
  computeOffAxisFrustum,
  effectiveBaseline,
  computeStereoEye,
  projectThroughEye,
  projectThroughToeInEye,
  screenHalfExtents,
  type StereoOptions,
} from '../off-axis';

const options: StereoOptions = {
  baseline: 0.12,
  zeroParallaxDistance: 2.5,
  fovYDeg: 50,
  aspect: 16 / 9,
  near: 0.05,
  far: 500,
};

describe('the off-axis frustum', () => {
  it('is symmetric when the eye is centred', () => {
    const f = computeOffAxisFrustum({
      eyeX: 0, eyeY: 0, eyeZ: 2.5, screenHalfWidth: 1.5, screenHalfHeight: 1, near: 0.05, far: 20,
    });
    expect(f.left).toBeCloseTo(-f.right, 12);
    expect(f.bottom).toBeCloseTo(-f.top, 12);
  });

  it('slides sideways with the eye instead of rotating', () => {
    const centred = computeOffAxisFrustum({
      eyeX: 0, eyeY: 0, eyeZ: 2.5, screenHalfWidth: 1.5, screenHalfHeight: 1, near: 0.05, far: 20,
    });
    const shifted = computeOffAxisFrustum({
      eyeX: 0.4, eyeY: 0, eyeZ: 2.5, screenHalfWidth: 1.5, screenHalfHeight: 1, near: 0.05, far: 20,
    });
    expect(shifted.left).toBeLessThan(centred.left);
    expect(shifted.right).toBeLessThan(centred.right);
    // The width is unchanged: the volume moved, it did not narrow.
    expect(shifted.right - shifted.left).toBeCloseTo(centred.right - centred.left, 12);
  });

  it('refuses a degenerate or impossible eye', () => {
    const base = { eyeX: 0, eyeY: 0, screenHalfWidth: 1.5, screenHalfHeight: 1, near: 0.05, far: 20 };
    expect(() => computeOffAxisFrustum({ ...base, eyeZ: 0 })).toThrow();
    expect(() => computeOffAxisFrustum({ ...base, eyeZ: -1 })).toThrow();
    expect(() => computeOffAxisFrustum({ ...base, eyeZ: Number.NaN })).toThrow();
    expect(() => computeOffAxisFrustum({ ...base, eyeZ: 2.5, far: 0.01 })).toThrow();
  });
});

describe('the stereo pair', () => {
  const left = computeStereoEye('left', options);
  const right = computeStereoEye('right', options);

  it('separates the eyes by the baseline, and no more', () => {
    expect(right.offsetX - left.offsetX).toBeCloseTo(options.baseline, 12);
    expect(computeStereoEye('centre', options).offsetX).toBe(0);
  });

  it('gives both eyes exactly the same vertical extent', () => {
    // This is the whole construction in one assertion. Vertical extent that
    // does not depend on the sideways offset is what makes the pair fusable.
    expect(left.frustum.top).toBe(right.frustum.top);
    expect(left.frustum.bottom).toBe(right.frustum.bottom);
  });

  it('shifts the horizontal extent in opposite directions', () => {
    expect(left.frustum.left).toBeGreaterThan(right.frustum.left);
    expect(left.frustum.right).toBeGreaterThan(right.frustum.right);
  });
});

describe('vertical disparity, which is what toe-in gets wrong', () => {
  // A point out towards a corner, well off the convergence plane: the place
  // where the two constructions disagree most.
  const corner = { x: 1.6, y: 1.1, z: -6 };

  it('is exactly zero for off-axis, everywhere', () => {
    for (const point of [
      corner,
      { x: -2.2, y: 1.4, z: -1.2 },
      { x: 3.0, y: -2.0, z: -40 },
      { x: 0, y: 0, z: -2.5 },
    ]) {
      const l = projectThroughEye(computeStereoEye('left', options), point)!;
      const r = projectThroughEye(computeStereoEye('right', options), point)!;
      expect(r.y - l.y).toBe(0);
    }
  });

  it('is not zero for toe-in, and grows towards the corner', () => {
    const at = (p: { x: number; y: number; z: number }) => {
      const l = projectThroughToeInEye('left', options, p)!;
      const r = projectThroughToeInEye('right', options, p)!;
      return Math.abs(r.y - l.y);
    };
    const nearCentre = at({ x: 0.05, y: 0.05, z: -6 });
    const atCorner = at(corner);
    expect(atCorner).toBeGreaterThan(0);
    expect(atCorner).toBeGreaterThan(nearCentre * 10);
  });

  it('leaves the zero-parallax plane free of horizontal disparity too', () => {
    // A point at the convergence distance must land in the same place in both
    // eyes, which is what "zero parallax" means.
    const onScreen = { x: 0.4, y: 0.3, z: -options.zeroParallaxDistance };
    const l = projectThroughEye(computeStereoEye('left', options), onScreen)!;
    const r = projectThroughEye(computeStereoEye('right', options), onScreen)!;
    expect(r.x - l.x).toBeCloseTo(0, 12);
    expect(r.y - l.y).toBe(0);
  });

  it('puts nearer things in front of the screen and farther things behind it', () => {
    const disparity = (z: number) => {
      const p = { x: 0, y: 0, z };
      const l = projectThroughEye(computeStereoEye('left', options), p)!;
      const r = projectThroughEye(computeStereoEye('right', options), p)!;
      return r.x - l.x;
    };
    // Beyond the screen the right eye sees the point further right: positive.
    expect(disparity(-10)).toBeGreaterThan(0);
    expect(disparity(-options.zeroParallaxDistance)).toBeCloseTo(0, 12);
    // In front of the screen the sign reverses, which is what "pop-out" is.
    expect(disparity(-1)).toBeLessThan(0);
  });

  it('grows the separation with the baseline, in proportion', () => {
    const at = (baseline: number) => {
      const o = { ...options, baseline };
      const p = { x: 0, y: 0, z: -10 };
      const l = projectThroughEye(computeStereoEye('left', o), p)!;
      const r = projectThroughEye(computeStereoEye('right', o), p)!;
      return r.x - l.x;
    };
    expect(at(0.24) / at(0.12)).toBeCloseTo(2, 6);
    expect(at(0)).toBe(0);
  });
});

describe('the zero-parallax plane', () => {
  it('grows with distance and with field of view', () => {
    const near = screenHalfExtents(2, 50, 1.5);
    const far = screenHalfExtents(4, 50, 1.5);
    expect(far.halfHeight / near.halfHeight).toBeCloseTo(2, 12);
    expect(screenHalfExtents(2, 90, 1.5).halfHeight)
      .toBeGreaterThan(screenHalfExtents(2, 50, 1.5).halfHeight);
  });

  it('is wider than it is tall in proportion to the viewport', () => {
    const e = screenHalfExtents(2.5, 50, 16 / 9);
    expect(e.halfWidth / e.halfHeight).toBeCloseTo(16 / 9, 12);
  });

  it('rejects nonsense rather than producing a silent zero', () => {
    expect(() => screenHalfExtents(0, 50, 1.5)).toThrow();
    expect(() => screenHalfExtents(2, 0, 1.5)).toThrow();
    expect(() => screenHalfExtents(2, 180, 1.5)).toThrow();
    expect(() => screenHalfExtents(2, 50, 0)).toThrow();
  });
});

describe('what the compression and clamp controls now mean', () => {
  const base = {
    baseline: 0.12,
    eyeViewportWidthPx: 960,
    zeroParallaxDistance: 2.5,
    fovYDeg: 50,
    aspect: 16 / 9,
  };

  it('compression scales the separation, which flattens without distorting', () => {
    expect(effectiveBaseline({ ...base, compression: 0.5 })).toBeCloseTo(0.06, 12);
    expect(effectiveBaseline({ ...base, compression: 1 })).toBeCloseTo(0.12, 12);
    expect(effectiveBaseline({ ...base, compression: 0 })).toBe(0);
  });

  it('a clamp caps how far apart the background may appear', () => {
    // Without a clamp the far field separates by baseline/halfWidth.
    const { halfWidth } = screenHalfExtents(base.zeroParallaxDistance, base.fovYDeg, base.aspect);
    const uncappedPx = (0.12 / halfWidth / 2) * base.eyeViewportWidthPx;
    expect(uncappedPx).toBeGreaterThan(10);

    const capped = effectiveBaseline({ ...base, clampPx: 10 });
    const cappedPx = (capped / halfWidth / 2) * base.eyeViewportWidthPx;
    expect(cappedPx).toBeCloseTo(10, 6);
  });

  it('a clamp that is not binding leaves the baseline alone', () => {
    expect(effectiveBaseline({ ...base, clampPx: 10000 })).toBeCloseTo(0.12, 12);
    expect(effectiveBaseline({ ...base, clampPx: 0 })).toBeCloseTo(0.12, 12);
  });

  it('the clamp and the compression both apply, the tighter one winning', () => {
    expect(effectiveBaseline({ ...base, compression: 0.1, clampPx: 10 }))
      .toBeCloseTo(0.012, 12);
  });
});
