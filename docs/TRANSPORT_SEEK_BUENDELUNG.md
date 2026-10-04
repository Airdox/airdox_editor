# Einordnung des Nutzerlogs: Sprünge während der Wiedergabe reißen den Audiographen neu auf

**Stand: 04.10.2026**

Zweiter Befund aus demselben Nutzerprotokoll wie `docs/FERN_JOB_LOGDIAGNOSE.md`
(dort Thema 1: Fern-Job bleibt auf „Wartet auf den externen Rechner“ stehen).
Die Zeitstempel des Protokolls tragen kein Datum; hier zählen deshalb die
**Abstände** innerhalb einer Klickfolge, nicht die Uhrzeiten.

---

## 1. Was im Log steht

Während laufender Wiedergabe wiederholt sich in kurzen Abständen dieselbe Zeile
aus `src/audio/audioEngine.ts` (`play()` bzw. `playWithStems()`):

```
+  0 ms   Wiedergabe gestartet bei 62.190s (Dauer 254.30s, Loop: false)
+ 37 ms   Wiedergabe gestartet bei 62.460s (Dauer 254.30s, Loop: false)
+ 49 ms   Wiedergabe gestartet bei 62.729s (Dauer 254.30s, Loop: false)
+ 67 ms   Wiedergabe gestartet bei 62.729s (Dauer 254.30s, Loop: false)
+101 ms   Wiedergabe gestartet bei 62.729s (Dauer 254.30s, Loop: false)
…
+  0 ms   Wiedergabe gestartet bei  89.382s (Dauer 254.30s, Loop: false)
+ 51 ms   Wiedergabe gestartet bei  89.651s (Dauer 254.30s, Loop: false)
```

Belegte Muster:

- **5 Neustarts in 101 ms**, an anderer Stelle **8 Neustarts in 155 ms**,
  an einer dritten **sechs Aufrufe mit derselben Zielposition** (62,729 s),
  an einer vierten **dieselbe Position 0,8 s lang** (116,879 s).
- Jeder Neustart nennt eine *andere* oder *dieselbe* Position – es sind also
  Nutzer-/Regler-Eingaben (Wellenform-Klick, Jog-Wheel, MIDI-Jog), keine
  Endlosrekursion.

## 2. Warum das passiert – und was daran unvermeidbar ist

Web Audio kennt **kein Seek auf einer laufenden Quelle**: eine
`AudioBufferSourceNode` wird gestartet und läuft oder sie ist beendet. Eine
Positionsänderung während der Wiedergabe bedeutet deshalb technisch immer
„Quelle stoppen, neue Quelle mit Offset starten“ – also genau das, was die Zeile
„Wiedergabe gestartet bei …“ protokolliert.

Unvermeidbar ist also **ein** Neuaufbau pro Sprung. Nicht unvermeidbar war die
Zahl: Der alte Pfad in `src/features/transport/useTransportControls.ts`
(`handleSeek`) rief bei **jedem** Ereignis sofort `audioEngine.play(...)` bzw.
`playWithStems(...)` auf. Ein Jog-Wheel, das 40–100 Ereignisse pro Sekunde
liefert, ergab damit 40–100 abgerissene Audiographen pro Sekunde – hörbar als
Stottern/Klicken, sichtbar als Log-Sturm.

## 3. Was jetzt anders ist

