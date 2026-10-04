/**
 * @license
 * airdox_SMART_Editor – Workspace-Layout der Drei-Zonen-Architektur (UI v2.0).
 *
 * Dieses Modul enthält die *Regeln* der Oberfläche als reinen Zustand ohne
 * React, DOM und Electron. Es ist die einzige Stelle, an der definiert ist:
 *
 *   - welche Panels es in Zone 2/Zone 3 gibt,
 *   - was der Fokus-Modus („Max. Platz / Alles einklappen") schließt,
 *   - wie die Reiter in Zone 3 aufgehen (genau einer),
 *   - in welchem der drei Zustände A/B/C das Stem-Center gerade ist.
 *
 * Warum als Reducer und nicht als verstreute `useState`-Aufrufe:
 *   Die harte Anforderung lautet „ein Klick schließt *synchron* alle Panels".
 *   Mit Einzelzuständen ist das eine Kette von Settern – und ein vergessener
 *   Setter ist genau der Fehler, der als „überlappende Infobox" sichtbar wird.
 *   Ein Übergang, ein Zustand: entweder alle zu oder keiner.
 *
 * Die drei Zonen (unveränderlich):
 *   Zone 1 – globale Top-Bar. Darf NICHTS verarbeiten: kein Fortschritt, kein
 *            Prozessstatus, keine Import-Schaltfläche. Nur Werkzeuge, Menüs,
 *            Transport, aktiver Track, Fokus-Umschalter, Systemzeit.
 *   Zone 2 – Viewport: Wellenform + dynamisches Stem-Center (Zustände A/B/C)
 *            + andockbare Paletten (Clips, Copilot).
 *   Zone 3 – Footer: eingeklappte Reiter (BEAT SELECT, SELECT, EDIT) und die
 *            Sammlungsleiste. Standard: eingeklappt.
 */

/** Sektionen der unteren Bearbeitungs-Paletten (Zone 3). */
export type Zone3SectionId = 'BEAT_SELECT' | 'SELECT' | 'EDIT';

/** Die drei Zustände des Stem-Centers plus der Zustand „fertige Stems". */
export type StemCenterPhase = 'IDLE' | 'CONFIGURE' | 'PROCESSING' | 'STEMS';

export interface Zone3SectionMeta {
  id: Zone3SectionId;
  label: string;
  hint: string;
}

/** Reihenfolge und Beschriftung der Zone-3-Reiter (eine Quelle für Rail und Panels). */
export const ZONE3_SECTIONS: readonly Zone3SectionMeta[] = [
  {
    id: 'BEAT_SELECT',
    label: 'BEAT SELECT',
    hint: 'Auswahllänge in Beats (1–128) am Rekordbox-Beatgrid setzen.',
  },
  {
    id: 'SELECT',
    label: 'SELECT',
    hint: 'Auswahl halbieren (1/2), verdoppeln (×2) oder aufheben.',
  },
  {
    id: 'EDIT',
    label: 'EDIT',
    hint: 'Clone, Copy, Cut, Paste, Insert, Replace, Overdub, Delete, Clear, Undo, Redo.',
  },
] as const;

/**
 * Alle schließbaren Panels außerhalb von Zone 1. Zone 1 ist bewusst NICHT
 * enthalten – sie ist permanent und hat keinen ein-/ausklappbaren Zustand.
 */
export interface WorkspacePanels {
  /** Fokus-Modus: „Max. Platz / Alles einklappen". */
  focusMode: boolean;
  /** Offene Zone-3-Sektion; `null` = alle Reiter eingeklappt (Standard). */
  zone3Section: Zone3SectionId | null;
  /** Stem-Center Zustand B (Konfigurations-Panel). */
  stemConfigOpen: boolean;
  /** Ausgelagerte Modell-Auswahl (öffnet aus dem Zahnrad des Panels). */
  stemModelPickerOpen: boolean;
  /** Clip-Palette rechts in Zone 2. */
  paletteOpen: boolean;
  /** Vollflächiges Clip-Deck unterhalb der Wellenform. */
  deckViewOpen: boolean;
  /** KI-Copilot-Palette rechts in Zone 2. */
  chatbotOpen: boolean;
  /** Sammlungs-/Browserleiste am untersten Rand (Zone 3). */
  browserOpen: boolean;
}

