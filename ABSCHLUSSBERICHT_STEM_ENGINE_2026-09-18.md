# Abschlussbericht – Stem-Engine: lauffähige Auswahl, Fail-fast, Statuslatenz, ehrliche Installation

**Datum:** 2026-09-18
**Eingang:** Produktionslog `renderer-20260918-153836-vn9mm341` (Windows, `C:\Users\p_kro\AppData\Roaming\airdox_SMART_Editor`)
**Umfang (Auftrag):** (a) `stems:engine-status` schnell und stabil, (b) Fail-fast mit klarem Grund statt minutenlangem `job-wait`, (c) BS-RoFormer/PyTorch-Pfad auf Windows installierbar/prüfbar/startbar, (d) Nachweis als Code + Tests + Bericht + PR.

---

## 1. Eingang – was im Log steht

```
[main/INFO]   10689 Tracks aus der rekordbox-XML importiert (5230 ms)
[PERFORMANCE] Langsamer IPC-Handler ›stems:engine-status‹: 7178 / 10531 / 9532 / 14949 / 14955 / 9422 / 21173 ms
[PERFORMANCE] Langsamer IPC-Handler ›stems:install-engine‹: 33554 / 277945 / 61759 ms
[EDITING]     KI-Modell wurde installiert und verifiziert: htdemucs-onnx-4stem-fp16
[PERFORMANCE] Langsamer IPC-Handler ›stems:job-wait‹: 263226 ms
[EDITING]     Fehler bei Stem-Separation: BACKEND_UNAVAILABLE: Kein Backend für
              bsroformer-musdb18hq-4stem-zfturbo verfügbar. bs_roformer:python-torch:
              Python/PyTorch-Laufzeit nicht verfügbar
              (...\stems\stem-runtime\Scripts\python.exe)
```

Beobachtungen:

1. Der Fehler tritt **nach** der erfolgreichen ONNX-Installation erneut auf – dieselbe Meldung, dasselbe Modell.
2. Der Job wartet **263 s**, bevor der Grund kommt, der vor dem ersten Sample feststand.
3. Jeder Statusaufruf kostet Sekunden; drei Aufrufe innerhalb von zehn Sekunden kosten dreimal.
4. „installiert und verifiziert“ wird gemeldet, obwohl der ONNX-Graph im Katalog noch
   `unverified` ist und die in-process-Runtime fehlen kann.

---

## 2. Diagnose (Wurzelursachen)

### 2.1 Auswahl nach Datei-Präsenz statt nach Lauffähigkeit

`selectForProfile`/`resolveModel` prüften nur, **ob die Dateien da sind**
(`modelManager.isInstalled` = Checkpoint + Config existieren). Auf dem betroffenen Rechner
liegen die BS-RoFormer-Gewichte, es gibt aber keine PyTorch-Laufzeit.

Folge: `BALANCED`/`HIGH` wurden weiter auf `bsroformer-musdb18hq-4stem-zfturbo` abgebildet
(„Preferenz bs_roformer“). Der **installierte ONNX-Graph**, der dieselben Profile bedienen
kann, wurde nie angeboten – deshalb kam derselbe Fehler nach der ONNX-Installation wieder.

### 2.2 Prüfung erst nach der teuren Arbeit

`separate()` erzeugte zuerst die Arbeitskopie (Decodieren/Resampling eines 6-Minuten-Tracks)
und probte **danach** das Backend. Das erklärt die 263 s `stems:job-wait`: Der Job wurde
angenommen, obwohl von Anfang an feststand, dass kein Backend startet.

### 2.3 Ungecachte Probes im Statuspfad

Jede Statusabfrage startete echte Interpreter (`python -c "import torch"`, 5–20 s auf einem
Windows-Laptop inkl. Virenscanner) und lud die native ONNX-Runtime neu (`import
'onnxruntime-node'`). Parallele Aufrufe starteten jeweils eigene Prozesse. Ergebnis:
7–21 s pro `stems:engine-status`.

### 2.4 Unehrliche Installationsmeldung

Der Renderer meldete pauschal „installiert und verifiziert“, auch für einen ONNX-Graphen mit
Katalog-Hash `unverified`. Zusätzlich hatte der zweite Installationslauf („Datei ist schon da,
Hash ist verifizierbar“) einen echten Absturz:

```js
for (const chunk of fs.createReadStream(target)) digest.update(chunk); // nicht iterierbar
```

### 2.5 Standardprofil ohne Bezug zur Lauffähigkeit

`usable` war „irgendein Profil ist verfügbar“; die UI wählte als Default pauschal `HIGH`,
sonst `BALANCED` – nicht das beste Profil, das ein startklares Backend hat.

---

## 3. Änderungen

