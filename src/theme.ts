export const COLORS = {
  black: '#000000',
  white: '#ffffff',
  grey: '#e5e5e5',
  lightGrey: '#f0f0f0',
  mutedGrey: '#b0b0b0',
  softGrey: '#888888',
  // rainbow gradient stops
  red: '#FF0000',
  orange: '#FF7F00',
  yellow: '#FFFF00',
  green: '#00FF00',
  blue: '#0000FF',
  purple: '#9400D3',
};

export const FONTS = {
  chicago: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  monaco: "'Monaco', 'Courier New', Courier, monospace",
  pixel: "'VT323', monospace",
};

export const NOTE_GRADIENTS = [
  `linear-gradient(90deg, ${COLORS.red}, ${COLORS.orange})`,
  `linear-gradient(90deg, ${COLORS.orange}, ${COLORS.yellow})`,
  `linear-gradient(90deg, ${COLORS.yellow}, ${COLORS.green})`,
  `linear-gradient(90deg, ${COLORS.green}, ${COLORS.blue})`,
  `linear-gradient(90deg, ${COLORS.blue}, ${COLORS.purple})`,
  `linear-gradient(90deg, ${COLORS.purple}, ${COLORS.red})`,
];

export const PINSTRIPE =
  `repeating-linear-gradient(180deg, ${COLORS.white}, ${COLORS.white} 1px, ${COLORS.black} 1px, ${COLORS.black} 2px)`;

export const GRID_BG = `repeating-linear-gradient(90deg, transparent, transparent 39px, ${COLORS.mutedGrey} 40px), repeating-linear-gradient(0deg, transparent, transparent 19px, ${COLORS.mutedGrey} 20px)`;

// Web-only style snippets. On native these no-op; we target the web demo.
export const BORDER_1BIT = {
  borderWidth: 1,
  borderColor: COLORS.black,
};

export const SHADOW_1BIT = {
  boxShadow: `1px 1px 0 0 ${COLORS.black}`,
} as const;

export const SHADOW_2BIT = {
  boxShadow: `2px 2px 0 0 ${COLORS.black}`,
} as const;
