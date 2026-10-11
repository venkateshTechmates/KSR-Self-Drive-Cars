// Upload state for handover photos (HND-01, HND-03): each photo uploads as soon as it is taken.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { uploadDocument } from '@/lib/documents';
import { errorMessage } from '@/lib/errors';
import { qk } from '@/admin/hooks/queries';

export interface SlotState {
  count: number;
  uploading: number;
  error: string | null;
}

export interface Slot {
  key: string;
  label: string;
}

export const EMPTY_SLOT: SlotState = { count: 0, uploading: 0, error: null };

export interface PhotoUploads {
  slots: Record<string, SlotState>;
  upload: (slot: Slot, files: File[]) => Promise<void>;
  busy: boolean;
  total: number;
  has: (key: string) => boolean;
}

/** Upload state for one document type on a booking (pickup_photos, return_photos, damage_photos). */
export function usePhotoUploads(bookingId: string, docType: string): PhotoUploads {
  const queryClient = useQueryClient();
  const [slots, setSlots] = useState<Record<string, SlotState>>({});

  const patch = (key: string, fn: (s: SlotState) => SlotState) => setSlots((all) => ({ ...all, [key]: fn(all[key] ?? EMPTY_SLOT) }));

  async function upload(slot: Slot, files: File[]) {
    if (!files.length) return;
    patch(slot.key, (s) => ({ ...s, uploading: s.uploading + files.length, error: null }));
    for (const file of files) {
      try {
        await uploadDocument({ ownerType: 'booking', ownerId: bookingId, docType, file, notes: slot.label });
        patch(slot.key, (s) => ({ ...s, count: s.count + 1, uploading: s.uploading - 1 }));
      } catch (err) {
        patch(slot.key, (s) => ({ ...s, uploading: s.uploading - 1, error: `${errorMessage(err)} Try again.` }));
      }
    }
    void queryClient.invalidateQueries({ queryKey: qk.documents });
  }

  const list = Object.values(slots);
  return {
    slots,
    upload,
    busy: list.some((s) => s.uploading > 0),
    total: list.reduce((n, s) => n + s.count, 0),
    has: (key) => (slots[key]?.count ?? 0) > 0,
  };
}
