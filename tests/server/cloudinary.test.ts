// Cloudinary file store settings and naming (server/config.ts, server/cloudinary.ts). The
// upload/download calls themselves are checked against a real account by hand; tests never
// touch Cloudinary.
import { describe, expect, it } from 'vitest';
import { cloudinaryEnabled, publicId } from '../../server/cloudinary.ts';
import { cloudinarySettings, config } from '../../server/config.ts';

const settings = (vars: Record<string, string>) => cloudinarySettings((k) => vars[k] ?? '');

describe('Cloudinary settings', () => {
  it('reads CLOUDINARY_URL', () => {
    expect(settings({ CLOUDINARY_URL: 'cloudinary://1234:s3cr%2Bet@democloud' })).toEqual({
      cloudName: 'democloud',
      apiKey: '1234',
      apiSecret: 's3cr+et',
      folder: 'ksr',
    });
  });
  it('reads the three separate settings and a folder', () => {
    expect(
      settings({ CLOUDINARY_CLOUD_NAME: 'c', CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: 's', CLOUDINARY_FOLDER: '/ksr-dev/' }),
    ).toEqual({ cloudName: 'c', apiKey: 'k', apiSecret: 's', folder: 'ksr-dev' });
  });
  it('is off without all three parts, and always off in tests', () => {
    expect(settings({ CLOUDINARY_CLOUD_NAME: 'c', CLOUDINARY_API_KEY: 'k' })).toBeNull();
    expect(settings({})).toBeNull();
    expect(config.cloudinary).toBeNull();
    expect(cloudinaryEnabled()).toBe(false);
  });
});

describe('Cloudinary ids', () => {
  it('keeps document ids with their extension, in a documents folder', () => {
    expect(publicId('documents', 'customers/abc/dl_front/f1.jpg', 'ksr')).toBe('ksr/documents/customers/abc/dl_front/f1.jpg');
  });
  it('stores car photos as images without the .webp (Cloudinary adds the format)', () => {
    expect(publicId('car-photos', 'cars/c1/p1-400.webp', 'ksr')).toBe('ksr/car-photos/cars/c1/p1-400');
  });
});
