import { useCallback, useRef, useState } from 'react';

// Runs one user action (a button press) that may call the API several times. It keeps the button from being pressed
// twice while it runs, remembers the error to show, and keeps idempotency keys: each named call gets a key that is
// kept until the call succeeds, so pressing the button again after a failure repeats the same calls and a call that
// already worked is not done twice.
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const keys = useRef(new Map<string, string>());

  const keyFor = useCallback((name: string): string => {
    let key = keys.current.get(name);
    if (key === undefined) {
      key = crypto.randomUUID();
      keys.current.set(name, key);
    }
    return key;
  }, []);

  const forget = useCallback((...names: string[]) => {
    for (const name of names) keys.current.delete(name);
  }, []);

  const run = useCallback(async (work: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await work();
      return true;
    } catch (caught) {
      setError(caught);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  return { busy, error, keyFor, forget, run, clearError: () => setError(null) };
}
