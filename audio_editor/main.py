"""
Hauptfenster des Audio Editors - Feature Branch: colab-stem-separation
Mit Cloud Stem Separation Integration
"""
import sys
from pathlib import Path
from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QHBoxLayout, QVBoxLayout,
    QLabel, QStatusBar, QMenuBar, QMenu, QMessageBox, QPushButton,
    QDialog, QTextEdit
)
from PySide6.QtCore import Qt, Slot
from PySide6.QtGui import QAction

from .config import CONFIG, get_app_dirs, APP_VERSION, BRANCH, has_valid_credentials, get_drive_folders
from .database import AudioDatabase
from .deck import DeckWidget
from .stem_manager import StemManager

class ColabSetupDialog(QDialog):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Colab Setup Anleitung")
        self.setMinimumSize(700, 600)
        self._init_ui()

    def _init_ui(self):
        layout = QVBoxLayout(self)
        
        title = QLabel("Google Colab Setup für Stem Separation")
        title.setStyleSheet("font-size: 16px; font-weight: bold;")
        layout.addWidget(title)
        
        text = QTextEdit()
        text.setReadOnly(True)
        
        # Lade Anleitung aus colab_trigger oder hardcode
        instructions = """
# Google Colab Setup - Vollautomatisierter Workflow

## Überblick
Der Audio Editor lädt Tracks automatisch auf Google Drive hoch.
Ein Colab Notebook beobachtet den Input-Ordner und verarbeitet neue Tracks mit htdemucs GPU.

## Schritt 1: Google Drive Ordnerstruktur
Die App erstellt automatisch:
- /MyDrive/AudioEditor_Stems/Input/   <- Uploads vom Editor
- /MyDrive/AudioEditor_Stems/Output/<Track_ID>/ <- Ergebnisse

## Schritt 2: Colab Notebook einrichten

1. Gehe zu https://colab.research.google.com
2. Erstelle neues Notebook oder lade audio_editor/colab/colab_notebook.ipynb hoch
3. WICHTIG: GPU aktivieren!
   Laufzeit -> Laufzeittyp ändern -> Hardwarebeschleuniger: GPU (T4/V100/A100)
4. Füge folgende Zellen ein (oder nutze das mitgelieferte Notebook):

### Zelle 1: Drive mounten
```python
from google.colab import drive
drive.mount('/content/drive')
```

### Zelle 2: GPU prüfen
```python
import torch
print(f"CUDA verfügbar: {torch.cuda.is_available()}")
print(f"GPU: {torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'Keine GPU!'}")
assert torch.cuda.is_available(), "Bitte GPU in Colab aktivieren!"
```

### Zelle 3: Dependencies
```python
!pip install -q demucs torch torchaudio
```

### Zelle 4: Processor Code
Kopiere den Inhalt von audio_editor/colab/demucs_processor.py
Oder:
```python
!git clone https://github.com/facebookresearch/demucs
# Oder nutze die lokale Datei
from pathlib import Path
import sys
sys.path.append('/content/drive/MyDrive/AudioEditor_Stems/')
# ... (siehe demucs_processor.py)
```

### Zelle 5: Watcher starten (Hauptautomatisierung)
```python
from audio_editor.colab.demucs_processor import DemucsProcessor

processor = DemucsProcessor(
    output_base=Path("/content/drive/MyDrive/AudioEditor_Stems/Output")
)

# Startet Endlosschleife die Input-Ordner überwacht
processor.watch_and_process(
    input_base=Path("/content/drive/MyDrive/AudioEditor_Stems/Input"),
    poll_interval=10
)
```

## Schritt 3: Automatisierung

Der Watcher erkennt automatisch:
- _TRIGGER_<Track_ID>.json Dateien
- Zugehörige Audio-Dateien <Track_ID>_<name>.mp3/wav

Er führt dann aus:
1. Lädt htdemucs Modell (offizielle Gewichte via demucs Bibliothek)
2. Nutzt GPU für Separation
3. Speichert nach Output/<Track_ID>/:
   - drums.wav
   - bass.wav
   - other.wav
   - vocals.wav
   - status.json
   - DONE Marker

Die Desktop-App pollt alle 15 Sekunden ob Ergebnisse bereit sind,
lädt sie herunter und verknüpft sie mit dem Originaltrack.

## Modell Details
- Modell: Hybrid Transformer Demucs (htdemucs)
- Gewichte: Automatisch über demucs.pretrained.get_model('htdemucs')
- Keine manuellen Links nötig
- GPU zwingend erforderlich
- Standard Stems: drums, bass, other, vocals

## Troubleshooting
- Kein GPU: In Colab Laufzeittyp ändern
- Keine Ergebnisse: Prüfe ob Watcher läuft, Input-Ordner existiert
- Drive nicht gemountet: drive.mount() ausführen
- Timeout: Polling Timeout ist 1 Stunde, für lange Tracks erhöhen

## Mock Modus für Entwicklung
Ohne Google Credentials:
- Setze Env Var USE_MOCK_DRIVE=1
- Oder aktiviere in config.json: cloud.use_mock_drive = true
- Oder im Credentials Dialog "Mock-Modus" wählen
Dann wird lokale Simulation verwendet (kein echtes Drive/Colab).
"""
        text.setText(instructions)
        layout.addWidget(text)
        
        close_btn = QPushButton("Schließen")
        close_btn.clicked.connect(self.accept)
        layout.addWidget(close_btn)


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.db = AudioDatabase()
        self.stem_manager = StemManager(database=self.db)
        self.app_dirs = get_app_dirs()
        self._init_ui()

    def _init_ui(self):
        self.setWindowTitle(f"Local Audio Editor v{APP_VERSION} - [{BRANCH}]")
        self.setGeometry(100, 100, 1400, 800)
        
        # Menü
        menubar = self.menuBar()
        file_menu = menubar.addMenu("Datei")
        
        exit_action = QAction("Beenden", self)
        exit_action.triggered.connect(self.close)
        file_menu.addAction(exit_action)
        
        cloud_menu = menubar.addMenu("Cloud")
        
        setup_action = QAction("Colab Setup Anleitung", self)
        setup_action.triggered.connect(self.show_colab_setup)
        cloud_menu.addAction(setup_action)
        
        creds_action = QAction("Credentials prüfen", self)
        creds_action.triggered.connect(self.check_credentials)
        cloud_menu.addAction(creds_action)
        
        mock_action = QAction("Mock Drive testen", self)
        mock_action.triggered.connect(self.test_mock_drive)
        cloud_menu.addAction(mock_action)
        
        help_menu = menubar.addMenu("Hilfe")
        about_action = QAction("Über", self)
        about_action.triggered.connect(self.show_about)
        help_menu.addAction(about_action)
        
        # Zentrales Widget
        central = QWidget()
        self.setCentralWidget(central)
        main_layout = QVBoxLayout(central)
        
        # Titel
        title = QLabel("Local Audio Editor - Deck Ansicht mit Cloud Stem Separation")
        title.setAlignment(Qt.AlignCenter)
        title.setStyleSheet("font-size: 20px; font-weight: bold; padding: 10px;")
        main_layout.addWidget(title)
        
        subtitle = QLabel(
            f"Branch: {BRANCH} | Daten: {self.app_dirs['data']} | "
            f"Drive: {get_drive_folders()['base']} | "
            f"Mock: {CONFIG['cloud'].get('use_mock_drive', False)}"
        )
        subtitle.setAlignment(Qt.AlignCenter)
        subtitle.setStyleSheet("color: #888; font-size: 11px; padding-bottom: 5px;")
        main_layout.addWidget(subtitle)
        
        # Credentials Status
        self.creds_status = QLabel()
        self.update_creds_status()
        self.creds_status.setAlignment(Qt.AlignCenter)
        main_layout.addWidget(self.creds_status)
        
        # Decks Layout
        decks_layout = QHBoxLayout()
        
        self.deck_a = DeckWidget(deck_id="A", database=self.db)
        self.deck_b = DeckWidget(deck_id="B", database=self.db)
        
        self.deck_a.track_loaded.connect(self.on_track_loaded)
        self.deck_b.track_loaded.connect(self.on_track_loaded)
        self.deck_a.stems_available.connect(self.on_stems_available)
        self.deck_b.stems_available.connect(self.on_stems_available)
        
        decks_layout.addWidget(self.deck_a)
        decks_layout.addWidget(self.deck_b)
        
        main_layout.addLayout(decks_layout)
        
        # Status Bar
        self.status_bar = QStatusBar()
        self.setStatusBar(self.status_bar)
        self.status_bar.showMessage("Bereit - Bitte Track laden | Feature: Externe Stems berechnen in jedem Deck")

    def update_creds_status(self):
        if has_valid_credentials():
            try:
                from .config import get_credentials_or_raise
                creds = get_credentials_or_raise()
                if creds.get("mock"):
                    self.creds_status.setText("🔧 Modus: Mock Drive (lokale Simulation, kein echtes Google Drive)")
                    self.creds_status.setStyleSheet("color: #a0a060; font-size: 11px; background-color: #2a2a1a; padding: 4px; border-radius: 3px;")
                else:
                    self.creds_status.setText("✅ Google Drive Credentials gefunden - Cloud Modus aktiv")
                    self.creds_status.setStyleSheet("color: #60a060; font-size: 11px; background-color: #1a2a1a; padding: 4px; border-radius: 3px;")
            except Exception as e:
                self.creds_status.setText(f"⚠️ Credentials Fehler: {e}")
                self.creds_status.setStyleSheet("color: #a06060; font-size: 11px; background-color: #2a1a1a; padding: 4px; border-radius: 3px;")
        else:
            self.creds_status.setText("❌ Keine Google Drive Credentials - Bitte in Cloud Menü prüfen oder Mock Modus nutzen")
            self.creds_status.setStyleSheet("color: #a06060; font-size: 11px; background-color: #2a1a1a; padding: 4px; border-radius: 3px;")

    @Slot(str, str)
    def on_track_loaded(self, track_id, file_path):
        self.status_bar.showMessage(f"Track geladen: {Path(file_path).name} (ID: {track_id})", 5000)
        self.update_creds_status()

    @Slot(str)
    def on_stems_available(self, track_id):
        self.status_bar.showMessage(f"✅ Stems verfügbar für Track {track_id} - Alles klar, die Stems sind nun verfügbar.", 10000)

    def show_colab_setup(self):
        dlg = ColabSetupDialog(self)
        dlg.exec()

    def check_credentials(self):
        self.update_creds_status()
        try:
            from .config import get_credentials_or_raise, find_credentials_file
            cred_file = find_credentials_file()
            creds = get_credentials_or_raise()
            
            info = f"Credentials Status:\n\n"
            if cred_file:
                info += f"Datei gefunden: {cred_file}\n"
            else:
                info += f"Keine Credentials-Datei gefunden an Standardorten\n"
            
            info += f"\nCredentials Typ: {creds.get('type', 'mock' if creds.get('mock') else 'unknown')}\n"
            
            if creds.get("mock"):
                info += "\n🔧 Mock Modus aktiv - keine echten Cloud-Calls\n"
                info += f"Mock Drive Verzeichnis: {self.app_dirs['mock_drive']}\n"
            else:
                info += "\n✅ Echte Credentials vorhanden\n"
                info += f"Drive Ordner: {get_drive_folders()}\n"
            
            info += f"\nConfig: {CONFIG['cloud']}\n"
            
            QMessageBox.information(self, "Credentials Status", info)
        except Exception as e:
            QMessageBox.warning(self, "Keine Credentials", str(e))

    def test_mock_drive(self):
        """Testet Mock Drive Workflow"""
        try:
            from .cloud.drive_client import MockDriveClient
            import tempfile
            
            client = MockDriveClient()
            client.ensure_folder_structure()
            
            # Erstelle Dummy Audio Datei
            temp_dir = Path(self.app_dirs["temp"])
            temp_dir.mkdir(parents=True, exist_ok=True)
            dummy_audio = temp_dir / "test_track.mp3"
            dummy_audio.write_text("dummy audio content for testing")
            
            track_id = "test123"
            result = client.upload_track(dummy_audio, track_id)
            
            # Simuliere Colab
            client.simulate_colab_processing(track_id)
            
            is_ready, stems = client.check_output_ready(track_id)
            
            msg = (
                f"Mock Drive Test:\n\n"
                f"Upload: {result['file_name']}\n"
                f"Trigger: {result['trigger_path']}\n"
                f"Bereit: {is_ready}\n"
                f"Stems gefunden: {len(stems)}\n"
                f"{stems}\n\n"
                f"Mock Drive Root: {client.mock_root}\n"
            )
            
            QMessageBox.information(self, "Mock Drive Test", msg)
            
            # Cleanup
            dummy_audio.unlink(missing_ok=True)
            
        except Exception as e:
            import traceback
            QMessageBox.critical(self, "Mock Test Fehler", f"{e}\n\n{traceback.format_exc()}")

    def show_about(self):
        QMessageBox.about(
            self,
            "Über Audio Editor",
            f"Local Audio Editor v{APP_VERSION}\n"
            f"Branch: {BRANCH}\n\n"
            "Features:\n"
            "- Zwei Decks mit Track laden, Play/Pause/Stop\n"
            "- Cloud Stem Separation via Google Drive + Colab\n"
            "- Button 'Externe Stems berechnen' in jedem Deck\n"
            "- Hintergrund Worker (GUI friert nicht ein)\n"
            "- Google Drive Upload/Download\n"
            "- Colab GPU mit htdemucs Modell\n"
            "- Automatische Verknüpfung mit Originaltrack\n"
            "- Pop-up: 'Alles klar, die Stems sind nun verfügbar.'\n\n"
            f"Datenverzeichnis: {self.app_dirs['data']}\n"
            f"DB: {self.app_dirs['db']}\n"
            f"Stems: {self.app_dirs['stems']}\n"
            f"Drive: {get_drive_folders()}\n\n"
            "Siehe COLAB_SETUP.md für Colab Einrichtung."
        )

