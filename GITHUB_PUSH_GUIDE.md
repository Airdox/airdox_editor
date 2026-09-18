# GitHub Push & Auto Version Guide

## Stand: feature/colab-stem-separation
- 68 Tests, alle bestanden
- Basis Editor bleibt erhalten (main Branch)
- Neuer Workflow integriert in bestehenden Editor
- Auto Version bei Push via GitHub Actions

## Was passiert bei GitHub Push automatisch?

### Workflow: .github/workflows/release.yml

Bei jedem Push auf:
- `main`, `master`, `feature/colab-stem-separation`
- Tags `v*`

Passiert automatisch:

1. **Tests laufen** (`pytest tests/ -v` mit USE_MOCK_DRIVE=1)
   - Wenn Tests fehlschlagen -> kein Release

2. **Version wird bestimmt:**
   ```bash
   VERSION=$(grep __version__ audio_editor/__init__.py)  # z.B. 0.2.0
   COMMIT=$(git rev-parse --short HEAD)                  # z.B. c0f3fca
   BRANCH=$(git rev-parse --abbrev-ref HEAD)             # z.B. feature/colab-stem-separation
   TIMESTAMP=$(date +%Y%m%d%H%M%S)
   
   # Für Branch Push:
   RELEASE_VERSION="0.2.0-feature-colab-stem-separation-c0f3fca-20260918204431"
   
   # Für main Push:
   RELEASE_VERSION="v0.2.0-c0f3fca"
   
   # Für Tag Push (v1.0.0):
   RELEASE_VERSION="v1.0.0" (nutzt Tag)
   ```

3. **Build:**
   - Linux EXE via PyInstaller
   - Windows EXE auf windows-latest Runner
   - Source ZIP + Portable ZIP

4. **GitHub Release wird erstellt:**
   - Tag: `0.2.0-feature-colab-stem-separation-c0f3fca-20260918204431`
   - Name: `AudioEditor 0.2.0-feature-colab-stem-separation-c0f3fca-... - feature/colab-stem-separation`
   - Body mit Changelog, Features, Test Ergebnissen
   - Files: Source ZIP, Portable ZIP, EXEs
   - Prerelease: true für feature Branches, false für main/tags

## Wie pushe ich zu GitHub?

### Option 1: Neues GitHub Repo erstellen

1. Auf https://github.com/new -> Repo erstellen, z.B. `AudioEditor`

2. Lokal Remote hinzufügen:
   ```bash
   git remote add origin https://github.com/<dein-user>/AudioEditor.git
   # Oder SSH:
   git remote add origin git@github.com:<dein-user>/AudioEditor.git
   ```

3. Push:
   ```bash
   git push -u origin main
   git push -u origin feature/colab-stem-separation
   git push --tags
   ```

   -> GitHub Actions startet automatisch, erstellt Release

### Option 2: Bestehendes Repo nutzen

```bash
git remote -v  # Zeigt aktuelles Remote
git remote set-url origin https://github.com/<dein-user>/<bestehendes-repo>.git
git push origin feature/colab-stem-separation
git push --tags
```

### Option 3: GitHub CLI

```bash
gh repo create AudioEditor --public --source=. --remote=origin --push
```

## Lokaler Test der Auto Version (ohne GitHub)

```bash
# Simuliere was GitHub Action macht:
VERSION=$(cat VERSION)
COMMIT=$(git rev-parse --short HEAD)
BRANCH=$(git rev-parse --abbrev-ref HEAD)
TIMESTAMP=$(date +%Y%m%d%H%M%S)
RELEASE_VERSION="${VERSION}-${BRANCH//\//-}-${COMMIT}-${TIMESTAMP}"

echo "Auto Version: $RELEASE_VERSION"

# Tag erstellen wie Action:
git tag -a "$RELEASE_VERSION" -m "Auto Release $RELEASE_VERSION"
git push origin "$RELEASE_VERSION"  # Löst Release aus wenn Tag Push in Workflow
```

## Aktueller Stand im lokalen Repo

- Branch: feature/colab-stem-separation
- Letzter Commit: c0f3fca
- Tests: 68 passed
- Tags:
  - 0.2.0-feature-colab-stem-separation-c0f3fca-20260918204431 (auto erstellt)

## CI Workflow: .github/workflows/ci.yml

Läuft bei jedem Push/PR:
- Tests auf Python 3.10, 3.11, 3.12
- Lint (flake8, black, isort)
- Build Linux + Windows EXE
- Upload Artifacts

## Secrets benötigt

- `GITHUB_TOKEN` - wird automatisch von GitHub bereitgestellt, kein manuelles Setup nötig
- Für Google Drive: Service Account JSON als Secret `GOOGLE_APPLICATION_CREDENTIALS_JSON` optional

## Versionierung Strategie

- `audio_editor/__init__.py` -> `__version__ = "0.2.0-feature-colab"`
- `VERSION` Datei -> `0.2.0`
- `CHANGELOG.md` -> Dokumentiert alle Änderungen
- Git Tags -> Auto Version bei Push

Bei jedem Push wird neue Version erstellt, keine manuelle Versionierung nötig.

## Beispiel GitHub Release nach Push

Nach `git push origin feature/colab-stem-separation`:

GitHub -> Actions -> Release Workflow läuft -> Erstellt:

```
Release: AudioEditor 0.2.0-feature-colab-stem-separation-c0f3fca-20260918204431

Assets:
- AudioEditor-Source-0.2.0-feature-colab-stem-separation-c0f3fca-...zip
- AudioEditor-Windows-Portable-0.2.0-feature-colab-stem-separation-c0f3fca-...zip
- AudioEditor-Linux (aus dist/)
- AudioEditor-Windows-EXE-...zip (von windows-latest Runner)
```

## Troubleshooting

- **Kein Release erstellt**: Prüfe Actions Tab, ob Workflow fehlgeschlagen (Tests müssen bestehen)
- **Permission denied**: GITHUB_TOKEN hat automatisch write permission, aber in Repo Settings -> Actions -> General -> Workflow permissions auf "Read and write" stellen
- **Tag existiert bereits**: Timestamp sorgt für Unique Tag, sollte nicht passieren

## Nächste Schritte

1. GitHub Repo erstellen
2. `git push -u origin feature/colab-stem-separation --tags`
3. In GitHub Actions Tab Verlauf beobachten
4. Nach 3-5 Minuten: Release erscheint unter Releases
5. ZIPs und EXEs herunterladen und testen
