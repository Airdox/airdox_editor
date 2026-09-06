# Recherche: Stems im Airdox_intelligents_Editor

**Stand: 06.09.2026 · Nur Recherche – es ist nichts implementiert.**

Diese Seite sammelt, was „Stems“ heute bedeuten, welche Dateiformate es gibt, was davon zu unserem
read-only-Pfad passt und was ausdrücklich nicht dazugehört. Entscheidungen sind hier nur *vorgeschlagen*:
kein Parser, kein Kanal-Slicing, keine Oberfläche, kein Test.

---

## 1. Der Begriff meint zwei verschiedene Dinge

| Bedeutung | Was in der Datei steht | Wer erzeugt sie | Für uns |
| --- | --- | --- | --- |
| **Echte Stems** (Mehrspur-Datei) | 4–5 fertige Stereo-Lagen in *einer* Datei, vorgerechnet vom Producer oder Label | Native Instruments Stem Creator, `stemgen`, Labels (Beatport, Juno Download und Traxsource verkaufen Stems) | **passend** – nur lesen und Kanäle entflechten, keine KI, keine Rechnung am Signal |
| **Echtzeit-Trennung** („Stems-Funktion“) | nichts – die Lagen werden beim Abspielen aus der Stereosumme geschätzt | Serato Stems (3.0+), rekordbox Track Separation, VirtualDJ, djay Neural Mix, Traktor Pro 4, Engine DJ (vorgerechnet) | **unpassend** – Modelldaten, Rechenzeit, neue Artefakte, und das Ergebnis wäre unser eigenes Erzeugnis |

Der Unterschied ist entscheidend, weil unser Versprechen lautet: Dateien der Bibliothek werden nur lesend
angefasst, eigene Berechnungen sind als Fallback gekennzeichnet. Echte Stems-Dateien passen in dieses
Versprechen (wir lesen nur mehr heraus, als wir bisher zeigen); Echtzeit-Trennung würde es brechen – wir
hätten ein Signal, das nirgends gespeichert ist, aber klingt wie die Aufnahme.

## 2. Die Formate

### 2.1 NI Stem File (`.stem.mp4`) – der offene Standard, an dem sich alles misst

* MP4-Container nach ISO/IEC 14496-12/-14, Endung `.stem.mp4`. Jeder normale MP4/AAC-Spieler gibt die
  Datei als ganzes Stück wieder; diese Abwärtskompatibilität ist Teil des Entwurfs, nicht Zufall.
* Inhalt: **fünf Stereo-Spuren** – vier Stems plus der gemasterte Mix, also zehn Kanäle in einem
  `mdat`. Die Lagen sind in einer festen Reihenfolge nummeriert (1 Drums, 2 Bass, 3 Other, 4 Vocals,
  5 Master): `stemgen` übernimmt sie genau so, wenn es `--drum`, `--bass`, `--other`, `--vocal` und
  `--mastered` in Spuren schreibt.
* Codec: Standard ist 256 kbit/s VBR AAC (lizenzfrei im Container), **ALAC verlustfrei** ist erlaubt.
* Ein einziger neuer Box-Typ trägt die Metadaten: `stem` **in `moov/udta`**, Inhalt ist **JSON** – bewusst
  in `udta`, damit bestehende APIs (AVFoundation auf iOS, TagLib) ohne Sonderweg drankommen. Darin:
  Formatversion, Streamzahl, je Stem Name, Farbe und Kanalzuordnung, dazu die Werte der Masterdynamik.
* **Stem Master Dynamics**: Kompressor und Limiter als Teil der *Wiedergabe*, Parameter in der Datei –
  weil beim Stummschalten einer Lage die Masterdynamik des Mitschnitts nicht mehr gilt. Wer Stems nur
  anzeigt, braucht das nicht; wer einen einzelnen Stem exportiert, sollte es erwähnen, sonst klingt die
  Datei leiser als erwartet.
