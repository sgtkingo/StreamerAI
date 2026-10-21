import { useEffect, useMemo, useState } from "react";
import { createAdvancingClock } from "./clock";
import type { DeviceEnvironment } from "./storage";

/** A live Settings clock, isolated from the theme provider's minute cadence. */
export function useLocalClock(environment: DeviceEnvironment): Date {
  const clock = useMemo(() => createAdvancingClock(environment), [environment]);
  const [instant, setInstant] = useState(() => clock.now());

  useEffect(() => {
    let timer = 0;
    const synchronize = () => {
      window.clearTimeout(timer);
      clock.reconcile();
      const now = clock.now();
      setInstant(now);
      // Hidden Settings do no per-second work. Resume catches up immediately.
      if (!document.hidden) {
        const remainder = ((now.getTime() % 1000) + 1000) % 1000;
        timer = window.setTimeout(synchronize, 1000 - remainder);
      }
    };
    synchronize();
    window.addEventListener("focus", synchronize);
    document.addEventListener("visibilitychange", synchronize);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", synchronize);
      document.removeEventListener("visibilitychange", synchronize);
    };
  }, [clock]);

  return instant;
}
