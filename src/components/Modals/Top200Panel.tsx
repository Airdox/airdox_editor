import React, { useEffect, useRef, useState } from 'react';
import type { BatchTrack, BatchEntry, Top200Batch } from '../../stems/remote/top200Batch';

async function request(action: string, tracks?: BatchTrack[], id?: string, modelId?: string) {
  const desktop = (window as any).rekordboxDesktop?.stemEngine;
  const result = desktop?.top200 ? await desktop.top200(action, tracks, id, modelId) : await fetch(`/api/stems/remote/top200/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tracks, id, modelId }) }).then(response => response.json());
  if (!result.ok) throw new Error(result.message);
  return result.data;
}
export function Top200Panel({ loadTracks, modelId, libraryName, libraryRevision }: { loadTracks: () => Promise<BatchTrack[]>; modelId: string; libraryName: string; libraryRevision: number }) {
  const [entries, setEntries] = useState<BatchEntry[]>([]);
  const [preparedTracks, setPreparedTracks] = useState<BatchTrack[]>([]);
  const [preparedRevision, setPreparedRevision] = useState(-1);
  const revision = useRef(libraryRevision);
  revision.current = libraryRevision;
  const [batches, setBatches] = useState<Top200Batch[]>([]);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setPreparedTracks([]); if (!selected) setEntries([]); }, [libraryRevision]);
  useEffect(() => { void request('list').then(setBatches).catch(reason => setError(String(reason))); }, []);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    const refresh = () => request('refresh', undefined, selected).then((batch: Top200Batch) => { if (active) { setEntries(batch.entries); setError(batch.error || (batch.published ? '' : 'Übertragung läuft; Colab erst nach Veröffentlichung starten.')); } }).catch(reason => { if (active) setError(String(reason)); });
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [selected]);
  const run = async (action: 'preview' | 'create') => {
    setBusy(true); setError('');
    try {
      const requestedRevision = libraryRevision;
      if (action === 'create' && preparedRevision !== libraryRevision) throw new Error('Sammlung wurde aktualisiert. Top 200 erneut prüfen.');
      const tracks = action === 'create' ? preparedTracks : (await loadTracks()).map(track => ({ id: track.id, title: track.title, playCount: track.playCount, originalMedia: track.originalMedia, databaseRecord: track.databaseRecord }));
      const data = await request(action, tracks, undefined, modelId);
      if (action === 'preview') {
        if (requestedRevision !== revision.current) throw new Error('Sammlung wurde während der Prüfung aktualisiert. Top 200 erneut prüfen.');
        setPreparedTracks(tracks); setPreparedRevision(requestedRevision); setSelected(''); setEntries(data);
      }
      else { setSelected(data.id); setBatches(await request('list')); setEntries(data.entries); }
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  return <section className="border border-neutral-700 rounded p-3 space-y-2">
    <h3 className="font-bold">Rekordbox Top 200 · Colab-Stapel</h3>
    <p>Importierte Sammlung: {libraryName}</p>
    <p>Editor-Modell: {modelId} · Neue Stapel übernehmen diese Auswahl; gespeicherte Stapel behalten ihr Modell.</p>
    <p>Auswahl nach Abspielzähler. Fehlende Dateien bleiben ihrem Rang zugeordnet. Für Audiokonvertierung wird ffmpeg benötigt.</p>
    <button disabled={busy} onClick={() => void run('preview')} className="p-2 border rounded">Top 200 prüfen</button>{' '}
    <button disabled={busy || preparedRevision !== libraryRevision || !entries.some(entry => entry.status === 'READY') || !!selected} onClick={() => void run('create')} className="p-2 border rounded">Stapel übertragen</button>
    <select value={selected} onChange={event => setSelected(event.target.value)} className="bg-neutral-900 w-full p-2"><option value="">Gespeicherten Stapel auswählen</option>{batches.map(batch => <option key={batch.id} value={batch.id}>{batch.id}</option>)}</select>
    {selected && <p>Colab BATCH_ID: <code className="select-text">{selected}</code> · {entries.filter(entry => !!entry.localJobId).length}/{entries.length} importiert</p>}
    {selected && <button disabled={busy} onClick={() => { setBusy(true); void request('retry', undefined, selected).then(batch => setEntries(batch.entries)).catch(reason => setError(String(reason))).finally(() => setBusy(false)); }}>Fehler erneut versuchen / Übertragung fortsetzen</button>}
    {error && <p role="alert">{error}</p>}
    <ol className="max-h-48 overflow-auto select-text">{entries.map((entry, index) => <li key={entry.track.id}>{index + 1}. {entry.track.title || entry.track.id} · {entry.track.playCount ?? 0} Plays · {entry.status} {entry.percent}% {entry.error} {entry.localJobId && `→ ${entry.localJobId}`}</li>)}</ol>
  </section>;
}
