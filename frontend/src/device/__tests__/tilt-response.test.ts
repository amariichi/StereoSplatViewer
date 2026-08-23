import { describe, expect, it } from 'vitest';

import {
  FADE_END,
  FADE_START,
  QUADRANT_HYSTERESIS_RAD,
  QUARTER_TURN,
  chooseQuadrant,
  removeQuadrant,
  tiltConfidence,
} from '../tilt-response';

const deg = (d: number) => (d * Math.PI) / 180;

describe('fading the correction out as the screen turns to face upwards', () => {
  it('applies it fully while there is plenty of gravity in the screen', () => {
    expect(tiltConfidence(9.81)).toBe(1);
    expect(tiltConfidence(FADE_START)).toBe(1);
  });

  it('withdraws it entirely once up has no meaning on the screen', () => {
    expect(tiltConfidence(FADE_END)).toBe(0);
    expect(tiltConfidence(0)).toBe(0);
    expect(tiltConfidence(Number.NaN)).toBe(0);
  });

  it('crosses the range without a step, which a threshold could not', () => {
    // The cliff it replaces held the last value and then stopped dead, which
    // was felt as the correction cutting out.
    let previous = tiltConfidence(FADE_START);
    for (let g = FADE_START; g >= FADE_END; g -= 0.05) {
      const now = tiltConfidence(g);
      expect(now).toBeLessThanOrEqual(previous + 1e-9);
      expect(Math.abs(now - previous)).toBeLessThan(0.05);
      previous = now;
    }
    expect(previous).toBeCloseTo(0, 6);
  });

  it('starts and stops smoothly rather than in a corner', () => {
    const slopeAt = (g: number) => (tiltConfidence(g + 1e-4) - tiltConfidence(g - 1e-4)) / 2e-4;
    expect(Math.abs(slopeAt(FADE_START - 1e-3))).toBeLessThan(0.05);
    expect(Math.abs(slopeAt(FADE_END + 1e-3))).toBeLessThan(0.05);
  });
});

describe('choosing which quarter turn the device is held at', () => {
  it('takes the nearest when there is nothing to compare against', () => {
    expect(chooseQuadrant(deg(5), null)).toBe(0);
    expect(chooseQuadrant(deg(80), null)).toBe(1);
  });

  it('does not flip the instant the boundary is crossed', () => {
    // Rounding flips at exactly forty-five degrees, and the correction is half
    // the angle capped at eighteen, so the picture snapped through thirty-six.
    // Reported from a device as the correction suddenly cutting in.
    expect(chooseQuadrant(deg(46), 0)).toBe(0);
    expect(chooseQuadrant(deg(50), 0)).toBe(0);
    expect(chooseQuadrant(deg(44), 1)).toBe(1);
  });

  it('does change once the reading has gone properly past', () => {
    const past = 45 + (QUADRANT_HYSTERESIS_RAD * 180) / Math.PI + 1;
    expect(chooseQuadrant(deg(past), 0)).toBe(1);
    expect(chooseQuadrant(deg(90 - past + 45), 1)).toBe(1);
  });

  it('holds still through the hand tremor of someone resting at the boundary', () => {
    let quadrant: number | null = 0;
    let flips = 0;
    for (let i = 0; i < 200; i++) {
      const jitter = deg(45 + Math.sin(i) * 3);
      const next = chooseQuadrant(jitter, quadrant);
      if (next !== quadrant) flips += 1;
      quadrant = next;
    }
    expect(flips).toBe(0);
  });

  it('keeps a real roll after the quadrant is taken out', () => {
    expect(removeQuadrant(deg(12), 0)).toBeCloseTo(deg(12), 9);
    expect(removeQuadrant(deg(90 + 12), 1)).toBeCloseTo(deg(12), 9);
    expect(removeQuadrant(deg(-90 + 12), -1)).toBeCloseTo(deg(12), 9);
    expect(Math.abs(removeQuadrant(deg(180 - 12), 2))).toBeCloseTo(deg(12), 9);
  });

  it('never returns more than half a quarter turn, whatever it is given', () => {
    for (let d = -360; d <= 360; d += 3) {
      const q = chooseQuadrant(deg(d), null);
      expect(Math.abs(removeQuadrant(deg(d), q))).toBeLessThanOrEqual(QUARTER_TURN / 2 + 1e-9);
    }
  });

  it('falls back rather than throwing on a reading that is not a number', () => {
    expect(chooseQuadrant(Number.NaN, 2)).toBe(2);
    expect(chooseQuadrant(Number.NaN, null)).toBe(0);
  });
});
