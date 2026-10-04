/**
 * Entwicklungsharness: Statusfenster des Fernpfads mit Testdatensätzen.
 *
 * Warum diese Seite existiert
 * ---------------------------
 * Der Laufzettel ist genau dann wichtig, wenn **nichts** vorangeht – man kann
 * ihn also nicht bequem im Betrieb begutachten, ohne einen Colab-Lauf hängen
 * zu lassen. Diese Seite rendert dieselbe Komponente mit vier Datensätzen
 * (`src/flowPreviewScenarios.ts`), die die typischen Lagen abbilden: wartend,
 * rechnend, fertig, geendet.
 *
 * Die Zustände werden nicht von Hand gemalt: jeder Datensatz läuft durch
 * `buildRemoteDataFlow()`, also dieselbe Logik, die auch der Editor benutzt.
 *
 * Nur für den Dev-Server (`npm run dev` → /flow-preview.html).
 * Nicht Teil des Produktions-Builds (Vite baut ausschließlich index.html).
 */
import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RemoteFlowModal } from './components/Modals/RemoteFlowModal';
import { PREVIEW_SCENARIOS, type FlowPreviewScenarioId, JOB_ID } from './flowPreviewScenarios';
import './index.css';

const FlowPreview: React.FC = () => {
  const [scenario, setScenario] = useState<FlowPreviewScenarioId>('waiting');
  const [confirmedAt, setConfirmedAt] = useState<number | null>(null);

  const { job, status } = useMemo(() => {
    const built = PREVIEW_SCENARIOS[scenario].build();
    // Eine Bestätigung hakt im Editor den Datensatz selbst ab
    // (`confirmCloudSync`). Für die Vorschau genügt es, dieselbe Wirkung auf
    // die berechnete Station abzubilden – die Logik dahinter bleibt dieselbe.
    if (confirmedAt && built.job.flow) {
      built.job.flow = {
        ...built.job.flow,
        awaitingCloudConfirmation: false,
        stations: built.job.flow.stations.map((station) =>
          station.id === 'cloud_sync'
            ? {
                ...station,
                state: 'done',
                at: confirmedAt,
                detail: 'Von Ihnen im Google-Drive-Ordner gesehen – eine Bestätigung, keine technische Prüfung.',
                facts: [
                  { label: 'Bestätigt', value: new Date(confirmedAt).toLocaleTimeString('de-DE', { hour12: false }) },
                  { label: 'Pfad in Drive', value: `jobs/${JOB_ID}/input/` },
                ],
                hint: undefined,
              }
            : station
        ),
      };
    }
    return built;
  }, [scenario, confirmedAt]);

  return (
    <div className="min-h-full bg-[#070a0e] p-6 text-neutral-200">
      <div className="mx-auto max-w-3xl">
        <div className="mb-4 rounded-xl border border-white/10 bg-white/[.03] p-4">
          <div className="text-[10px] uppercase tracking-[.2em] text-cyan-400">Nur für den Dev-Server</div>
          <h1 className="mt-1 text-lg font-bold">Laufzettel-Vorschau – Fernpfad</h1>
          <p className="mt-1 text-xs text-neutral-400">
            Dieselbe Komponente wie im Editor, mit Testdatensätzen. Die Zustände werden aus echten Datensätzen berechnet
            (<span className="font-mono">buildRemoteDataFlow</span>) – hier wird nichts gezeichnet, was die Logik im Betrieb nicht
            auch liefert.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {(Object.keys(PREVIEW_SCENARIOS) as FlowPreviewScenarioId[]).map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  setScenario(id);
                  setConfirmedAt(null);
                }}
                className={`rounded-lg border px-3 py-1.5 text-xs font-semibold ${
                  id === scenario
                    ? 'border-cyan-400/60 bg-cyan-500/15 text-cyan-100'
                    : 'border-white/15 text-neutral-400 hover:text-neutral-100'
                }`}
              >
                {PREVIEW_SCENARIOS[id].label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-neutral-500">{PREVIEW_SCENARIOS[scenario].hint}</p>
        </div>
      </div>

      <RemoteFlowModal
        open
        onClose={() => undefined}
        onCancel={() => undefined}
        onRefresh={() => undefined}
        onConfirmCloudSync={() => setConfirmedAt(Date.now())}
        status={status}
        job={job}
        trackName="Nightdrive (Extended Mix)"
        running={job.status !== 'COMPLETED' && job.status !== 'FAILED' && job.status !== 'CANCELLED'}
        error={null}
        phaseText={undefined}
      />
    </div>
  );
};

// Beim serverseitigen Rendern (Tests) gibt es kein #root – dann bleibt der
// Harness unbeteiligt, statt den Import zu sprengen.
const container = typeof document === 'undefined' ? null : document.getElementById('root');
if (container) createRoot(container).render(<FlowPreview />);
