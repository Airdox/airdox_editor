/**
 * @license
 * Stable callback identity with always-current closure values.
 *
 * Why this exists: the hot child components (palette, deck view, browser bar) are
 * wrapped in `React.memo` so a 60 fps playhead tick does not re-render them. That
 * only works while their props keep their identity — and every inline arrow in the
 * JSX (`onSelectClip={(clip) => …}`) is a brand-new function per render, which
 * makes the memo useless. The obvious alternative, `useCallback` with a dependency
 * list, then re-creates the callback whenever any of the ~20 state values it reads
 * changes… and if the list is trimmed for convenience, the callback silently keeps
 * a stale selection or playhead. That trade-off is exactly what produced the edit
 * bugs of the previous session (a command acting on the state of an older render).
 *
 * The pattern here is React's documented "latest ref" idiom: the *callback* is
 * stable forever, the *implementation* is the one from the current render. Safe for
 * event handlers, which always run after the render that created them — never call
 * the result during rendering.
 */

import { useCallback, useLayoutEffect, useRef } from 'react';

type AnyFn = (...args: never[]) => unknown;

export function useStableCallback<T extends AnyFn>(fn: T): T {
  const ref = useRef<T>(fn);

  useLayoutEffect(() => {
    // Updated after every render, before the browser paints — so a click or a key
    // press can never see an implementation from an outdated render.
    ref.current = fn;
  });

  return useCallback(((...args: Parameters<T>) => ref.current(...args)) as unknown as T, []);
}
