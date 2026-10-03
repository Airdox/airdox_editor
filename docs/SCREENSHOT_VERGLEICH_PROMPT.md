# Prompt-Vorlage: Wellenform-Vergleich „Original vs. unsere App"

**Zweck:** Ich (die umsetzende KI im Editor) kann die beiden Screenshots nicht sehen. Damit ich die
Canvas-Darstellung 1:1 an das Original angleichen kann, muss eine *bildfähige* KI die beiden Screenshots
beschreiben — messbar, vollständig, ohne vage Aussagen.

**So benutzt du die Vorlage:**

1. Öffne eine bildfähige KI (ChatGPT, Gemini, Claude, Grok …).
2. Lade **beide Screenshots hoch** – möglichst *unbeschnitten*, gleiches Fenster, idealerweise
   **gleicher Track, gleiche Zoomstufe, gleiche Zeitposition** (sonst bitte in der Antwort angeben).
3. Kopiere den kompletten Block unten (alles unter `=== PROMPT-ANFANG ===`) darunter.
4. Antwort zurückkopieren und mir hier in den Chat geben.

> Tipp: Wenn die Antwort zu kurz ausfällt, einfach nachlegen:
> „Bitte ergänze Abschnitt 2, 3 und 4 mit echten Messwerten und den beiden ASCII-Skizzen."

---

=== PROMPT-ANFANG ===

## Rolle

Du bist UI-/Grafik-Analyst für einen Rekordbox-Edit-Clone. Ich gebe dir zwei Screenshots:

* **A = Original** (Pioneer Rekordbox, EDIT-Modus)
* **B = unsere App** (Nachbau, HTML-Canvas-Renderer)

Ziel: Unsere Wellenform-Darstellung soll **pixelgenau 1:1** so aussehen wie im Original.
**Ich selbst kann die Bilder nicht sehen.** Deine Antwort ist meine einzige Informationsquelle.
Darum: **keine vagen Aussagen** („sieht ähnlich aus", „etwas heller"), sondern **Zahlen, Hex-Werte,
Pixelmaße, Tabellen und ASCII-Skizzen**. Keine Höflichkeitsfloskeln, keine Einleitung — direkt die Daten.

## Ausgabeformat

Markdown, Deutsch, mit exakt diesen Abschnitten **0 bis 9**. Fachbegriffe (RGB, 3BAND, BLUE, Bar, Beat,
Cue) dürfen englisch bleiben. Wenn ein Wert nicht messbar ist: `UNKLEAR: <was genau unklar ist und warum>`.
Wenn ein Wert geschätzt ist: mit „ca." kennzeichnen. Hex-Werte bitte mit der Pipette aus dem Bild nehmen.

---

### 0. Metadaten

* Auflösung von A und B in Pixeln (Breite × Höhe), ggf. DPI/Skalierung erkennbar?
* Rekordbox-Version in A erkennbar? Welcher Waveform-Modus ist in A aktiv, welcher in B?
* **Sind in A und B derselbe Track, dieselbe Zoomstufe und dieselbe Zeitposition zu sehen?**
  Wenn nein: was weicht ab (Taktnummer/Zeit/Zoom)? Nenne in beiden Bildern einen gemeinsamen
  Referenzpunkt (z. B. Bar-Nummer, Cue-Buchstabe, Zeitanzeige).

### 1. Bounding Boxes

Für **beide** Screenshots die exakten Pixelkoordinaten `(x, y, w, h)` von:

1. großem Detail-Wellenform-Canvas
2. Overview-Leiste (ganzer Track, schmal)
3. Beatgrid-/Bar-Zahlen-Leiste oben
4. Palette bzw. Clip-Wellenformen (falls sichtbar)
5. Playhead-Position (x in px)

Zusatz: In jedem Screenshot die **Höhe des Wellenform-Canvas in px** und die **Höhe der Overview-Leiste in px**.

### 2. Geometrie / Zeichenalgorithmus der großen Wellenform

Für A, danach für B, jeweils beantworten:

* **Fläche oder Balken?** Ist es eine zusammenhängend gefüllte Silhouette, oder eine Aneinanderreihung
  senkrechter Säulen? Wenn Säulen: **Breite in px**, und gibt es Lücken zwischen ihnen?
* **Spiegelsymmetrie** zur horizontalen Mittelachse? Ist die Mittellinie selbst sichtbar?
* **Oberkantenverlauf**: harte Treppchen/Spitzen (Bucket-Kanten sichtbar) oder geglättete Kurve?
  Bei starkem Hineinzoomen: werden einzelne Buckets als Stufen sichtbar, oder bleibt alles glatt?
