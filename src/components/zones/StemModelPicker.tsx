/**
 * @license
 * airdox_SMART_Editor – Ausgelagerte Modell-Auswahl (Zone 2, aus dem Zahnrad).
 *
 * Kernanforderung des Master-Plans (Modell-Isolation):
 *   Im Konfigurations-Panel des Stem-Centers existiert optisch NUR das aktive
 *   Modell. Alle anderen Engines (alternative Vocal-/Instrumental-Architekturen)
 *   sind dort weder ausgegraut noch versteckt – sie sind schlicht nicht
 *   vorhanden. Wer wechseln will, öffnet über das Zahnrad diese dedizierte,
 *   ausgelagerte Auswahl.
 *
 * Diese Fläche ist bewusst KEIN weiteres Panel im Zeilenfluss: sie liegt als
 * einzelne Karte über Zone 2, wird von einer Fokus-Falle gehalten und schließt
 * mit Escape, Klick daneben oder Auswahl eines Modells.
 */

import React, { useEffect } from 'react';
import { X, Check, Cloud, HardDrive, AlertTriangle, ExternalLink } from 'lucide-react';
import type { StemArchitectureOption } from '../../audio/stemArchitectures';
import { UI_ACTION, UI_ACCENT, UI_SURFACE } from '../../ui/theme';

interface StemModelPickerProps {
  open: boolean;
  options: StemArchitectureOption[];
  selectedId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  remoteConfigured: boolean;
  onOpenRemoteSetup: () => void;
}

export const StemModelPicker: React.FC<StemModelPickerProps> = ({
  open,
  options,
  selectedId,
  onSelect,
  onClose,
  remoteConfigured,
  onOpenRemoteSetup,
}) => {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[90]" data-stem-panel="model-picker">
      {/* Klick daneben schließt – die Wellenform bleibt sichtbar (kein Vollbild-Dialog) */}
      <button
        type="button"
        aria-label="Modell-Auswahl schließen"
        onClick={onClose}
        className="absolute inset-0 bg-black/45 cursor-default"
        tabIndex={-1}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Modell-Auswahl"
        className="absolute top-16 right-4 w-[420px] max-h-[70vh] overflow-y-auto rounded-md border shadow-2xl"
        style={{ backgroundColor: '#111319', borderColor: UI_SURFACE.borderStrong }}
      >
        <header className="flex items-center justify-between px-3 py-2 border-b border-[#22242d] sticky top-0" style={{ backgroundColor: '#111319' }}>
          <div className="flex flex-col">
            <span className="text-[11.5px] font-bold text-white tracking-wide">Modell-Auswahl</span>
            <span className="text-[9.5px] text-neutral-500">
              Hier existieren die Alternativen – im Konfigurations-Panel nie.
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className={`${UI_ACTION.ghost} w-6 h-6 flex items-center justify-center rounded`}
            title="Auswahl schließen (Esc)"
            aria-label="Auswahl schließen"
          >
            <X size={13} />
          </button>
        </header>

        <div className="p-2 flex flex-col gap-1">
          {options.length === 0 && (
            <div className="px-3 py-4 text-[10.5px] text-neutral-500 flex items-center gap-2">
              <AlertTriangle size={12} className="text-[#f0b429]" />
              <span>Keine Modelle gemeldet – die Stem-Engine ist nicht erreichbar (Diagnose über „Hilfe“).</span>
            </div>
          )}

          {options.map((option) => {
            const selected = option.id === selectedId;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => onSelect(option.id)}
                data-model-option={option.id}
                className={`text-left px-3 py-2 rounded border transition-colors ${
                  selected
                    ? 'border-[#00a2ff] bg-[#0a1a26]'
                    : 'border-[#22242d] bg-[#14161d] hover:border-[#0088ff]/60 hover:bg-[#171a23]'
                }`}
                title={option.detail}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className={`text-[11px] font-semibold ${selected ? 'text-[#00e5ff]' : 'text-neutral-200'}`}>
                    {option.label}
                  </span>
                  <span className="flex items-center gap-1.5 flex-shrink-0">
                    {option.installed ? (
                      <span className="text-[9px] font-mono px-1.5 py-[1px] rounded border border-[#15452a] bg-[#0d2417] text-[#00e676] flex items-center gap-1">
                        <HardDrive size={9} /> installiert
                      </span>
                    ) : (
                      <span className="text-[9px] font-mono px-1.5 py-[1px] rounded border border-[#3d2e15] bg-[#20180a] text-[#f0b429]">
                        keine Gewichte
                      </span>
                    )}
                    {option.inProcess && (
                      <span className="text-[9px] font-mono px-1.5 py-[1px] rounded border border-[#25304a] bg-[#101828] text-[#8fb8ff]">
                        in-process
                      </span>
                    )}
                    {selected && <Check size={12} className="text-[#00e5ff]" />}
                  </span>
                </div>
                <div className="mt-0.5 text-[9.5px] text-neutral-500 leading-snug">{option.detail}</div>
                {option.reason && !option.installed && (
                  <div className="mt-0.5 text-[9.5px]" style={{ color: UI_ACCENT.warning }}>
                    {option.reason}
                  </div>
                )}
              </button>
            );
          })}
        </div>

        <footer className="px-3 py-2 border-t border-[#22242d] flex items-center justify-between gap-2">
          <span className="text-[9.5px] text-neutral-500 flex items-center gap-1.5">
            <Cloud size={11} className={remoteConfigured ? 'text-[#00e676]' : 'text-neutral-600'} />
            {remoteConfigured
              ? 'Externer Rechner ist eingerichtet (Ziel „Google Colab“ im Panel).'
              : 'Externer Rechner ist nicht eingerichtet.'}
          </span>
          {!remoteConfigured && (
            <button
              type="button"
              onClick={onOpenRemoteSetup}
              className={`${UI_ACTION.secondary} px-2.5 py-1 rounded text-[10px] flex items-center gap-1.5`}
              title="Einrichtung für die externe Zerlegung öffnen (Drive-Ordner + Colab-Worker)"
            >
              <ExternalLink size={11} />
              <span>Externen Rechner einrichten…</span>
            </button>
          )}
        </footer>
      </div>
    </div>
  );
};
