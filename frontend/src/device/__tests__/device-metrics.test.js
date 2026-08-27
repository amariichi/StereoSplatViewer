import { expect, test } from 'vitest';

// node:assert/strict, expressed through vitest. The assertions in this file are
// copied unchanged from the project these modules came from, so the harness is
// adapted rather than the tests.
const assert = Object.assign(
  (value, message) => expect(value, message).toBeTruthy(),
  {
    ok: (value, message) => expect(value, message).toBeTruthy(),
    equal: (actual, expected, message) => expect(actual, message).toBe(expected),
    notEqual: (actual, expected, message) => expect(actual, message).not.toBe(expected),
    deepEqual: (actual, expected, message) => expect(actual, message).toEqual(expected),
    throws: (fn, _expected, message) => expect(fn, message).toThrow(),
    rejects: async (fn, _expected, message) => await expect(
      typeof fn === 'function' ? fn() : fn, message).rejects.toThrow(),
    match: (actual, re, message) => expect(actual, message).toMatch(re),
    doesNotThrow: (fn, message) => expect(fn, message).not.toThrow(),
  },
);


import {
  DEFAULT_VIEWING_DISTANCE_MM,
  KNOWN_DEVICES,
  computeViewingGeometry,
  findKnownDevice,
  loadStoredNumber,
  mmPerCssPxFromPanelLongSide,
  preservePhysicalPoint,
  resolveScreenMetrics,
  saveStoredNumber,
} from '../device-metrics.js';


test('device table entries have square pixels in both axes', () => {
  // A wrong panel size silently rescales every head-tracking distance, so the
  // two independent ways of deriving millimetres per CSS pixel must agree.
  for (const device of KNOWN_DEVICES) {
    const fromHeight = device.panelHeightMm / device.cssHeight;
    const fromWidth = device.panelWidthMm / device.cssWidth;
    assert.ok(
      Math.abs(fromHeight - fromWidth) / fromHeight < 0.005,
      `${device.label} pixels are not square: ${fromHeight} vs ${fromWidth}`,
    );
  }
});


test('known devices are matched in either orientation and missed safely', () => {
  const phone = KNOWN_DEVICES.find((device) => device.id === 'iphone-17');
  assert.equal(findKnownDevice({
    screenWidth: phone.cssWidth,
    screenHeight: phone.cssHeight,
    devicePixelRatio: 3,
  })?.id, 'iphone-17');
  assert.equal(findKnownDevice({
    screenWidth: phone.cssHeight,
    screenHeight: phone.cssWidth,
    devicePixelRatio: 3,
  })?.id, 'iphone-17');
  assert.equal(findKnownDevice({
    screenWidth: 402,
    screenHeight: 874,
    devicePixelRatio: 2,
  }), null);
  assert.equal(findKnownDevice({ screenWidth: 0, screenHeight: 0, devicePixelRatio: 3 }), null);
});


test('an explicitly measured screen size beats both the table and the estimate', () => {
  const measured = resolveScreenMetrics({
    screenWidth: 402,
    screenHeight: 874,
    devicePixelRatio: 3,
    measuredMmPerCssPx: 0.2,
  });
  assert.equal(measured.mmPerCssPx, 0.2);
  assert.equal(measured.source, 'measured');

  const tabled = resolveScreenMetrics({ screenWidth: 402, screenHeight: 874, devicePixelRatio: 3 });
  assert.equal(tabled.source, 'device-table');

  const unknown = resolveScreenMetrics({ screenWidth: 500, screenHeight: 900, devicePixelRatio: 3 });
  assert.equal(unknown.source, 'estimated');
  // The estimate must stay near real hardware. The CSS specification's nominal
  // 96 dpi would be 0.2646 mm and is wrong by more than half on these panels.
  assert.ok(Math.abs(unknown.mmPerCssPx - 0.1657) < 0.02);
});


test('a measured panel long side converts to an orientation-independent CSS scale', () => {
  const portrait = mmPerCssPxFromPanelLongSide({
    panelLongSideMm: 150,
    screenWidth: 400,
    screenHeight: 900,
  });
  const landscape = mmPerCssPxFromPanelLongSide({
    panelLongSideMm: 150,
    screenWidth: 900,
    screenHeight: 400,
  });
  assert.equal(portrait, 1 / 6);
  assert.equal(landscape, portrait);
  assert.throws(() => mmPerCssPxFromPanelLongSide({
    panelLongSideMm: 0,
    screenWidth: 400,
    screenHeight: 900,
  }));
});


