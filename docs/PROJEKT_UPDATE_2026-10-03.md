# Projekt-Update: Aufräumen, Vereinfachen, Modernisieren

Stand: 2026-10-03 · Branch: `arena/01a0f5aa-airdox-editor` · Basis: `main` (7effdc8)

**Zielbild („New Reality“), in dieser Reihenfolge:**

1. **Stabil** – kein roter Test, kein Build, der „grün“ meldet und trotzdem kaputt ausliefert.
2. **Schnell** – kurze Feedback-Schleifen (Tests, Build), flüssiger Start und Import.
3. **Bugfrei** – klare Verträge statt Sonderpfade; ein Fehler ist ein Fehler und wird angezeigt, nicht ersetzt.

---

## 1. Kennzahlen (Ist-Zustand vor dieser Welle)

| Kennzahl | Wert | Einordnung |
| --- | --- | --- |
| Einträge in der Repository-Wurzel | 49 | zu viel – Skripte, Docs, Artefakte und Ressourcen liegen gemischt |
| npm-Skripte | 47 | unübersichtlich; viele Varianten derselben Aktion |
| Testdateien (`tests/`) | 69 | sehr differenziert, teils überlappend (allein ~40 × `stem-*`) |
| Testlauf (komplett, seriell) | ≈ 85 s, 4 SKIP | zu langsam für tägliches Arbeiten; SKIPs verwässern das Signal |
| Rote Tests | 1 (`stem-asar-unpack`) | **echter Release-Bug**, s. Maßnahme A1 |
| Größte Quelldatei | `src/App.tsx`, 4.780 Zeilen | Sammelbecken für UI, Zustand, Import, Stems, Export |
| Größte Electron-Datei | `electron/main.cjs`, 864 Zeilen | höchster Risikowert der Code-Analyse (52/100) |
| Versionierte Binärlast | 10,5 MB XML + 5,3 MB WAV + 1,2 MB PNG | belastet Clone, Checkout und Diff |
| CI | 1 Workflow, defekt | baute die **Python**-Vorversion per PyInstaller/Inno Setup; `requirements.txt` existiert nicht mehr → Job kann nicht laufen |

---

## 2. Welle 1 – in diesem Schritt bereits erledigt

Alles ist über Git rückholbar; nichts davon wird von Code, Build oder Tests referenziert.

| Maßnahme | Dateien / Ordner | Begründung |
| --- | --- | --- |
| Einmal-/Reparaturskripte entfernt | `fix.cjs`, `fix-typo.cjs`, `fix_context_syntax.cjs`, `full_auto_fix.mjs`, `master-fix-and-push.cjs` | 0 Referenzen; historische Einmalaktionen, Fehlerquelle bei Nachahmung |
| Python-Ära entfernt | `build_pipeline.py`, `main.py`, `rekordbox_parser.py`, `waveform_renderer.py`, `build.spec`, `setup.iss`, `build_installer_only.py`, `patch_app.py` | `build_pipeline.py` erzeugte die anderen Dateien; Produkt ist Electron (siehe `BUILD_WINDOWS.md`) |
| Defekten CI-Workflow entfernt | `.github/workflows/windows-build.yml` | `pip install -r requirements.txt` → Datei fehlt; baute die Python-Vorversion. Ersatz: Maßnahme A2 |
| Generierte Analyse-Artefakte entfernt | `code_analysis_out/` (258 KB JSON), `visualization.html` (174 KB) | Ausgaben von `tools/code_analysis/analyze_repo.py`; Vorlage bleibt unter `tools/code_analysis/` |
| Validierungsoutput entfernt | `artifacts/` (5,3 MB WAV + Report) | Ergebnis eines Laufs, kein Quellcode |
| Doppeltes Lockfile entfernt | `bun.lock` | Paketmanager ist npm (`package-lock.json` ist maßgeblich); kein `bun`-Aufruf im Projekt |
| Kleinkram entfernt | `fix-package.txt`, `test_analysis.ts` (26 Bytes), `metadata.json` (Gemini-Artefakt), `electron/masterDbGate.cjs.bak` | ohne Funktion |
| Aufgeräumt/verschoben | `rekordbox_edit.png` → `reference/`; 5 `ABSCHLUSSBERICHT_*.md` → `docs/archive/` | zusammengehörige Dinge an einen Ort |
| `.gitignore` ergänzt | `code_analysis_out/`, `visualization.html`, `artifacts/` | verhindert, dass Generiertes zurückkommt |

