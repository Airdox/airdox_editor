/**
 * Laufzeit-Probes für alle Subprozess-Backends – billig, gecacht, single-flight.
 *
 * Warum es dieses Modul gibt
 * --------------------------
 * Der Editor fragt den Engine-Status mehrfach kurz hintereinander ab (Öffnen
 * der Einstellungen, Preflight, Installationsschritte). Jede dieser Abfragen
 * prüfte bisher jedes installierte Modell einzeln, und zwar *immer wieder* mit
 * einem echten `python -c "import torch"`. Auf einem Windows-Laptop kostet das
 * 5–20 s (Virenscanner liest die DLLs), und parallele Aufrufe starteten je
 * einen eigenen Interpreter. Genau das steht im Produktionslog:
 *
 *   Langsamer IPC-Handler ›stems:engine-status‹: 7178 / 10531 / 9532 / 14949 ms
 *
 * Deshalb gilt hier:
 *  - Der Interpreter wird zuerst *billig* geprüft (`importlib.util.find_spec`,
 *    ohne die CUDA/torch-DLLs zu laden), erst danach folgt einmalig der echte
 *    Import.
 *  - Ergebnisse werden im Prozess gecacht (positiv 10 min, negativ 20 s) und
 *    optional auf Platte (`<cacheDir>/runtime-probe.json`) – der Schlüssel
 *    enthält Pfad, Größe und mtime des Interpreters. Wird Python neu
 *    installiert, ändert sich der Schlüssel und es wird wieder gemessen; ein
 *    „negativ“ bleibt also nie dauerhaft stehen.
 *  - Parallele Probes desselben Schlüssels teilen sich ein Promise
 *    (single-flight). Der Fortschritt eines Status-Aufrufs wartet damit nie
 *    mehrfach auf denselben Interpreter.
 *
 * Die Verdicts bleiben streng: „verfügbar“ heißt weiterhin, dass der echte
 * `import torch` geklappt hat – nur eben gemessen statt geraten.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PROBE_CACHE_VERSION = 1;
const POSITIVE_TTL_MS = 10 * 60 * 1000;
const NEGATIVE_TTL_MS = 60 * 1000;
const PERSISTED_POSITIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PERSISTED_NEGATIVE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_FAST_TIMEOUT_MS = 5000;
const DEFAULT_IMPORT_TIMEOUT_MS = 20000;
const DEFAULT_INTERPRETER_TIMEOUT_MS = 8000;

export interface CommandProbeResult {
  found: boolean;
  exitCode: number | null;
  /** stdout+stderr, auf 400 Zeichen gekürzt (nur für Fehlermeldungen/Logs). */
  output: string;
  detail?: string;
  timedOut: boolean;
  durationMs: number;
}

export interface CommandProbeOptions {
  timeoutMs?: number;
  env?: Record<string, string>;
  cwd?: string;
}

/**
 * Startet ein Kommando einmal und meldet, ob es *sauber* (Exit 0) endete.
 * Ein Interpreter, der eine ImportError auf stderr schreibt, gilt als nicht
 * verfügbar – unabhängig davon, wie viel er ausgegeben hat.
 */
export function probeCommand(
  command: string,
  args: string[] = [],
  options: CommandProbeOptions = {}
): Promise<CommandProbeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_INTERPRETER_TIMEOUT_MS;
  const started = Date.now();
  if (path.isAbsolute(command) && !existsSync(command)) {
    return Promise.resolve({
      found: false,
      exitCode: null,
      output: '',
      detail: `Datei nicht gefunden: ${command}`,
      timedOut: false,
      durationMs: 0,
    });
  }
  return new Promise<CommandProbeResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        windowsHide: true,
        env: options.env ? { ...process.env, ...options.env } : process.env,
      });
    } catch (error) {
      resolve({
        found: false,
        exitCode: null,
        output: '',
        detail: error instanceof Error ? error.message : String(error),
        timedOut: false,
        durationMs: Date.now() - started,
      });
      return;
    }

    let output = '';
    let settled = false;
    const finish = (result: Omit<CommandProbeResult, 'output' | 'durationMs'> & { output?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = (result.output ?? output).trim().slice(0, 400);
      resolve({ ...result, output: text, durationMs: Date.now() - started });
    };

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish({ found: false, exitCode: null, output, detail: `Zeitüberschreitung nach ${timeoutMs} ms`, timedOut: true });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('error', (error) => {
      finish({ found: false, exitCode: null, output, detail: error.message, timedOut: false });
    });
    child.on('close', (code) => {
      finish({ found: code === 0, exitCode: code, output, detail: code === 0 ? undefined : undefined, timedOut: false });
    });
  });
}

