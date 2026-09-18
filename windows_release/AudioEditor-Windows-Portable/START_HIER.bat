@echo off
echo ========================================
echo  AudioEditor - Cloud Stem Separation
echo  Branch: feature/colab-stem-separation
echo ========================================
echo.
echo Dieses Paket enthaelt:
echo - Deck A/B mit Track laden
echo - Button "Externe Stems berechnen"
echo - Mock Modus fuer Tests ohne Google Credentials
echo - Echte Cloud via Google Drive + Colab GPU (htdemucs)
echo.
echo Starte im Mock Modus zum schnellen Testen...
echo.
set USE_MOCK_DRIVE=1
python -m audio_editor.main
pause
