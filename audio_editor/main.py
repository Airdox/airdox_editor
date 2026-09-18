"""
Hauptfenster des Audio Editors (main branch)
"""
import sys
from pathlib import Path
from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QHBoxLayout, QVBoxLayout,
    QLabel, QStatusBar, QMenuBar, QMenu
)
from PySide6.QtCore import Qt
from PySide6.QtGui import QAction

from .config import CONFIG, get_app_dirs, APP_VERSION
from .database import AudioDatabase
from .deck import DeckWidget

class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.db = AudioDatabase()
        self.app_dirs = get_app_dirs()
        self._init_ui()

    def _init_ui(self):
        self.setWindowTitle(f"Local Audio Editor v{APP_VERSION} - [main branch]")
        self.setGeometry(100, 100, 1200, 700)
        
        # Menü
        menubar = self.menuBar()
        file_menu = menubar.addMenu("Datei")
        
        exit_action = QAction("Beenden", self)
        exit_action.triggered.connect(self.close)
        file_menu.addAction(exit_action)
        
        help_menu = menubar.addMenu("Hilfe")
        about_action = QAction("Über", self)
        about_action.triggered.connect(self.show_about)
        help_menu.addAction(about_action)
        
        # Zentrales Widget
        central = QWidget()
        self.setCentralWidget(central)
        main_layout = QVBoxLayout(central)
        
        # Titel
        title = QLabel("Local Audio Editor - Deck Ansicht")
        title.setAlignment(Qt.AlignCenter)
        title.setStyleSheet("font-size: 20px; font-weight: bold; padding: 10px;")
        main_layout.addWidget(title)
        
        subtitle = QLabel(f"Daten: {self.app_dirs['data']} | DB: {self.app_dirs['db'].name}")
        subtitle.setAlignment(Qt.AlignCenter)
        subtitle.setStyleSheet("color: #666; font-size: 11px; padding-bottom: 10px;")
        main_layout.addWidget(subtitle)
        
        # Decks Layout
        decks_layout = QHBoxLayout()
        
        self.deck_a = DeckWidget(deck_id="A", database=self.db)
        self.deck_b = DeckWidget(deck_id="B", database=self.db)
        
        self.deck_a.track_loaded.connect(self.on_track_loaded)
        self.deck_b.track_loaded.connect(self.on_track_loaded)
        
        decks_layout.addWidget(self.deck_a)
        decks_layout.addWidget(self.deck_b)
        
        main_layout.addLayout(decks_layout)
        
        # Status Bar
        self.status_bar = QStatusBar()
        self.setStatusBar(self.status_bar)
        self.status_bar.showMessage("Bereit - Bitte Track laden")

    def on_track_loaded(self, track_id, file_path):
        self.status_bar.showMessage(f"Track geladen: {Path(file_path).name} (ID: {track_id})", 5000)

    def show_about(self):
        from PySide6.QtWidgets import QMessageBox
        QMessageBox.about(
            self,
            "Über Audio Editor",
            f"Local Audio Editor v{APP_VERSION}\n\n"
            "Ein einfacher Desktop-Audio-Editor mit Deck-Ansicht.\n"
            "Main Branch - Basis-Features ohne Cloud-Integration.\n\n"
            f"Datenverzeichnis: {self.app_dirs['data']}\n"
            "Für Cloud-Stems Feature siehe Branch feature/colab-stem-separation"
        )

def main():
    app = QApplication(sys.argv)
    app.setApplicationName("AudioEditor")
    app.setOrganizationName("AudioEditor")
    
    # Dark Theme rudimentär
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
    """)
    
    window = MainWindow()
    window.show()
    
    sys.exit(app.exec())

if __name__ == "__main__":
    main()