export interface TorchProbeResult {
  available: boolean;
  torchVersion?: string;
  /** Version des Interpreters, z. B. `3.11.9`. */
  interpreterVersion?: string;
  reason?: string;
  detail?: string;
  /** true, wenn die Antwort aus einem Cache kam (kein neuer Interpreter). */
  cached: boolean;
  durationMs: number;
  /** `find_spec` = billiges Verdikt, `import` = echter Modul-Import. */
  verification: 'none' | 'find_spec' | 'import';
}

export interface TorchProbeOptions {
  /** Interpreter (absoluter Pfad oder Kommandoname). */
  command: string;
  /** Argumente *vor* `-c` – z. B. `['-3.11']` für den Windows-Launcher `py`. */
  argsPrefix?: string[];
  env?: Record<string, string>;
  /**
   * `true` (Produktion): der Interpreter zählt nur als verfügbar, wenn
   * `import torch` wirklich klappt. `false` (Protokoll-Stubs der Vertragstests):
   * es genügt, dass der Interpreter startet.
   */
  requireImport?: boolean;
  /**
   * Prüftiefe:
   *  - `strict` (Default): Interpreter **und** echter `import torch`.
   *  - `fast`: nur der billige Schritt (Interpreter startet, Version
   *    unterstützt, `find_spec('torch')` findet die Pakete). Für den
   *    Statusaufruf der UI – der darf nie an einem 60-s-Import hängen; der
   *    echte Import passiert beim Jobstart (derselbe Cache, single-flight).
   */
  mode?: 'fast' | 'strict';
  /** Unterstützte Python-Minor-Versionen (PyTorch-Wheels). Default 3.10–3.12. */
  supportedMinorRange?: [number, number];
  /** Persistenter Cache-Ordner (Engine-`Cache/`). Ohne Angabe nur im Prozess. */
  cacheDir?: string;
  /**
   * Module, die importierbar sein müssen. `torch` gehört immer dazu, weil die
   * Versionsnummer aus diesem Import stammt (HT-Demucs prüft zusätzlich `demucs`).
   */
  modules?: string[];
  /** Budget für den echten Import. */
  timeoutMs?: number;
  /** Budget für die billige Vorprüfung. */
  fastTimeoutMs?: number;
  /** Test-Hook. */
  now?: () => number;
}

interface ProbeSnapshot {
  at: number;
  available: boolean;
  torchVersion?: string;
  interpreterVersion?: string;
  verification?: 'none' | 'find_spec' | 'import';
  reason?: string;
  detail?: string;
}

const memoryCache = new Map<string, ProbeSnapshot>();
const inflight = new Map<string, Promise<TorchProbeResult>>();
const persistedCache = new Map<string, Record<string, ProbeSnapshot>>();
let probeCounter = 0;

/** Anzahl wirklich gestarteter Interpreter-Probes (Diagnose/Tests). */
export function torchProbeSpawnCount(): number {
  return probeCounter;
}

/**
 * Leert die Verdikte.
 *
 * `keepPositive` (nach einer Installation): positive Ergebnisse bleiben gültig
 * – ein installiertes PyTorch verschwindet nicht durch ein Installationsskript.
 * Negative Ergebnisse dagegen sind genau der Grund, warum die App nach einer
 * erfolgreichen Installation weiter „nicht verfügbar“ meldete: sie werden
 * verworfen, auf Platte wie im Speicher.
 */
