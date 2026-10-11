// Line icons drawn in the design canvas (24×24, stroke 2).
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };
const base = (size: number, rest: SVGProps<SVGSVGElement>) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  ...rest,
});

export const PhoneIcon = ({ size = 18, ...rest }: P) => (
  <svg {...base(size, rest)}>
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.58 2.81.7A2 2 0 0 1 22 16.92z" />
  </svg>
);
export const ClockIcon = ({ size = 22, ...rest }: P) => (
  <svg {...base(size, rest)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);
export const ShieldIcon = ({ size = 22, ...rest }: P) => (
  <svg {...base(size, rest)}>
    <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
    <path d="M9 12l2 2 4-4" />
  </svg>
);
export const KeyIcon = ({ size = 22, ...rest }: P) => (
  <svg {...base(size, rest)}>
    <circle cx="8" cy="15" r="4" />
    <path d="M11 12l9-9" />
    <path d="M17 6l3 3" />
    <path d="M14.5 8.5l2 2" />
  </svg>
);
export const SeatIcon = ({ size = 16, ...rest }: P) => (
  <svg {...base(size, rest)}>
    <circle cx="12" cy="7" r="4" />
    <path d="M5 21v-1a7 7 0 0 1 14 0v1" />
  </svg>
);
export const FuelIcon = ({ size = 16, ...rest }: P) => (
  <svg {...base(size, rest)}>
    <path d="M4 21V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v16" />
    <path d="M3 21h13" />
    <path d="M7 8h5" />
    <path d="M15 10h2a2 2 0 0 1 2 2v5a1.5 1.5 0 0 0 3 0V9l-3-3" />
  </svg>
);
export const GearIcon = ({ size = 16, ...rest }: P) => (
  <svg {...base(size, rest)}>
    <circle cx="6" cy="5" r="1.6" />
    <circle cx="12" cy="5" r="1.6" />
    <circle cx="18" cy="5" r="1.6" />
    <circle cx="6" cy="19" r="1.6" />
    <circle cx="12" cy="19" r="1.6" />
    <path d="M6 7v10M12 7v10M18 7v5H6" />
  </svg>
);
export const ChevronRight = ({ size = 18, ...rest }: P) => (
  <svg {...base(size, { strokeWidth: 2.2, ...rest })}>
    <path d="M9 6l6 6-6 6" />
  </svg>
);
export const ChevronLeft = ({ size = 22, ...rest }: P) => (
  <svg {...base(size, { strokeWidth: 2.2, ...rest })}>
    <path d="M15 6l-6 6 6 6" />
  </svg>
);
export const CheckCircle = ({ size = 40, ...rest }: P) => (
  <svg {...base(size, rest)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8 12.5l2.8 2.8L16 10" />
  </svg>
);
export const WhatsAppIcon = ({ size = 18, ...rest }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...rest}>
    <path
      fill="currentColor"
      d="M12.04 2a9.9 9.9 0 0 0-8.5 14.98L2 22l5.17-1.5A9.9 9.9 0 1 0 12.04 2zm0 18.1a8.2 8.2 0 0 1-4.18-1.15l-.3-.18-3.07.89.9-2.99-.2-.31a8.2 8.2 0 1 1 6.85 3.74zm4.5-6.14c-.25-.12-1.46-.72-1.69-.8-.23-.08-.39-.12-.56.12-.16.25-.64.8-.79.97-.14.16-.29.18-.54.06-.25-.12-1.04-.38-1.98-1.22-.73-.65-1.23-1.46-1.37-1.7-.14-.25-.02-.38.11-.5.11-.11.25-.29.37-.43.12-.15.16-.25.25-.41.08-.17.04-.31-.02-.44-.06-.12-.56-1.34-.76-1.84-.2-.48-.4-.42-.56-.42h-.48c-.16 0-.43.06-.66.31-.23.25-.86.85-.86 2.06 0 1.22.89 2.39 1.01 2.56.12.16 1.74 2.66 4.22 3.73.59.25 1.05.4 1.41.52.59.19 1.13.16 1.56.1.48-.07 1.46-.6 1.67-1.18.2-.58.2-1.07.14-1.18-.06-.1-.22-.16-.47-.29z"
    />
  </svg>
);
