/**
 * Bound a promise that talks to the browser.
 *
 * This exists because of one specific habit of the platform: the browser stops serving
 * certain things to a page it does not consider visible — the compositor, the frame
 * clock, and the media pipeline that answers `VideoDecoder.isConfigSupported`. A call
 * into one of those does not fail when that happens. It simply never comes back, and a
 * promise that never settles is worse than one that rejects: rejection has a handler
 * waiting for it, and silence has nothing.
 *
 * So the callers here treat silence as an answer. `onExpire` supplies what to say when
 * nobody says anything — a conservative value for a question that only needs an
 * approximate answer, or a throw for a question that genuinely has to be answered.
 *
 * Rejection is passed straight through: an explicit failure is a real answer and should
 * be handled as one, not papered over with the fallback.
 */
export function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  onExpire: () => T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // One-shot: whichever arrives first settles the promise, and the loser is dropped.
    // Without this a slow answer could call `onExpire` *after* the real one resolved,
    // which for a state-carrying fallback would be a silent regression.
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        resolve(onExpire());
      } catch (cause) {
        // `onExpire` is allowed to refuse — that is how a caller turns a deadline into a
        // real error when there is no honest value to fall back to.
        reject(cause);
      }
    }, ms);

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    promise.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    );
  });
}