export function clearTorchProbeCache(options: { keepPositive?: boolean } = {}): void {
  inflight.clear();
  stage1Cache.clear();
  if (!options.keepPositive) {
    memoryCache.clear();
    persistedCache.clear();
    return;
  }
  for (const [key, snapshot] of [...memoryCache.entries()]) {
    if (!snapshot.available) memoryCache.delete(key);
  }
  for (const [dir, entries] of [...persistedCache.entries()]) {
    const kept: Record<string, ProbeSnapshot> = {};
    for (const [key, snapshot] of Object.entries(entries)) {
      if (snapshot.available) kept[key] = snapshot;
    }
    persistedCache.set(dir, kept);
    writePersisted(dir, kept);
  }
}

function interpreterSignature(command: string, argsPrefix: string[]): string {
  try {
    const info = statSync(command);
    return `${command}|${argsPrefix.join(' ')}|${info.size}|${Math.trunc(info.mtimeMs)}`;
  } catch {
    // Kommando aus dem PATH (`python3`) – nur der Name plus Argumente.
    return `${command}|${argsPrefix.join(' ')}|path`;
  }
}

function readPersisted(cacheDir: string | undefined): Record<string, ProbeSnapshot> {
  if (!cacheDir) return {};
  const cached = persistedCache.get(cacheDir);
  if (cached) return cached;
  let loaded: Record<string, ProbeSnapshot> = {};
  try {
    const raw = readFileSync(path.join(cacheDir, 'runtime-probe.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: number; entries?: Record<string, ProbeSnapshot> };
    if (parsed?.version === PROBE_CACHE_VERSION && parsed.entries) loaded = parsed.entries;
  } catch {
    /* kein oder kaputter Cache – wird neu geschrieben */
  }
  persistedCache.set(cacheDir, loaded);
  return loaded;
}

function writePersisted(cacheDir: string | undefined, entries: Record<string, ProbeSnapshot>): void {
  if (!cacheDir) return;
  try {
    mkdirSync(cacheDir, { recursive: true });
    const target = path.join(cacheDir, 'runtime-probe.json');
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: PROBE_CACHE_VERSION, entries }, null, 2));
    renameSync(tmp, target);
  } catch {
    /* Ein nicht schreibbarer Cache darf nie einen Statusaufruf verhindern. */
  }
}

function rememberProbe(key: string, options: TorchProbeOptions, snapshot: ProbeSnapshot): void {
  memoryCache.set(key, snapshot);
  if (!options.cacheDir) return;
  const entries = readPersisted(options.cacheDir);
  entries[key] = snapshot;
  writePersisted(options.cacheDir, entries);
}

function fromSnapshot(snapshot: ProbeSnapshot): TorchProbeResult {
  return {
    available: snapshot.available,
    torchVersion: snapshot.torchVersion,
    interpreterVersion: snapshot.interpreterVersion,
    reason: snapshot.reason,
    detail: snapshot.detail,
    cached: true,
    durationMs: 0,
    verification: snapshot.verification ?? 'none',
  };
}

/** Erwartete Python-Versionen der gepinnten PyTorch-Wheels. */
export const DEFAULT_SUPPORTED_MINOR_RANGE: [number, number] = [10, 12];

/** Erste Zeile eines stderr-Blocks – die enthält in 95 % der Fälle die Ursache. */
function firstMeaningfulLine(text: string): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .pop();
  return line ? line.slice(0, 240) : undefined;
}

/** Ein Python-Einzeiler, der Version UND Modul-Präsenz in einem Start liefert. */
function fastProbeScript(modules: string[]): string {
  return (
    'import importlib.util, json, sys;' +
    `mods = ${JSON.stringify(modules)};` +
    'found = {};' +
    '\nfor m in mods:' +
    '\n    try: found[m] = importlib.util.find_spec(m) is not None' +
    '\n    except Exception: found[m] = False' +
    '\nprint("AIRDDOX_PROBE " + json.dumps({"version": sys.version.split()[0], "executable": sys.executable, "modules": found}))'
  );
}

