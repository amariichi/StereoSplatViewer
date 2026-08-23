import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LEVELLING_GAIN,
  MAX_LEVELLING_RAD,
  computeLevelling,
  toQuaternion,
  upInDeviceFrame,
} from '../levelling';
import { computeScreenRoll } from '../device-tilt.js';

const G = 9.81;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** The accelerometer reading for a device rolled within its own plane. */
const rolled = (degrees: number) => ({
  x: -G * Math.sin(rad(degrees)),
  y: G * Math.cos(rad(degrees)),
  z: 0,
});

/** The reading for a device tipped back towards horizontal, no roll. */
const tippedBack = (degrees: number) => ({
  x: 0,
  y: G * Math.cos(rad(degrees)),
  z: G * Math.sin(rad(degrees)),
});

describe('measuring from where the device was, not from vertical', () => {
  it('has nothing to correct at the posture levelling began in', () => {
    // A tablet is read tipped 20 to 60 degrees back, so measuring from vertical
    // had the correction pinned at its cap before anyone had moved, and only
    // the two extremes were reachable.
    for (const posture of [tippedBack(0), tippedBack(30), tippedBack(55), rolled(20)]) {
      const reference = upInDeviceFrame(posture)!;
      expect(computeLevelling(posture, { reference })).toBe(null);
    }
  });

  it('grows from nothing as the device turns away from that posture', () => {
    const reference = upInDeviceFrame(tippedBack(45))!;
    const at = (d: number) => computeLevelling(tippedBack(45 + d), { reference });
    expect(at(0)).toBe(null);
    expect(deg(Math.abs(at(4)!.tip))).toBeCloseTo(2, 6);
    expect(deg(Math.abs(at(20)!.tip))).toBeCloseTo(10, 6);
  });

  it('was pinned at the cap for an ordinary reading posture without one', () => {
    expect(deg(Math.abs(computeLevelling(tippedBack(45))!.tip)))
      .toBeCloseTo(deg(MAX_LEVELLING_RAD), 6);
  });
});

describe('the two turns, which need opposite signs', () => {
  const upright = upInDeviceFrame(tippedBack(0))!;

  it('always turns a roll back towards level, never further over', () => {
    // Established by holding a device: there is no reason to want the scene to
    // lean further than the device does, and anyone who does can turn the
    // correction off and tilt as far as they like.
    for (const d of [10, 25, 40]) {
      const r = computeLevelling(rolled(d), { reference: upright })!;
      // The device rolled by +d in the sense computeScreenRoll reports; the
      // correction carries the same sign, which is what turned it back on the
      // sibling project's hardware.
      expect(Math.sign(r.roll)).toBe(Math.sign(computeScreenRoll(rolled(d))!));
      expect(deg(Math.abs(r.roll))).toBeCloseTo(Math.min(d / 2, 18), 6);
      expect(r.tip).toBeCloseTo(0, 9);
    }
  });

  it('stands the model up when the device is tipped up, which is the other sense', () => {
    const back = computeLevelling(tippedBack(30), { reference: upright })!;
    const forward = computeLevelling(tippedBack(-30), { reference: upright })!;
    expect(back.roll).toBeCloseTo(0, 9);
    expect(Math.sign(back.tip)).toBe(-Math.sign(forward.tip));
    expect(deg(Math.abs(back.tip))).toBeCloseTo(15, 6);
    // The sign was settled on hardware, and separately from the roll's: a
    // single axis-angle could not have expressed the two independently.
    expect(Math.sign(back.tip)).toBe(1);
  });

  it('handles the two together, each keeping its own sign', () => {
    const r = computeLevelling({ x: -G * 0.3, y: G * 0.8, z: G * 0.5 }, { reference: upright })!;
    expect(Math.abs(r.roll)).toBeGreaterThan(0);
    expect(Math.abs(r.tip)).toBeGreaterThan(0);
  });

  it('keeps working as the screen turns to face the ceiling', () => {
    // A roll angle stops meaning anything there; the tip is perfectly defined.
    const r = computeLevelling(tippedBack(85), { reference: upright })!;
    expect(r).not.toBe(null);
    expect(deg(Math.abs(r.tip))).toBeCloseTo(18, 6);
  });

  it('halves each and caps both at eighteen degrees', () => {
    const r = computeLevelling(rolled(60), { reference: upright })!;
    expect(deg(Math.abs(r.roll))).toBeCloseTo(18, 6);
    expect(DEFAULT_LEVELLING_GAIN).toBe(0.5);
  });
});

describe('refusing to act on a reading that means nothing', () => {
  it('says nothing when the reading is hand movement rather than gravity', () => {
    expect(upInDeviceFrame({ x: 0.1, y: 0.2, z: 0.1 })).toBe(null);
    expect(computeLevelling({ x: 0.1, y: 0.2, z: 0.1 })).toBe(null);
    expect(computeLevelling({ x: Number.NaN, y: G, z: 0 })).toBe(null);
    expect(computeLevelling(null)).toBe(null);
  });

  it('reads the accelerometer as pointing away from gravity, not along it', () => {
    expect(upInDeviceFrame({ x: 0, y: G, z: 0 })!.y).toBeCloseTo(1, 9);
  });

  it('turns off entirely when the gain is zero', () => {
    const reference = upInDeviceFrame(tippedBack(0))!;
    expect(computeLevelling(rolled(20), { reference, gain: 0 })).toBe(null);
  });
});

describe('as a quaternion', () => {
  it('is a unit quaternion', () => {
    const reference = upInDeviceFrame(tippedBack(0))!;
    const q = toQuaternion(computeLevelling(rolled(20), { reference })!);
    expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 12);
  });

  it('carries a pure roll onto the view axis and a pure tip onto the sideways one', () => {
    const reference = upInDeviceFrame(tippedBack(0))!;
    const qRoll = toQuaternion(computeLevelling(rolled(20), { reference })!);
    expect(Math.abs(qRoll.z)).toBeGreaterThan(0.05);
    expect(Math.abs(qRoll.x)).toBeCloseTo(0, 9);
    const qTip = toQuaternion(computeLevelling(tippedBack(20), { reference })!);
    expect(Math.abs(qTip.x)).toBeGreaterThan(0.05);
    expect(Math.abs(qTip.z)).toBeCloseTo(0, 9);
  });
});
