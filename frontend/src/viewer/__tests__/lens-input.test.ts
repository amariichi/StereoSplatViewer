import { describe, expect, it } from 'vitest';

import { parseFocalMm } from '../WindowViewer';

describe('reading a focal length someone typed on a phone', () => {
  it('takes an ordinary number', () => {
    expect(parseFocalMm('50')).toBe(50);
    expect(parseFocalMm('  85 ')).toBe(85);
    expect(parseFocalMm('26.5')).toBe(26.5);
  });

  it('takes the full-width digits a Japanese keyboard produces', () => {
    // The whole reason this function exists: an IME in its usual state gives
    // these, and Number() makes NaN of them.
    expect(parseFocalMm('５０')).toBe(50);
    expect(parseFocalMm('８５')).toBe(85);
    expect(parseFocalMm('２６．５')).toBe(26.5);
  });

  it('refuses what SHARP would refuse, so the field can say so first', () => {
    // Below 10 SHARP reads the value as a physical focal length and multiplies
    // it, which is not what someone giving a 35 mm equivalent means.
    expect(parseFocalMm('9')).toBe(null);
    expect(parseFocalMm('801')).toBe(null);
    expect(parseFocalMm('0')).toBe(null);
    expect(parseFocalMm('-50')).toBe(null);
  });

  it('refuses nonsense rather than guessing at it', () => {
    expect(parseFocalMm('')).toBe(null);
    expect(parseFocalMm('   ')).toBe(null);
    expect(parseFocalMm('fifty')).toBe(null);
    expect(parseFocalMm('50mm')).toBe(null);
  });
});
