// Types for the copied module. The implementation is carried over verbatim from
// the project it was proven in, so its types are declared at the boundary
// rather than by rewriting 152 lines and risking a transcription error.

export const DEVICE_SIZE_STORAGE_KEY: string;
export const VIEWING_DISTANCE_STORAGE_KEY: string;
export const DEFAULT_VIEWING_DISTANCE_MM: number;
export const MIN_VIEWING_DISTANCE_MM: number;
export const MAX_VIEWING_DISTANCE_MM: number;

export type KnownDevice = {
  id: string;
  label: string;
  cssWidth: number;
  cssHeight: number;
  devicePixelRatio: number;
  panelWidthMm: number;
  panelHeightMm: number;
  defaultViewingDistanceMm: number;
};

export const KNOWN_DEVICES: readonly KnownDevice[];

export function findKnownDevice(input: {
  screenWidth?: number; screenHeight?: number; devicePixelRatio?: number;
}): KnownDevice | null;

export type ScreenMetrics = {
  mmPerCssPx: number;
  source: 'measured' | 'device-table' | 'estimated';
  label: string;
  defaultViewingDistanceMm: number;
};

export function resolveScreenMetrics(input?: {
  screenWidth?: number;
  screenHeight?: number;
  devicePixelRatio?: number;
  measuredMmPerCssPx?: number | null;
}): ScreenMetrics;

export function mmPerCssPxFromPanelLongSide(input: {
  panelLongSideMm: number;
  screenWidth?: number;
  screenHeight?: number;
}): number;

export type ViewingGeometry = {
  screenHeightMm: number;
  /** Millimetres per world unit; one unit is half the screen's height. */
  worldUnitMm: number;
  viewingDistanceMm: number;
  /** Eye distance in world units, which is what the projection takes. */
  baselineEyeZ: number;
  verticalFovDeg: number;
};

export function computeViewingGeometry(input: {
  canvasCssHeight: number;
  mmPerCssPx: number;
  viewingDistanceMm?: number;
}): ViewingGeometry;

export function preservePhysicalPoint(
  point: { x: number; y: number; z: number },
  previousWorldUnitMm: number,
  nextWorldUnitMm: number,
): { x: number; y: number; z: number };

export function loadStoredNumber(storage: Storage | null | undefined, key: string): number | null;
export function saveStoredNumber(storage: Storage | null | undefined, key: string, value: number | null): void;
