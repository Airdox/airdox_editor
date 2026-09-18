#!/usr/bin/env python3
"""
Test Runner für Cloud Feature
"""
import sys
from pathlib import Path

BASE_DIR = Path(__file__).parent
sys.path.insert(0, str(BASE_DIR))

# Setze Mock Modus für Tests
import os
os.environ["USE_MOCK_DRIVE"] = "1"

print("=== Audio Editor Cloud Feature Tests ===")
print(f"Branch: feature/colab-stem-separation")
print(f"Mock Modus: {os.getenv('USE_MOCK_DRIVE')}")

try:
    from tests.test_cloud_workflow import (
        test_config_credentials,
        test_mock_drive_upload_download,
        test_stem_manager,
        test_demucs_processor_import
    )
    
    test_config_credentials()
    test_mock_drive_upload_download()
    test_stem_manager()
    test_demucs_processor_import()
    
    print("\n✅ Alle Tests bestanden!")
    print("\nNächste Schritte:")
    print("- Starte App mit: python -m audio_editor.main")
    print("- Oder mit Mock: USE_MOCK_DRIVE=1 python -m audio_editor.main")
    print("- Für echte Cloud: Credentials in ./service_account.json legen")
    print("- Colab Setup siehe audio_editor/colab/COLAB_SETUP.md")
    
except Exception as e:
    print(f"\n❌ Test fehlgeschlagen: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)
