let lockCount = 0;
let previousOverflow = "";

/** Keep document scrolling disabled until every open modal releases its lock. */
export function lockBodyScroll(): () => void {
  if (lockCount === 0) previousOverflow = document.body.style.overflow;
  lockCount += 1;
  document.body.style.overflow = "hidden";

  let released = false;
  return () => {
    if (released) return;
    released = true;
    lockCount = Math.max(0, lockCount - 1);
    if (lockCount === 0) document.body.style.overflow = previousOverflow;
  };
}
