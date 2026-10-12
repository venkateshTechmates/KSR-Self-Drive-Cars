// @vitest-environment jsdom
// The Android app's adaptations (src/lib/native.ts, src/lib/download.ts), with the native
// plugins replaced by fakes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSharedFiles, safeFileName, saveFile } from './download';
import { handleBackButton, isNativeApp, newTabTarget } from './native';

const fs = vi.hoisted(() => ({
  writeFile: vi.fn(async ({ path }: { path: string }) => ({ uri: `file:///cache/${path}` })),
  rmdir: vi.fn(async () => undefined),
}));
const share = vi.hoisted(() => ({ share: vi.fn(async () => ({})) }));
vi.mock('@capacitor/filesystem', () => ({ Filesystem: fs, Directory: { Cache: 'CACHE' } }));
vi.mock('@capacitor/share', () => ({ Share: share }));

const setNative = (on: boolean) => {
  (window as unknown as { Capacitor?: unknown }).Capacitor = on ? { isNativePlatform: () => true } : undefined;
};

beforeEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});
afterEach(() => setNative(false));

describe('isNativeApp', () => {
  it('is false in a browser and true inside the app', () => {
    expect(isNativeApp()).toBe(false);
    setNative(true);
    expect(isNativeApp()).toBe(true);
  });
});

describe('the Android back button', () => {
  const run = (canGoBack: boolean) => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    const exit = vi.fn();
    handleBackButton(canGoBack, exit);
    return { back, exit };
  };

  it('asks the top dialog to close, as Escape would (a saving dialog can refuse)', () => {
    document.body.innerHTML = '<dialog open id="a"></dialog><dialog open id="b"></dialog>';
    const top = document.getElementById('b') as HTMLDialogElement;
    const onCancel = vi.fn((e: Event) => e.preventDefault());
    top.addEventListener('cancel', onCancel);
    top.close = vi.fn();
    const { back, exit } = run(true);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(top.close).not.toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('closes a dialog that does not handle cancel itself', () => {
    document.body.innerHTML = '<dialog open></dialog>';
    const dialog = document.querySelector('dialog')!;
    dialog.close = vi.fn();
    run(true);
    expect(dialog.close).toHaveBeenCalledOnce();
  });

  it('closes the admin menu drawer', () => {
    document.body.innerHTML = '<div role="dialog" aria-modal="true"><button aria-label="Close menu"></button></div>';
    const click = vi.fn();
    document.querySelector('button')!.addEventListener('click', click);
    const { back } = run(true);
    expect(click).toHaveBeenCalledOnce();
    expect(back).not.toHaveBeenCalled();
  });

  it('goes back a page, or leaves the app on the first page', () => {
    expect(run(true).back).toHaveBeenCalledOnce();
    const first = run(false);
    expect(first.exit).toHaveBeenCalledOnce();
  });
});

describe('links that would open a new tab', () => {
  const here = 'https://www.ksr.example/book/kia-sonet';
  it('leave other sites and apps to Android', () => {
    expect(newTabTarget('https://wa.me/919876543210', here)).toBe('external');
    expect(newTabTarget('https://maps.google.com/?q=ksr', here)).toBe('external');
  });
  it('open our public pages in the in-app browser and admin pages in the app', () => {
    expect(newTabTarget('/privacy', here)).toBe('browser');
    expect(newTabTarget('https://www.ksr.example/terms', here)).toBe('browser');
    expect(newTabTarget('/admin/bookings/KSR-261011-001', here)).toBe('same-view');
  });
});

describe('saving files', () => {
  it('downloads in a browser', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const clicked: Array<{ href: string; download: string }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download });
    });
    await saveFile(new Blob(['a,b']), 'bookings.csv');
    expect(clicked).toEqual([{ href: 'blob:x', download: 'bookings.csv' }]);
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('opens the share sheet in the app, after clearing earlier shared files', async () => {
    setNative(true);
    await saveFile(new Blob(['a,b']), 'KSR bookings (Oct).csv');
    expect(fs.rmdir).toHaveBeenCalledWith({ path: 'share', directory: 'CACHE', recursive: true });
    expect(fs.writeFile).toHaveBeenCalledWith({ path: 'share/KSR_bookings_Oct_.csv', data: btoa('a,b'), directory: 'CACHE', recursive: true });
    expect(share.share).toHaveBeenCalledWith({ title: 'KSR bookings (Oct).csv', files: ['file:///cache/share/KSR_bookings_Oct_.csv'], dialogTitle: 'Save or send' });
  });

  it('treats closing the share sheet as fine, and reports real failures', async () => {
    setNative(true);
    share.share.mockRejectedValueOnce(new Error('Share canceled'));
    await expect(saveFile(new Blob(['x']), 'a.txt')).resolves.toBeUndefined();
    share.share.mockRejectedValueOnce(new Error('No app can open this file'));
    await expect(saveFile(new Blob(['x']), 'a.txt')).rejects.toThrow('No app can open this file');
  });

  it('clears shared files only inside the app', async () => {
    await clearSharedFiles();
    expect(fs.rmdir).not.toHaveBeenCalled();
  });

  it('makes file names safe', () => {
    expect(safeFileName('customer data/../x.json')).toBe('customer_data_.._x.json');
    expect(safeFileName('???')).toBe('_');
  });
});
