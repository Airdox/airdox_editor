# Nachweis: 100 % Rekordbox-Daten (Quelle der Wahrheit)

Regel: „Alle visuellen und zeitlichen Daten müssen zu 100 % aus den realen
Rekordbox/Hackerblocks-Daten stammen … Eine eigene Analyse-Engine ist nicht das Ziel.“

| Prüfung | Ergebnis |
| --- | --- |
| PQTZ · Schlagliste kommt bitgenau im Datenmodell an | bestanden |
| PQTZ · Importiertes Raster wird nicht durch ein neues ersetzt | bestanden |
| PQTZ · Taktmaß steht in den Daten und wird nicht angenommen | bestanden |
| Editor · Rasterung springt auf die importierten Beatzeiten | bestanden |
| Editor · Takt-Rasterung trifft nur echte Taktanfänge | bestanden |
| Editor · Beatlage ist an den importierten Beats exakt | bestanden |
| Editor · Beatlänge kommt aus den importierten Abständen | bestanden |
| Eingriff · Schnitt verschiebt nur den Rest, der Anfang bleibt unverändert | bestanden |
| Eingriff · Einfügen schiebt ab der Einfügestelle und lässt die Beats mitlaufen | bestanden |
| Eingriff · Verschieben trägt die Beats des Blocks mit | bestanden |
| Auflösung · Eine Lage ergibt kein Farb-Bild | bestanden |
| Auflösung · Keine erfundene Verstärkung in der Eigenberechnung | bestanden |
| Kennzeichnung · Herkunft ist im Editor lesbar | bestanden |
| Kennzeichnung · Ohne Schlagliste wird fortgeschrieben – und gesagt | bestanden |
| Kennzeichnung · master.db liefert kein Raster, das als eines aussieht | bestanden |
| Kennzeichnung · Keine zweite Analyse-Engine im Quellcode | bestanden |
| Kennzeichnung · Nachgezeichnete Kurve trägt Projekt-Herkunft | bestanden |
| Tragen · Schnitt braucht gar keine neue Analyse | bestanden |
| Tragen · Einfügen rechnet nur das eigene Fenster | bestanden |
| Tragen · Verschieben rechnet nichts, es hängt nur um | bestanden |
| Tragen · Überlagern rechnet nur den überlagerten Bereich | bestanden |
| Tragen · Renderer analysefrei, App trägt statt zu rechnen | bestanden |
| Kennzeichnung · Fortgeschriebenes Raster nennt sich Fortschreibung | bestanden |
| XML · Jeder TEMPO-Eintrag und jedes Taktmaß wird benutzt | bestanden |

## Messwerte

```
[PQTZ] Schlagliste kommt bitgenau im Datenmodell an
Beat 12 importiert: 5464 ms
Beat 12 bei Raster aus 128 BPM: 5625 ms
größte Abweichung Import → Datenmodell: 0.0e+0 s
```

```
[PQTZ] Importiertes Raster wird nicht durch ein neues ersetzt
Abstand Beat 0→1: 469 ms · Beat 9→10: 428 ms
```

```
[Editor] Rasterung springt auf die importierten Beatzeiten
gefragt 0.300 s → 0.469000 s = Beat 1 (Schlag 2/4)
gefragt 1.000 s → 0.938000 s = Beat 2 (Schlag 3/4)
gefragt 2.600 s → 2.813000 s = Beat 6 (Schlag 3/4)
gefragt 4.400 s → 4.607000 s = Beat 10 (Schlag 3/4)
gefragt 6.000 s → 5.893000 s = Beat 13 (Schlag 2/4)
```

```
[Editor] Takt-Rasterung trifft nur echte Taktanfänge
0.50 s → Takt 1 (Schlag 1) bei 0 ms
1.50 s → Takt 2 (Schlag 1) bei 1875 ms
3.20 s → Takt 3 (Schlag 1) bei 3750 ms
5.00 s → Takt 4 (Schlag 1) bei 5464 ms
```

