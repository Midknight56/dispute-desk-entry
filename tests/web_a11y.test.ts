/// <reference lib="dom" />
import { describe, expect, it } from 'vitest';
import { contrastRatio, palettes } from '../web/src/theme';

describe('theme contrast', () => {
  it('keeps required text and accent pairs at 4.5:1 in every palette', () => {
    for (const [paletteName, palette] of Object.entries(palettes)) {
      for (const [mode, tokens] of Object.entries(palette)) {
        const pairs: [string, string, string][] = [
          ['muted/bg', tokens.muted, tokens.bg],
          ['muted/surface', tokens.muted, tokens.surface],
          ['text/bg', tokens.text, tokens.bg],
          ['accentText/accent', tokens.accentText, tokens.accent],
        ];
        for (const [name, foreground, background] of pairs) {
          expect(contrastRatio(foreground, background), `${paletteName} ${mode} ${name}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
});
