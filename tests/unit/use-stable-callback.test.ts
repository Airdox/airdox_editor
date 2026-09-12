/**
 * @license
 * The contract of `useStableCallback` — the precondition for every `React.memo`
 * in the app.
 *
 * Two properties must hold at the same time, and each of the obvious shortcuts
 * breaks one of them:
 *  - identity never changes (otherwise memoisation is useless), and
 *  - the call always sees the state of the *current* render (otherwise a click
 *    acts on yesterday's selection — the failure class the edit commands had).
 *
 * Run with: npx vitest run tests/unit/use-stable-callback.test.ts
 */

import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useStableCallback } from '../../src/utils/useStableCallback';

describe('useStableCallback — Latest-Ref-Muster', () => {
  it('keeps one identity across renders', () => {
    const { result, rerender } = renderHook(({ value }) => {
      const run = useStableCallback(() => value);
      return { run, value };
    }, { initialProps: { value: 1 } });

    const first = result.current.run;
    rerender({ value: 2 });
    rerender({ value: 3 });
    expect(result.current.run).toBe(first);
  });

  it('calls the implementation of the latest render, not the first one', () => {
    const seen: number[] = [];
    const { result, rerender } = renderHook(({ value }) => {
      const run = useStableCallback((v: number) => {
        seen.push(v + value);
      });
      return run;
    }, { initialProps: { value: 10 } });

    act(() => result.current(1));
    rerender({ value: 100 });
    act(() => result.current(1));
    rerender({ value: 1000 });
    act(() => result.current(2));

    // 1+10, then 1+100, then 2+1000 — every call saw the state of its own render.
    expect(seen).toEqual([11, 101, 1002]);
  });

  it('returns whatever the callback returns', () => {
    const { result } = renderHook(() => useStableCallback((a: number, b: number) => a * b));
    let produced: number | undefined;
    act(() => {
      produced = result.current(6, 7);
    });
    expect(produced).toBe(42);
  });
});
