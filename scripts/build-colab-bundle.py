#!/usr/bin/env python3
"""Build the exact worker sources shipped beside the Windows app, no weights."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "resources/colab"
FILES = ["colab/remote_worker.py", "colab/remote_setup.py", "colab/requirements-worker.txt",
         "python/bsroformer_inference.py", "src/stems/modelCatalog.json"]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = dict(appVersion=json.loads((ROOT / "package.json").read_text())["version"],
                    sourceRevision=subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
                    files={name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in FILES})
    with zipfile.ZipFile(OUT / "airdox-colab-worker.zip", "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in FILES:
            archive.write(ROOT / name, name)
        archive.writestr("bundle.json", json.dumps(manifest, indent=2) + "\n")
    shutil.copyfile(ROOT / "colab/airdox-stem-remote-worker.ipynb", OUT / "airdox-stem-remote-worker.ipynb")
    shutil.copyfile(ROOT / "docs/COLAB_ABNAHME.md", OUT / "ABNAHME.md")
    (OUT / "bundle.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Colab-Paket {manifest['appVersion']}: {OUT}")


if __name__ == "__main__":
    main()
