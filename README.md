# Local Audio Editor

Ein leichtgewichtiger, lokaler Desktop-Audio-Editor mit Deck-Ansicht für DJs und Audio-Enthusiasten.

## Features (main branch)

- Zwei unabhängige Audio-Decks (Deck A / Deck B)
- Track laden, abspielen, pausieren
- Wellenform-Anzeige (Placeholder)
- Lokale Track-Datenbank (SQLite)
- Temporäre Arbeitskopien
- Basis-Konfiguration über `config.json` oder Umgebungsvariablen

## Installation

```bash
pip install -r requirements.txt
python -m audio_editor.main
```

## Struktur

```
audio_editor/
  main.py       # Hauptfenster & App-Start
  deck.py       # Deck-Widget (Track laden, Player)
  player.py     # Audio-Playback Logik
  database.py   # SQLite Track-Datenbank
  config.py     # Konfiguration & Pfade
  utils.py      # Hilfsfunktionen
```

## Roadmap

- [ ] Cloud Stem Separation via Google Drive + Colab (Branch: feature/colab-stem-separation)
  - Button "Externe Stems berechnen"
  - Background Worker
  - Google Drive Upload/Download
  - htdemucs GPU in Colab
  - Automatische Verknüpfung

## Lizenz

MIT
