// Which KSR server the app talks to. The default comes from the build (app.config.ts →
// EXPO_PUBLIC_API_URL, the live site); Settings can change it, for example to a computer on
// the office Wi-Fi while testing.
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { normalizeServerUrl } from './url';

const KEY = 'ksr.serverUrl';

export const DEFAULT_SERVER_URL =
  normalizeServerUrl(String((Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ?? '')) ??
  'https://ksr-self-drive-cars.onrender.com';

let current = DEFAULT_SERVER_URL;

/** The server address in use (read by the API client). */
export const serverUrl = () => current;

interface ServerState {
  url: string;
  isDefault: boolean;
  setUrl: (url: string | null) => Promise<void>;
}

const Ctx = createContext<ServerState | null>(null);

export function ServerProvider({ children, onChange }: { children: ReactNode; onChange?: () => void }) {
  const [url, setState] = useState<string | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(KEY)
      .then((saved) => {
        current = (saved && normalizeServerUrl(saved)) || DEFAULT_SERVER_URL;
        setState(current);
      })
      .catch(() => setState(DEFAULT_SERVER_URL));
  }, []);

  const setUrl = useCallback(
    async (next: string | null) => {
      current = next ?? DEFAULT_SERVER_URL;
      if (next) await AsyncStorage.setItem(KEY, next);
      else await AsyncStorage.removeItem(KEY);
      setState(current);
      onChange?.();
    },
    [onChange],
  );

  if (!url) return null; // a moment at start-up, behind the splash screen
  return <Ctx.Provider value={{ url, isDefault: url === DEFAULT_SERVER_URL, setUrl }}>{children}</Ctx.Provider>;
}

export function useServer(): ServerState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useServer outside ServerProvider');
  return v;
}
