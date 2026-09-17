# Eigenes Stem-Modell trainieren

Anleitung zum Finetuning eines BS-RoFormer-Modells und zur Einbindung in die
Desktop-App. Das Notebook dazu: `notebooks/train_stem_model_colab.ipynb`.

## Warum Colab und nicht lokal/CI

Training braucht eine GPU. Die Entwicklungs-Sandbox dieses Repos hat keine
(2 CPU-Kerne, 3 GB RAM) und erreicht weder Zenodo noch Hugging Face. Colab löst
beides: echte GPU und freier Netzzugang.

## Warum Finetuning und nicht from scratch

BS-RoFormer von Null auf MUSDB18-HQ zu trainieren ist in der Literatur ein Job
für mehrere A100-GPUs über Tage bis Wochen. Eine Colab-Session endet deutlich
früher (Gratis-Stufe typischerweise nach wenigen Stunden). From scratch führt
dort zuverlässig zu einem unbrauchbaren Modell.

Deshalb startet das Notebook von einem vortrainierten Checkpoint und passt ihn
an. Das ist in Stunden machbar und liefert ein Modell, das tatsächlich trennt.

## Lizenzlage — vor dem Start lesen

| Bestandteil | Lizenz | Kommerziell nutzbar? |
| --- | --- | --- |
| MSST-Trainingscode (ZFTurbo) | MIT | ja |
| MUSDB18 / MUSDB18-HQ (Daten) | *educational purposes only*, Teile CC BY-NC-SA | **nein** |
| Vortrainierte ZFTurbo-/viperx-Gewichte | keine explizite Lizenz | **ungeklärt** |
| Ergebnis eines Finetunes | erbt beide Einschränkungen | **nein** |

Ein auf MUSDB18 finetuntes Modell ist ein Forschungs- und Entwicklungsartefakt.
MUSDB18 formuliert das ausdrücklich: „provided for educational purposes only …
should not be used for any commercial purpose without the express permission of
the copyright holders".

Für ein kommerzielles Release brauchst du **eigene oder lizenzierte
Multitracks** und Startgewichte mit klarer Lizenz — oder eine schriftliche
Freigabe der Rechteinhaber.

## Datensatzformat

Für eigene Multitracks (Weg B im Notebook):

```
dataset/
  train/
    Song A/  vocals.wav  drums.wav  bass.wav  other.wav
    Song B/  vocals.wav  drums.wav  bass.wav  other.wav
  valid/
    Song C/  vocals.wav  drums.wav  bass.wav  other.wav
```

44.1 kHz, stereo, WAV, pro Song alle Stems gleich lang. Die Mischung entsteht
beim Training als Summe der Stems — dieselbe Konvention wie in
`src/stems/goldStandard.ts`.

Unter ~10 Songs reicht es für einen Rauchtest, aber nicht für ein Modell, das
auf fremder Musik funktioniert.

## Ergebnis in die App bringen

Das Notebook exportiert `<name>.ckpt`, `<name>.yaml` und eine `.json` mit
sha256 und Lizenzstatus. Lokal:

```bash
mkdir -p models/bsroformer
cp airdox_bs_roformer_finetune_v1.{ckpt,yaml} models/bsroformer/
export STEM_MODEL_FILENAME=airdox_bs_roformer_finetune_v1.ckpt
```

`STEM_MODEL_FILENAME` wird von `separateForDesktop()` gelesen und an
`AudioSeparatorSeparator` durchgereicht; programmatisch geht auch
`separateForDesktop({ modelFilename: '…' })`. Ohne beides bleibt es beim
Standardmodell aus `DEFAULT_AUDIO_SEPARATOR_MODEL`.

`models/` ist in `.gitignore` — Gewichte gehören nicht ins Repository.

## Bewertung: das Gate entscheidet, nicht die Loss

Die Trainings-Loss sagt nichts darüber, ob das Modell im Produkt taugt.
Maßgeblich ist das Stem Isolation Gate:

```bash
npm run test:stems
```

| Ergebnis | Bedeutung |
| --- | --- |
| `TECHNICAL_FAIL` | Pipeline kaputt: Stems fehlen, Original verändert, Absturz |
| `TECHNICAL_PASS_QUALITY_FAIL` | läuft sauber, trennt aber zu schlecht |
| `RELEASE_READY` | technisch und qualitativ ausreichend |

Solange dort nicht `RELEASE_READY` steht, ist das Modell nicht fertig.

Zur Einordnung der SDR-Werte (vocals, Multisong-Benchmark): Referenzmodelle
liegen bei 10–12 dB, unter ~6 dB ist ein Modell für ein Produkt nicht brauchbar.
Vergleiche immer gegen den **Startcheckpoint** — ist der Finetune schlechter als
sein Ausgangspunkt, hat das Training geschadet (meist zu hohe Lernrate oder zu
wenige/zu einseitige Daten).

## Stem-Anzahl

Viele verfügbare Checkpoints sind 2-Stem-Modelle (vocals/other), die App
erwartet standardmäßig 4 Stems. Entweder mehrere 2-Stem-Modelle finetunen oder
von einem 4-Stem-Checkpoint mit passender Config starten. Die Instrumentenliste
in der Config muss zu den Startgewichten passen, sonst passt die Ausgabeschicht
nicht und das Laden schlägt fehl.