Ergebnis: **72/73 Tests grün** (wie vorher), 4 SKIPs sind Umgebungs-SKIPs (torch/demucs/onnxruntime fehlen im Sandbox), kein Funktionsverlust.

---

## 3. Tabelle: geplante Maßnahmen

**Aufwand:** S = bis ~1 Stunde · M = bis ~1 Tag · L = mehrere Tage
**Priorität:** P1 = Stabilität/Bugfreiheit zuerst · P2 = Geschwindigkeit/Übersicht · P3 = Komfort/Zukunft

### A. Stabilität und Bugfreiheit (P1 – zuerst)

| Nr. | Maßnahme | Vorteile | Nachteile / Risiko | Aufwand | Prio |
| --- | --- | --- | --- | --- | --- |
| A1 | **`asarUnpack`-Vertrag erfüllen**: `stem-runtime`, `models`, `python`, `node-bridge.cjs` in `build.asarUnpack` aufnehmen (Test `tests/stem-asar-unpack.test.ts` ist seit 17.09. rot) | Release funktioniert wieder (Stems/Py-Bridge fehlen sonst im Paket), roter Test verschwindet, „grüner Build = laufende App“ wird wahr | Installationspaket wird etwas größer und entpackt mehr Dateien | S | **P1** |
| A2 | **CI neu aufbauen** (Electron): `npm ci`, `npm run rekordbox:native:rebuild/check`, `npm run build`, `node scripts/run-tests.mjs`, Artefakt-Upload – statt PyInstaller | Kaputte Builds, Native-Drift und rote Tests werden automatisch erkannt; Windows ist Referenzplattform | Windows-Runner + `better-sqlite3-multiple-ciphers`-Build brauchen gelegentlich Pflege | M | **P1** |
| A3 | **ANLZ-Spiegelmodul erzwingen**: `npm run build:anlz-structure` (+ `check`) als Pflichtschritt in `build` und CI | Gate und Renderer können nicht auseinanderlaufen („Gate akzeptiert, Renderer zeigt nichts“) | ein Build-Schritt mehr; generierte Datei muss im CI erzeugt werden | S | **P1** |
| A4 | **Testprofile trennen**: Default-Lauf = schnelle Unit-/Vertrags-Tests; Live-Tests (torch, demucs, onnxruntime, echtes Audio) nur über `--profile live` | Klares Signal (0 SKIP im Default), schnellere Schleife, SKIP kann nicht mehr „Erfolg“ bedeuten | Live-Prüfungen laufen seltener – bewusst terminieren | S/M | **P1** |
| A5 | **Doku enthärten**: feste Session-Branch-Namen (`arena/01a0f573-…`) durch Hinweis „aktueller Arbeitsbranch“ ersetzen | Anleitung bleibt auch in neuen Sessions korrekt | muss bei jedem Branch-Wechsel bewusst geprüft werden | S | **P2** |
| A6 | **Legacy-Root `D:\PIONEER` aus der ANLZ-Auflösung entfernen** (es gilt `analysis-data-root-path`, dann Datenbank-Root/Share) | Keine falschen Treffer mehr über einen veralteten Standardpfad | Geräte-Bibliotheken ohne `options.json` brauchen dann `AIRODOX_REKORDBOX_ANALYSIS_ROOT` | S | **P2** |
| A7 | **`src/App.tsx` schneiden** (4.780 Zeilen): Rekordbox-Import, Stem-UI, Editing-State, Palette in eigene Module/Hooks | Weniger Seiteneffekte, gezieltere Tests, schnellere Reviews, geringere Regressionsgefahr | Große Diffs; nur in grünen Zwischenschritten, nie „auf einen Rutsch“ | L | **P1** (schrittweise) |

### B. Geschwindigkeit

