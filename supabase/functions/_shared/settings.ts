// Load rows from the `settings` table, merged over the defaults in domain/settings.ts.
import { type SettingsKey, type SettingsMap, withDefaults } from './domain/settings.ts';
import type { Client } from './clients.ts';
import { fromPgError } from './http.ts';

export async function loadSettings<K extends SettingsKey>(
  client: Client,
  keys: readonly K[],
): Promise<Pick<SettingsMap, K>> {
  const { data, error } = await client.from('settings').select('key, value').in('key', [...keys]);
  if (error) throw fromPgError(error, 'settings');
  const rows = new Map<string, unknown>(
    ((data ?? []) as Array<{ key: string; value: unknown }>).map((r) => [r.key, r.value]),
  );
  const out = {} as Pick<SettingsMap, K>;
  for (const key of keys) out[key] = withDefaults(key, rows.get(key));
  return out;
}
