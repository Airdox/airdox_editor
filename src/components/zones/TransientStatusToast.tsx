/**
 * @license
 * airdox_SMART_Editor – Flüchtige Prozessmeldungen (außerhalb aller Zonen).
 *
 * Warum es diesen Bauteil gibt:
 *   Der Master-Plan verbietet in Zone 1 ausdrücklich jeden temporären
 *   Prozessstatus („niemals Fortschrittsbalken, Status oder Import-Buttons")
 *   und Zone 2 soll im Ruhezustand ausschließlich die Wellenform und die
 *   schmale Start-Zeile des Stem-Centers zeigen. Trotzdem muss der Bediener
 *   erfahren, was gerade passiert (Sammlung lädt, externer Job abgelehnt …).
 *
 *   Die Antwort ist eine einzelne, schwebende Statuskarte am rechten unteren
 *   Rand: sie gehört zu keiner Zone, überdeckt keine Bedienelemente und
 *   verschwindet von selbst. Fortschritt erscheint hier als dünne Linie – nie
 *   als Fläche. Der Abstand zum unteren Rand (64 px) hält sie frei von der
 *   Schaltfläche „Externer Job · Status ansehen", die im selben Eck liegt.
 */

import React from 'react';
import { AlertTriangle, Info, Loader2, X, CheckCircle2 } from 'lucide-react';
import { UI_ACCENT, UI_SURFACE } from '../../ui/theme';

export interface TransientStatusItem {
  id: string;
  tone: 'info' | 'error' | 'success' | 'busy';
  text: string;
  /** Optionaler Fortschritt 0–100. Wird als 2-px-Linie gezeichnet, nicht als Balkenfläche. */
  percent?: number | null;
  dismissible?: boolean;
}

interface TransientStatusToastProps {
  items: TransientStatusItem[];
  onDismiss: (id: string) => void;
}

export const TransientStatusToast: React.FC<TransientStatusToastProps> = ({ items, onDismiss }) => {
  if (items.length === 0) return null;
  return (
    <div
      className="fixed bottom-16 right-4 z-[120] flex flex-col gap-2 max-w-sm"
      role="status"
      aria-live="polite"
      data-transient-status="true"
    >
      {items.map((item) => (
        <StatusCard key={item.id} item={item} onDismiss={onDismiss} />
      ))}
    </div>
  );
};

const StatusCard: React.FC<{ item: TransientStatusItem; onDismiss: (id: string) => void }> = ({
  item,
  onDismiss,
}) => {
  const tone = toneStyles(item.tone);
  return (
    <div
      className="rounded-md border shadow-xl backdrop-blur-sm overflow-hidden"
      style={{ backgroundColor: 'rgba(14,16,21,0.96)', borderColor: tone.border }}
    >
      <div className="flex items-start gap-2 px-3 py-2">
        <span className="mt-[1px]" style={{ color: tone.accent }}>
          {item.tone === 'error' ? (
            <AlertTriangle size={13} />
          ) : item.tone === 'success' ? (
            <CheckCircle2 size={13} />
          ) : item.tone === 'busy' ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Info size={13} />
          )}
        </span>
        <span className="text-[11px] leading-snug text-neutral-200 min-w-0">{item.text}</span>
        {item.dismissible !== false && (
          <button
            type="button"
            onClick={() => onDismiss(item.id)}
            className="ml-1 shrink-0 text-neutral-500 hover:text-white transition-colors"
            title="Meldung ausblenden"
            aria-label="Meldung ausblenden"
          >
            <X size={12} />
          </button>
        )}
      </div>
      {typeof item.percent === 'number' && (
        <div className="h-[2px] w-full" style={{ backgroundColor: UI_SURFACE.border }}>
          <div
            className="h-full transition-all duration-200"
            style={{ width: `${Math.max(0, Math.min(100, item.percent))}%`, backgroundColor: tone.accent }}
          />
        </div>
      )}
    </div>
  );
};

function toneStyles(tone: TransientStatusItem['tone']): { accent: string; border: string } {
  switch (tone) {
    case 'error':
      return { accent: UI_ACCENT.danger, border: '#7f1d1d' };
    case 'success':
      return { accent: UI_ACCENT.success, border: '#15452a' };
    case 'busy':
      return { accent: UI_ACCENT.primaryBright, border: '#1f4a6b' };
    default:
      return { accent: UI_ACCENT.primaryBright, border: '#243244' };
  }
}