| Nr. | Maßnahme | Vorteile | Nachteile / Risiko | Aufwand | Prio |
| --- | --- | --- | --- | --- | --- |
| B1 | **10,5-MB-XML aus der Wurzel nach `resources/rekordbox/`** ( optional Git-LFS) | Clone/Checkout/Diff deutlich kleiner, Ressourcenpfad eindeutig (heute: Vite-Asset aus der Wurzel **und** `extraResources`) | Vite- und electron-builder-Konfiguration anpassen; LFS erfordert Client-Setup | M | **P2** |
| B2 | **Große Binärdateien prüfen**: `tests/fixtures/musdb-falcon69` (5 × 1 MB), `reference/*.png` (≈ 1,2 MB) → LFS oder按需 erzeugen | Repo schlank, schnellere Checkouts | Fixtures dürfen nicht versehentlich fehlen → Generator/LFS-Pflicht | M | **P3** |
| B3 | **Testsuite parallelisieren** (Runner läuft seriell, 85 s) | Feedback in ~25–30 s statt 85 s | Temporäre Verzeichnisse/Ports müssen kollisionsfrei sein; Reihenfolge-Abhängigkeiten müssen raus | S/M | **P2** |
| B4 | **Import-Pfad messen**: 12.246-Tracks-XML einmalig parsen, Ergebnis cachen; Dauer als Kennzahl im Log | Spürbar schnellerer Track-Import, messbare Basis | Cache-Invalidierung bei geänderter Datei (mtime/Größe) | M | **P2** |
| B5 | **Nativmodul-Prebuilds cachen** (Artefakt/CI-Cache statt Rebuild auf jedem Rechner) | Setup von ~Minuten auf Sekunden, weniger ABI-Fehler | Cache muss pro Electron-Version getrennt werden | M | **P3** |

### C. Vereinfachen und Zusammenführen

| Nr. | Maßnahme | Vorteile | Nachteile / Risiko | Aufwand | Prio |
| --- | --- | --- | --- | --- | --- |
| C1 | **npm-Skripte von 47 auf ~15 Kernbefehle** reduzieren (Rest als dokumentierte Aliase) | Neueinsteiger findet sich zurecht; weniger Falschaufrufe | Alte Skriptnamen in Gewohnheit/Doku müssen mitziehen | S/M | **P2** |
| C2 | **Dokumentation ordnen**: `docs/` (13 Dateien) + `docs/archive/` + `VORHABEN.md` + Root-MDs (`README`, `BUILD_WINDOWS`) → Startseite mit Index, Aktuelles nach vorn, Historie ins Archiv | Eine Einstiegsseite statt Suchen; veraltete Anleitungen fallen auf | Einmaliger Umstellungsaufwand, Links prüfen | S/M | **P2** |
| C3 | **Tests bündeln** (69 Dateien, ~40 × `stem-*`) zu thematischen Suiten | Weniger Redundanz, schnellere Läufe, klarere Verantwortlichkeiten | Bestehende Einzelfilter (`--filter`) müssen weiter funktionieren | M | **P3** |
| C4 | **`server.ts` (Express-Dev-Server) bewerten**: nur für Browser/Dev nötig – im Electron-Betrieb über IPC ersetzen oder klar als Dev-Pfad markieren | Eine statt zwei Laufzeitwelten, weniger Abweichungen Dev ↔ App | Browser-Demo-Pfad entfällt ggf. | M | **P3** |
| C5 | **`tools/code_analysis`** als Werkzeug dokumentieren (Aufruf, Ausgabe) oder entfernen | Kein unklares Verzeichnis mehr | Entfällt nur, wenn wirklich ungenutzt | S | **P3** |

### D. Modernisierung

| Nr. | Maßnahme | Vorteile | Nachteile / Risiko | Aufwand | Prio |
| --- | --- | --- | --- | --- | --- |
| D1 | **Pflicht-Gate**: Lint + `tsc --noEmit` + Tests lokal (pre-commit) und in CI | Typ- und Stilfehler kommen nie in den Branch | Initiale Aufräumrunde nötig | S/M | **P2** |
| D2 | **Dependency-Pflege** (Electron, Vite, onnxruntime-node, Prebuilds) mit festem Rhythmus + `npm audit` | Sicherheits- und ABI-Fehler werden selten | Updates am Nativmodul brauchen Verifikation auf Windows | M (dauerhaft) | **P2** |
| D3 | **Ein Release-Pfad**: Version, CHANGELOG, Abnahme-Checkliste (Gate grün, ANLZ-Herkunft `REKORDBOX_ANLZ`) | Reproduzierbare Auslieferung, keine „Bauchgefühl-Releases“ | Disziplin bei jedem Release | S/M | **P2** |

