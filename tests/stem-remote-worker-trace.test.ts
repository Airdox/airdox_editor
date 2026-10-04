/**
 * @license
 * airdox_SMART_Editor – Protokollanhänge des Fernworkers dürfen sich nicht
 * verlieren (§40).
 *
 * Warum diese Datei existiert:
 *   Das Ablaufprotokoll ist die einzige Stelle, an der ein hängender Lauf
 *   erklärt wird. Der Worker hängt eine Zeile an, indem er die Datei liest,
 *   die Zeile anfügt und alles zurückschreibt. Laufen zwei solcher Vorgänge
 *   gleichzeitig – eine Fortschrittsmeldung parallel zu „Inferenz gestartet“
 *   –, gewinnt der spätere Schreibvorgang und die frühere Zeile ist weg.
 *
 *   In der CI traf das `worker.inference_started`: der Lauf war danach
 *   abgeschlossen, aber das Protokoll behauptete, die Rechnung habe nie
 *   begonnen. Deshalb müssen Anhänge an dieselbe Datei hintereinander laufen.
 *
 * Run with: npx tsx tests/stem-remote-worker-trace.test.ts
 */

import assert from 'node:assert/strict';
import { appendCappedLine } from '../scripts/stem-remote-worker';
import type { IRemoteTransport } from '../src/stems/remote/transport';

/** Ablage im Speicher – mit Verzögerung, damit die Vorgänge sich überlappen. */
class MemoryTransport {
  public readonly files = new Map<string, string>();

  public constructor(private readonly delayMs: number) {}

  public async readText(relative: string): Promise<string | null> {
    await sleep(this.delayMs);
    return this.files.get(relative) ?? null;
  }

  public async writeText(relative: string, content: string): Promise<void> {
    await sleep(this.delayMs);
    this.files.set(relative, content);
  }

  public asTransport(): IRemoteTransport {
    return this as unknown as IRemoteTransport;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const lines = (value: string | null) => (value ?? '').split('\n').filter(Boolean);

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  FERNWORKER – PROTOKOLLANHÄNGE GEHEN NICHT VERLOREN             ');
console.log('═══════════════════════════════════════════════════════════════════');

console.log('\n[ TEST ] 1 – Gleichzeitige Meldungen landen alle in der Datei');
{
  const store = new MemoryTransport(1);
  const transport = store.asTransport();
  const steps = Array.from({ length: 12 }, (_unused, index) => `worker.schritt_${index}`);
  // Absichtlich **nicht** hintereinander: genau diese Gleichzeitigkeit hat in
  // der CI eine Meldung geschluckt.
  await Promise.all(steps.map((step) => appendCappedLine(transport, 'jobs/job-1/logs/worker.jsonl', step)));
  const written = lines(store.files.get('jobs/job-1/logs/worker.jsonl') ?? null);
  assert.equal(written.length, steps.length, `alle ${steps.length} Meldungen stehen in der Datei`);
  for (const step of steps) {
    assert.ok(written.includes(step), `${step} darf nicht verloren gehen`);
  }
  console.log(`  ✓ ${steps.length} gleichzeitige Meldungen, keine verloren`);
}

console.log('\n[ TEST ] 2 – Die Reihenfolge bleibt erhalten');
{
  const store = new MemoryTransport(1);
  const transport = store.asTransport();
  const steps = ['worker.claimed', 'worker.input_verified', 'worker.inference_started', 'worker.completed'];
  await Promise.all(steps.map((step) => appendCappedLine(transport, 'jobs/job-2/logs/worker.jsonl', step)));
  assert.deepEqual(
    lines(store.files.get('jobs/job-2/logs/worker.jsonl') ?? null),
    steps,
    'das Protokoll bleibt in der Reihenfolge der Meldungen lesbar'
  );
  console.log('  ✓ Reihenfolge der Meldungen bleibt erhalten');
}

console.log('\n[ TEST ] 3 – Die Datei bleibt begrenzt');
{
  const store = new MemoryTransport(0);
  const transport = store.asTransport();
  for (let index = 0; index < 210; index += 1) {
    await appendCappedLine(transport, 'jobs/job-3/logs/worker.jsonl', `worker.zeile_${index}`);
  }
  const written = lines(store.files.get('jobs/job-3/logs/worker.jsonl') ?? null);
  assert.equal(written.length, 200, 'höchstens 200 Zeilen – ältere fallen weg');
  assert.equal(written[written.length - 1], 'worker.zeile_209', 'die neueste Meldung bleibt stehen');
  console.log('  ✓ Protokolldatei bleibt auf 200 Zeilen begrenzt');
}

console.log('\n[ TEST ] 4 – Ein fehlgeschlagener Anhang blockiert die Datei nicht');
{
  const store = new MemoryTransport(1);
  const transport = store.asTransport();
  let failNext = true;
  const flaky = {
    async readText(relative: string) {
      return transport.readText(relative);
    },
    async writeText(relative: string, content: string) {
      if (failNext) {
        failNext = false;
        throw new Error('Ablage kurz nicht erreichbar');
      }
      await transport.writeText(relative, content);
    },
  } as unknown as IRemoteTransport;
  await appendCappedLine(flaky, 'jobs/job-4/logs/worker.jsonl', 'worker.claimed').catch(() => undefined);
  await appendCappedLine(flaky, 'jobs/job-4/logs/worker.jsonl', 'worker.inference_started');
  assert.deepEqual(
    lines(store.files.get('jobs/job-4/logs/worker.jsonl') ?? null),
    ['worker.inference_started'],
    'nach einem Fehlversuch schreibt die nächste Meldung wieder'
  );
  console.log('  ✓ nach einem Fehlversuch läuft die Kette weiter');
}

console.log('\n✔ FERNWORKER-PROTOKOLL: alle Prüfungen bestanden\n');
