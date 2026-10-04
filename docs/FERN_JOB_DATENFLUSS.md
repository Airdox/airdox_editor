# Datenfluss-Transparenz des Fernpfads („Laufzettel“)

Stand: 2026-10-04. Bezieht sich auf die externe Zerlegung über Google Drive +
Colab-Worker (`colab/remote_worker.py`, Notebook
`colab/airdox-stem-remote-worker.ipynb`).

## Worum es geht

Der Fernpfad führt dieselben Bytes durch vier Reiche: **dieser Rechner →
synchronisierte Ablage → Google-Cloud → Colab-Worker → zurück**. Eine einzelne
Prozentzahl kann das nicht abbilden: sie bleibt bei **0 %, solange kein Worker
gerechnet hat** – also genau in der Phase, in der der Nutzer nichts anderes
sieht. Ein Fenster mit „Status RUNNING · 0 %“ beantwortet nicht die einzige
Frage, die dann zählt: _Wo stehen die Daten gerade, und woran ist das
festgemacht?_

Deshalb zeigt das Statusfenster seitdem einen **Laufzettel**: jede Station
einzeln, mit Zustand, Uhrzeit, Dauer und Beleg.

## Grundregel

> Eine Station ist nur dann **belegt**, wenn es dafür einen Beleg gibt.

Belege entstehen ausschließlich im Moment der Beobachtung und werden am
Job-Datensatz festgehalten (`RemoteJobRecord.flow.checkpoints`,
`src/stems/remote/dataFlow.ts`). Sie überleben einen Editor-Neustart. Was der
Editor nicht beobachten kann, bleibt sichtbar offen – es wird nicht geschätzt,
nicht hochgerechnet und nicht „nach Gefühl“ grün gefärbt.

**Die einzige Ausnahme ist die Cloud-Synchronisation** (Station 3). Sie ist die
einzige Station ohne technischen Beleg, weil Drive für Desktop dem Editor nicht
zurückmeldet, was es bereits hochgeladen hat. Sie wird auf drei Arten
abgeschlossen – und in keiner davon behauptet der Editor eine Messung:

1. der Nutzer bestätigt sie von Hand („In Drive gesehen“),
2. der Rückweg beweist sie (Ergebnisse kamen aus derselben Cloud zurück),
3. sie bleibt offen – und das ist dann die ehrliche Antwort.

## Die Stationen

| # | Station | Wo | Beleg | Wenn sie offen bleibt, heißt das |
|---|---------|----|-------|----------------------------------|
| 1 | Arbeitskopie erstellt | Dieser Rechner | Dateiname, Größe, SHA-256, Dauer/Hz/Kanäle | – (immer belegt) |
| 2 | In der Jobablage abgelegt | Jobablage | Pfad, Steckbrief, **aus der Ablage zurückgelesener** Hash | Ablage nicht erreichbar / Upload nicht bestätigt |
| 3 | In der Google-Cloud angekommen | Google-Cloud | **nicht messbar** – Bestätigung oder Rückweg | Drive hat (nachweislich) noch nichts gemeldet |
| 4 | Colab-Worker in der Ablage gesehen | Colab-Worker | `worker.status.json`: Worker-ID, Host, Gerät, letztes Lebenszeichen | kein Worker läuft, oder falscher `JOB_ORDNER` |
| 5 | Job vom Worker angenommen | Colab-Worker | `claim.json`: Worker-ID, Zeitpunkt, Gerät, Versuche | Worker läuft, sieht den Job aber nicht |
| 6 | Trennung gerechnet | Colab-Worker | Prozent, Phase, Gerät, Modell, CPU-Rückfall | Worker hat beansprucht, rechnet aber nicht |
| 7 | Ergebnisse in der Ablage | Jobablage | Stem-Dateien mit Größe und Hash | Rechnung läuft noch, oder Worker gestorben |
| 8 | Ergebnisse geholt | Dieser Rechner | Dateien, Bytes, Zielordner | Ablage beim Lesen nicht erreichbar |
| 9 | Hashes und Geometrie geprüft | Dieser Rechner | SHA-256 je Stem, Größe | ein Ergebnis war beschädigt ⇒ `FAILED` |
| 10 | Im Editor verfügbar | Dieser Rechner | lokale Job-ID, Stem-Liste, Laufzeit | – |

