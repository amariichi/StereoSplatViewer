import { describe, expect, it } from 'vitest';

import {
  MAX_DEPTH_SCALE,
  MIN_DEPTH_SCALE,
  computeWindowPlacement,
  estimateCaptureAspect,
  estimateCaptureTangent,
  findFarFieldCut,
  MAX_ZOOM,
  MIN_ZOOM,
  MIN_EYE_FRACTION,
  lifeSizeDistanceMm,
  apexDistance,
  lifeSizeViewingDistance,
  mapTrackedEye,
} from '../window-placement';

describe('estimating the capture field of view from the gaussians themselves', () => {
  it('recovers the angle a synthetic frame was made with', () => {
    const tangent = 0.4;
    const values: number[] = [];
    for (let i = 0; i < 4000; i++) {
      const depth = 2 + (i % 40) / 10;
      const y = ((i % 81) / 80 * 2 - 1) * tangent * depth;
      values.push((i % 17) / 16, y, -depth);
    }
    const estimate = estimateCaptureTangent(new Float32Array(values), { stride: 1 });
    expect(estimate).toBeGreaterThan(tangent * 0.9);
    expect(estimate).toBeLessThanOrEqual(tangent * 1.02);
  });

  it('is not dragged out by a few strays', () => {
    const values: number[] = [];
    for (let i = 0; i < 2000; i++) values.push(0, 0.2 * 3, -3);
    for (let i = 0; i < 5; i++) values.push(0, 6 * 3, -3);
    expect(estimateCaptureTangent(new Float32Array(values), { stride: 1 })).toBeCloseTo(0.2, 6);
  });

  it('reports nothing rather than guessing when there is nothing to read', () => {
    expect(estimateCaptureTangent(undefined)).toBe(null);
    expect(estimateCaptureTangent(new Float32Array([]))).toBe(null);
    expect(estimateCaptureTangent(new Float32Array([0, 0, 0]), { stride: 1 })).toBe(null);
  });
});

const options = { captureTangent: 0.4, anchorDistance: 1.97 };
const apex = 1 / options.captureTangent;
const comfortable = 350 / 67;   // holding the device at arm's length, in window units

/** Where a scene point lands on the window, seen from an eye that may have moved. */
function directionFromEye(
  placement: { scale: number; translation: { z: number } },
  eyeDistance: number,
  point: { x: number; depth: number },
  eyeOffsetX = 0,
) {
  const x = placement.scale * point.x - eyeOffsetX;
  const z = placement.translation.z - placement.scale * point.depth - eyeDistance;
  return x / -z;
}

describe('placing the scene behind the window', () => {
  it('puts the capture camera where the photograph was taken from', () => {
    expect(computeWindowPlacement(options).translation.z).toBeCloseTo(apex, 12);
    expect(apexDistance(options.captureTangent)).toBeCloseTo(apex, 12);
  });

  it('makes the window exactly the physical screen', () => {
    // apex * captureTangent is (1/t) * t. The construction closes on itself,
    // and anything else silently rescales how far the view moves when the head
    // does -- which an earlier version did, by a factor of 2.1.
    expect(computeWindowPlacement(options).windowHalfHeight).toBe(1);
  });

  it('reproduces the photograph at every depth, which is what the far field needs', () => {
    const p = computeWindowPlacement(options);
    for (const depth of [2.66, 10, 40, 100, 169.14]) {
      expect(directionFromEye(p, apex, { x: 0.3 * depth, depth })).toBeCloseTo(0.3, 9);
    }
  });

  it('reproduces it at every size too, so size is free to mean something else', () => {
    for (const sizeScale of [0.3, 1, 3]) {
      const p = computeWindowPlacement({ ...options, sizeScale });
      expect(directionFromEye(p, apex, { x: 3, depth: 10 })).toBeCloseTo(0.3, 9);
    }
  });

  it('puts the anchored depth in the plane of the window at size one', () => {
    expect(computeWindowPlacement(options).anchorDepth).toBeCloseTo(0, 12);
  });

  it('leaves everything behind the glass when the near edge is anchored', () => {
    // Anchoring the median instead put the front of the scene 26 to 31 per cent
    // of the way from the window to the eye, where parallax is fiercest, and
    // the near relief came out violently exaggerated on a device.
    const p = computeWindowPlacement(options);
    for (const depth of [1.97, 2.66, 10, 169]) {
      const z = p.translation.z - p.scale * depth;
      expect(z).toBeLessThanOrEqual(1e-9);
    }
  });

  it('refuses nonsense rather than producing a scene at the origin', () => {
    expect(() => computeWindowPlacement({ ...options, anchorDistance: 0 })).toThrow();
    expect(() => computeWindowPlacement({ ...options, captureTangent: 0 })).toThrow();
    expect(() => apexDistance(0)).toThrow();
  });
});

