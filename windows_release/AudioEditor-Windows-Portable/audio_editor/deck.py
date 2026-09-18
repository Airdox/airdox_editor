"""
Deck-Ansicht des Audio-Editors - Feature Branch: colab-stem-separation
Erweitert um Button "Externe Stems berechnen" und Cloud-Integration
"""
from pathlib import Path
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QFileDialog, QSlider, QGroupBox, QMessageBox, QProgressBar,
    QListWidget, QListWidgetItem, QDialog, QFormLayout, QLineEdit,
    QDialogButtonBox, QTextEdit
)
from PySide6.QtCore import Qt, Signal, Slot
from .player import AudioPlayer, PlayerState
from .utils import generate_track_id, format_time
from .config import has_valid_credentials, get_credentials_or_raise, MissingCredentialsError
from .database import AudioDatabase
from .stem_manager import StemManager

class CredentialsDialog(QDialog):
    """Dialog zum Eingeben von fehlenden Credentials"""
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Google Drive Credentials erforderlich")
        self.setMinimumWidth(500)
        self._init_ui()

    def _init_ui(self):
        layout = QVBoxLayout(self)
        
        info = QLabel(
            "Für die Cloud Stem-Separation werden Google Drive Zugangsdaten benötigt.\n\n"
            "Bitte wähle eine Option:\n"
            "1. Pfad zu service_account.json / credentials.json angeben\n"
            "2. JSON Inhalt direkt einfügen\n"
            "3. Für Entwicklung: Mock-Modus verwenden (keine echten Credentials)"
        )
        info.setWordWrap(True)
        layout.addWidget(info)
        
        form = QFormLayout()
        
        self.path_input = QLineEdit()
        self.path_input.setPlaceholderText("/pfad/zu/service_account.json oder ./credentials.json")
        path_btn = QPushButton("Durchsuchen...")
        path_btn.clicked.connect(self.browse_file)
        
        path_layout = QHBoxLayout()
        path_layout.addWidget(self.path_input)
        path_layout.addWidget(path_btn)
        
        form.addRow("Credentials Pfad:", path_layout)
        
        self.json_input = QTextEdit()
        self.json_input.setPlaceholderText('{"type": "service_account", "project_id": "..."}')
        self.json_input.setMaximumHeight(150)
        form.addRow("Oder JSON Inhalt:", self.json_input)
        
        layout.addLayout(form)
        
        # Mock Option
        self.mock_btn = QPushButton("Mock-Modus für Entwicklung verwenden (kein Google Drive)")
        self.mock_btn.setStyleSheet("background-color: #3a5a3a;")
        self.mock_btn.clicked.connect(self.use_mock)
        layout.addWidget(self.mock_btn)
        
        # Buttons
        button_box = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        button_box.accepted.connect(self.accept)
        button_box.rejected.connect(self.reject)
        layout.addWidget(button_box)

    def browse_file(self):
        file_path, _ = QFileDialog.getOpenFileName(
            self,
            "Credentials Datei auswählen",
            "",
            "JSON Files (*.json);;All Files (*.*)"
        )
        if file_path:
            self.path_input.setText(file_path)

    def use_mock(self):
        self.path_input.setText("MOCK")
        self.accept()

    def get_result(self):
        path_text = self.path_input.text().strip()
        json_text = self.json_input.toPlainText().strip()
        
        if path_text == "MOCK":
            return {"mock": True}
        if json_text:
            try:
                import json
                return json.loads(json_text)
            except Exception as e:
                QMessageBox.warning(self, "Fehler", f"Ungültiges JSON: {e}")
                return None
        if path_text:
            p = Path(path_text)
            if p.exists():
                try:
                    import json
                    with open(p, 'r') as f:
                        return json.load(f)
                except Exception as e:
                    QMessageBox.warning(self, "Fehler", f"Fehler beim Laden der Datei: {e}")
                    return None
            else:
                QMessageBox.warning(self, "Fehler", f"Datei nicht gefunden: {path_text}")
                return None
        return None


