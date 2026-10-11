// Public car photos live in the public car-photos bucket as {id}.webp (1600 px) with
// {id}-800.webp and {id}-400.webp beside it (WEB-05: responsive WebP with width/height).
import { SUPABASE_URL } from '@/integrations/supabase/client';

export const carPhotoUrl = (path: string, width?: 400 | 800) =>
  `${SUPABASE_URL}/storage/v1/object/public/car-photos/${width ? path.replace(/\.webp$/, `-${width}.webp`) : path}`;

export const carPhotoSrcSet = (path: string) =>
  `${carPhotoUrl(path, 400)} 400w, ${carPhotoUrl(path, 800)} 800w, ${carPhotoUrl(path)} 1600w`;

export const carPhotoPaths = (carId: string, photoId: string) => {
  const base = `cars/${carId}/${photoId}`;
  return { full: `${base}.webp`, medium: `${base}-800.webp`, small: `${base}-400.webp` };
};
