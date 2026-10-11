import { useEffect, useState } from 'react';

/**
 * Current time in ms, refreshed every `intervalMs`. Use instead of calling Date.now()
 * during render (keeps components pure for the React Compiler lint rules).
 */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}
