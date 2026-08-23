// Taking a picture straight from the clipboard.
//
// Copying an image in a browser and pasting it here is a shorter path than
// saving it, finding it in a file picker and uploading it -- and on a phone,
// where there is no comfortable file manager, it is much shorter.
//
// Two ways in, because the platforms differ. A desktop browser fires a `paste`
// event carrying the image, which needs no permission at all. iOS has no
// keyboard to paste from, so the button asks the clipboard directly with
// `navigator.clipboard.read()`; Safari then shows its own Paste confirmation,
// which is one extra tap and no bad thing for something that reads the
// clipboard. Both need a secure origin, which the viewer already requires for
// the camera.

/** The image types worth trying, best first. */
export const PREFERRED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export function pickImageType(types: readonly string[]): string | null {
  for (const preferred of PREFERRED_IMAGE_TYPES) {
    if (types.includes(preferred)) return preferred;
  }
  return types.find((type) => type.startsWith('image/')) ?? null;
}

/** A filename for something that arrived without one. */
export function nameForType(type: string, now = new Date()): string {
  const extension = type === 'image/png' ? 'png'
    : type === 'image/webp' ? 'webp'
      : type === 'image/jpeg' ? 'jpg'
        : (type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  return `pasted-${stamp}.${extension}`;
}

/** The first image in a paste event, if it carried one. */
export function imageFromPasteEvent(event: ClipboardEvent): File | null {
  const items = event.clipboardData?.items;
  if (!items) return null;
  for (const item of Array.from(items)) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) return file;
  }
  const files = event.clipboardData?.files;
  if (files) {
    for (const file of Array.from(files)) {
      if (file.type.startsWith('image/')) return file;
    }
  }
  return null;
}

export type ClipboardReadResult =
  | { ok: true; file: File }
  | { ok: false; reason: 'unsupported' | 'denied' | 'empty' };

/**
 * Ask the clipboard for an image, which is the only route a phone has.
 *
 * Must be called from a tap: both the permission and, on Safari, the native
 * Paste confirmation depend on it.
 */
export async function readImageFromClipboard(
  clipboard: Clipboard | undefined = globalThis.navigator?.clipboard,
): Promise<ClipboardReadResult> {
  if (!clipboard || typeof clipboard.read !== 'function') return { ok: false, reason: 'unsupported' };
  let items: ClipboardItems;
  try {
    items = await clipboard.read();
  } catch {
    // Refused, dismissed, or no permission. The three are not distinguishable
    // and do not need to be: nothing arrived either way.
    return { ok: false, reason: 'denied' };
  }
  for (const item of items) {
    const type = pickImageType(item.types);
    if (!type) continue;
    try {
      const blob = await item.getType(type);
      return { ok: true, file: new File([blob], nameForType(type), { type }) };
    } catch {
      // Try the next item rather than giving up on the whole clipboard.
    }
  }
  return { ok: false, reason: 'empty' };
}
