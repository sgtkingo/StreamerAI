export function ComposingLabel() {
  return (
    <span className="composing-label">
      Composing<span className="composing-label__dots" aria-hidden="true" />
    </span>
  );
}

export function ComposingDots() {
  return (
    <span
      className="composing-dots"
      role="status"
      aria-label="Composing"
    />
  );
}
