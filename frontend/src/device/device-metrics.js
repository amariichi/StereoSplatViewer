// Browsers cannot report how physically large a screen is. A CSS pixel is a
// purely logical unit, and the naive "1 CSS pixel is 1/96 inch" assumption is
// wrong by more than 50% on modern phones. Without the real millimetre size,
// the virtual screen's world units have no physical meaning and every head
// tracking gain has to be guessed.
//
// This module resolves millimetres per CSS pixel from a small table of known
// devices, falling back to a density estimate, and lets the user store a
// measured value that always wins.

export const DEVICE_SIZE_STORAGE_KEY = 'rgbde-mobile-screen-mm-per-css-px-v1';
export const VIEWING_DISTANCE_STORAGE_KEY = 'rgbde-mobile-viewing-distance-mm-v1';

// A CSS pixel on a device with `devicePixelRatio` r covers r hardware pixels,
// so millimetres per CSS pixel is 25.4 * r / ppi.
const MM_PER_INCH = 25.4;

// Entries are matched on the portrait-normalised CSS screen size plus the
// device pixel ratio. `panelMm` is the active display area of the panel; the
// numbers come from the published hardware resolution divided by its ppi.
export const KNOWN_DEVICES = Object.freeze([
  {
    id: 'iphone-17',
    label: 'iPhone 17',
    cssWidth: 402,
    cssHeight: 874,
    devicePixelRatio: 3,
    // 1206 x 2622 hardware pixels at 460 ppi.
    panelWidthMm: 66.59,
    panelHeightMm: 144.78,
    defaultViewingDistanceMm: 300,
  },
  {
    id: 'ipad-mini-a17-pro',
    label: 'iPad mini (A17 Pro)',
    cssWidth: 744,
    cssHeight: 1133,
    devicePixelRatio: 2,
    // 1488 x 2266 hardware pixels at 326 ppi.
    panelWidthMm: 115.94,
    panelHeightMm: 176.55,
    defaultViewingDistanceMm: 400,
  },
]);

export const DEFAULT_VIEWING_DISTANCE_MM = 350;
export const MIN_VIEWING_DISTANCE_MM = 150;
export const MAX_VIEWING_DISTANCE_MM = 900;

// Used when no table entry matches. Apple's phone and tablet panels sit close
// to 160 hardware pixels per CSS pixel-inch, which lands within a few percent
// of both table entries above and is far better than the 96 dpi assumption.
const FALLBACK_CSS_PPI = 160;

function positive(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function findKnownDevice({ screenWidth, screenHeight, devicePixelRatio }) {
  const width = positive(screenWidth);
  const height = positive(screenHeight);
  const ratio = positive(devicePixelRatio);
  if (!width || !height || !ratio) return null;
  // Orientation must not change which device we are looking at.
  const shortSide = Math.min(width, height);
  const longSide = Math.max(width, height);
  return KNOWN_DEVICES.find((device) => (
    Math.abs(device.cssWidth - shortSide) <= 2
    && Math.abs(device.cssHeight - longSide) <= 2
    && Math.abs(device.devicePixelRatio - ratio) < 0.01
  )) || null;
}

export function resolveScreenMetrics({
  screenWidth,
  screenHeight,
  devicePixelRatio = 1,
  measuredMmPerCssPx = null,
} = {}) {
  const measured = positive(measuredMmPerCssPx);
  if (measured) {
    return {
      mmPerCssPx: measured,
      source: 'measured',
      label: 'Measured screen size',
      defaultViewingDistanceMm: DEFAULT_VIEWING_DISTANCE_MM,
    };
  }
  const device = findKnownDevice({ screenWidth, screenHeight, devicePixelRatio });
  if (device) {
    return {
      mmPerCssPx: device.panelHeightMm / device.cssHeight,
      source: 'device-table',
      label: device.label,
      defaultViewingDistanceMm: device.defaultViewingDistanceMm,
    };
  }
  return {
    mmPerCssPx: MM_PER_INCH / FALLBACK_CSS_PPI,
    source: 'estimated',
    label: 'Estimated screen size',
    defaultViewingDistanceMm: DEFAULT_VIEWING_DISTANCE_MM,
  };
}

export function mmPerCssPxFromPanelLongSide({ panelLongSideMm, screenWidth, screenHeight }) {
  const millimetres = positive(panelLongSideMm);
  const width = positive(screenWidth);
  const height = positive(screenHeight);
  if (!millimetres || !width || !height) {
    throw new Error('Screen calibration requires a positive panel length and screen dimensions.');
  }
  return millimetres / Math.max(width, height);
}

// The virtual screen used by the head-coupled projection is always two world
// units tall and is mapped onto the whole canvas. One world unit is therefore
// half the canvas's physical height, which is what converts millimetres of real
// head movement into world units without any tunable gain.
export function computeViewingGeometry({
  canvasCssHeight,
  mmPerCssPx,
  viewingDistanceMm = DEFAULT_VIEWING_DISTANCE_MM,
}) {
  const cssHeight = positive(canvasCssHeight);
  const mmPerPx = positive(mmPerCssPx);
  if (!cssHeight || !mmPerPx) {
    throw new Error('Viewing geometry requires a positive canvas height and screen scale.');
  }
  const distance = Math.min(
    Math.max(positive(viewingDistanceMm) || DEFAULT_VIEWING_DISTANCE_MM, MIN_VIEWING_DISTANCE_MM),
    MAX_VIEWING_DISTANCE_MM,
  );
  const screenHeightMm = cssHeight * mmPerPx;
  const worldUnitMm = screenHeightMm / 2;
  return {
    screenHeightMm,
    worldUnitMm,
    viewingDistanceMm: distance,
    baselineEyeZ: distance / worldUnitMm,
    verticalFovDeg: (2 * Math.atan(worldUnitMm / distance) * 180) / Math.PI,
  };
}

/** Keep a world-space point at the same physical millimetre position. */
export function preservePhysicalPoint(point, previousWorldUnitMm, nextWorldUnitMm) {
  const previous = positive(previousWorldUnitMm);
  const next = positive(nextWorldUnitMm);
  if (!point || !previous || !next) {
    throw new Error('Physical point conversion requires positive world-unit scales.');
  }
  const scale = previous / next;
  const x = Number(point.x);
  const y = Number(point.y);
  const z = Number(point.z);
  if (![x, y, z].every(Number.isFinite)) {
    throw new Error('Physical point conversion requires finite XYZ coordinates.');
  }
  return { x: x * scale, y: y * scale, z: z * scale };
}

export function loadStoredNumber(storage, key) {
  try {
    const raw = storage?.getItem?.(key);
    if (raw === null || raw === undefined) return null;
    return positive(Number(raw));
  } catch {
    return null;
  }
}

export function saveStoredNumber(storage, key, value) {
  try {
    if (positive(value)) storage?.setItem?.(key, String(value));
    else storage?.removeItem?.(key);
  } catch {
    // Private browsing can reject storage; the current session still works.
  }
}
