import { describe, expect, it } from 'vitest';

import {
  HEAD_DISTANCE_SCALE_STORAGE_KEY,
  MAX_DISTANCE_SCALE,
  MIN_DISTANCE_SCALE,
  clampDistanceScale,
  distanceScaleFrom,
  loadDistanceScale,
  saveDistanceScale,
} from '../head-distance-calibration';

const fakeStorage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
    has: (k: string) => map.has(k),
  } as unknown as Storage & { has(k: string): boolean };
};

describe('correcting the tracker against a measured distance', () => {
  it('produces the ratio that makes the report match reality', () => {
    // The case measured on hardware: reported 300, actually 150.
    expect(distanceScaleFrom(300, 150)).toBeCloseTo(0.5, 12);
    expect(distanceScaleFrom(150, 300)).toBeCloseTo(2, 12);
    expect(distanceScaleFrom(350, 350)).toBe(1);
  });

  it('corrects every distance, because the error is a scale and not an offset', () => {
    // Both the assumed face size and the assumed focal length enter as ratios,
    // so one number fixes the whole range.
    const scale = distanceScaleFrom(300, 150);
    for (const reported of [200, 300, 600, 1000]) {
      expect(reported * scale).toBeCloseTo(reported / 2, 9);
    }
  });

  it('refuses a correction so large the tracker is broken rather than off', () => {
    expect(distanceScaleFrom(1000, 1)).toBe(MIN_DISTANCE_SCALE);
    expect(distanceScaleFrom(1, 1000)).toBe(MAX_DISTANCE_SCALE);
  });

  it('does nothing at all rather than throwing on a tracker that has not settled', () => {
    // This runs from a button on a phone; a report of zero must not poison the
    // stored calibration.
    expect(distanceScaleFrom(0, 350)).toBe(1);
    expect(distanceScaleFrom(300, 0)).toBe(1);
    expect(distanceScaleFrom(Number.NaN, 350)).toBe(1);
    expect(distanceScaleFrom(300, Number.NaN)).toBe(1);
    expect(clampDistanceScale(null)).toBe(1);
    expect(clampDistanceScale(-2)).toBe(1);
  });
});

describe('remembering the correction', () => {
  it('round-trips through storage', () => {
    const storage = fakeStorage();
    saveDistanceScale(storage, 0.5);
    expect(loadDistanceScale(storage)).toBeCloseTo(0.5, 12);
  });

  it('stores nothing when there is nothing to correct', () => {
    const storage = fakeStorage();
    saveDistanceScale(storage, 2);
    saveDistanceScale(storage, 1);
    expect(storage.has(HEAD_DISTANCE_SCALE_STORAGE_KEY)).toBe(false);
    expect(loadDistanceScale(storage)).toBe(1);
  });

  it('survives storage being unavailable, which private browsing does', () => {
    const hostile = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    } as unknown as Storage;
    expect(loadDistanceScale(hostile)).toBe(1);
    expect(() => saveDistanceScale(hostile, 0.5)).not.toThrow();
    expect(loadDistanceScale(null)).toBe(1);
  });

  it('clamps a stored value that has been tampered with', () => {
    const storage = fakeStorage();
    storage.setItem(HEAD_DISTANCE_SCALE_STORAGE_KEY, '999');
    expect(loadDistanceScale(storage)).toBe(MAX_DISTANCE_SCALE);
    storage.setItem(HEAD_DISTANCE_SCALE_STORAGE_KEY, 'nonsense');
    expect(loadDistanceScale(storage)).toBe(1);
  });
});
