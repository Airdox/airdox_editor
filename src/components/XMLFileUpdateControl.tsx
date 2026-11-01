import { useRef, useState } from 'react';
import {
  commitXmlCollectionUpdate, prepareXmlCollectionUpdate, readXmlCollectionUpdate,
  type XmlCollectionUpdate, type XmlUpdateBridge, type XmlUpdateCommit,
} from '../features/import/xmlCollectionUpdate';

export interface XMLFileUpdateControlProps {
  onUpdate: XmlUpdateCommit;
  currentSourceLabel?: string;
}

export function XMLFileUpdateControl({ onUpdate, currentSourceLabel }: XMLFileUpdateControlProps) {
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [lastUpdate, setLastUpdate] = useState<(XmlCollectionUpdate & { committedAt: number }) | null>(null);
  const bridge = typeof window === 'undefined' ? undefined : (window.rekordboxDesktop as XmlUpdateBridge | undefined);
  const sourceLabel = currentSourceLabel ?? lastUpdate?.sourceLabel;
  const canReread = bridge?.readXmlFile && sourceLabel && /^(?:[a-z]:[\\/]|\/|\\\\)/i.test(sourceLabel);

  async function run(load: () => Promise<XmlCollectionUpdate | null>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const update = await load();
      if (!update) return;
      await commitXmlCollectionUpdate(update, onUpdate);
      setLastUpdate({ ...update, committedAt: Date.now() });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'XML-Datei konnte nicht aktualisiert werden.');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  function selectFile() {
    if (bridge?.chooseXmlFile && bridge.readXmlFile) {
      void run(async () => {
        const selected = await bridge.chooseXmlFile!();
        if (!selected) return null;
        return readXmlCollectionUpdate(selected.path, bridge);
      });
    } else input.current?.click();
  }

  return (
    <section aria-label="XML-Datei-Update" className="space-y-2 text-sm">
      <p>In Rekordbox die Sammlung manuell als XML exportieren. Danach die aktuelle XML-Datei hier auswählen oder erneut einlesen.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={selectFile}>XML-Datei-Update</button>
        {canReread && (
          <button type="button" disabled={busy} onClick={() => void run(() => readXmlCollectionUpdate(sourceLabel, bridge))}>
            Bekannte XML erneut einlesen
          </button>
        )}
      </div>
      <input ref={input} type="file" accept=".xml,application/xml,text/xml" hidden disabled={busy}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) void run(async () => prepareXmlCollectionUpdate({
            data: await file.text(), path: file.name, modifiedAt: file.lastModified,
          }));
        }} />
      <p className="break-all">Quelle: {sourceLabel || 'Keine XML ausgewählt'}</p>
      <div role="status" aria-live="polite">
        {busy ? 'XML wird geprüft und übernommen …' : lastUpdate && <>
          <p>Bibliothek vollständig ersetzt: {lastUpdate.tracks.length} Tracks · {new Date(lastUpdate.committedAt).toLocaleString('de-DE')}</p>
          {lastUpdate.modifiedAt != null && <p>Dateistand: {new Date(lastUpdate.modifiedAt).toLocaleString('de-DE')}</p>}
        </>}
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

export default XMLFileUpdateControl;