describe('mapping the head so a comfortable distance is the apex', () => {
  const map = (x: number, y: number, z: number) =>
    mapTrackedEye({ eye: { x, y, z }, nominalZ: comfortable, apex });

  it('lands the comfortable holding distance exactly on the apex', () => {
    // Without it the viewer sits permanently off-apex, which is what made the
    // background enormous when this was first attempted.
    expect(map(0, 0, comfortable).z).toBeCloseTo(apex, 12);
  });

  it('keeps the picture exact there, which is the reason for the mapping', () => {
    const p = computeWindowPlacement(options);
    const eye = map(0, 0, comfortable);
    for (const depth of [1.97, 40, 169.14]) {
      expect(directionFromEye(p, eye.z, { x: 0.3 * depth, depth })).toBeCloseTo(0.3, 9);
    }
  });

  it('scales all three axes by the same factor', () => {
    // This is the whole correction. Scaling the depth alone measured sideways
    // movement against an apex two and a half times nearer than the device is
    // really held, so every head movement produced two and a half times the
    // parallax it should -- reported from hardware as depth that felt
    // exaggerated and unpleasant on every image tried.
    const factor = apex / comfortable;
    const mapped = map(0.4, -0.3, comfortable);
    expect(mapped.x).toBeCloseTo(0.4 * factor, 12);
    expect(mapped.y).toBeCloseTo(-0.3 * factor, 12);
    expect(mapped.z).toBeCloseTo(comfortable * factor, 12);
  });

  it('gives the same picture as viewing from the comfortable distance', () => {
    // The version that felt natural on hardware put the apex at the distance
    // the device is held and made the window proportionally larger. This one
    // puts the apex at the photograph's own viewpoint and keeps the window at
    // the screen. They are the same construction written two ways, and the
    // equality is what guarantees the parallax is neither damped nor
    // exaggerated -- scaling the depth alone broke it and multiplied the
    // parallax by two and a half.
    const anchor = options.anchorDistance;
    const t = options.captureTangent;

    // Where a point lands within the frame, as a fraction of half the frame.
    const framePosition = (
      sceneScale: number, apexZ: number, windowHalf: number,
      eyeX: number, point: { x: number; depth: number },
    ) => {
      const dx = sceneScale * point.x - eyeX;
      const dz = apexZ - sceneScale * point.depth - apexZ;   // relative to the eye
      return (dx / -dz) * apexZ / windowHalf;
    };

    for (const eyeXReal of [0, 0.15, 0.4, -0.3]) {
      for (const point of [{ x: 0.5, depth: 2 }, { x: -2, depth: 20 }, { x: 8, depth: 120 }]) {
        // As it was: apex at the holding distance, window scaled to suit.
        const asItWas = framePosition(
          comfortable / anchor, comfortable, comfortable * t, eyeXReal, point,
        );
        // As it is: apex at the photograph's viewpoint, window the screen, and
        // the whole head position mapped by the same factor.
        const p = computeWindowPlacement(options);
        const eye = mapTrackedEye({
          eye: { x: eyeXReal, y: 0, z: comfortable }, nominalZ: comfortable, apex,
        });
        const asItIs = framePosition(p.scale, apex, p.windowHalfHeight, eye.x, point);
        expect(asItIs).toBeCloseTo(asItWas, 9);
      }
    }
  });

  it('preserves how much the distance changed, in proportion', () => {
    // Within the range it is allowed to move: below the floor the ratio is
    // deliberately no longer preserved.
    for (const k of [0.8, 1.3, 2]) {
      expect(map(0, 0, comfortable * k).z / apex).toBeCloseTo(k, 9);
    }
  });

  it('stops the eye short of the glass, where the nearest things run away', () => {
    // Coming closer magnifies whatever is nearest much faster than the rest,
    // which on a face reads as the forehead stretching away from the mouth. A
    // window really does that, but the tracker also reports the head as closer
    // when the device is merely rotated -- measured at 285 mm for a device held
    // at 400 -- so the effect arrives without anyone having moved.
    expect(MIN_EYE_FRACTION).toBeGreaterThan(0.5);
    for (const k of [0.5, 0.3, 0.05]) {
      expect(map(0, 0, comfortable * k).z).toBeCloseTo(apex * MIN_EYE_FRACTION, 9);
    }
    // And it is still a floor, not a freeze: real movement above it counts.
    expect(map(0, 0, comfortable * 0.9).z).toBeLessThan(apex);
    expect(map(0, 0, comfortable * 0.9).z).toBeGreaterThan(apex * MIN_EYE_FRACTION);
  });

  it('cannot reach the plane of the window, where there is no frustum at all', () => {
    expect(map(0, 0, comfortable / 100).z).toBeGreaterThan(0);
    expect(map(0, 0, comfortable * 1000).z).toBeCloseTo(apex * 6, 9);
  });

  it('falls back to the apex rather than throwing on a tracker that reports nonsense', () => {
    expect(map(0, 0, Number.NaN).z).toBe(apex);
    expect(map(0, 0, -1).z).toBe(apex);
    expect(map(Number.NaN, 0, comfortable).x).toBe(0);
    expect(() => mapTrackedEye({ eye: { x: 0, y: 0, z: 5 }, nominalZ: 5, apex: 0 })).toThrow();
    expect(() => mapTrackedEye({ eye: { x: 0, y: 0, z: 5 }, nominalZ: 0, apex: 2 })).toThrow();
  });
});