### 3.1 Lauffähige Auswahl (`src/stems/stemSeparationEngine.ts`)

* Neu: `backendAvailability(descriptor)` – aggregiert alle Kandidaten samt Probe-Begründung,
  gecacht im **geteilten** `BackendAvailabilityCache` (Matrix, Job-Start und Fehlermeldung
  sehen dieselbe Antwort).
* Neu: `isRunnable(descriptor)`, `selectRunnableModel(profile, family?)` → läuft
  `registry.rankForProfile` durch, überspringt Kandidaten ohne Gewichte oder mit nicht
  startklarem Backend und liefert `{descriptor, runnable, reason}`.
* `selectBackend()` nutzt denselben Cache; Fehlermeldungen hängen den Grund nicht doppelt an
  (`bs_roformer:python-torch: …` bleibt lesbar).
* `separate()` prüft jetzt in dieser Reihenfolge: Gewichte → Backend → Arbeitskopie. Kein
  Decode mehr, wenn feststeht, dass nichts rechnen kann.

### 3.2 Kein Job, der nicht starten kann (`src/stems/stemJobService.ts`)

* Profil-Matrix und `defaultProfile` entstehen aus `selectRunnableModel` – nicht mehr aus
  Datei-Präsenz. `defaultProfile` ist das beste **lauffähige** Profil
  (`HIGH_QUALITY → HIGH → BALANCED → PREVIEW → MAXIMUM_QUALITY`).
* `status()` ist TTL-gecacht (Default 2 s, `AIRODOX_STEM_STATUS_TTL_MS`) und single-flight;
  die Laufzeit-Probes laufen parallel (`Promise.all`) statt sequenziell.
* `start()` lehnt im freien Auto-Pfad **sofort** mit `BACKEND_UNAVAILABLE` ab, wenn kein
  Modell des Profils rechenbar ist – mit Modell, Profil und der vollständigen Begründung,
  und ohne einen Job anzulegen. Eine explizit gewählte Architektur bleibt erlaubt, scheitert
  aber im Kern **vor** dem Decodieren.

### 3.3 Prüftiefe: schnell im Status, streng beim Job

`src/stems/backends/runtimeProbe.ts`, `availabilityCache.ts`, `types.ts`,
`roformerSeparator.ts`, `htDemucsSeparator.ts`, `onnxSeparator.ts`:

* `BackendAvailabilityOptions.fast` → `probeTorchRuntime({ mode })`:
  * **fast** (Statuspfad): **ein** Interpreterstart, Version + `find_spec` – kein `import
    torch`. Gemessen: **24 ms** statt Sekunden.
  * **strict** (Jobstart): derselbe billige Schritt (aus dem Memo, kein zweiter Prozess),
    danach der echte Import.
  * Ein strenges Verdikt (echter Import) gilt auch für `fast` – der Cache-Schlüssel enthält
    die Prüftiefe, damit sich die Aussagen nicht vermischen.
* Caches: im Prozess (positiv 10 min / negativ 20 s) und auf Platte
  `<Cache>/runtime-probe.json` (positiv 7 Tage / negativ 5 min). Der Schlüssel enthält Pfad,
  **Größe und mtime** des Interpreters: eine Neuinstallation erzeugt einen neuen Schlüssel.
  Single-flight pro Schlüssel; **Zeitüberschreitungen werden nicht persistiert** (ein
  langsamer Virenscanner darf kein Dauer-„nicht verfügbar“ erzeugen).
* Begründungen sind jetzt handlungsfähig: „Python 3.14.0 wird nicht unterstützt – die
  gepinnten PyTorch-Wheels gibt es für Python 3.10–3.12“, „torch ist in <Interpreter> nicht
  installiert (…)“ inkl. Hinweis auf das Einstellungsmenü, „… nicht importierbar“ inkl. der
  ersten Fehlerzeile (`DLL load failed …`).
* ONNX: die native Runtime wird **einmal pro Prozess** geladen (`sharedRuntimePromise`) und
  das Laufzeit-Verdikt 5 Minuten gecacht, single-flight.

### 3.4 Installation wirkt sofort und sagt die Wahrheit

* Neu `src/stems/runtimeCaches.ts::clearRuntimeCaches()`: **positive** Verdikte bleiben
  gültig (ein installiertes PyTorch verschwindet nicht durch ein Installationsskript),
  **negative** werden verworfen – im Speicher und auf Platte. Ohne das bleibt nach einer
  Installation minutenlang „nicht verfügbar“ stehen.
* Aufrufer: `electron/stemEngineBridge.cjs::refreshRuntime()` (Desktop) und
  `server.ts` nach `/api/stems/install` (Dev/Browser).