def main():
    app = QApplication(sys.argv)
    app.setApplicationName("AudioEditor")
    app.setOrganizationName("AudioEditor")
    
    # Dark Theme
    app.setStyleSheet("""
        QMainWindow { background-color: #1a1a1a; }
        QWidget { background-color: #1a1a1a; color: #e0e0e0; }
        QGroupBox { 
            border: 1px solid #444; 
            border-radius: 6px; 
            margin-top: 10px; 
            padding-top: 10px;
            font-weight: bold;
        }
        QGroupBox::title { subcontrol-origin: margin; left: 10px; }
        QPushButton { 
            background-color: #2d2d2d; 
            border: 1px solid #555; 
            padding: 8px 16px; 
            border-radius: 4px;
        }
        QPushButton:hover { background-color: #3a3a3a; }
        QPushButton:disabled { color: #666; background-color: #222; }
        QLabel { color: #e0e0e0; }
        QSlider::groove:horizontal { background: #333; height: 6px; border-radius: 3px; }
        QSlider::handle:horizontal { background: #5a9bd5; width: 14px; height: 14px; border-radius: 7px; margin: -4px 0; }
        QProgressBar {
            border: 1px solid #444;
            border-radius: 4px;
            text-align: center;
            background-color: #222;
        }
        QProgressBar::chunk {
            background-color: #2a5a8f;
            border-radius: 3px;
        }
        QTextEdit {
            background-color: #1e1e1e;
            border: 1px solid #444;
            border-radius: 4px;
        }
    """)
    
    window = MainWindow()
    window.show()
    
    sys.exit(app.exec())

if __name__ == "__main__":
    main()
