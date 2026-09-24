export function shouldSynthesizeMouseClick(event: {
  nativeActivationSeen: boolean;
  pointerDownObserved: boolean;
  isTrusted: boolean;
  button: number;
}): boolean {
  return (
    event.nativeActivationSeen &&
    !event.pointerDownObserved &&
    event.isTrusted &&
    event.button === 0
  );
}
