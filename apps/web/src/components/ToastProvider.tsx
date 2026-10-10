import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type ToastKind = "info" | "success" | "warning" | "error";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastEntry {
  id: number;
  message: string;
  kind: ToastKind;
  action?: ToastAction;
}

interface ToastContextValue {
  showToast: (
    message: string,
    kind?: ToastKind,
    options?: { action?: ToastAction },
  ) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);
const NOOP_TOAST_CONTEXT: ToastContextValue = { showToast: () => undefined };

export function useToasts(): ToastContextValue {
  return useContext(ToastContext) ?? NOOP_TOAST_CONTEXT;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastEntry[]>([]);
  const itemsRef = useRef(items);
  const nextIdRef = useRef(0);
  const itemRefs = useRef(new Map<number, HTMLDivElement>());
  const [heights, setHeights] = useState<Record<number, number>>({});

  const showToast = useCallback<ToastContextValue["showToast"]>(
    (message, kind = "info", options = {}) => {
      const next = [
        ...itemsRef.current.filter(
          (item) =>
            item.action ||
            options.action ||
            item.message !== message ||
            item.kind !== kind,
        ),
        {
          id: ++nextIdRef.current,
          message,
          kind,
          action: options.action,
        },
      ];
      itemsRef.current = next;
      setItems(next);
    },
    [],
  );

  const dismissToast = useCallback((id: number) => {
    const entry = itemsRef.current.find((item) => item.id === id);
    if (!entry) return;
    const next = itemsRef.current.filter((item) => item.id !== id);
    itemsRef.current = next;
    setItems(next);
  }, []);

  useLayoutEffect(() => {
    const measure = () => {
      const next: Record<number, number> = {};
      for (const item of items) {
        const element = itemRefs.current.get(item.id);
        if (element) next[item.id] = element.offsetHeight;
      }
      setHeights((current) => {
        const currentIds = Object.keys(current);
        const nextIds = Object.keys(next);
        if (
          currentIds.length === nextIds.length &&
          nextIds.every((id) => current[Number(id)] === next[Number(id)])
        ) {
          return current;
        }
        return next;
      });
    };
    window.addEventListener("resize", measure);
    measure();
    return () => {
      window.removeEventListener("resize", measure);
    };
  }, [items]);

  const contextValue = useMemo(() => ({ showToast }), [showToast]);
  let offset = 0;

  return (
    <ToastContext.Provider value={contextValue}>
      <div className="toast-stack" aria-label="Notifications">
        {items.map((item) => {
          const itemOffset = offset;
          offset += (heights[item.id] ?? 56) + 10;
          return (
            <div
              key={item.id}
              className="toast-stack__item"
              ref={(element) => {
                if (element) itemRefs.current.set(item.id, element);
                else itemRefs.current.delete(item.id);
              }}
              style={{ transform: `translateY(${itemOffset}px)` }}
            >
              <div
                className={`toast-message toast-message--${item.kind}`}
                role={item.kind === "error" ? "alert" : "status"}
                onAnimationEnd={() => dismissToast(item.id)}
              >
                <span>{item.message}</span>
                {item.action && (
                  <button
                    type="button"
                    className="toast-message__action"
                    onClick={() => {
                      item.action?.onClick();
                      dismissToast(item.id);
                    }}
                  >
                    {item.action.label}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {children}
    </ToastContext.Provider>
  );
}
