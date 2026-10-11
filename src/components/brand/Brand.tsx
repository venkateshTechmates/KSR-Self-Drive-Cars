// Visual elements from the design canvas: the KSR number-plate logo, price plates and
// car silhouettes (used until a car has photos).
import type { ReactNode } from 'react';
import type { CarCategory } from '@shared/constants.ts';
import type { PublicCarPhoto } from '@/types/db';
import { carPhotoSrcSet, carPhotoUrl } from '@/lib/carPhotos';
import { cn } from '@/lib/cn';

const Dot = ({ size = 4, colour = '#6B6B6B' }: { size?: number; colour?: string }) => (
  <span aria-hidden="true" className="shrink-0 rounded-full" style={{ width: size, height: size, background: colour }} />
);

export function KsrLogo({ size = 'md', withName = true, inverted = false }: { size?: 'sm' | 'md'; withName?: boolean; inverted?: boolean }) {
  const sm = size === 'sm';
  return (
    <span className="inline-flex items-center gap-2.5">
      <span
        className={cn('inline-flex items-center rounded-md bg-black', sm ? 'gap-2 px-[9px] py-1.5' : 'gap-2.5 px-2.5 py-[7px]')}
        style={{ boxShadow: 'inset 0 0 0 2px #000, inset 0 0 0 3px var(--color-plate)' }}
      >
        <Dot />
        <span className={cn('stretch-75 leading-none font-extrabold tracking-[0.08em] text-plate', sm ? 'text-[20px]' : 'text-[24px]')}>KSR</span>
        <Dot />
      </span>
      {withName && (
        <span className={cn('font-bold tracking-[-0.005em]', sm ? 'text-[15px]' : 'text-[17px]', inverted ? 'text-white' : 'text-ink')}>
          Self Drive Cars
        </span>
      )}
    </span>
  );
}