class DeckWidget(QWidget):
    """Ein einzelnes Deck (A oder B) mit Cloud Stem Feature"""
    track_loaded = Signal(str, str)  # track_id, file_path
    stems_available = Signal(str)  # track_id

    def __init__(self, deck_id: str = "A", database=None, parent=None):
        super().__init__(parent)
        self.deck_id = deck_id
        self.database = database or AudioDatabase()
        self.stem_manager = StemManager(database=self.database)
        self.player = AudioPlayer(deck_id=deck_id)
        self.worker = None
        self._init_ui()
        self._update_stems_ui()

    def _init_ui(self):
        self.setObjectName(f"Deck{self.deck_id}")
        
        main_layout = QVBoxLayout(self)
        
        # Group Box
        group = QGroupBox(f"Deck {self.deck_id}")
        group_layout = QVBoxLayout(group)
        
        # Track Info
        self.track_label = QLabel("Kein Track geladen")
        self.track_label.setStyleSheet("font-weight: bold; font-size: 14px;")
        self.track_label.setWordWrap(True)
        group_layout.addWidget(self.track_label)
        
        self.info_label = QLabel("Dauer: --:-- | Status: Stopped")
        group_layout.addWidget(self.info_label)
        
        # Waveform Placeholder
        self.waveform_label = QLabel("[ Wellenform-Anzeige ]")
        self.waveform_label.setAlignment(Qt.AlignCenter)
        self.waveform_label.setStyleSheet("""
            background-color: #2b2b2b;
            color: #888;
            border: 1px solid #444;
            padding: 30px;
            border-radius: 4px;
        """)
        group_layout.addWidget(self.waveform_label)
        
        # Position Slider
        self.position_slider = QSlider(Qt.Horizontal)
        self.position_slider.setRange(0, 1000)
        self.position_slider.setValue(0)
        group_layout.addWidget(self.position_slider)
        
        # Controls
        controls_layout = QHBoxLayout()
        
        self.load_btn = QPushButton("Track laden")
        self.load_btn.clicked.connect(self.load_track_dialog)
        controls_layout.addWidget(self.load_btn)
        
        self.play_btn = QPushButton("▶ Play")
        self.play_btn.clicked.connect(self.toggle_play)
        self.play_btn.setEnabled(False)
        controls_layout.addWidget(self.play_btn)
        
        self.stop_btn = QPushButton("■ Stop")
        self.stop_btn.clicked.connect(self.stop)
        self.stop_btn.setEnabled(False)
        controls_layout.addWidget(self.stop_btn)
        
        group_layout.addLayout(controls_layout)
        
        # --- NEU: Cloud Stem Separation Feature ---
        cloud_group = QGroupBox("Cloud Stem Separation (Google Drive + Colab)")
        cloud_layout = QVBoxLayout(cloud_group)
        
        # Erklärung
        cloud_info = QLabel(
            "Trennt den aktuell geladenen Track in Drums, Bass, Other, Vocals\n"
            "via Google Drive + Colab GPU (htdemucs Modell)"
        )
        cloud_info.setStyleSheet("color: #aaa; font-size: 11px;")
        cloud_info.setWordWrap(True)
        cloud_layout.addWidget(cloud_info)
        
        # Button "Externe Stems berechnen" - Kernanforderung
        self.stem_btn = QPushButton("Externe Stems berechnen")
        self.stem_btn.setStyleSheet("""
            QPushButton {
                background-color: #2a5a8f;
                border: 1px solid #3a7abf;
                padding: 10px 16px;
                border-radius: 6px;
                font-weight: bold;
                font-size: 13px;
            }
            QPushButton:hover {
                background-color: #3a6a9f;
            }
            QPushButton:disabled {
                background-color: #222;
                color: #666;
                border: 1px solid #333;
            }
        """)
        self.stem_btn.setToolTip(
            "Bezieht sich strikt auf den aktuell in diesem Deck geladenen Track.\n"
            "Erstellt temporäre Kopie, lädt auf Drive hoch, triggert Colab htdemucs GPU,\n"
            "lädt Ergebnisse herunter und verknüpft sie mit dem Originaltrack."
        )
        self.stem_btn.clicked.connect(self.on_stem_button_clicked)
        self.stem_btn.setEnabled(False)  # Nur wenn Track geladen
        cloud_layout.addWidget(self.stem_btn)
        
        # Progress & Status
        self.stem_progress = QProgressBar()
        self.stem_progress.setRange(0, 100)
        self.stem_progress.setValue(0)
        self.stem_progress.setVisible(False)
        cloud_layout.addWidget(self.stem_progress)
        
        self.stem_status_label = QLabel("")
        self.stem_status_label.setStyleSheet("color: #7ec8e3; font-size: 11px;")
        self.stem_status_label.setWordWrap(True)
        self.stem_status_label.setVisible(False)
        cloud_layout.addWidget(self.stem_status_label)
        
        # Stems Liste
        self.stems_list_label = QLabel("Verfügbare Stems:")
        self.stems_list_label.setStyleSheet("font-weight: bold; font-size: 11px; margin-top: 5px;")
        self.stems_list_label.setVisible(False)
        cloud_layout.addWidget(self.stems_list_label)
        
        self.stems_list = QListWidget()
        self.stems_list.setMaximumHeight(100)
        self.stems_list.setStyleSheet("""
            QListWidget {
                background-color: #1e1e1e;
                border: 1px solid #444;
                border-radius: 4px;
            }
        """)
        self.stems_list.setVisible(False)
        cloud_layout.addWidget(self.stems_list)
        
        group_layout.addWidget(cloud_group)
        
        main_layout.addWidget(group)

    def load_track_dialog(self):
        file_path, _ = QFileDialog.getOpenFileName(
            self,
            f"Track für Deck {self.deck_id} laden",
            "",
            "Audio Files (*.mp3 *.wav *.flac *.aiff *.ogg *.m4a);;All Files (*.*)"
        )
        if file_path:
            self.load_track(Path(file_path))

    def load_track(self, file_path: Path):
        file_path = Path(file_path)
        if not file_path.exists():
            QMessageBox.warning(self, "Fehler", f"Datei nicht gefunden:\n{file_path}")
            return
        
        track_id = generate_track_id(file_path)
        
        # In DB speichern
        if self.database:
            self.database.add_or_update_track(
                track_id=track_id,
                file_path=str(file_path),
                file_name=file_path.name,
                title=file_path.stem
            )
        
        # In Player laden
        self.player.load(file_path, track_id)
        
        # UI Update
        self.track_label.setText(f"{file_path.name}\nID: {track_id}")
        self.info_label.setText(f"Dauer: --:-- | Status: {self.player.state.value} | Deck {self.deck_id}")
        self.play_btn.setEnabled(True)
        self.stop_btn.setEnabled(True)
        self.stem_btn.setEnabled(True)
        self.waveform_label.setText(f"♪ {file_path.stem} ♪\n[Waveform geladen]")
        self.waveform_label.setStyleSheet("""
            background-color: #1e3a5f;
            color: #7ec8e3;
            border: 1px solid #2a5a8f;
            padding: 30px;
            border-radius: 4px;
        """)
        
        self.track_loaded.emit(track_id, str(file_path))
        print(f"[Deck {self.deck_id}] Track geladen: {file_path} (ID: {track_id})")
        
        # Prüfe ob bereits Stems vorhanden
        self._update_stems_ui()

    def toggle_play(self):
        if self.player.state == PlayerState.PLAYING:
            self.player.pause()
            self.play_btn.setText("▶ Play")
        else:
            self.player.play()
            self.play_btn.setText("⏸ Pause")
        self.info_label.setText(f"Dauer: --:-- | Status: {self.player.state.value} | Deck {self.deck_id}")

    def stop(self):
        self.player.stop()
        self.play_btn.setText("▶ Play")
        self.info_label.setText(f"Dauer: --:-- | Status: {self.player.state.value} | Deck {self.deck_id}")

    def get_current_track_info(self):
        """Gibt Infos zum aktuell geladenen Track zurück - strikt auf dieses Deck bezogen"""
        current = self.player.get_current_track()
        if current["path"] is None:
            return None
        return {
            "track_id": current["id"],
            "file_path": current["path"],
            "file_name": current["path"].name if current["path"] else None,
            "deck_id": self.deck_id
        }

    def is_track_loaded(self):
        return self.player.is_track_loaded()

    def _update_stems_ui(self):
        """Aktualisiert UI basierend auf vorhandenen Stems"""
        track_info = self.get_current_track_info()
        if not track_info:
            self.stems_list_label.setVisible(False)
            self.stems_list.setVisible(False)
            return
        
        track_id = track_info["track_id"]
        stems = self.database.get_stems_for_track(track_id)
        
        if stems:
            self.stems_list.clear()
            for stem in stems:
                item_text = f"{stem['stem_type'].upper()}: {stem['file_name']} ({stem.get('local_size', 0)//1024} KB)"
                item = QListWidgetItem(item_text)
                self.stems_list.addItem(item)
            
            self.stems_list_label.setVisible(True)
            self.stems_list.setVisible(True)
            self.stems_list_label.setText(f"Verfügbare Stems ({len(stems)}):")
        else:
            # Prüfe auch lokal ohne DB
            local_stems = self.stem_manager.list_local_stems(track_id)
            if local_stems:
                self.stems_list.clear()
                for p in local_stems:
                    self.stems_list.addItem(f"{p.name}")
                self.stems_list_label.setVisible(True)
                self.stems_list.setVisible(True)
                self.stems_list_label.setText(f"Verfügbare Stems (lokal {len(local_stems)}):")
            else:
                self.stems_list_label.setVisible(False)
                self.stems_list.setVisible(False)

    @Slot()
    def on_stem_button_clicked(self):
        """
        Haupt-Handler für Button "Externe Stems berechnen"
        - Bezieht sich strikt auf aktuell geladenen Track in diesem Deck
        - Startet Hintergrundprozess
        """
        track_info = self.get_current_track_info()
        if not track_info:
            QMessageBox.warning(
                self,
                "Kein Track geladen",
                f"Bitte lade zuerst einen Track in Deck {self.deck_id}."
            )
            return
        
        track_id = track_info["track_id"]
        file_path = track_info["file_path"]
        
        print(f"[Deck {self.deck_id}] Externe Stems berechnen für: {file_path} (ID: {track_id})")
        
        # Prüfe Credentials
        if not has_valid_credentials():
            # Frage Nutzer nach Credentials
            dlg = CredentialsDialog(self)
            if dlg.exec() == QDialog.Accepted:
                creds_result = dlg.get_result()
                if creds_result:
                    if creds_result.get("mock"):
                        # Mock Modus aktivieren
                        import os
                        os.environ["USE_MOCK_DRIVE"] = "1"
                        QMessageBox.information(
                            self,
                            "Mock Modus",
                            "Mock-Modus aktiviert! Es wird kein echtes Google Drive verwendet.\n"
                            "Für echte Cloud-Nutzung bitte echte Credentials hinterlegen.\n\n"
                            "Die Verarbeitung wird simuliert."
                        )
                    else:
                        # Speichere Credentials temporär
                        import json
                        from pathlib import Path
                        cred_path = Path("credentials.json")
                        try:
                            with open(cred_path, 'w') as f:
                                json.dump(creds_result, f, indent=2)
                            QMessageBox.information(
                                self,
                                "Credentials gespeichert",
                                f"Credentials gespeichert in {cred_path}\n"
                                "Bitte erneut auf 'Externe Stems berechnen' klicken."
                            )
                            return
                        except Exception as e:
                            QMessageBox.warning(self, "Fehler", f"Konnte Credentials nicht speichern: {e}")
                            return
                else:
                    return
            else:
                return  # Abgebrochen
        
        # Prüfe ob bereits Stems vorhanden
        if self.database.has_stems(track_id):
            reply = QMessageBox.question(
                self,
                "Stems bereits vorhanden",
                f"Für diesen Track existieren bereits Stems.\n"
                f"Möchtest du sie erneut berechnen und überschreiben?",
                QMessageBox.Yes | QMessageBox.No
            )
            if reply != QMessageBox.Yes:
                return
        
        # Starte Worker
        self._start_stem_worker(file_path, track_id)

    def _start_stem_worker(self, file_path: Path, track_id: str):
        """Startet den Hintergrund-Worker"""
        # UI für Worker vorbereiten
        self.stem_btn.setEnabled(False)
        self.stem_progress.setVisible(True)
        self.stem_progress.setValue(0)
        self.stem_status_label.setVisible(True)
        self.stem_status_label.setText("Starte Cloud-Verarbeitung...")
        
        # Worker importieren (lazy damit GUI nicht blockiert)
        try:
            from .cloud.worker import StemSeparationWorker
            
            self.worker = StemSeparationWorker(
                track_path=file_path,
                track_id=track_id,
                deck_id=self.deck_id
            )
            
            # Signale verbinden
            self.worker.progress.connect(self.on_worker_progress)
            self.worker.status_message.connect(self.on_worker_status)
            self.worker.finished_success.connect(self.on_worker_finished)
            self.worker.error_occurred.connect(self.on_worker_error)
            self.worker.log_message.connect(lambda msg: print(f"[Deck {self.deck_id} Worker Log] {msg}"))
            
            # Starten
            self.worker.start()
            
            print(f"[Deck {self.deck_id}] Worker gestartet für {track_id}")
            
        except Exception as e:
            import traceback
            traceback.print_exc()
            QMessageBox.critical(self, "Fehler", f"Fehler beim Starten des Workers:\n{e}")
            self.stem_btn.setEnabled(True)
            self.stem_progress.setVisible(False)
            self.stem_status_label.setVisible(False)

    @Slot(int)
    def on_worker_progress(self, percent: int):
        self.stem_progress.setValue(percent)

    @Slot(str)
    def on_worker_status(self, message: str):
        self.stem_status_label.setText(message)

    @Slot(str, list)
    def on_worker_finished(self, track_id: str, stem_paths: list):
        print(f"[Deck {self.deck_id}] Worker fertig für {track_id}: {stem_paths}")
        
        self.stem_progress.setValue(100)
        self.stem_status_label.setText("Alles klar, die Stems sind nun verfügbar.")
        self.stem_btn.setEnabled(True)
        
        # UI aktualisieren
        self._update_stems_ui()
        
        # Pop-up / Hinweis laut Spec
        QMessageBox.information(
            self,
            "Stems bereit",
            f"Alles klar, die Stems sind nun verfügbar.\n\n"
            f"Track: {track_id}\n"
            f"Deck: {self.deck_id}\n"
            f"Anzahl Stems: {len(stem_paths)}\n\n"
            f"Die Stems wurden heruntergeladen und mit dem Originaltrack verknüpft."
        )
        
        self.stems_available.emit(track_id)
        
        # Progress nach kurzer Zeit ausblenden
        from PySide6.QtCore import QTimer
        QTimer.singleShot(5000, lambda: self.stem_progress.setVisible(False))

    @Slot(str, str)
    def on_worker_error(self, track_id: str, error_msg: str):
        print(f"[Deck {self.deck_id}] Worker Fehler für {track_id}: {error_msg}")
        
        self.stem_progress.setVisible(False)
        self.stem_status_label.setText(f"Fehler: {error_msg}")
        self.stem_btn.setEnabled(True)
        
        QMessageBox.critical(
            self,
            "Fehler bei Stem Separation",
            f"Fehler bei der Stem-Separation für Track {track_id}:\n\n"
            f"{error_msg}\n\n"
            f"Bitte prüfe:\n"
            f"- Google Drive Credentials\n"
            f"- Colab Notebook läuft und GPU aktiviert ist\n"
            f"- Internetverbindung"
        )