describe('reading the photograph\'s shape back off the gaussians', () => {
  // A frame w wide and h tall, unprojected: the extreme gaussians sit on its
  // edge, so the ratio of the two tangents is the ratio of its sides.
  const frame = (halfW: number, halfH: number, depth = 2) => {
    const out: number[] = [];
    for (let i = 0; i <= 40; i++) {
      const f = i / 40;
      out.push((-halfW + 2 * halfW * f) * depth, halfH * depth, -depth);
      out.push((-halfW + 2 * halfW * f) * depth, -halfH * depth, -depth);
      out.push(halfW * depth, (-halfH + 2 * halfH * f) * depth, -depth);
      out.push(-halfW * depth, (-halfH + 2 * halfH * f) * depth, -depth);
    }
    return new Float32Array(out);
  };

  it('measures the two axes separately', () => {
    const centers = frame(0.6, 0.4);
    expect(estimateCaptureTangent(centers, { stride: 1, percentile: 1 })).toBeCloseTo(0.4, 6);
    expect(estimateCaptureTangent(centers, { stride: 1, percentile: 1, axis: 'x' }))
      .toBeCloseTo(0.6, 6);
  });

  it('reports a landscape frame as wider than tall and a portrait as the reverse', () => {
    expect(estimateCaptureAspect(frame(0.6, 0.4), { stride: 1, percentile: 1 }))
      .toBeCloseTo(1.5, 6);
    expect(estimateCaptureAspect(frame(0.3, 0.4), { stride: 1, percentile: 1 }))
      .toBeCloseTo(0.75, 6);
  });

  it('says nothing rather than guessing when there is nothing to measure', () => {
    expect(estimateCaptureAspect(undefined)).toBe(null);
    expect(estimateCaptureAspect(new Float32Array([]))).toBe(null);
  });

  it('is what decides how much of the width a screen shows', () => {
    // An upright phone against an ordinary landscape photograph: without
    // opening zoomed out, two thirds of the width is off the sides.
    const phone = 1206 / 2622;
    const aspect = estimateCaptureAspect(frame(0.667, 0.5), { stride: 1, percentile: 1 })!;
    expect(Math.min(1, phone / aspect)).toBeCloseTo(0.345, 3);
  });
});

