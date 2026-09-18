Platzhalter – hier liegt in gebündelten Builds die Python-Runtime der Stem-Engine.

Erwartet wird (Windows) `python.exe` direkt in diesem Ordner, dazu `Lib/`,
`Scripts/` und die Pakete torch 2.5.1, torchaudio 2.5.1, msst, soundfile, PyYAML.

Erzeugen:

```
npm run stems:runtime                     # relokatierbar (python-build-standalone)
npm run stems:runtime -- --mode venv      # venv aus lokalem Python 3.10–3.12
npm run stems:runtime -- --dry-run        # nur anzeigen
```

Die Runtime wird von `resolveStemRuntime()` (env → resources → %APPDATA% → .venv)
gefunden und ist damit auch für die portable EXE nutzbar.

Die README bleibt versioniert, damit `extraResources` im Build diesen Ordner
immer vorfindet; die Runtime selbst ist per `.gitignore` ausgenommen.
Genaue Anleitung: `docs/STEM_BUNDLING.md`.