Zu jeder Station nennt das Fenster außerdem **Uhrzeit**, **Dauer seit der
vorherigen Station** und bei der Rechnung **„letzte Meldung vor …“**. Damit ist
„der Worker ist langsam“ von „der Worker ist verstummt“ unterscheidbar.

Ein Lauf, der endet (Fehler oder Abbruch), markiert **die Station, an der er
endete**, und trägt dort den Grund ein (`REMOTE_TIMEOUT`, `REMOTE_OUTPUT_*`, …).
Nichts verschwindet in einer generischen „Fehlgeschlagen“-Zeile.

## Neue Worker-Schritte (Colab-Seite)

Damit auch die Mitte der Rechnung sichtbar ist, meldet der Worker zusätzlich:

| Schritt | Bedeutung |
|---------|-----------|
| `worker.job_seen` | Job in der Ablage gefunden, Worker übernimmt gleich |
| `worker.weights_ready` | Gewichte liegen bereit (Name, Bytes) und werden geladen |
| `worker.weights_missing` | Gewichte fehlen im Modellordner – Warnung **vor** der Inferenz |

`worker.inference_completed` nennt jetzt außerdem die reine Rechenzeit.
Chunk-Fortschritt (`pass 1/1 chunk 7/20`) und Prozent waren bereits vorhanden
und landen weiterhin im Ablaufprotokoll.

Der Node-Worker (`scripts/stem-remote-worker.ts`) meldet `worker.job_seen`
ebenfalls, damit die lokale Ende-zu-Ende-Probe dieselbe Kette abbildet.

## Bedienung

- **Jetzt prüfen** – ein sofortiger Poll der Ablage, ohne auf den nächsten
  Zyklus (Voreinstellung 15 s) zu warten.
- **In Drive gesehen** (nur an Station 3) – vermerkt Ihre Beobachtung. Es wird
  **keine** Datei in der Ablage verändert und keine Cloud-API berührt; im
  Ablaufprotokoll steht der Schritt ausdrücklich als „manuelle Bestätigung,
  keine technische Prüfung“.
- **Protokoll kopieren** – Stationen, Belege und Ablaufprotokoll als Text in
  die Zwischenablage (für Support und Nachweiskette).
- **Job abbrechen** – wie bisher; der Worker beendet die Rechnung beim nächsten
  Arbeitsschritt.

## Unverändernde Diagnose daneben

Der Laufzettel ersetzt die Ablage-Diagnose nicht, er ergänzt sie:

```bash
python3 colab/remote_worker.py --root "<Jobablage>" --check-store
```

## Belege im Code

| Baustein | Datei |
|----------|-------|
| Stationen, Zustände, Belege, Prüfpunkte | `src/stems/remote/dataFlow.ts` |
| Prüfpunkte schreiben (Start, Ablage, Worker, Import) | `src/stems/remote/remoteStemJobService.ts` |
| Anzeige (Laufzettel, Belege, Protokoll) | `src/components/Modals/RemoteFlowModal.tsx` |
| Transport: IPC-Kanal `stems:remote-cloud-sync` | `electron/stemEngineBridge.cjs`, `electron/preload.cjs` |
| Transport: `POST /api/stems/remote/jobs/:id/cloud-sync` | `server.ts`, `src/audio/stemEngine.ts` |
| Prüfungen | `tests/stem-remote-data-flow.test.ts` (8 Fälle) |

```bash
npm run test:stems:remote     # Fernpfad-Suite, enthält den Laufzettel-Test
python3 colab/remote_worker.py --self-test
```

## Was das ausdrücklich nicht beweist

- Ein belegter Laufzettel beweist **keine Audioqualität**. Qualität braucht
  trainierte Gewichte und das Gate (`npm run test:stems:gate`).
- Die manuelle Cloud-Bestätigung ist eine **Aussage des Nutzers**, keine
  Messung. Sie kostet im Zweifel ein Häkchen zu viel, nie ein falsches Ergebnis.
- Ein grüner Laufzettel beweist **keinen** produktiven Google-/Colab-Lauf.
  Siehe `docs/STEM_REMOTE_NACHWEISKETTE.md`.
