import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const paths = {
  pair: "M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h3v3h3v3h-6zM12 3v3m0 6h3m6 0v3M3 12h3m6 3v6",
  household: "m3 10 9-7 9 7M5 9v12h14V9M9 21v-8h6v8",
  cloud: "M7 18h11a4 4 0 0 0 .4-8A6.5 6.5 0 0 0 6 8.5 4.8 4.8 0 0 0 7 18Z",
  profiles:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 4a4 4 0 0 1 0 8m6 9v-2a4 4 0 0 0-3-3.9M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  devices: "M3 4h18v13H3zM8 21h8m-4-4v4",
  services: "M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-12 0V8Zm6 9v4",
  backups: "M3 11a9 9 0 1 1 2.6 7M3 4v7h7m2-4v5l3 2",
  security: "m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Zm-4 9 3 3 5-6",
  support:
    "M9 9a3 3 0 1 1 5 2c-2 1-2 2-2 3m0 3h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z",
  arrow: "M7 17 17 7M7 7h10v10",
  check: "m5 12 4 4L19 6",
  lock: "M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5zM12 14v3",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7",
  download: "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5",
  info: "M12 11v6m0-10h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z",
  clock: "M12 7v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z",
} as const;

export type AdminIconName = keyof typeof paths;
export function AdminIcon({ name }: { name: AdminIconName }) {
  return (
    <svg
      className="admin-icon"
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  );
}

export function AdminStatus({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "success" | "warning" | "danger" | "neutral";
}) {
  return (
    <span className={`admin-status admin-status--${tone}`}>
      <span aria-hidden="true" />
      {children}
    </span>
  );
}

export function AdminNote({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: "info" | "warning";
}) {
  return (
    <div className={`admin-note admin-note--${tone}`}>
      <AdminIcon name={tone === "warning" ? "security" : "info"} />
      <div>{children}</div>
    </div>
  );
}

export function AdminHelp({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    above: boolean;
  } | null>(null);
  const show = useCallback(() => {
    const rect = button.current?.getBoundingClientRect();
    if (!rect) return;
    if (rect.bottom < 0 || rect.top > window.innerHeight) {
      setPosition(null);
      return;
    }
    const above = window.innerHeight - rect.bottom < 180;
    setPosition({
      left: Math.max(
        16,
        Math.min(
          rect.left - 120,
          window.innerWidth - Math.min(290, window.innerWidth - 32) - 16,
        ),
      ),
      top: above ? rect.top - 10 : rect.bottom + 10,
      above,
    });
  }, []);
  const open = position !== null;
  useEffect(() => {
    if (!open) return;
    const reposition = () => {
      // Keyboard focus may scroll the trigger into view. Keep its help open
      // through that scroll and viewport changes, anchored to the new position.
      if (document.activeElement === button.current) show();
      else setPosition(null);
    };
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open, show]);
  return (
    <>
      <button
        ref={button}
        type="button"
        className="admin-help"
        aria-label={label}
        aria-describedby={position ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={() => {
          if (document.activeElement !== button.current) setPosition(null);
        }}
        onFocus={show}
        onBlur={() => setPosition(null)}
        onClick={show}
        onKeyDown={(event) => {
          if (event.key === "Escape") setPosition(null);
        }}
      >
        <AdminIcon name="info" />
      </button>
      {position &&
        createPortal(
          <span
            id={id}
            role="tooltip"
            className="admin-help__tooltip"
            style={{
              left: position.left,
              top: position.top,
              transform: position.above ? "translateY(-100%)" : undefined,
            }}
          >
            {children}
          </span>,
          document.body,
        )}
    </>
  );
}