* Nachweise: ISMIR-2015-Kurzpapier der NI-Autoren (CC BY 4.0) mit Box-Diagramm, stems-music.com,
  Traktor-Supportartikel (Stem-Deck seit 2.9.0, seit 2.10.1 mit allen vier Lagen und je
  VOLUME/FILTER/FX SEND; Deck-Formen wechselt Traktor seit 2.8.0 beim Laden automatisch), Mixxx 2.6 liest
  das Format (Epic #13116: `stem_count` 2..4, je Stem Volume/Mute/Farbe/VU, einzelner Stem in den Sampler).
  TagLib **2.2** (Feb. 2026) hat „Support for NI STEM in MP4 files“ bekommen, **2.3.1** repariert
  64-bit-lange Atome – nützlich als Referenz für die Fallstricke.
* Werkzeuge zum *Erzeugen*: NI Stem Creator (gratis, Oberfläche, vier fest benannte Lagen),
  `acolombier/stemgen` (Demucs + PyTorch, Docker), `faroit/stempeg` (Python, braucht MP4Box),
  `monteslu/stem-mp4` (reines JavaScript für Metadaten und Muxen, `Atoms.readNiStemsMetadata`).

### 2.2 `.serato-stems` – Seitendatei, kein Audiostream

Serato DJ Pro 3.0+ und Studio schreiben bei genutzten Stems eine Datei **neben** das Original
(`track.1.2.serato-stems`, also Originalname plus Zähler), die das Trennergebnis enthält; beim Entfernen
des Tracks aus der Kiste löscht Serato sie wieder. Für uns unattraktiv: kein offenes Dokument, kein Audio
zum Anfassen, und das Ergebnis stammt aus einem proprietären Modell. Interessant ist nur die *Speicherstrategie*
(Seitendatei statt Eingriff ins Original) – und als Warnung: Fremdsoftware legt Dateien in unserem
Bibliotheksordner ab, die wir beim Vergleich von Sammlungen wiedererkennen müssen.

### 2.3 rekordbox: „STEMS“ ist eine Funktion, kein Dateiformat

* Die Track Separation kam mit **rekordbox 6.7.0** (zusammen mit dem DDJ-FLX10) in drei Teilen:
  Vocals, Drums, Instrumental. Die Release Notes zu **7.2.8 (03.12.2025)** zählen „Added [4 Stems
  (VOCAL, INST, BASS, DRUMS)] to STEMS function“ auf, dazu den Umschalter 3 Stem/4 Stem im STEMS-Modus und
  einen Fix für den Fall, dass „Prioritize sound quality“ gewählt war; 7.0.4 brachte laut Szene spürbar
  bessere Qualität.
* Eingeschaltet unter Preferences → Extensions (bzw. Controller/Deck), Laufzeit lokal, an ein Abo oder eine
  unterstützte Hardware gebunden, 16 GB RAM empfohlen. Bedienung: Part ISO verwandelt den
  Kanal-Equalizer-Zug in Part-Isolatoren, Effekte liegen je Part an, „Part Waveform“ zeigt die Hüllkurve
  des gerade hörbaren Teils statt der Summe.
* Für unsere Datenwege ist die entscheidende Frage, **ob dabei etwas in `master.db` oder in den
  ANLZ-Dateien landet**. In dem, was wir lesen, findet sich nichts Stembezügliches: die `djmdContent`-
  Spalten (ID, FolderPath, FileNameL, Title, ArtistID, AlbumID, GenreID, BPM, Length, …, AnalysisDataPath,
  FileSize, SampleRate, ISRC …) kennen kein Stem-Feld, und unsere ANLZ-Abschnitte sind `PPTH`, `PQTZ`,
  `PWV3`–`PWV7`, `PCO2`/`PCP2`, `PCOB`/`PCPT`, `PSSI`. Das ist *kein* Beweis – wir lesen nur eine
  Teilmenge –, deshalb Abschnitt 7, Punkt 2.
* Abspielgeräte ohne Rechner: dazu ist nichts dokumentiert, die Szene hofft seit 2023 darauf. Für uns heißt
  das: Stems bleiben ein Thema des Arbeitsplatz-Rechners. Auf USB-Medium funktioniert ein Stem-Set nur,
  wenn es als Datei vorliegt – dann sind es normale Titel, die wie jeder andere behandelt werden.

### 2.4 Weitere Anbieter am Rand

* **Traktor Pro 4** erzeugt aus normalen Titeln selbst Stem-Versionen (KI, lokal gespeichert, eigene Datei,
  mit dem Originaleintrag verknüpft) – inzwischen also *beide* Welten in einem Produkt.
* **Engine DJ** rendert Stems in Engine DJ Desktop offline vor, damit Standalone-Geräte sie nutzen
  können – das Modell „vorrechnen und als Datei ablegen“ statt „beim Abspielen raten“, mit einem
  zusätzlichen Vorbereitungsschritt und auf den meisten Geräten einer kleinen Lizenzgebühr.
* **Matroska-Stems**: `draft-swhited-mka-stems` (IETF) will Stems in MKA standardisieren, Mixxx diskutiert
  Unterstützung. Beobachten, nicht bauen.

## 3. Was ein Pfad für uns konkret heißen würde

Nur Skizze, in Reihenfolge so gewählt, dass jeder Schritt für sich etwas bringt.

1. **Erkennen (reines JavaScript, kein natives Modul).** Box-Baum der Datei bis `moov/udta` ablaufen, `stem`
   suchen, JSON lesen; Zahl der `trak`-Boxen als Zusatzbeweis, 64-bit-Längen über das `largesize`-Feld
   mitnehmen (der Fall, den TagLib 2.3.1 repariert hat). Ergebnis: „dieser Track trägt vier Stems: Drums
   (rot), Bass (gelb) …“. Größe: ein Modul `src/audio/stemFormat.ts` mit rund 120 Zeilen plus Fixture-Test.
2. **Lagern statt rechnen.** `readOriginalAudio` liefert die Bytes unverändert,
   `audioCtx.decodeAudioData` (Chromium in Electron 44) gibt einen `AudioBuffer` mit allen Kanälen –
   Zehnkanal-AAC und -ALAC sind normaler Chromium-Alltag, muss aber an einer echten Datei verifiziert
   werden (Abschnitt 7, Punkt 3). Unser `PcmAudio` ist ohnehin eine Kanalliste, ein Stem wäre also einfach
   `{ sampleRate, channels: [L, R] }`: kein neuer Audiotyp, kein neuer Speicherweg.
3. **Anzeigen.** Je Stem Mini-Peaks und eine Farbkante aus `stem.color` in `DetailWaveform` und
   `TrackOverview`, dazu die vorhandenen Bänder: das Bass-Band aus dem Bass-Stem ist echte Information
   statt geschätzter Filterbank – genau die Schwachstelle, die `WELLENFORM-DATEN.md` bei eigenen
   Berechnungen nennt.
4. **Bearbeiten.** Alles, was wir für Clips schon haben, läuft pro Stem unverändert weiter:
   Pegel-Anpassung (`normalizeClipAudio`, Ziel −1 dBFS, max. 12 dB), Tempo- und Tonhöhenanpassung
   (`fitClipForTrack`, `speed = Ziel-BPM / Quellen-BPM`), Kopieren und Ausschneiden. Ein Stem-Clip ist ein
   Clip. Neu wäre nur der *Ausschnitt aus mehreren Lagen*: „kopiere nur Vocals von Takt 5–12 in Spur 2“.
5. **Hören.** Die Deck-Ansicht der Clip-Bibliothek ist der natürliche Ort für Stem-Schalter
   (`MUTE`/`SOLO` je Lage, gleiche Grenzen wie die Loop-Region), weil dort Ein-/Ausstieg, Schleife und
   Vorschau schon sitzen – ohne die Spur anzufassen.
6. **Exportieren.** „Nur Vocals als WAV“ über unseren `encodeWav`, Benennung wie bei Clip-Exporten. Beim
   Export einer einzelnen Lage bleibt die Master-Dynamics-Frage offen: erwähnen, nicht heimlich anwenden.
7. **Was wir nicht schreiben.** Keine `.stem.mp4`, keine `.serato-stems`, keine Seitendatei neben den
   Originalen – nicht, weil es technisch schwer wäre, sondern weil unsere Zusage „Dateien der Bibliothek
   bleiben unverändert“ sonst ausgehöhlt würde (Fremdsoftware legt dort ohnehin Dateien ab, und wir würden
   beim Sammilvergleich Geisterdateien sehen).

## 4. Warum Echtzeit-Trennung abgelehnt wird

* **Rechenlast und Geräte:** `stemgen` braucht Demucs (htdemucs) und PyTorch, empfiehlt Docker und warnt vor
  FFmpeg-Versionskonflikten; lokal in einer Electron-App hieße das eine ONNX-Laufzeit plus Modell-Download
  in der Größenordnung von Hundert Megabyte und pro Titel Rechenzeit im Minutenbereich auf der CPU.
* **Qualität:** die Vergleiche der Szene (NUO-STEMS, RipX, rekordbox mit Deezer Spleeter, VirtualDJ,
  Serato, djay, Ableton Live 12, Logic, FL Studio) zeigen große Unterschiede je Material; gerade Vocals und
  Hall-Ausklänge bleiben dünn. Die Szene ist sich einig, dass ein *vorgerechnetes* Modell sauberer trennt
  als jeder Echtzeit-Mixer (ein Anbieterblog nennt für htdemucs fine-tuned rund 8 dB SDR und hält es für
  „meaningfully cleaner“ als jede Echtzeit-Engine) – das aber um den Preis von Renderzeit und Hardware.
  Ein geschätzter Stem klingt wie eine schlechtere Version des Songs; als *Datenbasis* für Zuschnitt und
  Wellenform wäre das irreführend, weil die Kurve dann nicht mehr zeigt, was die Datei enthält.
* **Betrieb:** Mehrfaches gleichzeitiges Trennen erzeugt CPU-Spitzen und Aussetzer, die Geräteabhängigkeit
  ist groß („quality and stability are very hardware dependent“ über rekordbox 7), und selbst Serato-User
  pre-analysieren ihre Tracks, damit es live sauber bleibt. Genau die Betriebsart, die ein Editor nicht will.
* **Lizenz und Erwartung:** Modelle und ihre Ausgaben sind rechtlich nicht abschließend geklärt, und Nutzer
  erwarten nach „read-only“ kein zusätzliches Erzeugnis im Ordner.
* **Nutzen:** Was ein DJ damit will (Lagen im Set schalten), geschieht im Player, nicht im Editor. Unser
  Beitrag ist Ordnung, Zuschnitt und Analyse – dafür sind vorgerechnete Stems die einzige ehrliche Quelle.

## 5. Lizenz- und Rechtsrand

* Das Format ist offen dokumentiert (ISMIR-Paper CC BY 4.0, Spezifikation öffentlich, keine Gebühr für
  Erstellung, Vertrieb oder Nutzung); AAC und ALAC dekodiert Chromium, eigene Encoder bringen wir nicht mit.
* Stems werden ganz normal verkauft (Beatport, Bleep, Juno Download, Traxsource, Label-Shops) – reale
  Dateien in echten Sammlungen, die unser Import heute als „MP4 mit zehn Kanälen“ ansieht.
* Eine `.stem.mp4` ist für jedes MP4-fähige Gerät eine normale Audiodatei; nichts am Format verlangt nach
  Umbenennen oder Umwandeln.

## 6. Aufwand und Nutzen (Vorschlag, falls das je gebaut wird)

| Stufe | Inhalt | Aufwand | Nutzen |
| --- | --- | --- | --- |
| A | `stem`-Box lesen, Stem-Namen und Farben in Track-Details und Bibliothek | klein (ein Modul plus Fixture-Test) | „Was für eine Datei habe ich hier eigentlich?“ – und die Basis für alles Weitere |
| B | Kanäle zu `PcmAudio`-Lagen, Wellenform je Stem | mittel (Decoder verifizieren, `analyzer.ts` je Lage aufrufen) | sichtbare echte Information, Bass- und Melodieband werden korrekt |
| C | Stem als Clip: ausschneiden, Pegel, Tempo, Export | klein, *wenn* A und B stehen (alles vorhanden: `buildClip`, `fitClipForTrack`, `encodeWav`) | der eigentliche Arbeitsgewinn: Vokal-Takt in die eigene Spur, Instrumental behalten |
| D | Mute/Solo je Stem in der Deck-Ansicht | klein (Deck-Ansicht vorhanden) | Kontrolle beim Zuschneiden |
| E | KI-Trennung | groß | abgelehnt, siehe Abschnitt 4 |

## 7. Offene Punkte (Recherche, kein Code)

1. **Eine echte Datei besorgen** (NI-Beispiel-STEM oder ein Beatport-Stem) und die `stem`-Box 1:1
   dokumentieren: Schlüsselnamen, Verhalten bei fehlenden Lagen (nur Vocals + Master), wie `stemgen` und
   `stem-mp4` die JSON schreiben, und ob Traktor Zahlen oder Namen erwartet.
2. **Ist in `master.db` oder ANLZ wirklich nichts?** Eine Bibliothek mit und ohne genutzter Stem-Funktion
   vergleichen: `PRAGMA table_info(djmdContent)` (und `djmdCue`, `djmdCollection`) sowie die
   ANLZ-Sektionsliste vor und nach der Analyse nach neuen Signaturen durchsuchen. Natürlich nur lesend.
3. **Decoder verifizieren** in unserer Electron-Fassung: `decodeAudioData` mit Zehnkanal-AAC und
   Zehnkanal-ALAC – Kanalzahl, Reihenfolge, `chan`-Deskriptoren – und wie sich unsere Pfade
   (`EditableAudio`, Peaks) mit zehn Kanälen verhalten, bevor wir zerlegen.
4. **rekordbox-Versionen:** was genau 6.7.x konnte (drei Teile), was 7.0.4 verbesserte, was 7.2.8 ändert
   (vier Teile, Qualitätsmodus), und ob das Trennergebnis irgendwo als Datei sichtbar ist.
5. **Serato-/Engine-Dateien im Sammelordner** als Kennzeichnungsaufgabe statt Importaufgabe: erkennen, dass
   `*.serato-stems` danebenliegt, und sie im Bibliotheksvergleich nicht als „unbekannte Datei“ melden.
6. **Matroska-Stems behalten:** falls `draft-swhited-mka-stems` Werkzeuge bekommt, ist das Box-Parsing
   ähnlich und der Container fasst mehr als vier Lagen – ein Grund, den Parser an die `stem`-Box zu binden
   und nicht an die Endung `.stem.mp4`.

## 8. Quellen

* ISMIR 2015 (Late-Breaking Demo): M. Le Goff, C. Carrier, S. Walker, „Introducing STEM, a New
  Multi-Channel Audio Format“ – Box-Struktur (`ftyp` → `moov` → `udta` → `stem` mit JSON, fünf `trak`),
  ALAC-Option, Master-Dynamics-Kette, Stem Creator und das Kommandozeilenwerkzeug `ni-stem` für
  eigenes JSON. https://www.ismir2015.uma.es/LBD/LBD39.pdf
* stems-music.com – die Formatseite von Native Instruments (Creator, Vertrieb, Abspielen als normale
  Stereodatei).
* Native Instruments Support, „How Can I Control the Individual Stems on a TRAKTOR Stem Deck?“
  (2.9.0 führt das Stem-Deck ein, 2.10.1 zeigt alle vier Lagen mit VOLUME/FILTER/FX SEND, automatischer
  Deck-Formenwechsel); TRAKTOR Play-Handbuch „Working with Stems“ (vier Lagen plus Summe, beim Abspielen
  sind alle hörbar); djworx, „Traktor 2.9 is out now — Stems are go!“ (Stem-Steuerung braucht passende
  Hardware, Sub-Mix-Regler seit 2.9 als „Deck Common“ für Remix- und Stem-Deck gemeinsam).
* djtechtools, „Stems: A New Multi-Channel Audio Format for DJing“ (14.10.2015) und cdm.link, „Stems for
  DJs and More“ – fünf Stereolagen, 256 kbit/s AAC, ID3-Tags je Stem, offene Nutzung ohne Gebühr.
* splice.com, „Native Instruments Stems Format: How Does it Work or, How Should it Work?“ – MP4-Mehrspur-
  Aufbau, die Vier-Stem-Grenze als Entscheidung von NI und nicht des Containers.
* Mixxx: News 2024-08-26 „Stem Mixing“, Epic #13116 (`stem_count`, je Stem `volume`/`mute`/`color`/
  `vu_meter`, `load_selected_track_stems`), Issue #16347 (andere Stem-Formate, Verweis auf
  `draft-swhited-mka-stems` und `codeberg.org/SamWhited/mkastem`).