### E. Hausordnung

| Nr. | Maßnahme | Vorteile | Nachteile / Risiko | Aufwand | Prio |
| --- | --- | --- | --- | --- | --- |
| E1 | **Alte Branches/PRs schließen** (3 offene PRs vom 17./18.09., Dutzende `arena/*`-Branches) | Klare Historie, weniger Verwechslungen | Vorher prüfen/sichern, ob darin noch offene Arbeit steckt | S | **P2** |
| E2 | **Schutzzonen schriftlich fixieren** (s. Abschnitt 4) und in Reviews abfragen | Verhindert, dass „Aufräumen“ die verbindlichen Regeln aufweicht | – | S | **P1** |

---

## 4. Schutzzonen – hier wird nicht „vereinfacht“

Diese Regeln sind die Substanz des Projekts; jede Aufräum-Maßnahme muss sie unberührt lassen.

1. **1:1-Kette**: XML-TrackID → `djmdContent.ID` (exakt diese Zeile) → deren `AnalysisDataPath` → dessen ANLZ → dessen PPTH-Original. Kein Ersatz, keine Ähnlichkeitssuche, keine eigene Berechnung. Fehlt ein Glied → harter Fehlercode.
2. **Kein Fallback auf eigene Analyse**: eine selbst berechnete Kurve ist `GENERATED_FALLBACK` und darf nie als Rekordbox-Daten ausgegeben werden (keine erfundenen ANLZ-Tags, kein Prüfvermerk).
3. **Leseschutz**: Quelldateien (Datenbank, ANLZ, Audio) werden ausschließlich lesend geöffnet; Größe/mtime werden vor und nach jedem Lesen verglichen.
4. **Gate/Renderer-Parität**: die ANLZ-Struktur stammt aus einer Quelle (`src/rekordbox/anlzStructure.ts` + generiertes Spiegelmodul für Electron).
5. **Pfad-Schutz** (`electron/pathGuard.cjs`): Exporte gehen nur in ein ausgewähltes Zielverzeichnis, nie über eine Quelldatei.

---

## 5. Vorgeschlagene Reihenfolge

| Welle | Inhalt | Zielbild danach |
| --- | --- | --- |
| **Welle 1** | erledigt: Müll raus, Generiertes ignoriert, Python-Ära und defektes CI entfernt | übersichtliche Wurzel, unveränderte Funktion |
| **Welle 2** | A1, A3, A4, A5, E2 | **0 rote Tests**, Pflichtschritte gesichert, klare Schutzzonen |
| **Welle 3** | A2, B1, B3 | CI prüft jeden Push, Repo spürbar kleiner, Suite < 30 s |
| **Welle 4** | A7 (schrittweise), C1, C2 | `App.tsx` entflochten, 15 Kernbefehle, ein Dokueinstieg |
| **Welle 5** | B2/B4/B5, C3–C5, D1–D3, E1 | dauerhafte Pflege statt Feuerwehr |

## 6. Messkriterien (Exit-Bedingungen)

- `node scripts/run-tests.mjs` → **73/73**, **0 SKIP** im Default-Profil.
- CI grün auf Windows inkl. Native-Modul-Nachweis (`rekordbox:native:check`).
- Testlauf unter **30 s**, Clone ohne die 10,5-MB-XML bzw. mit LFS.
- `src/App.tsx` unter **2.000 Zeilen**, kein Modul mit Risikowert > 50.
- Jedes Release mit dokumentierter Abnahme (Gate `OK / REKORDBOX_ANLZ` auf einem echten Track).

## 7. Offene Entscheidungen (bitte ankreuzen)

1. **A2** – CI neu als Electron-Build (ja / nein / später)?
2. **B1** – 10,5-MB-XML nach `resources/rekordbox/`, mit oder ohne Git-LFS?
3. **A6** – Legacy-Root `D:\PIONEER` komplett entfernen?
4. **C4** – Express-`server.ts` behalten (Browser/Dev) oder abschaffen?
5. **E1** – alte Branches und die drei offenen PRs schließen?
6. **A7** – `App.tsx`-Zerlegung in welcher Reihenfolge (Import zuerst oder Stems zuerst)?
