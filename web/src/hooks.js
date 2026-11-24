import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

/**
 * Polls the scan status: every 1.5 s while a scan runs, every 20 s otherwise.
 * `version` increases whenever a scan finishes, so pages can reload their data.
 */
export function useScan() {
  const [state, setState] = useState(null);
  const [version, setVersion] = useState(0);
  const wasRunning = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const s = await api.scan();
      setState(s);
      if (wasRunning.current && !s.running) setVersion((v) => v + 1);
      wasRunning.current = s.running;
      return s;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    let timer;
    let stopped = false;
    const loop = async () => {
      const s = await refresh();
      if (!stopped) timer = setTimeout(loop, s?.running ? 1500 : 20000);
    };
    loop();
    return () => { stopped = true; clearTimeout(timer); };
  }, [refresh]);

  const start = useCallback(async (opts) => {
    try { setState(await api.startScan(opts)); } catch { /* already running */ }
    wasRunning.current = true;
    setTimeout(refresh, 800);
  }, [refresh]);

  return { state, version, start, refresh };
}