test('viewing geometry puts the eye about two screen heights away on real devices', () => {
  // The previous build used a fixed eye distance of 2.5 world units against a
  // virtual screen two units tall, which is 1.25 screen heights. A phone or
  // tablet is actually held at roughly two screen heights, so every gain had to
  // be shrunk to compensate for an eye that was twice too close.
  for (const device of KNOWN_DEVICES) {
    const metrics = resolveScreenMetrics({
      screenWidth: device.cssWidth,
      screenHeight: device.cssHeight,
      devicePixelRatio: device.devicePixelRatio,
    });
    const geometry = computeViewingGeometry({
      canvasCssHeight: device.cssHeight,
      mmPerCssPx: metrics.mmPerCssPx,
      viewingDistanceMm: device.defaultViewingDistanceMm,
    });
    assert.ok(
      geometry.baselineEyeZ > 3.5 && geometry.baselineEyeZ < 5.5,
      `${device.label} derived eye distance ${geometry.baselineEyeZ}`,
    );
    assert.ok(
      geometry.verticalFovDeg > 20 && geometry.verticalFovDeg < 32,
      `${device.label} derived vertical field of view ${geometry.verticalFovDeg}`,
    );
    assert.ok(Math.abs(geometry.worldUnitMm * 2 - geometry.screenHeightMm) < 1e-9);
  }
});


test('viewing distance is clamped and bad geometry inputs are rejected', () => {
  const near = computeViewingGeometry({ canvasCssHeight: 800, mmPerCssPx: 0.16, viewingDistanceMm: 10 });
  assert.equal(near.viewingDistanceMm, 150);
  const far = computeViewingGeometry({ canvasCssHeight: 800, mmPerCssPx: 0.16, viewingDistanceMm: 5000 });
  assert.equal(far.viewingDistanceMm, 900);
  const fallback = computeViewingGeometry({ canvasCssHeight: 800, mmPerCssPx: 0.16, viewingDistanceMm: Number.NaN });
  assert.equal(fallback.viewingDistanceMm, DEFAULT_VIEWING_DISTANCE_MM);
  assert.throws(() => computeViewingGeometry({ canvasCssHeight: 0, mmPerCssPx: 0.16 }));
  assert.throws(() => computeViewingGeometry({ canvasCssHeight: 800, mmPerCssPx: 0 }));
});


test('viewport changes preserve the eye at the same physical millimetre point', () => {
  const before = { x: 0.5, y: -0.25, z: 5 };
  const after = preservePhysicalPoint(before, 60, 90);
  assert.ok(Math.abs(after.x - 1 / 3) < 1e-12);
  assert.ok(Math.abs(after.y + 1 / 6) < 1e-12);
  assert.ok(Math.abs(after.z - 10 / 3) < 1e-12);
  assert.ok(Math.abs(after.x * 90 - before.x * 60) < 1e-9);
  assert.ok(Math.abs(after.y * 90 - before.y * 60) < 1e-9);
  assert.ok(Math.abs(after.z * 90 - before.z * 60) < 1e-9);
  assert.throws(() => preservePhysicalPoint(before, 0, 90));
});


test('stored measurements round-trip and survive unavailable storage', () => {
  const backing = new Map();
  const storage = {
    getItem: (key) => (backing.has(key) ? backing.get(key) : null),
    setItem: (key, value) => backing.set(key, value),
    removeItem: (key) => backing.delete(key),
  };
  saveStoredNumber(storage, 'distance', 420);
  assert.equal(loadStoredNumber(storage, 'distance'), 420);
  saveStoredNumber(storage, 'distance', 0);
  assert.equal(loadStoredNumber(storage, 'distance'), null);

  const hostile = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('denied'); },
  };
  assert.equal(loadStoredNumber(hostile, 'distance'), null);
  assert.doesNotThrow(() => saveStoredNumber(hostile, 'distance', 300));
});
