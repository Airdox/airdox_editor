"""
Deck-Ansicht des Audio-Editors (main branch)
Enthält Basis-UI ohne Cloud-Feature
"""
from pathlib import Path
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QFileDialog, QSlider, QGroupBox, QMessageBox
)
from PySide6.QtCore import Qt, Signal
from .player import AudioPlayer, PlayerState
from .utils import generate_track_id, format_time

class DeckWidget(QWidget):
    """Ein einzelnes Deck (A oder B)"""
    track_loaded = Signal(str, str)  # track_id, file_path

    def __init__(self, deck_id: str = "A", database=None, parent=None):
        super().__init__(parent)
        self.deck_id = deck_id
        self.database = database
        self.player = AudioPlayer(deck_id=deck_id)
        self._init_ui()

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
        
        # Placeholder für zukünftiges Feature
        self.feature_placeholder = QLabel("Cloud-Stems Feature: In Entwicklung (Branch feature/colab-stem-separation)")
        self.feature_placeholder.setStyleSheet("color: #666; font-style: italic; font-size: 11px;")
        self.feature_placeholder.setAlignment(Qt.AlignCenter)
        group_layout.addWidget(self.feature_placeholder)
        
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
        """Gibt Infos zum aktuell geladenen Track zurück"""
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