interface FastProbeInfo {
  version?: string;
  executable?: string;
  modules?: Record<string, boolean>;
}

function parseFastProbe(output: string): FastProbeInfo | undefined {
  const match = /AIRDDOX_PROBE\s+(\{.*\})/s.exec(output);
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]) as FastProbeInfo;
  } catch {
    return undefined;
  }
}

/** `AIRDDOX_TORCH <version>` – dieselbe Marke wie im echten Import. */
function parseTorchVersion(output: string): string | undefined {
  return /AIRDDOX_TORCH\s+(\S+)/.exec(output)?.[1];
}

/**
 * Ergebnis der billigen Vorprüfung. Sie liefert dieselbe Antwort für den
 * schnellen und den strengen Pfad – ohne sie startete ein Statusaufruf (fast)
 * und der anschließende Jobstart (strict) zwei Interpreter für dieselbe Frage.
 */
const stage1Cache = new Map<string, { at: number; info?: FastProbeInfo; probe: CommandProbeResult }>();
const STAGE1_TTL_MS = 60 * 1000;

async function stage1Probe(
  signature: string,
  options: TorchProbeOptions,
  modules: string[]
): Promise<{ info?: FastProbeInfo; probe: CommandProbeResult }> {
  const cached = stage1Cache.get(signature);
  const now = options.now ? options.now() : Date.now();
  if (cached && now - cached.at < STAGE1_TTL_MS) return cached;
  const probe = await probeCommand(options.command, [...(options.argsPrefix ?? []), '-c', fastProbeScript(modules)], {
    timeoutMs: options.fastTimeoutMs ?? DEFAULT_FAST_TIMEOUT_MS,
    env: options.env,
  });
  const entry = { at: now, info: parseFastProbe(probe.output), probe };
  // Auch Zeitüberschreitungen werden im Prozess (stage1Cache) gemerkt,
  // damit parallele oder unmittelbar folgende Statusaufrufe nicht erneut blockieren.
  // Auf Platte wird eine Zeitüberschreitung aber weiterhin nicht geschrieben.
  stage1Cache.set(signature, entry);
  return entry;
}

/**
 * Prüft, ob ein Interpreter PyTorch wirklich benutzen kann.
 *
 * Reihenfolge: Prozess-Cache → Platten-Cache → billige Vorprüfung → echter Import.
 * Das Ergebnis ist dieselbe Aussage wie vorher, nur ohne den Interpreter bei
 * jeder Statusabfrage erneut zu starten.
 */
