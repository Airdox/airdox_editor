# Nachweis: Schneide-Workflow der App

Demospur: 8 Takte, 128 BPM, 24000 Hz, Stereo, Beat = 0.468750 s = 11250 Samples (ganzzahlig → exakte Schnitte).

Erzeugt mit `npx tsx tests/edit-workflow.test.ts` (Generator ist deterministisch,
die Prüfsummen sind bei jedem Lauf identisch). Dieselben Funktionen wie die
Werkzeugleiste: `src/audio/editOps.ts`.

| Datei | Bedeutung | Samples | Dauer | Bytes | SHA-256 |
| --- | --- | ---: | ---: | ---: | --- |
| `nachweis-4beats-0-ausgang.wav` | Ausgangsspur (8 Takte) | 360000 | 15.000 s | 1440044 | `eb4df0f7e9e14066…` |
| `nachweis-4beats-1-ans-ende.wav` | Version 1: Anfangsblock (4 Beats) ans Ende kopiert | 405000 | 16.875 s | 1620044 | `e07944d2cbf41862…` |
| `nachweis-4beats-2-an-den-anfang.wav` | Version 2: letzter Block (4 Beats) an den Taktanfang | 405000 | 16.875 s | 1620044 | `cf5ba2dbb38eac11…` |
| `nachweis-4beats-3-mitte-raus.wav` | Version 3: mittlere 4 Beats entfernt | 360000 | 15.000 s | 1440044 | `1b92f65acf57c3b2…` |
| `nachweis-4takten-0-ausgang.wav` | Ausgangsspur (8 Takte) | 360000 | 15.000 s | 1440044 | `eb4df0f7e9e14066…` |
| `nachweis-4takten-1-ans-ende.wav` | Version 1: Anfangsblock (4 Takte) ans Ende kopiert | 540000 | 22.500 s | 2160044 | `8c290c2bebd8e783…` |
| `nachweis-4takten-2-an-den-anfang.wav` | Version 2: letzter Block (4 Takte) an den Taktanfang | 540000 | 22.500 s | 2160044 | `3f74f28e7b767a42…` |
| `nachweis-4takten-3-mitte-raus.wav` | Version 3: mittlere 4 Takte entfernt | 360000 | 15.000 s | 1440044 | `eb4df0f7e9e14066…` |

## Vollständige Prüfsummen

- `nachweis-4beats-0-ausgang.wav` → `eb4df0f7e9e14066c996d07f2b30d9472dd9f2bfe58a3aa120e3137fbcb716cc`
- `nachweis-4beats-1-ans-ende.wav` → `e07944d2cbf4186239b8574eadbc0b786075f100700c259bcd34eded12127846`
- `nachweis-4beats-2-an-den-anfang.wav` → `cf5ba2dbb38eac111ed8272a373f4332f338c48b092b7ecd66c19cb240a41814`
- `nachweis-4beats-3-mitte-raus.wav` → `1b92f65acf57c3b2a2c3f9d189f05495462b327d6f063b3cf51828b5c134d461`
- `nachweis-4takten-0-ausgang.wav` → `eb4df0f7e9e14066c996d07f2b30d9472dd9f2bfe58a3aa120e3137fbcb716cc`
- `nachweis-4takten-1-ans-ende.wav` → `8c290c2bebd8e783a67feac4931aba6bd13f206c271df59db02284580934101e`
- `nachweis-4takten-2-an-den-anfang.wav` → `3f74f28e7b767a4282407e639c9b8ba09fd27f9016a54b3e6a0437d631171e2d`
- `nachweis-4takten-3-mitte-raus.wav` → `eb4df0f7e9e14066c996d07f2b30d9472dd9f2bfe58a3aa120e3137fbcb716cc`

## Ablauf mit 4 Beats

- Einheit = 4 Beats = 4 Beats = 1.8750 s
- Samples: 360000 → 405000 → 405000 → 360000
- Beatgrid-Beats nach V3: 33, Dauer 15.0000 s
- 1.875 s entfernt; 4 Marker um 1.875 s nachgezogen, 1 Marker im Bereich gelöscht.
- 8 Marker vorher → 7 nachher (1 im Schnitt entfernt, 4 nachgezogen)

## Ablauf mit 4 Takten

- Einheit = 4 Takte = 16 Beats = 7.5000 s
- Samples: 360000 → 540000 → 540000 → 360000
- Beatgrid-Beats nach V3: 33, Dauer 15.0000 s
- 7.500 s entfernt; 4 Marker um 7.500 s nachgezogen, 4 Marker im Bereich gelöscht.
- 8 Marker vorher → 4 nachher (4 im Schnitt entfernt, 4 nachgezogen)

## Projektdatei (Beweis)

- `nachweis-projekt.airdoxproj.json` – Schema 1, Art „airdox-intelligents-project",
  1 Spur, 1 Clip aus der Clip-Bibliothek, Arbeitskopie eingebettet
  (360000 Samples @ 24000 Hz).
- `nachweis-projekt-arbeitskopie.wav` – dieselbe Arbeitskopie als Tondatei,
  SHA-256 `0cb6ee8c8240f0289f8c4138a252d442125266b8d64c46bd62fb9a9789efedc0`.
- Die Datei enthält nur referenzierte, unveränderte Originale (accessMode READ_ONLY,
  Status MISSING) und lässt sich ohne sie öffnen.

Die WAVs sind Beweise, keine Datenbestände: sie lassen sich mit dem Test jederzeit
neu erzeugen und können gelöscht werden.
