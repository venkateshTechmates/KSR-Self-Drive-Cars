import { withDefaults, type SettingsKey, type SettingsMap } from '../shared/settings.ts';
import { one } from './db/connection.ts';

/** A settings value merged over defaults (so new fields never arrive undefined). */
export function getSetting<K extends SettingsKey>(key: K): SettingsMap[K] {
  const row = one<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
  let parsed: unknown = null;
  try {
    parsed = row ? JSON.parse(row.value) : null;
  } catch {
    parsed = null;
  }
  return withDefaults(key, parsed);
}

/** A numeric booking rule (SET-02) with a fallback. */
export function bookingRule(name: keyof SettingsMap['booking_rules'], fallback: number): number {
  const v = getSetting('booking_rules')[name];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function retentionSetting(name: keyof SettingsMap['retention'], fallback: number): number {
  const v = getSetting('retention')[name];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** "privacy-en-v1": the notice version a customer agrees to (SET-03). */
export function currentNoticeVersion(locale = 'en'): string {
  const row = one<{ version: number; locale: string }>(
    `SELECT version, locale FROM policy_versions WHERE kind = 'privacy' AND locale = ? ORDER BY version DESC LIMIT 1`,
    locale,
  );
  return row ? `privacy-${row.locale}-v${row.version}` : 'privacy-en-v0';
}