export async function probeTorchRuntime(options: TorchProbeOptions): Promise<TorchProbeResult> {
  const requireImport = options.requireImport !== false;
  const mode = options.mode ?? 'strict';
  const now = options.now ?? Date.now;
  const argsPrefix = options.argsPrefix ?? [];
  const modules = options.modules && options.modules.length > 0 ? options.modules : ['torch'];
  const [minMinor, maxMinor] = options.supportedMinorRange ?? DEFAULT_SUPPORTED_MINOR_RANGE;
  const commandLabel = options.command;

  // Der Cache-Schlüssel enthält die Prüftiefe: ein *strenges* Verdikt (echter
  // Import) gilt auch für den schnellen Pfad, umgekehrt nicht.
  const keyBase = `${PROBE_CACHE_VERSION}|${requireImport ? modules.join('+') : 'interpreter'}|${interpreterSignature(options.command, argsPrefix)}`;
  const strictKey = `${keyBase}|strict`;
  const fastKey = `${keyBase}|fast`;
  const key = mode === 'fast' ? fastKey : strictKey;

  const fresh = (snapshot: ProbeSnapshot): boolean => {
    const ttl = snapshot.available ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
    return now() - snapshot.at < ttl;
  };
  const persistedFresh = (snapshot: ProbeSnapshot): boolean => {
    const ttl = snapshot.available ? PERSISTED_POSITIVE_TTL_MS : PERSISTED_NEGATIVE_TTL_MS;
    return now() - snapshot.at < ttl;
  };

  // Stufe 0: Prozess-Cache. Im schnellen Modus zählt ein vorhandenes strenges
  // Verdikt als stärkere Antwort.
  for (const candidateKey of mode === 'fast' ? [fastKey, strictKey] : [strictKey]) {
    const memory = memoryCache.get(candidateKey);
    if (memory && fresh(memory)) return fromSnapshot(memory);
  }

  // Stufe 0b: Platten-Cache (überlebt App-Neustarts).
  if (options.cacheDir) {
    const entries = readPersisted(options.cacheDir);
    for (const candidateKey of mode === 'fast' ? [fastKey, strictKey] : [strictKey]) {
      const persisted = entries[candidateKey];
      if (persisted && persistedFresh(persisted)) {
        memoryCache.set(candidateKey, persisted);
        return fromSnapshot(persisted);
      }
    }
  }

  const running = inflight.get(key);
  if (running) return running;

  const task = (async (): Promise<TorchProbeResult> => {
    const started = now();
    probeCounter += 1;

    const remember = (snapshot: ProbeSnapshot, options_: { persist?: boolean } = {}) => {
      memoryCache.set(key, snapshot);
      // Der schnelle Pfad schreibt sein positives Verdikt NICHT auf Platte:
      // „find_spec hat torch gefunden“ ist kein Beweis, dass der Import klappt.
      const persist = options_.persist ?? (mode === 'strict' || !snapshot.available);
      if (persist) rememberProbe(key, options, snapshot);
      return { ...fromSnapshot(snapshot), durationMs: now() - started, cached: false };
    };

    // Wenn ein absoluter Pfad angegeben ist und die Datei nicht existiert:
    // sofort als nicht verfügbar melden, ohne Prozessstart oder Timeout.
    if (path.isAbsolute(options.command) && !existsSync(options.command)) {
      const snapshot: ProbeSnapshot = {
        at: now(),
        available: false,
        verification: 'none',
        reason: `Python-Laufzeit nicht verfügbar (${commandLabel})`,
        detail: `Datei nicht gefunden: ${options.command}`,
      };
      return remember(snapshot, { persist: true });
    }

    // Nur-Interpreter (Protokoll-Stubs der Vertragstests).
    if (!requireImport) {
      const probe = await probeCommand(options.command, [...argsPrefix, '-c', 'print(1)'], {
        timeoutMs: options.fastTimeoutMs ?? DEFAULT_INTERPRETER_TIMEOUT_MS,
        env: options.env,
      });
      const snapshot: ProbeSnapshot = {
        at: now(),
        available: probe.found,
        verification: 'none',
        reason: probe.found ? undefined : `Python-Laufzeit nicht verfügbar (${commandLabel})`,
        detail: probe.found ? undefined : (probe.detail ?? probe.output.slice(-200)),
      };
      return remember(snapshot);
    }

    // Stufe 1: Interpreter startet, Version unterstützt, Module auffindbar –
    // alles in *einem* Prozessstart, ohne torch zu importieren.
    const stage1 = await stage1Probe(`${interpreterSignature(options.command, argsPrefix)}|${modules.join('+')}`, options, modules);
    const fast = stage1.probe;
    const info = stage1.info;
    const [major, minor] = (info?.version ?? '').split('.').map((part) => Number.parseInt(part, 10));
    const interpreterVersion = Number.isFinite(major) && Number.isFinite(minor) ? `${major}.${minor}` : undefined;

    if (!fast.found) {
      const snapshot: ProbeSnapshot = {
        at: now(),
        available: false,
        verification: 'none',
        interpreterVersion,
        reason: `Python/${modules.join('/')}-Laufzeit nicht verfügbar (${commandLabel})`,
        detail:
          (fast.timedOut
            ? `Der Interpreter hat innerhalb von ${options.fastTimeoutMs ?? DEFAULT_FAST_TIMEOUT_MS} ms nicht geantwortet.`
            : fast.detail ?? firstMeaningfulLine(fast.output)) || undefined,
      };
      // Eine Zeitüberschreitung ist keine belastbare Aussage: sie bleibt im
      // Prozess (kurze TTL), wird aber nicht auf Platte festgeschrieben.
      return remember(snapshot, { persist: !fast.timedOut });
    }
    if (interpreterVersion && (minor < minMinor || minor > maxMinor)) {
      const snapshot: ProbeSnapshot = {
        at: now(),
        available: false,
        verification: 'find_spec',
        interpreterVersion,
        reason:
          `Python ${info?.version ?? interpreterVersion} wird nicht unterstützt – die gepinnten PyTorch-Wheels gibt es für ` +
          `Python 3.${minMinor}–3.${maxMinor} (${commandLabel}).`,
        detail: `Empfehlung: Python 3.11 (64-Bit) installieren und die Runtime im Einstellungsmenü neu einrichten. Gefunden: ${info?.executable ?? commandLabel}`,
      };
      return remember(snapshot);
    }
    const missing = modules.filter((module) => info?.modules?.[module] !== true);
    if (info && missing.length > 0) {
      const snapshot: ProbeSnapshot = {
        at: now(),
        available: false,
        verification: 'find_spec',
        interpreterVersion,
        reason: `${missing.join('/')} ist in ${commandLabel} nicht installiert (Python ${info.version ?? '?'}).`,
        detail: `Installation über das Einstellungsmenü ("KI-Modelle installieren") ausführen – dort wird PyTorch in genau diese Umgebung installiert.`,
      };
      return remember(snapshot);
    }
    if (!info) {
      // Interpreter antwortet, ist aber kein Python mit JSON-Ausgabe.
      const snapshot: ProbeSnapshot = {
        at: now(),
        available: false,
        verification: 'none',
        reason: `Python-Laufzeit liefert keine verwertbare Antwort (${commandLabel})`,
        detail: (fast.detail ?? firstMeaningfulLine(fast.output)) || undefined,
      };
      return remember(snapshot);
    }

    // Schneller Modus: Modul ist auffindbar, der echte Import bleibt dem
    // Jobstart überlassen (gleicher Cache, single-flight).
    if (mode === 'fast') {
      const snapshot: ProbeSnapshot = {
        at: now(),
        available: true,
        verification: 'find_spec',
        interpreterVersion,
        detail: `${info.executable ?? commandLabel} · Python ${info.version ?? '?'} · Module: ${modules.join(', ')} (Import-Prüfung beim Jobstart)`,
      };
      return remember(snapshot);
    }

    // Stufe 2: echter Import – genau das, was der Job später auch tut.
    const probe = await probeCommand(
      options.command,
      [...argsPrefix, '-c', `import ${modules.join(', ')}; print("AIRDDOX_TORCH", torch.__version__)`],
      { timeoutMs: options.timeoutMs ?? DEFAULT_IMPORT_TIMEOUT_MS, env: options.env }
    );
    const version = parseTorchVersion(probe.output);
    const snapshot: ProbeSnapshot = {
      at: now(),
      available: probe.found && Boolean(version),
      verification: 'import',
      torchVersion: version,
      interpreterVersion,
      reason:
        probe.found && version
          ? undefined
          : probe.timedOut
            ? `Zeitüberschreitung beim ${modules.join('/')}-Import (${commandLabel})`
            : `${modules.join('/')} ist in ${commandLabel} nicht importierbar (Python ${info.version ?? '?'})`,
      detail: probe.found && version ? undefined : (firstMeaningfulLine(probe.output) ?? probe.detail) || undefined,
    };
    // Eine Zeitüberschreitung ist keine belastbare Aussage (langsamer Start,
    // Antivirus) – sie wird nur im Prozess gemerkt, nicht auf Platte.
    return remember(snapshot, { persist: !probe.timedOut });
  })().finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, task);
  return task;
}