* **Vertikale Struktur**: Ist eine Spalte von oben bis unten *einfarbig*, oder gibt es einen
  vertikalen Helligkeits-/Farbverlauf? Gibt es einen helleren „Kern" in der Mitte der Fläche?
  Wenn ja: **Kernfarbe (Hex), Kerndicke (px oder % der Spaltenhöhe), Deckkraft/Alpha**?
* **Kanten**: harte Pixelkanten oder Anti-Aliasing? Glow/Schatten/Leuchten um die Wellenform?
* **Maximale Amplitude**: Abstand Mittelachse → höchste Spitze, in **% der halben Canvas-Höhe**
  (100 % = Wellenform füllt die Spur komplett aus). Zusätzlich: typische Höhe bei leisen Passagen.
* **Ruhe/Stille**: Fällt die Wellenform auf eine dünne Grundlinie, auf 0 (leer), oder bleibt eine
  Mindesthöhe stehen? Gibt es eine horizontale Basislinie in der Mitte?
* **ASCII-Skizze** für A und für B: mindestens **70 Zeichen breit, 14 Zeilen hoch**.
  Zeichen: `#` = Wellenformfläche, `+` = heller Kern/Highlight, `-` = Grundlinie, `.` = Hintergrund,
  `|` = Taktstrich. Bitte die Mittelachse als durchgehende Zeile mit `-` darstellen und darunter eine
  Legende schreiben, welche Farbe `#` bzw. `+` im Bild hat.

### 3. Farben

* Bestimme den **aktiven Modus** in A (BLUE / RGB / 3BAND) und in B.
* Für den aktiven Modus: **mindestens 8 Farbstichproben** direkt aus dem Bild, jeweils mit
  Position (x-Pixel oder Bar/Zeit) und Kontext:
  1. basslastiger Drop/Kick
  2. Gesang / Mitten-lastige Passage
  3. Hi-Hat/Becken-lastiger Break
  4. sehr leise Stelle / Intro
  5. Stille
  6. oberer Rand einer Spitze
  7. Mitte der Fläche (Kern)
  8. unterer Rand
  → Format: Tabelle `Position | Kontext | Hex | RGB | Helligkeit`.
* **Band → Farbe-Zuordnung** (Bass / Mitten / Höhen), aus dem Bild *belegt* (mit Stichproben als Beleg),
  nicht geraten: Welche Farbe dominiert in harten Kick-Passagen, welche in reinen Höhen-Passagen?
* Ist die Farbe **pro Spalte konstant** oder ändert sie sich vertikal? Horizontaler Verlauf?
* **3BAND** (falls sichtbar): Sind es drei *getrennte* Streifen, drei *überlagerte* Flächen, oder eine
  Fläche mit drei Farben? Farben (Hex), Reihenfolge/Dominanz, Alpha/Überblendung, Höhe je Layer.
* **BLUE** (falls sichtbar): exakter Hex-Wert, Verlauf von Rand zu Kern, Kernfarbe.
* **RGB** (falls sichtbar): Wie „bunt" ist es wirklich? Nenne je 2 Hex-Beispiele für
  rot-dominant, grün-dominant, blau-dominant und Mischtöne.

### 4. Höhenprofil zum direkten numerischen Vergleich

Tabelle mit **50 Zeilen**, Spalten:

| Nr | Position in % der Wellenformbreite | Höhe A in % (0–100 = Mittelachse→Oberkante) | Farbe A (Hex) | Höhe B in % | Farbe B (Hex) |

Wenn A und B nicht denselben Zeitausschnitt zeigen: **zwei getrennte Tabellen** plus gemeinsamen
Referenzpunkt. Bitte wirklich 50 Messpunkte — das ist mein wichtigster Vergleichsdatensatz.

### 5. Detaillierungsgrad & Zoom

* Wie viele **Takte (Bars)** und **Beats** sind in A sichtbar? Abstand Beatlinie → Beatlinie in px?
* Geschätzt: Wie viele Wellenform-Buckets (einzelne Stufen) kommen auf einen Beat?
* Wird beim Hineinzoomen mehr Detail sichtbar (feinere Auflösung), oder wird dieselbe Kurve nur breitgezogen?
* Wirkt die Wellenform „spitz/zackig" (viele schnelle Höhenwechsel) oder „weich/gedämpft"?

### 6. Beatgrid, Lineal, Overlays