/** Small inline price plate, e.g. on fleet cards. */
export function PricePlate({ children, size = 'md', className }: { children: ReactNode; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const sizes = { sm: 'text-[22px] px-[9px] pt-1.5 pb-[5px]', md: 'text-[30px] px-3 pt-2 pb-[7px]', lg: 'text-[40px] px-3.5 pt-2 pb-1.5' };
  return (
    <span
      className={cn('stretch-70 inline-block rounded-md bg-black leading-none font-extrabold tracking-[0.03em] text-plate', sizes[size], className)}
      style={{ boxShadow: 'inset 0 0 0 2px #000, inset 0 0 0 3px var(--color-plate)' }}
    >
      {children}
    </span>
  );
}

/** Large framed plate with rivets (hero "FROM ₹1,300", booking total). */
export function BigPlate({
  children,
  label,
  tilt = false,
  size = 'lg',
  className,
}: {
  children: ReactNode;
  label?: string;
  tilt?: boolean;
  size?: 'md' | 'lg' | 'xl';
  className?: string;
}) {
  const text = { md: 'text-[40px]', lg: 'text-[52px]', xl: 'text-[clamp(42px,5vw,68px)]' }[size];
  const pad = { md: 'p-1.5', lg: 'p-[7px]', xl: 'p-2.5' }[size];
  const inner = { md: 'px-3.5 py-2 gap-3 border-2', lg: 'px-[18px] py-2.5 gap-3.5 border-2', xl: 'px-6 py-[18px] gap-4 border-[3px]' }[size];
  return (
    <div
      role={label ? 'img' : undefined}
      aria-label={label}
      className={cn('inline-block rounded-[10px] bg-black', pad, tilt && '-rotate-2 shadow-[0_22px_30px_-20px_rgba(0,0,0,0.6)]', className)}
    >
      <div className={cn('flex items-center justify-between rounded-md border-plate', inner)}>
        <Dot size={size === 'xl' ? 10 : 7} colour="#4A4A4A" />
        <span aria-hidden={label ? true : undefined} className={cn('stretch-62 leading-none font-extrabold tracking-[0.04em] whitespace-nowrap text-plate', text)}>
          {children}
        </span>
        <Dot size={size === 'xl' ? 10 : 7} colour="#4A4A4A" />
      </div>
    </div>
  );
}

const SHAPES: Record<CarCategory, { body: string; windows: string[]; pillars: number[]; wheels: [number, number, number][]; roof?: [number, number] }> = {
  hatch: {
    body: 'M16 75 L16 55 Q16 45 26 43 L40 27 Q44 21 52 21 L124 21 Q134 21 142 27 L166 45 L204 49 Q222 51 224 63 L224 75 Z',
    windows: ['M47 41 L57 28 L96 28 L96 41 Z', 'M102 28 L125 28 Q133 28 138 32 L150 41 L102 41 Z'],
    pillars: [99],
    wheels: [
      [60, 75, 15],
      [184, 75, 15],
    ],
  },
  suv: {
    body: 'M14 74 L14 46 Q14 38 22 36 L32 18 Q36 12 44 12 L140 12 Q150 12 156 18 L176 36 L212 40 Q226 42 226 54 L226 74 Z',
    windows: ['M36 34 L44 19 L94 19 L94 34 Z', 'M100 19 L138 19 Q146 19 150 23 L162 34 L100 34 Z'],
    pillars: [97],
    wheels: [
      [60, 74, 16],
      [188, 74, 16],
    ],
    roof: [50, 134],
  },
  mpv: {
    body: 'M12 75 L12 40 Q12 30 22 28 L28 14 Q31 9 38 9 L152 9 Q162 9 170 17 L192 38 L216 42 Q229 44 229 56 L229 75 Z',
    windows: ['M32 28 L38 16 L76 16 L76 28 Z', 'M82 16 L120 16 L120 28 L82 28 Z', 'M126 16 L152 16 Q159 16 163 21 L172 28 L126 28 Z'],
    pillars: [79, 123],
    wheels: [
      [56, 75, 15],
      [192, 75, 15],
    ],
  },
};

/** Side-view silhouette by category, as drawn in the design. */
export function CarSilhouette({ category, stroke = 2.5, ground = true, className }: { category: CarCategory; stroke?: number; ground?: boolean; className?: string }) {
  const s = SHAPES[category];
  return (
    <svg viewBox="0 0 240 96" width="100%" className={className} aria-hidden="true">
      {ground && <line x1="6" y1="90" x2="234" y2="90" stroke="#A3ABA4" strokeWidth={Math.max(2, stroke - 0.5)} strokeDasharray="12 9" />}
      {s.roof && <line x1={s.roof[0]} y1="8" x2={s.roof[1]} y2="8" stroke="#1D2125" strokeWidth={stroke} strokeLinecap="round" />}
      <path d={s.body} fill="#FFFFFF" stroke="#1D2125" strokeWidth={stroke} strokeLinejoin="round" />
      {s.windows.map((d) => (
        <path key={d} d={d} fill="#9DAFB9" />
      ))}
      {stroke <= 3 && s.pillars.map((x) => <line key={x} x1={x} y1={category === 'mpv' ? 32 : 40} x2={x} y2="69" stroke="#1D2125" strokeWidth="1.5" />)}
      {s.wheels.map(([cx, cy, r]) => (
        <g key={cx}>
          <circle cx={cx} cy={cy} r={r} fill="#1D2125" />
          <circle cx={cx} cy={cy} r={r * 0.4} fill="#DCE0DB" />
        </g>
      ))}
    </svg>
  );
}

/** Cover photo (responsive WebP with width/height, lazy below the fold) or the silhouette. */
export function CarImage({
  photo,
  category,
  sizes = '(min-width: 1240px) 380px, (min-width: 700px) 45vw, 100vw',
  eager = false,
  className,
}: {
  photo?: PublicCarPhoto | null;
  category: CarCategory;
  sizes?: string;
  eager?: boolean;
  className?: string;
}) {
  if (photo) {
    return (
      <img
        src={carPhotoUrl(photo.path, 800)}
        srcSet={carPhotoSrcSet(photo.path)}
        sizes={sizes}
        width={photo.width}
        height={photo.height}
        alt={photo.alt}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        className={cn('h-full w-full object-cover', className)}
      />
    );
  }
  return <CarSilhouette category={category} className={cn('max-w-[280px]', className)} />;
}
