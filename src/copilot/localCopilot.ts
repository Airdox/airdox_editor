/**
 * Offline responses for the Smart Copilot.
 *
 * The browser build normally talks to `/api/chat`. Packaged Electron builds do
 * not run the development Express server, however, so the editing assistant
 * must remain useful without a network service or a Gemini key. This module
 * turns the same common DJ requests into explicit, user-triggered editor
 * actions. It never reads or changes Rekordbox source files itself.
 */

import type { ChatbotAction, TrackEditorContext } from '../types/chatbot';
import { nextId } from '../utils/ids';

export interface LocalCopilotReply {
  text: string;
  actions: ChatbotAction[];
  model: 'local-copilot';
}

function id(kind: string): string {
  return `${kind}-${nextId('copilot')}`;
}

function action(
  kind: string,
  type: ChatbotAction['type'],
  label: string,
  description: string,
  params: Record<string, unknown> = {}
): ChatbotAction {
  return { id: id(kind), type, label, description, params };
}

function formatTime(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const minutes = Math.floor(safe / 60);
  const remainder = safe % 60;
  return `${minutes}:${Math.floor(remainder).toString().padStart(2, '0')}.${Math.floor((remainder % 1) * 100).toString().padStart(2, '0')}`;
}

/**
 * Produce a deterministic assistant reply when the remote chat endpoint cannot
 * be reached. Returned actions are only applied after the user presses their
 * corresponding “Ausführen” button (or explicitly enables Auto-Run).
 */