* `electron/stemInstaller.cjs`:
  * SHA256 wird **immer** berechnet: bei verifizierbarem Katalog-Hash als Prüfung, bei
    `unverified` als Beleg fürs Manifest `<Models>/installed-models.json`
    (`file`, `sha256`, `catalogSha256`, `installedAt`).
  * Ehrliches Label: „installiert und **SHA256-geprüft**“ bzw. „installiert – SHA256
    `<prefix>`… berechnet … Katalog führt das Modell noch als unverified“ plus Warnung, wenn
    die in-process ONNX-Runtime im App-Prozess nicht ladbar ist.
  * PyTorch-Pfad: „installiert und verifiziert (Test-Inferenz)“ – dort läuft die
    Modellverifikation tatsächlich.
  * **Bugfix:** vorhandene Datei mit verifizierbarem Hash ließ den Installer abstürzen
    (`for … of fs.createReadStream(...)`) → jetzt `sha256OfFile()` (Stream, chunked).
* Renderer: `StemModelInstallModal` und `StemQualityWarningModal` zeigen Label und Hinweis
  unverändert an; `App.tsx` schreibt denselben Wortlaut ins Log.

### 3.5 Renderer und Transport

* `App.tsx`: Default-Profil ist `stemEngineInfo.defaultProfile` (das beste **lauffähige**
  Profil) statt pauschal `HIGH`/`BALANCED`.
* „Fertig – jetzt in KI-Qualität trennen“ läuft über den Preflight (`handleSeparateStems`)
  statt blind zu starten – dort, wo „Profil nicht verfügbar“ sauber gemeldet wird.
* Preflight-Bedingung gehärtet: `!info.ok || !chosen?.available` (ein fehlendes Profil darf
  keinen Lauf durchwinken).
* `electron/main.cjs`: Slow-IPC-Schwelle für `stems:engine-status`/`get-status` von 15 s auf
  **3 s** – ein Statusaufruf ist reine Abfrage und gecacht; mehr als drei Sekunden heißt
  „es wird erneut geprobt“ und soll im Log auffallen.

---

## 4. Nachweis

### 4.1 Statische Prüfung und Suiten

| Befehl | Ergebnis |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `node scripts/run-tests.mjs --group stems` | **21/21 bestanden**, 1 Skip (`onnx-separator-inmemory`), 0 Fehler (58,5 s) |
| `npm test` (alle Gruppen) | **55/55 bestanden**, 4 Skips (Umgebung), 0 Fehler (68,1 s) |

Skips sind Umgebungsnachweise, keine übergangenen Fehler: `onnxruntime-node` ist in dieser
Umgebung nicht installierbar (kein Mirror-Treffer, natives Binary nur über NuGet – `ECONNRESET`),
PyTorch/Demucs fehlen im Sandbox-Interpreter.

### 4.2 Neue Tests (Regression aus genau diesem Log)

| Test | Prüft |
| --- | --- |
| `tests/stem-engine-runnable-selection.test.ts` | Szenario des Logs: BS-RoFormer-Gewichte vorhanden, **kein** Python, ONNX-Graph lauffähig. PREVIEW/BALANCED/HIGH bewerben **den ONNX-Graphen** (nicht BS-RoFormer), HIGH_QUALITY nennt den echten Grund; `usable = true`; ein Job ohne `modelId` landet auf dem ONNX-Modell und **läuft durch** (4 Stems, Validierung ok); vier weitere Statusabfragen erzeugen **keine** neuen Backend-Probes (3 statt 10). |
| `tests/stem-job-service-fail-fast.test.ts` | Nichts ist lauffähig: freie Profilwahl wird in **< 1 s** mit `BACKEND_UNAVAILABLE` abgelehnt (inkl. `modelId`/`profile` im Fehler, Log-Eintrag, **kein** Job angelegt); ein explizit gewähltes Modell wird angenommen, scheitert aber nach **1 ms** und **vor** der Arbeitskopie (`Working/` bleibt leer). |
| `tests/stem-engine-runtime-probe.test.ts` | fast = 1 Interpreterstart (kein Import), strict = derselbe Vorprüfprozess + 1 Import, danach alles aus dem Cache; Platten-Cache überlebt den Speicher-Verlust; Python 3.14 → Bereich + Abhilfe; fehlendes `torch` → Modul + Abhilfe; kaputter Import → erste Fehlerzeile; **Timeouts werden nicht persistiert**; `clearRuntimeCaches()` verwirft negative, behält positive Verdikte. |
| `tests/stem-installer-onnx-honesty.test.cjs` | `unverified`-Hash → Hash berechnet + Manifest + Runtime-Warnung, **kein** „verifiziert“ im Label; verifizierbarer Hash → „SHA256-geprüft“ ohne Warnung; zweiter Lauf lädt nicht erneut; falscher Hash wird nicht aktiviert. |
| `tests/onnx-separator-inmemory.test.ts` (angepasst) | `isAvailable({ descriptor })` – neue Optionsform des Backend-Vertrags. |