describe('trading framing against apparent size, which a small screen forces', () => {
  const screenHalfHeightMm = 67;

  it('shows the whole photograph at zoom one', () => {
    const p = computeWindowPlacement(options);
    expect(p.visibleFraction).toBe(1);
    expect(p.windowHalfHeight).toBe(1);
  });

  it('crops in as it zooms, and says how much is left', () => {
    const p = computeWindowPlacement({ ...options, zoom: 2 });
    expect(p.visibleFraction).toBeCloseTo(0.5, 12);
    expect(p.windowHalfHeight).toBeCloseTo(0.5, 12);
  });

  it('never moves the apex or the scene, so zooming stays exact', () => {
    for (const zoom of [1, 1.5, 3]) {
      expect(computeWindowPlacement({ ...options, zoom }).translation.z).toBeCloseTo(apex, 12);
      expect(computeWindowPlacement({ ...options, zoom }).scale)
        .toBeCloseTo(computeWindowPlacement(options).scale, 12);
    }
  });

  it('brings the life-size distance out towards arm’s length as it crops', () => {
    const at = (zoom: number) =>
      lifeSizeDistanceMm(computeWindowPlacement({ ...options, zoom }).windowHalfHeight,
        apex, screenHalfHeightMm);
    expect(at(2)).toBeGreaterThan(at(1));
    expect(at(1)).toBeCloseTo(screenHalfHeightMm * apex, 6);
  });

  it('clamps the zoom rather than letting it invert or run away', () => {
    // Below one the window grows past the frame, which is how a photograph
    // wider than the screen is ever seen whole -- so more than 1 here is the
    // point rather than a fault. It still stops, at MIN_ZOOM.
    expect(computeWindowPlacement({ ...options, zoom: 0.1 }).visibleFraction)
      .toBeCloseTo(1 / MIN_ZOOM, 12);
    expect(computeWindowPlacement({ ...options, zoom: 0.6 }).visibleFraction)
      .toBeCloseTo(1 / 0.6, 12);
    // Nonsense still falls back to showing exactly the frame.
    expect(computeWindowPlacement({ ...options, zoom: -2 }).visibleFraction).toBe(1);
    expect(computeWindowPlacement({ ...options, zoom: Number.NaN }).visibleFraction).toBe(1);
    expect(computeWindowPlacement({ ...options, zoom: 1e6 }).visibleFraction)
      .toBeCloseTo(1 / MAX_ZOOM, 12);
  });

  it('leaves the apex and the scene alone when zooming out, as when zooming in', () => {
    // The same guarantee the zoom-in test makes: only the window changes, so
    // the geometry stays exact on both sides of one.
    for (const zoom of [0.3, 0.6, 1, 2]) {
      expect(computeWindowPlacement({ ...options, zoom }).translation.z).toBeCloseTo(apex, 12);
      expect(computeWindowPlacement({ ...options, zoom }).scale)
        .toBeCloseTo(computeWindowPlacement({ ...options, zoom: 1 }).scale, 12);
    }
  });

  it('makes a larger miniature flatter, and a smaller one deeper', () => {
    const shift = (sizeScale: number) => {
      const p = computeWindowPlacement({ ...options, sizeScale });
      return Math.abs(directionFromEye(p, apex, { x: 3, depth: 10 }, 0.5)
        - directionFromEye(p, apex, { x: 3, depth: 10 }, 0));
    };
    expect(shift(0.3)).toBeGreaterThan(shift(1));
    expect(shift(1)).toBeGreaterThan(shift(3));
  });

  it('clamps the size control too', () => {
    const base = apex / options.anchorDistance;
    expect(computeWindowPlacement({ ...options, sizeScale: 1e6 }).scale)
      .toBeCloseTo(base * MAX_DEPTH_SCALE, 12);
    expect(computeWindowPlacement({ ...options, sizeScale: 1e-9 }).scale)
      .toBeCloseTo(base * MIN_DEPTH_SCALE, 12);
  });

  it('reports where the picture would look life-sized, without placing anything there', () => {
    expect(lifeSizeViewingDistance(0.4)).toBeCloseTo(2.5, 12);
    expect(() => lifeSizeDistanceMm(0, 5, 67)).toThrow();
  });
});

describe('finding the empty band in a scene’s depth, for a future trim', () => {
  // Nothing consumes this yet: the camera's far clip has no effect on splats,
  // so a trim has to remove the gaussians, which belongs in the backend.
  const bimodal = () => {
    const v: number[] = [];
    for (let i = 0; i < 3000; i++) v.push(0, 0, -(2 + (i % 100) / 100));
    for (let i = 0; i < 1200; i++) v.push(0, 0, -(4 + (i % 100) / 20));
    for (let i = 0; i < 1500; i++) v.push(0, 0, -(40 + (i % 100)));
    return new Float32Array(v);
  };

  it('finds the empty band between the subject and the background', () => {
    const cut = findFarFieldCut(bimodal(), { stride: 1 })!;
    expect(cut).toBeGreaterThan(9);
    expect(cut).toBeLessThan(40);
  });

  it('declines to cut a scene that is evenly filled', () => {
    const even: number[] = [];
    for (let i = 0; i < 6000; i++) even.push(0, 0, -(2 + (i % 1000) / 20));
    expect(findFarFieldCut(new Float32Array(even), { stride: 1 })).toBe(null);
  });

  it('reports nothing rather than guessing when there is too little to read', () => {
    expect(findFarFieldCut(undefined)).toBe(null);
    expect(findFarFieldCut(new Float32Array([0, 0, -3]), { stride: 1 })).toBe(null);
  });
});
