// Public car photos are stored as {id}.webp (1600 px) with {id}-800.webp and {id}-400.webp
// beside it, and served by the KSR server under /media/car-photos (WEB-05: responsive WebP
// with width/height).
export const carPhotoUrl = (path: string, width?: 400 | 800) =>
  `/media/car-photos/${width ? path.replace(/\.webp$/, `-${width}.webp`) : path}`;

export const carPhotoSrcSet = (path: string) =>
  `${carPhotoUrl(path, 400)} 400w, ${carPhotoUrl(path, 800)} 800w, ${carPhotoUrl(path)} 1600w`;

export const carPhotoPaths = (carId: string, photoId: string) => {
  const base = `cars/${carId}/${photoId}`;
  return { full: `${base}.webp`, medium: `${base}-800.webp`, small: `${base}-400.webp` };
};