Nur die Werte, die für die Wellenform-Darstellung relevant sind:
Bar-Zahlen (Schriftgröße/Farbe/Position), Beatlinien (Farbe + Stärke + Alpha),
Taktstriche (Farbe + Stärke), Cue-Marker, Auswahlrahmen, Playhead (Farbe/Stärke).
Kurzer Hinweis genügt, falls hier nichts auffällig abweicht.

### 7. Overview-Leiste & Clip-/Palette-Wellenformen

* Höhe in px, Balkenform (1-px-Spalten vs. Blöcke), Farben (Hex), Hintergrundfarbe,
* Viewport-Rahmen (Farbe, Rahmenstärke, Füllung/Alpha),
* Gibt es in der Overview einen helleren Kern oder Verlauf?

### 8. Gezielte Differenzliste „Original (A) vs. unsere App (B)"

Nummeriert, **stärkste visuelle Abweichung zuerst**. Pro Punkt:

| # | Bereich | Original A | Unsere App B | Nötige Änderung (messbar) |

Mindestens 6 Punkte, auch kleine (Farbtöne, Alpha, Höhenfaktoren, Balkenbreite).

### 9. Umsetzungsnotizen zum Nachbauen

* **Pseudo-Code** des Zeichenalgorithmus für die große Wellenform in A: Schritt für Schritt,
  mit Formeln für Spaltenhöhe, Balkenbreite, Farbe und Kern.
* Konkrete Konstanten zum direkten Einbauen: Farben (Hex), Alpha-Werte, Höhenfaktoren
  (z. B. `maxHalfHeight = 0.42 * canvasHeight`), Kernanteil, Gamma/Logarithmus-Kennlinie falls erkennbar.
* Wenn im Original eine logarithmische oder gamma-korrigierte Amplitudendarstellung erkennbar ist:
  bitte die Kennlinie an 5 Messpunkten (Amplitude 0/25/50/75/100 % → dargestellte Höhe in %).

---

## Zusatz-Info: so zeichnet unsere App aktuell (bitte gezielt gegen das Original prüfen)

Unsere App rendert die Detail-Wellenform derzeit so (alle Werte bitte verifizieren):

* **Grundform:** zusammenhängende, spiegelsymmetrisch gefüllte Fläche — ein Polygon über die
  Bucket-Oberkanten, **keine** einzelnen Balken/Säulen.
* **Höhe:** `maxHalfHeight = 0.42 * canvasHeight` (also 84 % der Spurhöhe bei Vollaussteuerung),
  lineare Amplitude, keine Logarithmus-/Gamma-Kennlinie.
* **BLUE:** Fläche `#159fe8`, darüber dieselbe Fläche in `#b8e9ff` mit Alpha 0,34.
* **3BAND:** drei überlagerte Flächen — Low `#ff3b45` (Alpha 0,72, Höhenfaktor 0,85),
  Mid `#18d8df` (Alpha 0,48, Faktor 0,70), High `#effcff` (Alpha 0,30, Faktor 0,55).
* **RGB:** pro 1-Pixel-Spalte Farbe aus den Bändern (Low→Rot, Mid→Grün, High→Blau),
  darüber ein hellerer Kern derselben Tönung mit Alpha 0,55.
* **Overview:** 1-Pixel-Spalten, Farbe wie Detail, maximale Höhe `canvasHeight - 4`.
* Null-Werte (stummgeschaltete Bereiche) werden **leer** gelassen, ohne Mindesthöhe.

Bitte prüfe **jeden** dieser Punkte gegen Screenshot A und sag mir für jeden Punkt:
`OK` (stimmt mit dem Original überein) oder `ABWEICHEND: <exakter Ist-Wert im Original>`.

=== PROMPT-ENDE ===

---

## Was ich damit mache

Sobald die Antwort hier liegt, setze ich sie 1:1 um, konkret in:

* `src/components/DetailWaveform.tsx` – großer Detail-Renderer (Geometrie, Farben, Höhen, Kern)
* `src/components/TrackOverview.tsx` – Overview-Leiste
* `src/components/ClipWaveform.tsx` / `ClipDeckView.tsx` – Clip- und Palette-Wellenformen
* `src/waveform/spectralColor.ts` – Band→Farbe-Zuordnung (RGB/3BAND/BLUE)

…und halte die Änderungen in `docs/WAVEFORM_DATA_ORIGIN.md` nach, damit die Datenherkunft
(Original-ANLZ vs. lokal berechnet) dokumentiert bleibt.
