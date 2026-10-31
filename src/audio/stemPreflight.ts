/** Bound readiness probes so a lost IPC response cannot trap the job monitor. */
export async function withStemPreflightTimeout<T>(operation: Promise<T>, timeoutMs = 30_000, signal?: { readonly aborted: boolean }): Promise<T> {
  let cancelTimer: ReturnType<typeof setInterval> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        const check = () => {
          if (signal?.aborted) reject(Object.assign(new Error('Stem-Vorbereitung abgebrochen.'), { code: 'INFERENCE_CANCELLED' }));
        };
        if (signal) { check(); cancelTimer = setInterval(check, 50); }
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Die Stem-Engine antwortet nicht. Bitte erneut versuchen oder die Diagnose öffnen.')), timeoutMs);
      }),
    ]);
  } finally {
    if (cancelTimer !== undefined) clearInterval(cancelTimer);
    if (timer !== undefined) clearTimeout(timer);
  }
}
