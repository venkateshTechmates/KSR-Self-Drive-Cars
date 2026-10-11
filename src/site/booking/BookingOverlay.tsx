// "Book this car" opens the booking form: a modal on desktop, a full-screen sheet on mobile (5.4).
// It lives at /book/:slug so the browser Back button closes it.
import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { IconButton } from '@/components/ui/Button';
import type { PublicCar } from '@/types/db';
import type { PublicConfig } from '../hooks/publicData';
import { ChevronLeft } from '../components/Icons';
import { BookingForm } from './BookingForm';

export function BookingOverlay({ cars, config, car, onClose }: { cars: PublicCar[]; config: PublicConfig; car: PublicCar | undefined; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
    const root = document.documentElement;
    const prev = root.style.overflow;
    root.style.overflow = 'hidden';
    return () => {
      root.style.overflow = prev;
    };
  }, []);

  const title = car ? `Book ${car.display_name}` : 'Book a car';

  return (
    <dialog
      ref={ref}
      aria-labelledby="booking-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className="m-0 h-dvh max-h-dvh w-full max-w-none bg-page p-0 text-ink md:m-auto md:h-auto md:max-h-[92dvh] md:max-w-[1040px] md:rounded-[20px] md:shadow-2xl"
    >
      <div className="flex h-dvh flex-col md:h-auto md:max-h-[92dvh]">
        {/* Mobile header (design: back arrow + centred title) */}
        <header className="grid h-16 flex-none grid-cols-[48px_minmax(0,1fr)_48px] items-center border-b border-line px-2.5 md:hidden">
          <IconButton label="Back to cars" onClick={onClose}>
            <ChevronLeft />
          </IconButton>
          <h1 id="booking-title" className="m-0 text-center text-[17px] font-bold">
            Book a car
          </h1>
          <span aria-hidden="true" />
        </header>
        {/* Desktop header */}
        <header className="hidden items-center justify-between gap-4 border-b border-line px-7 py-4 md:flex">
          <h1 className="display m-0 text-[44px]">{title}</h1>
          <IconButton label="Close" onClick={onClose}>
            <X size={22} aria-hidden="true" />
          </IconButton>
        </header>
        <BookingForm cars={cars} config={config} initialCarId={car?.id} variant="sheet" idPrefix="bk" onDone={onClose} />
      </div>
    </dialog>
  );
}
