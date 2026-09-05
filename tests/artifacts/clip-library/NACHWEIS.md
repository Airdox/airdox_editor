# Clip-Bibliothek – Nachweis

Erzeugt von `tests/clip-library.test.ts` (npx tsx tests/clip-library.test.ts).

| Datei | Inhalt | Samples @ 24000 Hz | Bytes |
| ----- | ------ | ------------------------- | ----- | ----- |
| `clip-vor-rundlauf.wav` | Clip „Beweis-Clip“ direkt aus der Auswahl | 45000 | 180044 |
| `clip-nach-rundlauf.wav` | derselbe Clip nach Speichern und Öffnen eines Projekts | 45000 | 180044 |

Beide WAVs sind bytegleich, weil die Projektdatei die 16-Bit-Arbeitskopie
einbettet und das erneute Einbetten nichts mehr verändert. Der Clip behält Name,
Taktzahl (`1` Takte), BPM (`128`) und Vorschau
(`48 Buckets`).

Originale werden nicht verändert: die Bibliothek arbeitet ausschließlich auf der
Arbeitskopie (Zugriffsmodus READ_ONLY, `provenance.originalsModified = false`).