/**
 * Standard-Layout nach dem Start: Zone 3 ist eingeklappt (genau das ist die
 * Vorgabe – „standardmäßig eingeklappt oder als dezente, schmale Reiter"),
 * Zone 2 zeigt die Wellenform mit der Clip-Palette, kein Modal, kein Fokus.
 */
export const INITIAL_WORKSPACE_PANELS: WorkspacePanels = {
  focusMode: false,
  zone3Section: null,
  stemConfigOpen: false,
  stemModelPickerOpen: false,
  paletteOpen: true,
  deckViewOpen: false,
  chatbotOpen: false,
  browserOpen: false,
};

/**
 * Layout, das nach dem Verlassen des Fokus-Modus wiederhergestellt wird.
 * Bewusst das Standard-Layout und nicht „der Zustand von vorhin": der Nutzer
 * kommt aus einem aufgeräumten Bild zurück und soll nicht von einer zufälligen
 * Panel-Kombination überrascht werden.
 */
export const RESTORED_WORKSPACE_PANELS: WorkspacePanels = {
  ...INITIAL_WORKSPACE_PANELS,
};

export type WorkspaceAction =
  | { type: 'TOGGLE_FOCUS_MODE' }
  | { type: 'SET_FOCUS_MODE'; value: boolean }
  /** Reiter in Zone 3 anklicken: derselbe Reiter schließt, ein anderer öffnet. */
  | { type: 'TOGGLE_ZONE3_SECTION'; section: Zone3SectionId }
  | { type: 'CLOSE_ZONE3' }
  /** „+ Stem-Separation starten" (Zustand A → B). */
  | { type: 'OPEN_STEM_CONFIG' }
  | { type: 'CLOSE_STEM_CONFIG' }
  | { type: 'SET_STEM_MODEL_PICKER'; open: boolean }
  | { type: 'SET_PALETTE'; open: boolean }
  | { type: 'SET_DECK_VIEW'; open: boolean }
  | { type: 'SET_CHATBOT'; open: boolean }
  | { type: 'SET_BROWSER'; open: boolean };

/**
 * „Alles einklappen" – die vollständige Liste dessen, was der Fokus-Modus
 * schließt. Als Konstante exportiert, damit Tests *und* Dokumentation dieselbe
 * Quelle prüfen: kommt ein Panel hinzu, muss es hier auftauchen.
 */
export const FOCUS_MODE_CLOSES: readonly (keyof WorkspacePanels)[] = [
  'zone3Section',
  'stemConfigOpen',
  'stemModelPickerOpen',
  'paletteOpen',
  'deckViewOpen',
  'chatbotOpen',
  'browserOpen',
] as const;

/**
 * Panels, die beim Betreten des Fokus-Modus geschlossen werden. Bewusst NICHT
 * enthalten: ein laufender Job. Der Fortschritt ist kein Panel, sondern eine
 * flache Zeile in Zone 2 – er darf durch das Aufräumen nicht unsichtbar werden.
 */
export function collapsedForFocusMode(state: WorkspacePanels): WorkspacePanels {
  const next: WorkspacePanels = { ...state, focusMode: true };
  for (const key of FOCUS_MODE_CLOSES) {
    // @ts-expect-error – die Schlüssel sind bewusst gemischt typisiert.
    next[key] = key === 'zone3Section' ? null : false;
  }
  return next;
}