* TagLib-Releases: 2.2 „Support for NI STEM in MP4 files“, 2.3.1 „MP4: Support NI STEM atoms with 64-bit
  length“. https://taglib.org/older.html
* `acolombier/stemgen` (Demucs + PyTorch, Kanalreihenfolge Drums/Bass/Other/Vocals/Master),
  `faroit/stempeg` (Python + MP4Box), `monteslu/stem-mp4` und `monteslu/m4a-stems` (reines JavaScript,
  `readNiStemsMetadata` → `{ version, mastering_dsp, stems: [{ name, color }] }`, Pfad `moov/udta/stem`).
* Serato Support, „Misc: Stems“ (`.serato-stems` beim Speichern) und NUO-STEMS-Doku „Serato Mode“
  (`track.1.2.serato-stems` neben der Audiodatei, Caching beim Kisten-Scan, Serato-Neustart nötig).
* rekordbox Release Notes: https://rekordbox.com/en/support/releasenote/ – 7.2.8 (03.12.2025) mit vier
  Stems, 3/4-Stem-Umschalter und Fix für „Prioritize sound quality“.
* wearecrossfader.co.uk, „How to Get Rekordbox Stems On Any Pioneer DJ Setup“ (Track Separation seit
  6.7.0, Aktivierung unter Preferences → Extensions, MIDI-Mapping, 7.0.4-Soundverbesserung) und
  Reddit-Threads dazu (Abo-/Hardware-Bindung, 16 GB RAM, fehlende CDJ-Unterstützung).
