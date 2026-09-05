# Nachweis: Wellenform-Farben (überarbeitet)

Anlass: die Kurve wirkte blass und pastelltonartig. Ursache war die RGB-Mischung
der alten Rampe in Richtung `rgb(255, 219, 168)` (Cremeweiß) plus ein heller
Weißstreifen auf *jeder* Bar (Alpha ab 0,25) und ein 15%iger Loop-Schleier.

Gemessen mit `npx tsx tests/waveform-colors.test.ts` – reine Farbmathematik, kein
Screenshot. Sättigung = HSV-Sättigung (1 = reine Farbe, 0 = grau/weiß);
Weißanteil = kleinster Kanal ÷ 255 (direktes Maß für „pastellig“).

| Bereich (Testsignal, alle Amplituden) | Sättigung vorher | Sättigung nachher | Weißanteil vorher | Weißanteil nachher |
| --- | --- | --- | --- | --- |
| gesamtes Signal | 0.843 | 0.979 | 0.152 | 0.021 |
| laute Balken (peak ≥ 0.55) | 0.654 | 0.915 | 0.346 | 0.085 |

Neue Rampe (`src/waveform/colors.ts`):

* HSL-Anker 22°→45°, Sättigung 0,92…1,0; Luminanz 0,22→0,63 (heißes Gold statt Creme)
* Hintergrund `#0a0806` (warmes Fast-Schwarz) statt Blauschwarz
* heiße Balkenspitze ab peak ≥ 0,82 in `rgb(255, 208, 66)`
* Höhen erhöhen den Blaukanal nicht: „heiß“ heißt Rot/Grün rauf, Blau runter
* Kern erst ab peak ≥ 0,62, max. 0,42 Deckkraft (vorher: ab 0,25 bis 0,80 auf jeder Bar)
* Loop-Schleier von 0,15 auf 0,08 gesenkt
* Übersichtsspur, Detailspur und Clip-Minis rechnen alle mit `amberColor`

Vorschau: `vorschau.png` (900×176) – identisches Signal, zwei Zeilen:
* oben, graue Marke: alte Rechnung (Creme-Rampe + Weißstreifen auf jeder Bar)
* unten, amber Marke: neue Rechnung (gesättigte Rampe, heiße Spitzen, Kern nur noch bei lauten Balken)
