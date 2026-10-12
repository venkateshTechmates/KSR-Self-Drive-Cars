// Brand colours from the website (src/index.css), so the app and the site look the same.
export const colors = {
  page: '#e9ebe7',
  surface: '#ffffff',
  subtle: '#f3f4f1',
  tile: '#dce0db',
  ink: '#1d2125',
  ink2: '#3a4046',
  muted: '#555c63',
  line: '#cbd0cb',
  lineCard: '#d3d8d2',
  lineInput: '#a9b0aa',
  action: '#0a6640',
  actionPressed: '#074a2e',
  plate: '#ffc72c',
  danger: '#8a2412',
  dangerBg: '#fbe9e4',
  amber: '#7a4d00',
  amberBg: '#fdf1d6',
  blue: '#1d4f8f',
  blueBg: '#e3eefb',
  green: '#0a6640',
  greenBg: '#e3f3ea',
  nightText: '#f2f3f0',
  nightMuted: '#aab2af',
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
export const radius = { sm: 10, md: 14, lg: 18, pill: 999 } as const;
