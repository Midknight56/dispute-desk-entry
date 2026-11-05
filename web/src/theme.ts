// Every colour the desk uses. Four palettes; DEFAULT_PALETTE is the one the desk ships with, and `?palette=<name>`
// in the address previews another. Accent is the brand colour (buttons, the largest bar); the status colours stay
// readable in every palette.

type Tokens = {
  bg: string;
  surface: string;
  text: string;
  muted: string;
  line: string;
  accent: string;
  accentText: string;
  ok: string;
  warn: string;
  danger: string;
  webhook: string;
  call: string;
  agent: string;
  chart: string;
};

const graphiteLight: Tokens = {
  bg: '#f6f6f5',
  surface: '#ffffff',
  text: '#1d1d1b',
  muted: '#6b6b66',
  line: '#e3e3df',
  accent: '#1d1d1b',
  accentText: '#ffffff',
  ok: '#2f7d4f',
  warn: '#a86412',
  danger: '#b3261e',
  webhook: '#2f7d4f',
  call: '#6b6b66',
  agent: '#a86412',
  chart: '#6b6b66',
};
const graphiteDark: Tokens = {
  bg: '#171715',
  surface: '#222220',
  text: '#f1f1ed',
  muted: '#aaa9a2',
  line: '#3a3a36',
  accent: '#f1f1ed',
  accentText: '#171715',
  ok: '#69b785',
  warn: '#e3a14a',
  danger: '#ee756d',
  webhook: '#69b785',
  call: '#aaa9a2',
  agent: '#e3a14a',
  chart: '#aaa9a2',
};

export const palettes: Record<string, { light: Tokens; dark: Tokens }> = {
  graphite: { light: graphiteLight, dark: graphiteDark },
  // Ledger: a deep green, the colour of money kept safe.
  ledger: {
    light: {
      ...graphiteLight,
      bg: '#f4f6f3',
      line: '#dfe5dd',
      accent: '#1f5c45',
      chart: '#7d9a8c',
      webhook: '#1f5c45',
    },
    dark: {
      ...graphiteDark,
      bg: '#131815',
      surface: '#1c231f',
      line: '#33403a',
      accent: '#7fc4a3',
      accentText: '#0f1512',
      chart: '#7d9a8c',
      webhook: '#7fc4a3',
    },
  },
  // Clay: a fired terracotta, for a maker's shop.
  clay: {
    light: { ...graphiteLight, bg: '#f8f4f1', line: '#eadfd8', accent: '#9a4a2f', chart: '#b98d7c', agent: '#9a4a2f' },
    dark: {
      ...graphiteDark,
      bg: '#1a1513',
      surface: '#241d1a',
      line: '#3f342f',
      accent: '#e39a7d',
      accentText: '#1a1513',
      chart: '#b98d7c',
      agent: '#e39a7d',
    },
  },
  // Ink: a dark navy, a bank statement's calm.
  ink: {
    light: { ...graphiteLight, bg: '#f4f5f8', line: '#dde1ea', accent: '#1f3a5f', chart: '#8193ad', call: '#1f3a5f' },
    dark: {
      ...graphiteDark,
      bg: '#12151b',
      surface: '#1b2029',
      line: '#323a48',
      accent: '#8fb0dc',
      accentText: '#12151b',
      chart: '#8193ad',
      call: '#8fb0dc',
    },
  },
};

export function contrastRatio(foreground: string, background: string): number {
  const luminance = (color: string) => {
    const channels = color.match(/[\da-f]{2}/gi)?.map((channel) => parseInt(channel, 16) / 255);
    if (!channels || channels.length < 3) throw new Error(`Invalid color: ${color}`);
    const linear = channels
      .slice(0, 3)
      .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

export const DEFAULT_PALETTE = 'ledger';

function chosen(): string {
  try {
    const p = new URLSearchParams(window.location.search).get('palette');
    if (p && p in palettes) return p;
  } catch {
    // no window in tests
  }
  return DEFAULT_PALETTE;
}

export const paletteName = chosen();
export const colors: Tokens = palettes[paletteName].light;
export const darkColors: Tokens = palettes[paletteName].dark;

export function applyTheme(dark: boolean) {
  const palette = dark ? darkColors : colors;
  for (const [name, value] of Object.entries(palette)) document.documentElement.style.setProperty(`--${name}`, value);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}
