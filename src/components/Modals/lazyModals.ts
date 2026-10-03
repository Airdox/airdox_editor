/**
 * Lazy-Fassade für die schweren Dialoge.
 *
 * Warum es diese Datei gibt:
 *   Alle Modals waren früher statisch in `App.tsx` importiert. Dadurch lag
 *   nicht nur ihr eigener Code im Startchunk, sondern auch `three.js`
 *   (≈536 kB min / ≈130 kB gzip), das ausschließlich der 3D-Renderinspektor im
 *   Export-Dialog benutzt. Diese Datei bündelt die `React.lazy`-Wrapper an einer
 *   Stelle, damit `App.tsx` nur eine Importzeile braucht und die Zuordnung
 *   „Dialog → Chunk" nachvollziehbar bleibt.
 *
 * Regeln:
 *   - Nur Dialoge, die der Nutzer aktiv öffnet, gehören hierher.
 *   - Immer genutzte Dialoge (Ersteinrichtung, Operations-Feedback,
 *     Projektinfo) bleiben statisch importiert, damit sie ohne Nachladen
 *     erscheinen.
 *   - Die gerenderten Bereiche müssen in `<Suspense>` stehen (siehe App.tsx).
 */

import { lazy } from 'react';

export const LazyRecorderModal = lazy(async () => ({ default: (await import('./RecorderModal')).RecorderModal }));
export const LazyRemoteFlowModal = lazy(async () => ({ default: (await import('./RemoteFlowModal')).RemoteFlowModal }));
export const LazyRemoteSetupModal = lazy(async () => ({ default: (await import('./RemoteSetupModal')).RemoteSetupModal }));
export const LazyWorkspaceSettingsModal = lazy(async () => ({ default: (await import('./WorkspaceSettingsModal')).WorkspaceSettingsModal }));
export const LazyExportModal = lazy(async () => ({ default: (await import('./ExportModal')).ExportModal }));
export const LazyDatabaseExtractionModal = lazy(async () => ({ default: (await import('./DatabaseExtractionModal')).DatabaseExtractionModal }));
export const LazyRekordboxXmlImportModal = lazy(async () => ({ default: (await import('./RekordboxXmlImportModal')).RekordboxXmlImportModal }));
export const LazySystemLogModal = lazy(async () => ({ default: (await import('./SystemLogModal')).SystemLogModal }));
export const LazyDeleteModeModal = lazy(async () => ({ default: (await import('./DeleteModeModal')).DeleteModeModal }));
export const LazyClearHistoryModal = lazy(async () => ({ default: (await import('./ClearHistoryModal')).ClearHistoryModal }));
export const LazyStemQualityWarningModal = lazy(async () => ({ default: (await import('./StemQualityWarningModal')).StemQualityWarningModal }));
export const LazyStemModelInstallModal = lazy(async () => ({ default: (await import('./StemModelInstallModal')).StemModelInstallModal }));
export const LazyEditAssistantModal = lazy(async () => ({ default: (await import('./EditAssistantModal')).EditAssistantModal }));
export const LazyMidiControllerModal = lazy(async () => ({ default: (await import('./MidiControllerModal')).MidiControllerModal }));
