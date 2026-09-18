#!/usr/bin/env python3
"""
airdox_SMART_Editor – Code-Analyse & Visualisierungs-Exporter
=============================================================

Scannt das Repository und erzeugt:

  1. code_analysis_out/airdox.cc.json   – CodeCharta-kompatible Metrik-Datei
       Höhe (3D)   = rloc
       Fläche      = functions (im Studio wählbar)
       Farbe       = complexity / fanIn / churn (im Studio wählbar)
  2. code_analysis_out/graph.json       – Knoten/Kanten-Daten für die D3-App
  3. visualization.html (Repo-Root)     – eigenständige Single-Page-App
       (Template tools/code_analysis/visualization_template.html mit
        eingebetteten Daten – läuft per Doppelklick via file://)

Erkannte „Welten“ und Datenströme (Cross-World-Edges):
  - IPC:      preload.cjs-Methoden werden geparst und über Kanalnamen den
              ipcMain.handle-Registrierungen in electron/*.cjs zugeordnet.
  - HTTP/API: fetch('/api/...') im Renderer -> server.ts
  - Subprozess/Protokoll: kuratierte, per Codekommentar verifizierte Kanten
              (BS-RoFormer-Adapter, Colab-Worker, Runtime-Installer).
  - Bundle-Brücke: electron/stemEngineBridge.cjs lädt das Build-Produkt von
              src/stems/nodeBridge.ts (dist/stems/node-bridge.cjs).

Verwendung:
    python3 tools/code_analysis/analyze_repo.py [--repo /pfad/zum/repo]

Keine pip-Abhängigkeiten – nur Python-Standardbibliothek.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

# --------------------------------------------------------------------------
# Konfiguration
# --------------------------------------------------------------------------

CODE_EXTS = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".cpp", ".cc", ".h", ".hpp"}
SKIP_DIRS = {".git", "node_modules", "dist", "release", ".venv", "venv", "coverage",
             "out", "build", ".arena", "__pycache__", "resources"}
ROOT_CORE_FILES = {"server.ts", "vite.config.ts", "test_analysis.ts", "index.html"}

GROUPS = {
    "frontend": {"label": "Frontend & UI (src/)", "color": "#4f9cf9",
                 "description": "React-Renderer: Editor-UI, Audio-Engine-Clients, Rekordbox-Import, Stems-Steuerung"},
    "desktop":  {"label": "Desktop-Wrapper (electron/)", "color": "#f5c518",
                 "description": "Electron-Main & Preload: Fenster, sichere IPC-Kanäle, Runtime-Resolver"},
    "core":     {"label": "Core-Logik & Interfaces (Root)", "color": "#ef4444",
                 "description": "Express-Server, Build-Konfiguration, Einstiegspunkte im Repo-Root"},
    "native":   {"label": "Native C++ (native/)", "color": "#22c55e",
                 "description": "Native Stem-Engine: Realtime-RingBuffer, Overlap-Add, ONNX-Inferenz-Worker"},
    "python":   {"label": "Python (python/ + colab/)", "color": "#14b8a6",
                 "description": "ML-Inferenz-Adapter & GPU-Remote-Worker (BS-RoFormer)"},
    "scripts":  {"label": "Skripte (scripts/)", "color": "#a78bfa",
                 "description": "Build-, Setup-, Bundle- und Diagnose-Werkzeuge"},
    "tests":    {"label": "Tests (tests/)", "color": "#64748b",
                 "description": "Unit-, Vertrags- und Qualitätsgate-Tests inkl. Fixtures"},
}

EDGE_TYPES = {
    "import":     {"label": "Statischer Import",      "color": "#64748b"},
    "ipc":        {"label": "IPC (Electron)",         "color": "#38bdf8"},
    "api":        {"label": "HTTP /api/ Aufruf",      "color": "#f87171"},
    "subprocess": {"label": "Python-Subprozess",      "color": "#34d399"},
    "bridge":     {"label": "Bundle-Brücke (CJS↔TS)", "color": "#fb923c"},
    "protocol":   {"label": "Geteiltes Protokoll",    "color": "#2dd4bf"},
}

# Kuratierte, im Code verifizierte Cross-World-Kanten
# (Quelle → Ziel, Typ, Begründung – siehe Codekommentare der jeweiligen Dateien)
CURATED_EDGES = [
    ("src/stems/backends/roformerSeparator.ts", "python/bsroformer_inference.py", "subprocess",
     "startet python/bsroformer_inference.py als Subprozess (CLI-Protokoll)"),
    ("scripts/setup-stem-runtime.mjs", "python/install_bsroformer.py", "subprocess",
     "übernimmt dieselben Version-Pins wie python/install_bsroformer.py"),
    ("scripts/stem-remote-worker.ts", "colab/remote_worker.py", "protocol",
     "Referenz-Worker des Remote-Job-Protokolls (Spiegel zum Colab-Worker)"),
    ("colab/remote_worker.py", "python/bsroformer_inference.py", "protocol",
     "GPU-Pfad nutzt dieselbe CLI-Schnittstelle wie bsroformer_inference.py"),
    ("electron/stemEngineBridge.cjs", "src/stems/nodeBridge.ts", "bridge",
     "lädt dist/stems/node-bridge.cjs – das Build-Produkt dieses TS-Moduls"),
]

# Kuratierte Kurzbeschreibungen für Tooltips (deutsch)
DESCRIPTIONS = {
    "src/App.tsx": "Zentrale React-Anwendung: orchestriert Editor-UI, Timeline, Import-Workflows und Stem-Jobs (God-Component, ~4.5k Zeilen – Hotspot!).",
    "server.ts": "Express-Backend: /api/stems (Stem-Jobs), /api/stems/remote (Colab), /api/chat, /api/logs; bedient Vite im Dev-Modus.",
    "src/audio/editingEngine.ts": "Nicht-destruktive Editing-Logik: Clips, Schnitte, Overdub-Operationen auf Audiodaten.",
    "src/audio/stemEngine.ts": "Renderer-Client für Stem-Separation: HTTP (/api/stems) im Browser, Desktop-API (IPC) in Electron.",
    "src/audio/stemEngineInstaller.ts": "Installer-Client: stößt Modell-Installation an (/api/stems/install) und verfolgt den Fortschritt.",
    "src/stems/stemJobService.ts": "Job-Service der Stem-Separation (Queue, Cache, Fortschritt) – gemeinsamer Kern für HTTP- und Desktop-Pfad.",
    "src/stems/nodeBridge.ts": "Einzige Brücke Main→TS-Engine: wird zu dist/stems/node-bridge.cjs gebündelt, nur structured-clone-sichere Daten.",
    "src/stems/transportTypes.ts": "Vertragstypen der Desktop-API (StemDesktopApi) – Basis des IPC-Vertragstests.",
    "src/stems/backends/onnxSeparator.ts": "ONNX-Runtime-Backend: lokale Stem-Inferenz ohne Python.",
    "src/stems/backends/roformerSeparator.ts": "BS-RoFormer-Backend: steuert python/bsroformer_inference.py als Subprozess an.",
    "src/stems/backends/processTransport.ts": "Gemeinsamer Spawn-/Protokoll-/Cancel-Transport aller Python-Backends.",
    "src/stems/remote/remoteStemJobService.ts": "Remote-Stem-Jobs über Google-Drive-Ablage + Colab-GPU-Worker (Lease, Polling, Resume).",
    "src/stems/runtime/pythonRuntime.ts": "Findet/validiert gebündelte Python-Runtimes (Produktion ohne globales python3).",
    "src/rekordbox/anlzParser.ts": "Parser für Rekordbox-ANLZ*-Dateien (Waveform-/Beatgrid-Analyse).",
    "src/utils/logger.ts": "Gebatchtes Logging: Renderer → /api/logs bzw. IPC-Kanal logs:write.",
    "electron/main.cjs": "Electron-Main-Prozess: Fenster, IPC für Rekordbox/Logs/Legacy-Stems, Pfad-Schutz (PathGuard), Audit-Log.",
    "electron/preload.cjs": "contextBridge: exposiert schreibgeschützte Rekordbox-/Stem-APIs an den Renderer (window.rekordboxDesktop).",
    "electron/stemEngineBridge.cjs": "Host des node-bridge-Bundles: registriert die stems:*-IPC-Kanäle im Main-Prozess.",
    "electron/stemRuntime.cjs": "Resolved Python-Runtime, Modelle, SHA256-Prüfung & GPU-Status (Bundle vs. Dev-.venv).",
    "electron/demucsRunner.cjs": "Legacy-Demucs-Pfad: Umgebungstest + Stems via Subprozess (optional, BS-RoFormer ist primär).",
    "python/bsroformer_inference.py": "Inferenz-Adapter: BS-RoFormer trennt WAV-Chunks in Stems (definiertes CLI-Protokoll).",
    "python/install_bsroformer.py": "Installiert gepinnte PyTorch-/RoFormer-Abhängigkeiten in die Runtime.",
    "colab/remote_worker.py": "GPU-Worker für Google Colab: verarbeitet Remote-Stem-Jobs (gleiche CLI wie bsroformer_inference.py).",
    "scripts/stem-remote-worker.ts": "Lokaler Referenz-Worker des Remote-Job-Protokolls (spiegelbildlich zu colab/remote_worker.py).",
    "native/stem_engine/src/StemEngineManager.cpp": "Native Manager-Komponente: Lebenszyklus der Realtime-Stem-Engine.",
    "native/stem_engine/src/StemInferenceWorker.cpp": "Native Inferenz-Worker (ONNX) mit Overlap-Add-Verarbeitung.",
    "native/stem_engine/src/HighQualityStemCache.cpp": "Hochwertiger Stem-Cache der nativen Engine.",
}

GROUP_FALLBACK_DESC = {
    "frontend": "React/TS-Modul des Editors (UI, Audio, Rekordbox, Stems).",
    "desktop": "Electron-Main/Preload-Modul (Desktop-Wrapper, IPC, Runtime).",
    "core": "Zentrale Root-Logik bzw. Build-/Einstiegsdatei.",
    "native": "C++-Baustein der nativen Stem-Engine (Anbindung via JUCE geplant).",
    "python": "Python-Modul der ML-Inferenz bzw. des Remote-Workers.",
    "scripts": "Werkzeug-Skript für Build/Setup/Diagnose.",
    "tests": "Test- oder Fixture-Modul (Vertrags-, Qualitäts- und Unit-Tests).",
}

# --------------------------------------------------------------------------
# Sprach-Parser (approximativ, regex-basiert, kommentar-/stringbereinigt)
# --------------------------------------------------------------------------


def strip_ts_like(src: str) -> str:
    """Entfernt Kommentare und String-Inhalte (approximativ) für Zählungen."""
    out = []
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        nxt = src[i + 1] if i + 1 < n else ""
        if c == "/" and nxt == "/":
            while i < n and src[i] != "\n":
                i += 1
        elif c == "/" and nxt == "*":
            i += 2
            while i + 1 < n and not (src[i] == "*" and src[i + 1] == "/"):
                out.append("\n" if src[i] == "\n" else " ")
                i += 1
            i += 2
        elif c in "'\"`":
            quote = c
            out.append(quote)
            i += 1
            while i < n and src[i] != quote:
                if src[i] == "\\":
                    i += 1
                out.append("\n" if src[i] == "\n" else " ")
                i += 1
            out.append(quote)
            i += 1
        else:
            out.append(c)
            i += 1
    return "".join(out)


def strip_python(src: str) -> str:
    out_lines = []
    for line in src.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            out_lines.append("")
            continue
        code, in_s, in_d = [], False, False
        i = 0
        while i < len(line):
            ch = line[i]
            if ch == "'" and not in_d:
                in_s = not in_s
            elif ch == '"' and not in_s:
                in_d = not in_d
            elif ch == "#" and not in_s and not in_d:
                break
            code.append(ch)
            i += 1
        out_lines.append("".join(code))
    return "\n".join(out_lines)


def strip_cpp(src: str) -> str:
    return strip_ts_like(src)  # identische Regeln für //, /* */, "..." genügen


RE_TS_FUNC = re.compile(
    r"(?:function\s*\*?\s*\w+|"
    r"(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?(?:function\b|\()|"
    r"(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?"
    r"(?:(?:private|public|protected|static|readonly|get|set)\s+)*"
    r"\w+\s*(?:<[^>]*>)?\([^;)]*\)\s*(?::\s*[^{;\n]+)?\s*\{)"
)
RE_TS_CLASS = re.compile(r"\b(?:class|interface)\s+[A-Za-z_$][\w$]*")
RE_PY_FUNC = re.compile(r"^\s*(?:async\s+)?def\s+\w+", re.M)
RE_PY_CLASS = re.compile(r"^\s*class\s+\w+", re.M)
RE_CPP_FUNC = re.compile(r"[~\w:<>]+\s*\([^;{()]*\)\s*(?:const\s*)?(?:noexcept\s*)?\{")
RE_CPP_CLASS = re.compile(r"\b(?:class|struct)\s+\w+")


def lang_of(path: Path) -> str:
    return {".ts": "TypeScript", ".tsx": "TypeScript (React)", ".js": "JavaScript",
            ".jsx": "JavaScript (React)", ".mjs": "JavaScript (ESM)", ".cjs": "JavaScript (CommonJS)",
            ".py": "Python", ".cpp": "C++", ".cc": "C++", ".h": "C/C++ Header",
            ".hpp": "C++ Header"}.get(path.suffix, path.suffix)


def complexity_of(code: str, family: str) -> int:
    """Näherung: zyklomatische Komplexität = 1 + Verzweigungsstellen."""
    if family == "python":
        tokens = r"\bif\b|\belif\b|\bfor\b|\bwhile\b|\bexcept\b|\bcase\b|\band\b|\bor\b|:=|\bassert\b"
    else:
        tokens = r"\bif\b|\belse\s+if\b|\bfor\b|\bwhile\b|\bcase\b|\bcatch\b|&&|\|\||\?\?"
    score = 1 + len(re.findall(tokens, code))
    score += len(re.findall(r"\?[^.?]*:[^:]", code))  # Ternaries (grob)
    return score


def analyze_file(path: Path) -> dict:
    rel = path.relative_to(path.parents[len(path.parents) - 1]).as_posix() if False else None  # Platzhalter
    return {}


def analyze_source(rel: str, text: str) -> dict:
    """Berechnet Metriken für eine Datei anhand ihres Inhalts."""
    ext = Path(rel).suffix
    loc = text.count("\n") + (0 if text.endswith("\n") or not text else 1)
    todos = len(re.findall(r"\b(?:TODO|FIXME|HACK|XXX)\b", text))

    if ext in {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}:
        code = strip_ts_like(text)
        comment_lines = len(re.findall(r"^\s*(?://|/\*|\*)", text, re.M))
        functions = len(RE_TS_FUNC.findall(code))
        classes = len(RE_TS_CLASS.findall(code))
        max_depth, depth = 0, 0
        for ch in code:
            if ch == "{":
                depth += 1
                max_depth = max(max_depth, depth)
            elif ch == "}":
                depth = max(0, depth - 1)
        family = "ts"
    elif ext == ".py":
        code = strip_python(text)
        comment_lines = sum(1 for l in text.splitlines() if l.strip().startswith("#"))
        functions = len(RE_PY_FUNC.findall(code))
        classes = len(RE_PY_CLASS.findall(code))
        indents = [((len(l) - len(l.lstrip())) // 4) for l in code.splitlines() if l.strip()]
        max_depth = max(indents) if indents else 0
        family = "python"
    else:
        code = strip_cpp(text)
        comment_lines = len(re.findall(r"^\s*(?://|/\*|\*)", text, re.M))
        functions = len(RE_CPP_FUNC.findall(code))
        classes = len(RE_CPP_CLASS.findall(code))
        max_depth, depth = 0, 0
        for ch in code:
            if ch == "{":
                depth += 1
                max_depth = max(max_depth, depth)
            elif ch == "}":
                depth = max(0, depth - 1)
        family = "cpp"

    rloc = sum(1 for l in code.splitlines() if l.strip())
    return {
        "path": rel, "family": family, "loc": loc, "rloc": rloc,
        "commentLines": comment_lines, "functions": functions, "classes": classes,
        "complexity": complexity_of(code, family), "maxDepth": max_depth, "todos": todos,
        "importStatements": 0, "internalTargets": [], "externalImports": 0,
    }


# --------------------------------------------------------------------------
# Import-Graph
# --------------------------------------------------------------------------

RE_TS_IMPORT = re.compile(
    r"""(?:import\s+(?:[\w*{},\s$]+\s+from\s+)?|export\s+(?:\*|\{[^}]*\})\s+from\s+|require\s*\(|import\s*\()\s*['"]([^'"]+)['"]""",
    re.X)
RE_PY_IMPORT = re.compile(r"^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.,\s]+))", re.M)
RE_CPP_INCLUDE = re.compile(r'#include\s+"([^"]+)"')

TS_RESOLVE_EXTS = ["", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx",
                   "/index.ts", "/index.tsx", "/index.js", "/index.mjs", "/index.cjs"]


def resolve_ts(spec: str, importer_rel: str, files_by_path: set) -> str | None:
    if not spec.startswith("."):
        return None
    base = (Path(importer_rel).parent / spec).as_posix()
    for ext in TS_RESOLVE_EXTS:
        cand = base + ext
        if cand in files_by_path:
            return cand
    return None


def resolve_py(spec: str, importer_rel: str, files_by_path: set) -> str | None:
    mod = spec.replace(".", "/")
    for root in ("python", "colab"):
        for cand in (f"{root}/{mod}.py", f"{root}/{mod}/__init__.py"):
            if cand in files_by_path:
                return cand
    if importer_rel.startswith("colab/"):
        cand = f"colab/{mod}.py"
        if cand in files_by_path:
            return cand
    return None


def resolve_cpp(spec: str, files_by_path: set) -> str | None:
    for cand in (f"native/stem_engine/{spec}", f"native/stem_engine/{spec}.h",
                 f"native/stem_engine/{spec}.cpp",
                 f"native/stem_engine/include/{spec}", f"native/stem_engine/include/{spec}.h"):
        if cand in files_by_path:
            return cand
    return None


# --------------------------------------------------------------------------
# Cross-World-Erkennung
# --------------------------------------------------------------------------

RE_PRELOAD_METHOD = re.compile(
    r"(\w+)\s*:\s*\(([^)]*)\)\s*=>\s*ipcRenderer\.(?:invoke|send|on)\(\s*'([^']+)'")
RE_IPC_REGISTER = re.compile(r"ipcMain\.(?:handle|on)\(\s*'([^']+)'")
# Registrierung über Konstanten-Objekt:  const CHANNELS = { start: 'stems:job-start', ... }
#                                        ipcMain.handle(CHANNELS.start, ...)
RE_CH_CONST = re.compile(r"(\w+)\s*:\s*'((?:stems|rekordbox|logs|app):[^']+)'")
RE_IPC_HANDLE_VAR = re.compile(r"ipcMain\.(?:handle|on)\(\s*[A-Za-z_$][\w$]*\.(\w+)")
RE_DESKTOP_CALL = re.compile(r"rekordboxDesktop\.((?:\w+)(?:\.\w+)*)\s*\(")
RE_FETCH_API = re.compile(r"""fetch\(\s*['"`](/api/[^'"`$]*)""")


def parse_preload_methods(preload_text: str) -> dict:
    """Mappt Preload-Methoden (inkl. verschachtelter Objekte wie `stemEngine`) auf IPC-Kanäle."""
    methods: dict = {}
    nested_prefix = None
    for line in preload_text.splitlines():
        stripped = line.strip()
        if nested_prefix is not None and stripped.startswith("},"):
            nested_prefix = None
            continue
        for m in RE_PRELOAD_METHOD.finditer(line):
            name, _args, channel = m.groups()
            key = f"{nested_prefix}.{name}" if nested_prefix else name
            methods[key] = channel
        if re.match(r"\w+\s*:\s*\{\s*$", stripped):
            nested_prefix = stripped.split(":")[0].strip()
    return methods


def build_ipc_map(electron_texts: dict):
    """Liefert (method→channel aus preload, channel→Main-Datei)."""
    preload = electron_texts.get("electron/preload.cjs", "")
    methods = parse_preload_methods(preload)
    channel_owner: dict = {}
    for rel, text in electron_texts.items():
        for channel in RE_IPC_REGISTER.findall(text):
            channel_owner.setdefault(channel, rel)
        # Variante über Konstanten-Objekt (z. B. CHANNELS.start)
        const_map = dict(RE_CH_CONST.findall(text))
        for key in RE_IPC_HANDLE_VAR.findall(text):
            channel = const_map.get(key)
            if channel:
                channel_owner.setdefault(channel, rel)
    return methods, channel_owner


# --------------------------------------------------------------------------
# Git-Churn
# --------------------------------------------------------------------------

def git_risk_metrics(repo: Path) -> dict:
    """Java-freie Alternative zum ccsh-gitlogparser: pro Datei
    commitsCount (= churn), authorCount und ageInDays aus der vollen Historie."""
    try:
        out = subprocess.run(
            ["git", "-C", str(repo), "log", "--pretty=format:%x1e%an%x1f%ct", "--name-only"],
            capture_output=True, text=True, timeout=120, check=True,
        ).stdout
    except Exception:
        return {}
    metrics: dict = {}
    author, ts = None, 0
    for line in out.split("\n"):   # splitlines() wuerde \x1e als Zeilenende schlucken!
        if line.startswith("\x1e"):   # Header NICHT strippen (U+001E ist in Python "Whitespace")
            parts = line[1:].split("\x1f")
            author, ts = parts[0], int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
            continue
        stripped = line.strip()
        if not stripped or author is None:
            continue
        path = stripped.replace("\\", "/")
        m = metrics.setdefault(path, {"commits": 0, "authors": set(), "lastTs": 0})
        m["commits"] += 1
        m["authors"].add(author)
        m["lastTs"] = max(m["lastTs"], ts)
    now = _dt.datetime.now().timestamp()
    return {k: {"commitsCount": v["commits"], "authorCount": len(v["authors"]),
                "ageInDays": max(0, int((now - v["lastTs"]) / 86400))}
            for k, v in metrics.items()}


def group_of(rel: str) -> str:
    if rel.startswith("src/"):
        return "frontend"
    if rel.startswith("electron/"):
        return "desktop"
    if rel.startswith("native/"):
        return "native"
    if rel.startswith("python/") or rel.startswith("colab/"):
        return "python"
    if rel.startswith("scripts/"):
        return "scripts"
    if rel.startswith("tests/"):
        return "tests"
    return "core"


# --------------------------------------------------------------------------
# cc.json-Baum
# --------------------------------------------------------------------------

def folder_to_cc(tree: dict, fan_in: dict, fan_out: dict, risk: dict, risk_scores: dict) -> list:
    children: list = []
    for name, value in sorted(tree.items()):
        if name.endswith("/"):
            children.append({"name": name[:-1], "type": "folder", "attributes": {},
                             "children": folder_to_cc(value, fan_in, fan_out, risk, risk_scores)})
        else:
            s = value
            rel = s["path"]
            r = risk.get(rel, {})
            children.append({"name": name, "type": "file", "attributes": {
                "rloc": s["rloc"], "loc": s["loc"], "functions": s["functions"],
                "classes": s["classes"], "complexity": s["complexity"],
                "maxDepth": s["maxDepth"], "imports": s["importStatements"],
                "fanIn": fan_in.get(rel, 0), "fanOut": fan_out.get(rel, 0),
                "commitsCount": r.get("commitsCount", 0),
                "authorCount": r.get("authorCount", 0),
                "ageInDays": r.get("ageInDays", 0),
                "riskScore": risk_scores.get(rel, 0),
                "commentLines": s["commentLines"], "todos": s["todos"],
            }})
    return children


# --------------------------------------------------------------------------
# Hauptprogramm
# --------------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser(description="airdox Code-Analyse → cc.json + graph.json + visualization.html")
    ap.add_argument("--repo", default=str(Path(__file__).resolve().parents[2]))
    ap.add_argument("--template", default=str(Path(__file__).resolve().parent / "visualization_template.html"))
    args = ap.parse_args()
    repo = Path(args.repo).resolve()

    # --- Dateien sammeln ---------------------------------------------------
    files: list = []
    for p in repo.rglob("*"):
        if not p.is_file() or p.suffix.lower() not in CODE_EXTS:
            continue
        rel_parts = p.relative_to(repo).parts
        if any(part in SKIP_DIRS for part in rel_parts):
            continue
        files.append(p)
    files.sort()
    files_by_path = {p.relative_to(repo).as_posix() for p in files}
    print(f"[1/5] {len(files)} Code-Dateien gefunden")

    # --- Metriken + Imports ------------------------------------------------
    texts = {p.relative_to(repo).as_posix(): p.read_text(errors="replace") for p in files}
    stats: dict = {}
    import_edges: list = []
    for rel in sorted(texts):
        text = texts[rel]
        s = analyze_source(rel, text)
        targets: list = []
        external = 0
        if s["family"] == "ts":
            specs = RE_TS_IMPORT.findall(text)
            s["importStatements"] = len(specs)
            for spec in specs:
                t = resolve_ts(spec, rel, files_by_path)
                if t and t != rel:
                    targets.append(t)
                elif not spec.startswith("."):
                    external += 1
        elif s["family"] == "python":
            for a, b in RE_PY_IMPORT.findall(text):
                specs = [a] if a else [p.strip() for p in b.split(",") if p.strip()]
                for spec in specs:
                    s["importStatements"] += 1
                    t = resolve_py(spec, rel, files_by_path)
                    if t and t != rel:
                        targets.append(t)
                    else:
                        external += 1
        elif s["family"] == "cpp":
            specs = RE_CPP_INCLUDE.findall(text)
            s["importStatements"] = len(specs)
            for spec in specs:
                t = resolve_cpp(spec, files_by_path)
                if t and t != rel:
                    targets.append(t)
        s["externalImports"] = external
        s["internalTargets"] = sorted(set(targets))
        stats[rel] = s
        for t in set(targets):
            import_edges.append((rel, t, targets.count(t)))

    merged: dict = {}
    for a, b, w in import_edges:
        merged[(a, b)] = merged.get((a, b), 0) + w
    import_edges = [(a, b, w) for (a, b), w in merged.items()]
    print(f"[2/5] {len(import_edges)} Import-Kanten aufgelöst")

    # --- Fan-In/-Out, Churn ------------------------------------------------
    fan_in: dict = defaultdict(int)
    fan_out: dict = defaultdict(int)
    for a, b, _w in import_edges:
        fan_out[a] += 1
        fan_in[b] += 1
    risk = git_risk_metrics(repo)

    # --- Kombinierter Risiko-Score (0-100) ---------------------------------
    # Klassische Hotspot-These: Risiko = Komplexität × Änderungshäufigkeit ×
    # Autorenbeteiligung (+ Größe). Jede Komponente wird auf das Maximum im
    # Projekt normiert, dann gewichtet summiert. Gewichte bewusst einfach,
    # damit sie dokumentiert und anpassbar bleiben (siehe README).
    max_complexity = max((s["complexity"] for s in stats.values()), default=1) or 1
    max_rloc = max((s["rloc"] for s in stats.values()), default=1) or 1
    max_commits = max((v.get("commitsCount", 0) for v in risk.values()), default=1) or 1
    max_authors = max((v.get("authorCount", 0) for v in risk.values()), default=1) or 1
    risk_scores: dict = {}
    for rel, s in stats.items():
        rv = risk.get(rel, {})
        risk_scores[rel] = round(100 * (
            0.35 * (s["complexity"] / max_complexity)
            + 0.35 * (rv.get("commitsCount", 0) / max_commits)
            + 0.20 * (rv.get("authorCount", 0) / max_authors)
            + 0.10 * (s["rloc"] / max_rloc)))

    # --- Cross-World-Edges -------------------------------------------------
    cross_edges: list = []
    for src, dst, typ, why in CURATED_EDGES:
        if src in stats and dst in stats:
            cross_edges.append({"source": src, "target": dst, "type": typ, "why": why})

    electron_texts = {rel: t for rel, t in texts.items() if rel.startswith("electron/")}
    methods, channel_owner = build_ipc_map(electron_texts)
    ipc_count = 0
    for rel, t in texts.items():
        if not rel.startswith("src/"):
            continue
        for chain in set(RE_DESKTOP_CALL.findall(t)):
            channel = methods.get(chain)
            if channel is None:  # Aufruf über Zwischenvariable o. ä. – Suche nach letztem Segment
                leaf = chain.split(".")[-1]
                channel = next((ch for m, ch in methods.items() if m.split(".")[-1] == leaf), None)
            owner = channel_owner.get(channel) if channel else None
            if owner:
                cross_edges.append({"source": rel, "target": owner, "type": "ipc",
                                    "why": f"IPC-Kanal '{channel}' (via preload contextBridge)"})
                ipc_count += 1
        if RE_FETCH_API.search(t):
            cross_edges.append({"source": rel, "target": "server.ts", "type": "api",
                                "why": "fetch('/api/...') – HTTP-Aufruf des Express-Servers"})
    # Kanal-Verträge ohne Renderer-Aufruf (z. B. Invoke ohne direkten Deskop-Call)
    for method, channel in methods.items():
        owner = channel_owner.get(channel)
        if owner:
            cross_edges.append({"source": "electron/preload.cjs", "target": owner, "type": "ipc",
                                "why": f"Kanal-Vertrag '{channel}' ({method})"})
    seen: set = set()
    cross_dedup = []
    for e in cross_edges:
        key = (e["source"], e["target"], e["type"], e["why"])
        if key not in seen:
            seen.add(key)
            cross_dedup.append(e)
    cross_edges = cross_dedup
    print(f"[3/5] {len(cross_edges)} Cross-World-Kanten erkannt ({ipc_count} Renderer-IPC-Aufrufe, "
          f"{len(methods)} Preload-Methoden, {len(channel_owner)} Main-Kanäle)")

    # --- Knoten aufbauen ---------------------------------------------------
    nodes = []
    for rel, s in stats.items():
        lang = {".ts": "TypeScript", ".tsx": "TypeScript (React)", ".js": "JavaScript",
                ".jsx": "JavaScript (React)", ".mjs": "JavaScript (ESM)", ".cjs": "JavaScript (CommonJS)",
                ".py": "Python", ".cpp": "C++", ".cc": "C++", ".h": "C/C++ Header",
                ".hpp": "C++ Header"}.get(Path(rel).suffix, Path(rel).suffix)
        g = group_of(rel)
        nodes.append({
            "id": rel, "name": Path(rel).name, "group": g, "lang": lang,
            "rloc": s["rloc"], "loc": s["loc"], "functions": s["functions"],
            "classes": s["classes"], "complexity": s["complexity"],
            "maxDepth": s["maxDepth"], "imports": s["importStatements"],
            "externalImports": s["externalImports"],
            "fanIn": fan_in.get(rel, 0), "fanOut": fan_out.get(rel, 0),
            "churn": risk.get(rel, {}).get("commitsCount", 0), "todos": s["todos"],
            "commitsCount": risk.get(rel, {}).get("commitsCount", 0),
            "authorCount": risk.get(rel, {}).get("authorCount", 0),
            "ageInDays": risk.get(rel, {}).get("ageInDays", 0),
            "riskScore": risk_scores.get(rel, 0),
            "commentLines": s["commentLines"],
            "desc": DESCRIPTIONS.get(rel, GROUP_FALLBACK_DESC[g]),
            "importsList": s["internalTargets"][:12],
        })

    # --- graph.json --------------------------------------------------------
    out_dir = repo / "code_analysis_out"
    out_dir.mkdir(exist_ok=True)
    group_counts: dict = defaultdict(int)
    for n in nodes:
        group_counts[n["group"]] += 1
    graph = {
        "generatedAt": _dt.datetime.now().isoformat(timespec="seconds"),
        "project": "airdox_SMART_Editor",
        "groups": {k: {**v, "count": group_counts.get(k, 0)} for k, v in GROUPS.items()},
        "edgeTypes": EDGE_TYPES,
        "nodes": nodes,
        "links": ([{"source": a, "target": b, "type": "import", "weight": w}
                   for a, b, w in import_edges]
                  + [{"source": e["source"], "target": e["target"], "type": e["type"],
                      "why": e["why"]} for e in cross_edges]),
    }
    (out_dir / "graph.json").write_text(json.dumps(graph, ensure_ascii=False))
    print(f"[4/5] code_analysis_out/graph.json geschrieben "
          f"({len(nodes)} Knoten, {len(graph['links'])} Kanten)")

    # --- cc.json (CodeCharta) ----------------------------------------------
    root_children: dict = {}
    for rel, s in stats.items():
        parts = rel.split("/")
        node = root_children
        for folder in parts[:-1]:
            node = node.setdefault(folder + "/", {})
        node[parts[-1]] = s
    cc_nodes = [{"name": "root", "type": "folder", "attributes": {},
                 "children": folder_to_cc(root_children, fan_in, fan_out, risk, risk_scores)}]
    cc_edges = [{"fromNode": f"/root/{a}", "toNode": f"/root/{b}", "attributes": {"imports": w}}
                for a, b, w in import_edges]
    for e in cross_edges:
        cc_edges.append({"fromNode": f"/root/{e['source']}", "toNode": f"/root/{e['target']}",
                         "attributes": {"imports": 1, "crossWorld": 1}})
    cc = {
        "projectName": "airdox_SMART_Editor",
        "apiVersion": "1.3",
        "nodes": cc_nodes,
        "attributeTypes": {
            "nodes": {k: "absolute" for k in
                      ["rloc", "loc", "functions", "classes", "complexity", "maxDepth",
                       "imports", "fanIn", "fanOut", "churn", "todos", "commentLines",
                       "commitsCount", "authorCount", "ageInDays", "riskScore"]},
            "edges": {"imports": "absolute", "crossWorld": "absolute"},
        },
        "edges": cc_edges,
        "blacklist": [],
    }
    (out_dir / "airdox.cc.json").write_text(json.dumps(cc, ensure_ascii=False))
    print(f"       code_analysis_out/airdox.cc.json geschrieben ({len(cc_edges)} Kanten)")

    # --- visualization.html ------------------------------------------------
    template_path = Path(args.template)
    if template_path.exists():
        payload = json.dumps(graph, ensure_ascii=False).replace("</", "<\\/")
        html = template_path.read_text(encoding="utf-8").replace("/*__GRAPH_DATA__*/null", payload)
        (repo / "visualization.html").write_text(html)
        print(f"[5/5] visualization.html geschrieben ({len(html) // 1024} KB, Daten eingebettet)")
    else:
        print("[5/5] WARNUNG: Template nicht gefunden – visualization.html übersprungen")


if __name__ == "__main__":
    sys.exit(main())
