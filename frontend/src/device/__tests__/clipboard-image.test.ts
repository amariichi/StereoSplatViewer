import { describe, expect, it } from 'vitest';

import {
  imageFromPasteEvent,
  nameForType,
  pickImageType,
  readImageFromClipboard,
} from '../clipboard-image';

describe('choosing what to take from the clipboard', () => {
  it('prefers lossless over lossy when both are offered', () => {
    // A browser copying an image often puts several encodings on the clipboard.
    expect(pickImageType(['image/jpeg', 'image/png'])).toBe('image/png');
    expect(pickImageType(['text/html', 'image/jpeg'])).toBe('image/jpeg');
  });

  it('takes any image rather than none', () => {
    expect(pickImageType(['image/heic'])).toBe('image/heic');
  });

  it('takes nothing when there is no image', () => {
    expect(pickImageType(['text/plain', 'text/html'])).toBe(null);
    expect(pickImageType([])).toBe(null);
  });
});

describe('naming something that arrived without a name', () => {
  const when = new Date('2026-08-22T16:04:05Z');

  it('uses the extension the type calls for', () => {
    expect(nameForType('image/png', when)).toBe('pasted-20260822T160405.png');
    expect(nameForType('image/jpeg', when)).toBe('pasted-20260822T160405.jpg');
    expect(nameForType('image/webp', when)).toBe('pasted-20260822T160405.webp');
  });

  it('produces something usable from a type it does not know', () => {
    expect(nameForType('image/heic', when)).toBe('pasted-20260822T160405.heic');
    expect(nameForType('nonsense', when)).toMatch(/^pasted-\d{8}T\d{6}\.[a-z0-9]+$/);
  });
});

describe('the paste event, which is how a desktop does it', () => {
  const fakeEvent = (items: unknown[], files: unknown[] = []) =>
    ({ clipboardData: { items, files } } as unknown as ClipboardEvent);

  it('finds an image among whatever else was pasted', () => {
    const file = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' });
    expect(imageFromPasteEvent(fakeEvent([
      { kind: 'string', type: 'text/html', getAsFile: () => null },
      { kind: 'file', type: 'image/png', getAsFile: () => file },
    ]))).toBe(file);
  });

  it('falls back to the files list when the items give nothing', () => {
    const file = new File([new Uint8Array([1])], 'a.jpg', { type: 'image/jpeg' });
    expect(imageFromPasteEvent(fakeEvent([], [file]))).toBe(file);
  });

  it('returns nothing for a paste that carried no image', () => {
    expect(imageFromPasteEvent(fakeEvent([{ kind: 'string', type: 'text/plain', getAsFile: () => null }])))
      .toBe(null);
    expect(imageFromPasteEvent({ clipboardData: null } as unknown as ClipboardEvent)).toBe(null);
  });
});

describe('asking the clipboard directly, which is the only route a phone has', () => {
  const clipboardWith = (items: unknown[]) =>
    ({ read: async () => items } as unknown as Clipboard);

  it('returns the image it found', async () => {
    const blob = new Blob([new Uint8Array([1, 2])], { type: 'image/png' });
    const result = await readImageFromClipboard(clipboardWith([
      { types: ['image/png'], getType: async () => blob },
    ]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.file.type).toBe('image/png');
      expect(result.file.name).toMatch(/^pasted-.*\.png$/);
    }
  });

  it('reports a browser that cannot do it, rather than throwing', async () => {
    expect(await readImageFromClipboard(undefined)).toEqual({ ok: false, reason: 'unsupported' });
    expect(await readImageFromClipboard({} as Clipboard)).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('reports a refusal without pretending to know which kind it was', async () => {
    // Denied, dismissed and no-permission are indistinguishable here, and the
    // difference does not matter: nothing arrived either way.
    const hostile = { read: async () => { throw new Error('NotAllowedError'); } } as unknown as Clipboard;
    expect(await readImageFromClipboard(hostile)).toEqual({ ok: false, reason: 'denied' });
  });

  it('reports an empty clipboard distinctly, so the message can say so', async () => {
    expect(await readImageFromClipboard(clipboardWith([{ types: ['text/plain'] }])))
      .toEqual({ ok: false, reason: 'empty' });
  });

  it('tries the next item when one fails rather than giving up', async () => {
    const blob = new Blob([new Uint8Array([1])], { type: 'image/jpeg' });
    const result = await readImageFromClipboard(clipboardWith([
      { types: ['image/png'], getType: async () => { throw new Error('gone'); } },
      { types: ['image/jpeg'], getType: async () => blob },
    ]));
    expect(result.ok).toBe(true);
  });
});