export function createLocalCopilotReply(query: string, context: TrackEditorContext): LocalCopilotReply {
  const q = query.toLocaleLowerCase('de-DE');
  const bpm = context.bpm && context.bpm > 0 ? context.bpm : 130;
  const secondsPerBeat = 60 / bpm;
  const secondsPerBar = secondsPerBeat * 4;
  const currentTime = Math.max(0, context.currentTime ?? 0);
  const defaultMixInTime = Math.min(context.duration ?? Number.POSITIVE_INFINITY, 16 * secondsPerBar);

  if (/mix[ -]?in|energie|phrase|übergang|einstieg|analys/.test(q)) {
    const time = Number.isFinite(defaultMixInTime) ? defaultMixInTime : 16 * secondsPerBar;
    return {
      text:
        `Lokaler Smart Copilot: Für ${context.title ? `„${context.title}“` : 'den aktuellen Track'} schlage ich Takt 17.1 bei ${formatTime(time)} vor. ` +
        'Der Vorschlag basiert auf einem 16-Takt-Intro bei der aktuell bekannten BPM-Zahl und ist als bearbeitbarer Startpunkt markiert.',
      actions: [
        action(
          'mixin',
          'SET_MIX_IN_POINT',
          `Mix-In bei Takt 17.1 setzen (${formatTime(time)})`,
          'Springt zum vorgeschlagenen Einstieg, setzt einen Hot Cue und markiert 16 Takte.',
          { time, bar: 17, cueSlot: 'A', cueName: 'MIX-IN', zoomPreset: '16_BARS', selectBars: 16 }
        ),
      ],
      model: 'local-copilot',
    };
  }

  if (/zoom|takt|bars?|gesamt|voll/.test(q)) {
    const preset = /gesamt|full|voll/.test(q)
      ? 'FULL_TRACK'
      : /64/.test(q)
        ? '64_BARS'
        : /32/.test(q)
          ? '32_BARS'
          : /16/.test(q)
            ? '16_BARS'
            : /8/.test(q)
              ? '8_BARS'
              : /4/.test(q)
                ? '4_BARS'
                : '2_BARS';
    const label = preset === 'FULL_TRACK' ? 'Gesamten Track anzeigen' : `Auf ${preset.replace('_', ' ')} zoomen`;
    return {
      text: `Ich habe eine Zoom-Aktion für ${label.toLocaleLowerCase('de-DE')} vorbereitet.`,
      actions: [action('zoom', 'SET_ZOOM', label, 'Passt das Detail-Sichtfenster an.', { preset })],
      model: 'local-copilot',
    };
  }

  if (/cue|marker|hot/.test(q)) {
    return {
      text: 'Ich kann am aktuellen Playhead einen Memory Cue setzen.',
      actions: [
        action('cue', 'ADD_MEMORY_CUE', 'Memory Cue am Playhead setzen', 'Erstellt einen USER_EDIT-Marker im Projekt.'),
      ],
      model: 'local-copilot',
    };
  }

  if (/beatgrid|grid|ausricht|align/.test(q)) {
    return {
      text: 'Die Ausrichtung bleibt eine explizite Benutzeraktion: Der Vorschlag verschiebt das bestehende Grid erst nach deiner Bestätigung.',
      actions: [
        action('grid', 'AUTO_ALIGN_GRID', 'Beatgrid manuell ausrichten', 'Sucht am Playhead die stärkste vorhandene Wellenformspalte und kennzeichnet das Ergebnis als USER_EDIT.'),
      ],
      model: 'local-copilot',
    };
  }

  if (/quantize/.test(q)) {
    const enabled = !context.quantize;
    return {
      text: `Quantize ist momentan ${context.quantize ? 'aktiv' : 'inaktiv'}.`,
      actions: [
        action('quantize', 'SET_QUANTIZE', enabled ? 'Quantize aktivieren' : 'Quantize deaktivieren', 'Schaltet die Beatgrid-Einrastung um.', { enabled }),
      ],
      model: 'local-copilot',
    };
  }

  if (/3[ -]?band|rgb|blau|farbe|wellenform/.test(q)) {
    const mode = /3[ -]?band/.test(q) ? '3BAND' : /blau/.test(q) ? 'BLUE' : 'RGB';
    return {
      text: `Ich habe den Wellenformmodus ${mode} vorbereitet.`,
      actions: [action('waveform', 'SET_WAVEFORM_MODE', `${mode} Wellenform aktivieren`, 'Ändert nur die Darstellung der verfügbaren Analysewerte.', { mode })],
      model: 'local-copilot',
    };
  }

  if (/palette|clip|loop/.test(q)) {
    const hasSelection = Boolean(context.hasSelection);
    return hasSelection
      ? {
          text: 'Die aktive Auswahl kann als wiederverwendbarer Clip in die Palette übernommen werden.',
          actions: [action('palette', 'ADD_TO_PALETTE', 'Auswahl in Palette speichern', 'Legt aus der aktiven Auswahl einen Projekt-Clip an.')],
          model: 'local-copilot',
        }
      : {
          text: 'Wähle zuerst einen Bereich aus. Ich kann dafür 16 Beats ab dem Playhead markieren.',
          actions: [action('select', 'SELECT_RANGE', '16 Beats auswählen', 'Markiert vier Takte ab der aktuellen Position.', { beats: 16 })],
          model: 'local-copilot',
        };
  }

  if (/copy|kopier|cut|ausschneid|paste|einfüg|delete|lösch|clear|stumm/.test(q)) {
    const operation = /cut|ausschneid/.test(q)
      ? 'CUT'
      : /paste|einfüg/.test(q)
        ? 'PASTE'
        : /delete|lösch/.test(q)
          ? 'DELETE'
          : /clear|stumm/.test(q)
            ? 'CLEAR'
            : 'COPY';
    return {
      text: `Ich habe die Editieraktion ${operation} vorbereitet. Sie wird erst nach deiner Bestätigung ausgeführt.`,
      actions: [action('edit', 'PERFORM_EDIT', `${operation} ausführen`, 'Führt die gewählte Operation auf der aktuellen Auswahl aus.', { operation })],
      model: 'local-copilot',
    };
  }

  return {
    text:
      `Lokaler Smart Copilot bereit${context.title ? ` für „${context.title}“` : ''}. ` +
      `Aktuelle Position: ${formatTime(currentTime)}. Ich kann Zoom, Cues, Beatgrid, Quantize, Clips und Editierbefehle vorbereiten.`,
    actions: [
      action('zoom', 'SET_ZOOM', 'Auf 16 Bars zoomen', 'Zeigt einen praxisnahen Übergangsbereich.', { preset: '16_BARS' }),
      action('cue', 'ADD_MEMORY_CUE', 'Memory Cue setzen', 'Erstellt einen Marker an der aktuellen Position.'),
    ],
    model: 'local-copilot',
  };
}