---

## 5. Was in dieser Umgebung nicht beweisbar ist

* **`onnxruntime-node` lässt sich hier nicht installieren** (npm-Mirror ohne Paket, natives
  Binary über `api.nuget.org` → `ECONNRESET`; zwei Versuche, auch mit
  `--include=optional --foreground-scripts`). Der In-Memory-ONNX-Test bleibt deshalb SKIP.
* **Kein Zugriff auf huggingface.co** – echte Gewichte (166 MiB ONNX, 500 MiB Checkpoint)
  können hier nicht geladen werden; die Probe-Modelle der Tests sind synthetisch.
* **Kein Windows-Host** – der PyTorch-Installationspfad (`py -3.11` → venv → torch →
  Verifikation) läuft hier nicht, seine Bausteine sind aber durch die Installer-Tests
  abgedeckt.

Deshalb der Abnahmeblick auf dem betroffenen Rechner (nach dem Update):

1. `stems:engine-status` bleibt **unter 3 s**, auch beim ersten Aufruf – keine
   `Langsamer IPC-Handler ›stems:engine-status‹`-Warnung mehr.
2. Fehlt eine Laufzeit, kommt **sofort** `BACKEND_UNAVAILABLE` mit Grund; kein Job, kein
   `job-wait` über Minuten.
3. Die Profil-Matrix zeigt PREVIEW/BALANCED/HIGH auf `htdemucs-onnx-4stem-fp16` (grün,
   sobald der ONNX-Graph installiert ist) und HIGH_QUALITY/MAXIMUM_QUALITY rot mit
   „Python/PyTorch-Laufzeit nicht verfügbar …“ – nicht mehr fünfmal derselbe BS-RoFormer-Grund.
4. Die Installationsmeldung nennt genau das Geprüfte (PyTorch: „installiert und verifiziert“;
   ONNX: „installiert und SHA256-geprüft“ oder „… SHA256 … berechnet“, plus Runtime-Hinweis).

### BS-RoFormer/PyTorch (Kriterium c) – Reihenfolge auf dem Windows-Rechner

1. Python **3.11 (64-Bit)** von python.org installieren (nur nötig, wenn `py -3.11` fehlt).
2. Einstellungsmenü → `bsroformer-musdb18hq-4stem-zfturbo` → **installieren**
   (6 Schritte: Python finden → venv → PyTorch/Audio → Architekturpakete → Gewichte →
   Test-Inferenz).
3. Erwartete Meldung: „… installiert und verifiziert (bsroformer-musdb18hq-4stem-zfturbo).“
   Schlägt ein Schritt fehl, nennt die Meldung jetzt den Schritt und die letzte Ausgabe –
   kein pauschales „nicht verfügbar“ mehr.
4. Danach zeigt `HIGH_QUALITY` wieder `bsroformer-musdb18hq-4stem-zfturbo` (grün,
   `torchVersion` in den Backend-Details) und der Lauf nutzt ihn.

---

## 6. Produktregeln unverändert

* **Kein Spektral-/DSP-Fallback als Stem-Separation** (§2, §38): wer nicht rechnen kann, wird
  als nicht lauffähig gemeldet („STEM AI UNAVAILABLE“), nie durch ein Ersatzverfahren ersetzt.
* **Originale bleiben read-only** (Audio/XML/ANLZ/DB) – Arbeitskopien entstehen weiterhin
  ausschließlich im Engine-Datenordner, jetzt aber erst nach der Lauffähigkeitsprüfung.
* **Nur geprüfte Modelle rechnen**: `modelManager.ensureDescriptorAvailable` (SHA256) läuft
  weiter vor jedem Lauf; die Verfügbarkeitsprüfung davor ändert daran nichts.

---

## 7. Offene Punkte

* Der Katalog-Hash von `htdemucs-onnx-4stem-fp16` ist weiterhin `unverified`; der Installer
  berechnet ihn jetzt und legt ihn in `Models/installed-models.json` ab. Nach dem nächsten
  Lauf steht der Wert in der Meldung (und im Manifest) und kann in
  `src/stems/modelCatalog.json` eingetragen werden – dann prüft die Engine die Datei bei
  jedem Start.
* `onnxruntime-node` muss in der packaged App als optionale Abhängigkeit mitkommen
  (`npm ci` vollständig ausführen). Fehlt sie, sagt die App das jetzt im Klartext
  (Installationsmeldung + Statusgrund) statt „verifiziert“.
