/** Timeline range shared by the Rekordbox model and Edit Assistant. */
export interface SelectionRange {
  start: number; // seconds
  end: number; // seconds
  startBeat?: number;
  endBeat?: number;
  beatsCount: number;
  barsCount: number;
  duration: number;
}
