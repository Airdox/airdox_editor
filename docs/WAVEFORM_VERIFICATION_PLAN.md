# Waveform-Verifikation ab 0.4.20

## Ziel

Jede Waveform muss auf eine nachweisbare Quelle zurückführbar sein. Für
Rekordbox-Tracks ist das ausschließlich `ANLZ/PWV`; eine lokale Analyse des
Arbeitsbuffers darf diese Quelle nicht ersetzen. Palette-Clips übernehmen den
Ausschnitt aus derselben Analysequelle.

## Agenten und Gates

Der `Waveform Gatekeeper` (`npm run verify:waveform`) orchestriert die Agenten
sequenziell. Ein späteres Gate darf nicht über einen Fehler der vorherigen
Stufe hinweggehen.

1. **Source-Provenance-Agent**
   - prüft Renderer, Palette und Editpfad statisch
   - blockiert `analyzeAudioBuffer` als Ersatzquelle nach einem Edit
   - prüft rekursiven ANLZ-Scan und Datenträger-Suche
2. **Resolver-/ANLZ-Scan-Agent**
   - `AnalysisDataPath`, Pfadnormalisierung und verschachtelte `USBANLZ`-Ordner
3. **Binary-Provenance-Agent**
   - echte DAT/EXT-Strukturen, PPTH, PQTZ, PCOB/PCO2 und PWV
4. **Variant-/Renderer-Agent**
   - Zoom-Auswahl, `sourceTag`, keine synthetische Waveform
5. **Palette-Agent**
   - Palette-Buckets stammen aus dem Quelltrack-Analysebereich und werden
     gespeichert; kein zufälliges Farb-Balkenmuster als Datenersatz
6. **XML/DB-Integrations-Agent**
   - Import → ANLZ-Merge → Modell → Renderer
7. **TypeScript- und Produktions-Build-Gatekeeper**
   - `lint` und `build` müssen grün sein

## Laufzeitnachweis

Ein Diagnosebericht muss für einen Track mindestens folgende Kette zeigen:

```text
ANLZ PPTH-Scan: scanned > 0, Treffer > 0
→ anlzAutoApplied: true
→ waveformSource: PWV...
→ waveformBuckets > 0
→ analysis.origin: REKORDBOX_ANLZ
→ Palette waveform.origin: REKORDBOX_ANLZ
```

Wenn ein Gate nicht erfüllt ist, beendet der Gatekeeper den Lauf mit einem
Grund und einer konkreten nächsten Agentenaktion. Ein Leerzustand ist nur dann
korrekt, wenn der Bericht nachweisbar keine ANLZ-Quelle gefunden hat; eine
lokale Neuberechnung darf diesen Zustand nicht still kaschieren.