| Ebene | Verhalten jetzt | Datei |
| --- | --- | --- |
| Position | geht **sofort** in Store und Engine – Playhead und Zeitanzeige bleiben am Klick | `useTransportControls.ts` (`handleSeek` → `applyPosition`) |
| Audiograph | Neuaufbau **höchstens alle 150 ms**, mit der **zuletzt** gewünschten Position (Trailing Edge, letzter Klick gewinnt) | `src/features/transport/seekScheduler.ts` |
| Dauerfeuer auf dieselbe Position | läuft in einem Fenster nur **einmal** los; ein zweiter Aufbau unterbleibt, weil der Ton schon dorthin spielt | `seekScheduler.ts` (`throttled`-Prüfung in `execute`) |
| Pause / Stop / Trackwechsel | offene Sprünge werden verworfen (`cancel()`), es feuert nichts mehr in die neue Wiedergabe | `useTransportControls.ts` (`handleTogglePlay`, `handleReturnToStart`, Effekt auf `activeTrack.id`/`workingAudioBuffer`) |
| Anzeige zwischen Klick und Neustart | `audioEngine.setSeekTarget()` hält die Zielposition fest; `clearSeekTarget()` gibt sie frei, sobald der neue Graph läuft | `src/audio/audioEngine.ts` |
| Nachweis | Aus dem Systemprotokoll verschwinden die Mehrfach-Neustarts; gebündelte Fälle stehen als `Seek gebündelt: N Anfragen → 1 Neustart bei Xs` (Kategorie `AUDIO_ENGINE`) neben der Startzeile | `useTransportControls.ts` (`onCoalesce`) |

Der Scheduler ist bewusst **React- und Web-Audio-frei**: Er kennt nur
`applyPosition`, `restart`, `releaseOverride` sowie injizierbare Uhr/Timer. Nur
deshalb ist die Logik in Node testbar – `AudioContext` und
`AudioBufferSourceNode` existieren dort nicht.

## 4. Belege

- `tests/seek-scheduler.test.ts` (framework-frei, gestubbte Uhr):
  1. einzelner Sprung ⇒ 1 Neustart, Position sofort,
  2. **5 Anfragen in 101 ms ⇒ 2 Neustarts** (Bericht `4 → 1 bei 62.729s`),
  3. identische Wiederholungen in einem Fenster ⇒ kein zweiter Neustart,
  4. späterer, echter Sprung an dieselbe Position ⇒ wird ausgeführt,
  5. `cancel()` (Pause/Stop/Trackwechsel) ⇒ kein Neustart mehr,
  6. Trailing Edge ⇒ neueste Position gewinnt,
  7. `audioEngine.getCurrentTime()` folgt dem Klick und fällt nicht zurück.
- `npm test` → **81/81 Tests bestanden, 4 übersprungen, 0 fehlgeschlagen**.
- `npm run lint` (`tsc --noEmit`), `npx vite build`, `npm run budget`
  (202,8 kB gzip / 679,3 kB roh, Budget 260/900) und `npm run bench:budget` grün.

## 5. Was dieser Nachweis **nicht** sagt

- Es wurde **kein** Hörversuch an echter Hardware/echtem Ausgabegerät gemacht:
  Der Beleg ist die Zahl der Neuaufbauten, nicht ein Gehör-Urteil.
- Die 150 ms sind eine Abwägung (Reaktionsgefühl gegen Graph-Arbeit) und in
  `DEFAULT_SEEK_COALESCE_MS` an einer Stelle änderbar; der Test bleibt gleich.
- Für **lupenreines, lückenloses** Jog-Verhalten bräuchte es später ein anderes
  Verfahren (z. B. ein länger laufendes Quell-Graph mit Positionsverschiebung
  per Convolver/Worklet oder Vorab-„Bake“ in einen zweiten Puffer). Das ist
  nicht Teil dieser Änderung.

## 6. Wenn das Muster erneut im Log auftaucht

Dann gilt einer dieser Fälle:

1. Es läuft noch der **alte Build** – prüfen mit dem Commit-Hinweis im Log
   (`npm run build && npm run desktop`).
2. Der Sprung kommt über einen Pfad, der `handleSeek` **nicht** benutzt
   (z. B. Transport-Steuerung aus dem MIDI-Bridge-Sonderfall, Clip-Deck,
   Recorder-Ende). Dann die zugehörige Aufrufstelle melden; gebündelt wird nur
   der Hauptdeck-Pfad.
3. Die Quelle selbst ist teuer: Zwischen zwei Neustarts liegt dann nicht der
   Takt (150 ms), sondern die Rechenzeit von `play()`/`playWithStems()`. Im Log
   wäre der Abstand zwischen `Seek gebündelt: …` und der folgenden
   `Wiedergabe gestartet bei …`-Zeile auffällig groß. Das wäre ein neuer Befund
   (z. B. Stem-Mixer-Aufbau), nicht der hier behandelte.