* dj.studio, „2026 DJ Software Stem Separation Benchmark“ und „Stem Separation Usability Test For DJ
  Apps“ – Einordnung der Echtzeit-Trenner (rekordbox 7: Qualität „very hardware dependent“, Serato am
  besten mit Voranalyse, Engine DJ mit Vorberechnung gegen kleine Lizenzgebühr, 16 GB RAM als Untergrenze, CPU-
  Last beim Mehrfach-Stem-Betrieb). https://dj.studio/blog/dj-software-stem-separation-benchmark
* stemsplit.io, „Rekordbox Stem Separation (2026)“ – Offline-Modell (htdemucs FT, ~8,4 dB SDR) gegen
  Echtzeit-Engines: Vocals mit Resten vom Instrument, Bass/Kick gut, melodische Teile artefaktbehaftet,
  „high CPU usage when stems are active on multiple decks“.
* medium.com/@dj_nuo, „State of STEMS for DJs (June 2023)“ – Algorithmen der Anbieter (rekordbox 6.7.3 =
  Deezer Spleeter, Serato und VirtualDJ proprietär, NUO-STEMS und RipX = Demucs v3/v4).
* pyrekordbox-Doku, „Rekordbox 6 Database Format“ – Tabellen und Spalten von `master.db` (unsere
  Lese-Teilmenge, kein Stem-Feld). https://pyrekordbox.readthedocs.io/en/latest/formats/db6.html