```
[Editor] Beatlage ist an den importierten Beats exakt
Mitte zwischen Beat 9 und 10 liegt bei Beat-Position 9.500
```

```
[Editor] Beatlänge kommt aus den importierten Abständen
Durchschnitt aus 16 importierten Beats: 0.450000 s · Wert des ersten Eintrags: 0.468750 s
```

```
[Eingriff] Schnitt verschiebt nur den Rest, der Anfang bleibt unverändert
Kopf unverändert: 0, 469, 938, 1406 ms · Rest um die Schnittlänge 1875 ms nach vorne (größte Abweichung 0.0e+0 s) · 12 Beats, letzter bei 4.8750 s
```

```
[Eingriff] Einfügen schiebt ab der Einfügestelle und lässt die Beats mitlaufen
12 Beats um eine Taktlänge (1.8750 s) nach hinten · Beatanzahl 16
```

```
[Eingriff] Verschieben trägt die Beats des Blocks mit
Block (3 Beats) bei 0, 429, 857 ms · 9 Beats um 1286 ms nach rechts · Beatanzahl 16/16
```

```
[Auflösung] Eine Lage ergibt kein Farb-Bild
PWAV: BLUE · PWV7: BLUE, 3BAND
```

```
[Auflösung] Keine erfundene Verstärkung in der Eigenberechnung
größter Peak 0.500 · größtes Band 0.238 (kein Aufschlag, 1 kHz-Ton mit 0,5 Amplitude)
```

```
[Kennzeichnung] Herkunft ist im Editor lesbar
ANLZ: „AUS DER ANALYSE-DATEI" · eigene Rechnung: „EIGENBERECHNUNG – KEINE REKORDBOX-DATEN"
```

```
[Kennzeichnung] Ohne Schlagliste wird fortgeschrieben – und gesagt
Hinweis im Datensatz: „PQTZ ohne lesbare Beat-Einträge übersprungen."
```

```
[Kennzeichnung] Nachgezeichnete Kurve trägt Projekt-Herkunft
importiert: AUS DER ANALYSE-DATEI · nach Eingriff: NACH DEM SCHNITT NEU GEZEICHNET
```

```
[Tragen] Schnitt braucht gar keine neue Analyse
25 Buckets Kopf unverändert · 57 Buckets Rest übernommen · Länge 83 bei 80 ms pro Bucket
```

```
[Tragen] Einfügen rechnet nur das eigene Fenster
50 Buckets vorn + 50 Buckets hinten übernommen · nur 19 Buckets (1.520 s) neu gezeichnet
```

```
[Tragen] Verschieben rechnet nichts, es hängt nur um
24 Buckets an den Anfang gehängt · Summe der Kurve vorher 47.522 / nachher 40.522
```

```
[Tragen] Überlagern rechnet nur den überlagerten Bereich
nur die Buckets 12…24 neu (13 von 100)
```

```
[Kennzeichnung] Fortgeschriebenes Raster nennt sich Fortschreibung
importiert: 16 Beats ohne Flag · fortgeschrieben: 26 Beats mit Flag „FORTGESCHRIEBEN"
```

```
[XML] Jeder TEMPO-Eintrag und jedes Taktmaß wird benutzt
Anker 0 s (128 BPM) und 30 s (140 BPM) · Abstand davor 468.8 ms, danach 428.6 ms · Taktmaß 3
```

## Offen (bewusst, dokumentiert)

Nach einem Eingriff ins Audio wird die Wellenform der bearbeiteten Spur aus dem
vorhandenen PCM neu gezeichnet (`analyzePcm`, Herkunft `PROJECT`), weil die
ANLZ-Kurven fest an die Originalsamples gebunden sind. Das ist als
Nachzeichnung beschriftet und im Editor sichtbar; die dauerhafte Lösung ist das
Mitschieben der importierten Buckets (siehe WELLENFORM-DATEN.md).