export function workspaceReducer(state: WorkspacePanels, action: WorkspaceAction): WorkspacePanels {
  switch (action.type) {
    case 'TOGGLE_FOCUS_MODE':
      return state.focusMode ? { ...RESTORED_WORKSPACE_PANELS } : collapsedForFocusMode(state);
    case 'SET_FOCUS_MODE':
      return action.value
        ? collapsedForFocusMode(state)
        : { ...RESTORED_WORKSPACE_PANELS };
    /*
     * „Ein Erweiterer auf einmal": Wer in Zone 3 eine Sektion aufklappt, will
     * die Wellenform sehen und nicht zwei konkurrierende Panel-Stapel. Deshalb
     * schließt jede Erweiterung in Zone 2/Zone 3 die jeweils andere – und der
     * Fokus-Modus endet, weil der Nutzer gerade etwas aufklappen will.
     */
    case 'TOGGLE_ZONE3_SECTION': {
      const next = state.zone3Section === action.section ? null : action.section;
      return {
        ...state,
        focusMode: false,
        zone3Section: next,
        stemConfigOpen: false,
        stemModelPickerOpen: false,
      };
    }
    case 'CLOSE_ZONE3':
      return { ...state, zone3Section: null };
    case 'OPEN_STEM_CONFIG':
      return {
        ...state,
        focusMode: false,
        stemConfigOpen: true,
        stemModelPickerOpen: false,
        zone3Section: null,
      };
    case 'CLOSE_STEM_CONFIG':
      return { ...state, stemConfigOpen: false, stemModelPickerOpen: false };
    case 'SET_STEM_MODEL_PICKER':
      return {
        ...state,
        stemModelPickerOpen: action.open,
        // Die ausgelagerte Auswahl ersetzt das Panel nicht – sie schließt es.
        stemConfigOpen: action.open ? false : state.stemConfigOpen,
      };
    case 'SET_PALETTE':
      return { ...state, paletteOpen: action.open, focusMode: action.open ? false : state.focusMode };
    case 'SET_DECK_VIEW':
      return { ...state, deckViewOpen: action.open, focusMode: action.open ? false : state.focusMode };
    case 'SET_CHATBOT':
      return { ...state, chatbotOpen: action.open, focusMode: action.open ? false : state.focusMode };
    case 'SET_BROWSER':
      return { ...state, browserOpen: action.open, focusMode: action.open ? false : state.focusMode };
    default:
      return state;
  }
}

/** True, wenn der Fokus-Modus die untere Zone vollständig ausblendet. */
export function zone3Visible(state: WorkspacePanels): boolean {
  return !state.focusMode;
}

export interface StemCenterInput {
  /** Fertige Stems liegen für den aktiven Track vor. */
  hasStems: boolean;
  /** Ein Job läuft (lokal oder extern). */
  isSeparating: boolean;
  /** Nutzer hat „+ Stem-Separation starten" geklickt (Zustand B). */
  configOpen: boolean;
}

/**
 * Zustandsableitung des Stem-Centers (Progressive Disclosure, harte Reihenfolge):
 *
 *   PROCESSING  – ein laufender Job hat Vorrang vor allem (Fortschritt bleibt
 *                 sichtbar, auch wenn das Konfigurations-Panel schon zu ist).
 *   CONFIGURE   – Zustand B: Konfigurations-Panel mit genau einem Modell. Steht
 *                 vor STEMS, damit „Separation erneut ausführen" bei bereits
 *                 vorhandenen Stems das Panel wirklich öffnet (der Mixer bleibt
 *                 darunter sichtbar – siehe StemCenter).
 *   STEMS       – fertige Stems: der Fortschrittsbalken ist in die Mixer-Ansicht
 *                 übergegangen.
 *   IDLE        – Zustand A: eine einzige, schmale Zeile mit dem Start-Button.
 */
export function deriveStemCenterPhase(input: StemCenterInput): StemCenterPhase {
  if (input.isSeparating) return 'PROCESSING';
  if (input.configOpen) return 'CONFIGURE';
  if (input.hasStems) return 'STEMS';
  return 'IDLE';
}

/**
 * Beschriftung des aktiven Modells für die Kopfzeile des Konfigurations-Panels.
 * In Zustand B wird AUSSCHLIESSLICH dieses Modell genannt – Alternativen
 * existieren dort nicht, sie liegen hinter dem Zahnrad.
 */
export function activeStemModelLabel(
  architectureLabel: string | null | undefined,
  fallback = 'Automatisch (Profil entscheidet)'
): string {
  const label = (architectureLabel ?? '').trim();
  return label.length > 0 ? label : fallback;
}
