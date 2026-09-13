/**
 * @license
 * airdox_SMART_Editor - Full-Stack Express Server with Gemini AI Proxy
 */

import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import demucsRunner from './electron/demucsRunner.cjs';
// Gemeinsamer dateibasierter Logger mit dem Electron-Main-Prozess. Der
// Default-Import eines .cjs-Moduls funktioniert gleichermaßen unter tsx (ESM)
// und im esbuild-CJS-Bundle (dist/server.cjs).
import loggerPackage from './electron/logger.cjs';

type MainLogger = {
  configure(options: {
    logDirectory: string;
    processName?: string;
    level?: string;
    retentionDays?: number;
    appInfo?: Record<string, unknown>;
  }): MainLogger;
  installProcessHandlers(): void;
  installConsoleCapture?(): void;
  flush?(): Promise<void>;
  getCurrentFilePath?(): string;
  getInfo(): Record<string, unknown>;
  ingestRendererEntries(entries: unknown[]): { accepted: number };
  debug(category: string, message: string, details?: unknown): void;
  info(category: string, message: string, details?: unknown): void;
  warn(category: string, message: string, details?: unknown): void;
  error(category: string, message: string, details?: unknown): void;
  fatal(category: string, message: string, details?: unknown): void;
};

const { mainLogger: logger } = loggerPackage as { mainLogger: MainLogger };
logger.configure({
  logDirectory: path.join(process.cwd(), 'logs'),
  processName: 'server',
  level: process.env.AIRDOX_LOG_LEVEL || 'INFO',
  appInfo: { appName: 'airdox_SMART_Editor', appVersion: 'dev' },
});
logger.installProcessHandlers();

const { separateWav } = demucsRunner as {
  separateWav: (
    bytes: Uint8Array,
    options?: {
      repoRoot?: string;
      model?: string;
      onProgress?: (text: string) => void;
      onLog?: (level: string, category: string, message: string, details?: unknown) => void;
    }
  ) => Promise<{ model: string; stems: Record<string, Buffer> }>;
};

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  // Allumfassendes HTTP-Audit-Protokoll: jede Anfrage mit Methode, Pfad,
  // Status, Dauer und Antwortgröße. Statische Asset-Anfragen laufen auf DEBUG,
  // API-Aufrufe auf INFO, Fehler auf WARN/ERROR.
  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      const durationMs = Date.now() - startedAt;
      const level =
        res.statusCode >= 500
          ? 'error'
          : res.statusCode >= 400
          ? 'warn'
          : req.url.startsWith('/api')
          ? 'info'
          : 'debug';
      const contentLength = Number(res.getHeader('content-length')) || undefined;
      logger[level]('NETWORK', `${req.method} ${req.originalUrl || req.url} → ${res.statusCode}`, {
        durationMs,
        bytes: contentLength,
        userAgent: String(req.headers['user-agent'] || '').slice(0, 200) || undefined,
      });
    });
    next();
  });

  // Real Stem-Separation: the request body is the finished stereo song mix.
  // Demucs never receives or has access to reference/ground-truth stems.
  app.post(
    '/api/stems/separate',
    express.raw({ type: ['audio/wav', 'application/octet-stream'], limit: '1gb' }),
    async (req, res) => {
      try {
        if (!Buffer.isBuffer(req.body) || req.body.length < 44) {
          logger.warn('STEMS', 'Separationsanfrage ohne gültige WAV-Mixdatei abgelehnt (400).');
          return res.status(400).json({ error: 'Eine gültige PCM-WAV-Mixdatei ist erforderlich.' });
        }
        logger.info('STEMS', `HTTP /api/stems/separate – ${req.body.length} Bytes WAV empfangen.`);
        const result = await separateWav(req.body, {
          repoRoot: process.cwd(),
          model: process.env.DEMUCS_MODEL || 'htdemucs_ft',
          onProgress: (text) => {
            const line = text.trim();
            if (line) logger.debug('STEMS', `[demucs-fortschritt] ${line.slice(0, 300)}`);
          },
          onLog: (level: string, category: string, message: string, details?: unknown) =>
            logger[level] ? logger[level](category, message, details) : logger.info(category, message, details),
        });
        // One response keeps all four files from the exact same model pass aligned.
        // Base64 is intentionally used only on the local API/desktop path.
        const stemSizes = Object.fromEntries(
          Object.entries(result.stems).map(([name, bytes]) => [name, bytes.length])
        );
        logger.info('STEMS', `Separation erfolgreich (${result.model}) – Stems ausgeliefert.`, {
          model: result.model,
          stemBytes: stemSizes,
        });
        return res.json({
          engine: 'demucs',
          model: result.model,
          stems: Object.fromEntries(
            Object.entries(result.stems).map(([name, bytes]) => [name, bytes.toString('base64')])
          ),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('STEMS', `HTTP-Separation fehlgeschlagen: ${message}`, {
          stack: error instanceof Error ? error.stack : undefined,
        });
        return res.status(503).json({ error: message });
      }
    }
  );

  app.use(express.json({ limit: '10mb' }));

  // Lazy Gemini client initialization
  let aiClient: GoogleGenAI | null = null;
  function getGeminiClient(): GoogleGenAI {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY environment variable is required');
    }
    if (!aiClient) {
      aiClient = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });
    }
    return aiClient;
  }

  // Health check endpoint
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      hasGeminiKey: !!process.env.GEMINI_API_KEY,
      timestamp: Date.now(),
    });
  });

  // Chatbot Copilot endpoint
  app.post('/api/chat', async (req, res) => {
    try {
      const {
        messages = [],
        model = 'gemini-3.5-flash',
        trackContext = {},
      } = req.body;

      const apiKey = process.env.GEMINI_API_KEY;

      // If no API key configured, use intelligent local DJ Copilot engine
      if (!apiKey) {
        const lastMsg = messages[messages.length - 1];
        const userPrompt = (lastMsg?.text || lastMsg?.content || '').toLowerCase();
        const fallback = generateOfflineCopilotResponse(userPrompt, trackContext);
        return res.json(fallback);
      }

      const ai = getGeminiClient();

      const systemInstruction = `Du bist airdox DJ Smart Copilot, der spezialisierte KI-Assistent für den airdox_SMART_Editor (einen professionellen Rekordbox-Audio-Editor für DJs & Produzenten).

DEINE ROLLE:
1. Unterstütze den DJ beim Schneiden, Editieren, Beatgrid-Ausrichten, Cue-Setzen, Phrasen-Arrangieren und Vorbereiten von Tracks.
2. Wenn der Benutzer eine Bearbeitung wünscht (z.B. Zoom auf Takte, Cue setzen, Bereich auswählen, Schneiden, Beatgrid ausrichten, Quantize umschalten), antworte kurz und kompetent auf Deutsch UND schlage direkt auszuführende Software-Aktionen vor oder führe sie durch!

AKTUELLES PROJEKT & DECK-KONTEXT:
- Track: ${trackContext.title || 'Kein Track geladen'} (${trackContext.artist || 'Kein Artist'})
- BPM: ${trackContext.bpm ? trackContext.bpm.toFixed(2) : 'Unbekannt'} | Tonart: ${trackContext.key || '--'}
- Gesamtlänge: ${trackContext.duration ? trackContext.duration.toFixed(2) + 's' : '0s'}
- Playhead Position: ${trackContext.currentTime ? trackContext.currentTime.toFixed(3) + 's' : '0.000s'} (Takt ca. ${trackContext.currentBar || 1})
- Auswahl: ${
        trackContext.hasSelection
          ? `${trackContext.selectionStart?.toFixed(3)}s bis ${trackContext.selectionEnd?.toFixed(3)}s (${trackContext.selectionBeats || 0} Beats / ${trackContext.selectionBars || 0} Takte)`
          : 'Keine Auswahl aktiv'
      }
- Zwischenablage: ${trackContext.hasClipboard ? 'Enthält Audio-Puffer' : 'Leer'}
- Quantize: ${trackContext.quantize ? 'EIN (Beatgrid-Snapping)' : 'AUS'}
- Wellenform-Modus: ${trackContext.waveformMode || 'RGB'}
${
  trackContext.mixInAnalysis
    ? `- MIX-IN & ENERGIE-ANALYSE:
  * Optimaler Mix-In Punkt: Takt ${trackContext.mixInAnalysis.optimalPoint?.barNumber}.1 (${trackContext.mixInAnalysis.optimalPoint?.timeFormatted} = ${trackContext.mixInAnalysis.optimalPoint?.timeSeconds?.toFixed(2)}s)
  * Phrase: ${trackContext.mixInAnalysis.optimalPoint?.phraseName} | Energie: ${trackContext.mixInAnalysis.optimalPoint?.energyPercent}% (Bass: ${trackContext.mixInAnalysis.optimalPoint?.bassEnergyPercent}%, Mitten: ${trackContext.mixInAnalysis.optimalPoint?.midEnergyPercent}%)
  * Begründung: ${trackContext.mixInAnalysis.optimalPoint?.djMixingRationale}
  * Kick-Einstieg: Takt ${trackContext.mixInAnalysis.energySummary?.kickEntryBar} (${trackContext.mixInAnalysis.energySummary?.kickEntryTime?.toFixed(2)}s)
  * Dynamik-Spanne: Intro ${trackContext.mixInAnalysis.energySummary?.introAvgEnergy}% vs. Main ${trackContext.mixInAnalysis.energySummary?.bodyAvgEnergy}% (Peak: ${trackContext.mixInAnalysis.energySummary?.peakEnergy}%)
  * DJ-Empfehlung: ${trackContext.mixInAnalysis.djStrategyAdvice}`
    : ''
}

AUSFÜHRBARE AKTIONEN:
Wenn du Software-Schritte vorschlagen oder selbstständig übernehmen möchtest, hänge am Ende deiner Antwort einen JSON-Codeblock an:
\`\`\`json
{
  "actions": [
    {
      "id": "act-${Date.now()}",
      "type": "SET_ZOOM" | "SEEK_TO" | "SELECT_RANGE" | "ADD_CUE" | "ADD_MEMORY_CUE" | "SHIFT_BEATGRID" | "PERFORM_EDIT" | "SET_QUANTIZE" | "SET_WAVEFORM_MODE" | "ADD_TO_PALETTE" | "AUTO_ALIGN_GRID" | "SET_MIX_IN_POINT",
      "label": "Button-Label (z.B. 'Optimalen Mix-In setzen')",
      "description": "Erklärung des Schritts",
      "params": { ... }
    }
  ]
}
\`\`\`
Mögliche Aktionstypen & Parameter:
- SET_MIX_IN_POINT: { "time": number (Sekunden), "bar": number, "cueSlot": "A" | "B" | "C" | "MEMORY", "cueName": string, "selectBars": number (z.B. 16 oder 32), "zoomPreset": "16_BARS" }
- SET_ZOOM: { "preset": "2_BARS" | "4_BARS" | "8_BARS" | "16_BARS" | "32_BARS" | "64_BARS" | "FULL_TRACK" }
- SEEK_TO: { "time": number (Sekunden) }
- SELECT_RANGE: { "start": number, "end": number, "beats": number }
- ADD_CUE: { "type": "MEMORY" | "HOT_CUE", "time": number }
- ADD_MEMORY_CUE: {}
- SHIFT_BEATGRID: { "deltaSeconds": number } (z.B. 0.005 für 5ms)
- PERFORM_EDIT: { "operation": "COPY" | "CUT" | "PASTE" | "DELETE" | "CLEAR" | "OVERDUB" | "REPLACE" }
- SET_QUANTIZE: { "enabled": boolean }
- SET_WAVEFORM_MODE: { "mode": "RGB" | "3BAND" | "BLUE" }
- ADD_TO_PALETTE: { "name": string }
- AUTO_ALIGN_GRID: {}

Halte deine Antworten strukturiert, professionell und praxisnah.`;

      // Transform messages into contents format
      const contents = messages.map((m: any) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.text || m.content || '' }],
      }));

      const response = await ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction,
          temperature: 0.7,
        },
      });

      const responseText = response.text || '';

      // Extract JSON actions if present
      let actions: any[] = [];
      let cleanText = responseText;
      const jsonMatch = responseText.match(/```json\s*(\{[\s\S]*?"actions"[\s\S]*?\})\s*```/);

      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[1]);
          if (Array.isArray(parsed.actions)) {
            actions = parsed.actions;
          }
          cleanText = responseText.replace(/```json\s*\{[\s\S]*?"actions"[\s\S]*?\}\s*```/, '').trim();
        } catch (err) {
          logger.warn('CHATBOT', `Aktions-JSON aus KI-Antwort konnte nicht geparst werden: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      return res.json({
        text: cleanText,
        actions,
        model,
      });
    } catch (err: any) {
      logger.error('CHATBOT', `Chat-Endpunkt fehlgeschlagen: ${err?.message || String(err)}`, {
        stack: err?.stack,
      });
      return res.status(500).json({
        error: err.message || 'Interner Server-Fehler beim Verarbeiten der Anfrage',
      });
    }
  });

  // Client-seitige Logs auch im Browser-/Dev-Betrieb in dieselben Tagesdateien
  // schreiben (Desktop läuft über Electron-IPC; der Dev-Server bietet hierfür
  // einen einfachen Sammel-Endpunkt).
  app.post('/api/logs', express.json({ limit: '8mb' }), (req, res) => {
    try {
      const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
      const { accepted } = logger.ingestRendererEntries(entries);
      logger.flush?.();
      res.json({ ok: true, accepted });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/logs/info', (_req, res) => {
    res.json(logger.getInfo());
  });

  // Vite development middleware or static production serving
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    logger.info('SYSTEM', `Dev-/API-Server gestartet auf http://localhost:${PORT}`, {
      port: PORT,
      hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
      logFile: logger.getCurrentFilePath?.() || null,
    });
  });
}

/**
 * Intelligent local fallback when GEMINI_API_KEY is not configured yet
 */
function generateOfflineCopilotResponse(query: string, ctx: any) {
  const q = query.toLowerCase();
  const bpm = ctx.bpm || 130.0;
  const secPerBeat = 60 / bpm;
  const secPerBar = secPerBeat * 4;

  // 1. Mix-In & Energy Phrase Analysis (Optimaler Einstiegspunkt)
  if (
    q.includes('mix-in') ||
    q.includes('mixin') ||
    q.includes('mix in') ||
    q.includes('energie') ||
    q.includes('energy') ||
    q.includes('phrase') ||
    q.includes('übergang') ||
    q.includes('einstieg') ||
    q.includes('optimal') ||
    (q.includes('analys') && !q.includes('grid'))
  ) {
    if (ctx.mixInAnalysis) {
      const opt = ctx.mixInAnalysis.optimalPoint;
      const es = ctx.mixInAnalysis.energySummary;
      const candidates = ctx.mixInAnalysis.allCandidates || [];

      const candidateListText = candidates
        .map(
          (c: any) =>
            `• ${c.isRecommendedPrimary ? '★ **[Empfehlung]** ' : ''}**${c.label}** (${c.timeFormatted}): ${c.energyDescription} — ${c.phraseName} (${c.energyPercent}% Energie)`
        )
        .join('\n');

      return {
        text: `🎯 **Automatische Phrasen- & Energieanalyse für "${ctx.title || 'Aktueller Track'}":**\n\n` +
          `• **Optimaler Mix-In Punkt:** **Takt ${opt.barNumber}.1** bei **${opt.timeFormatted}** (${opt.timeSeconds.toFixed(2)}s)\n` +
          `• **Sektions-Phrase:** ${opt.phraseName}\n` +
          `• **Energielevel:** ${opt.energyPercent}% (Bass-Kick: ${opt.bassEnergyPercent}%, Mitten: ${opt.midEnergyPercent}%)\n` +
          `• **Dynamik-Verlauf:** Intro-Durchschnitt ${es.introAvgEnergy}% ➔ Hauptteil ${es.bodyAvgEnergy}% (Peak: ${es.peakEnergy}% bei Takt ${es.peakBar})\n\n` +
          `💡 **DJ-Mischbegründung:**\n${opt.djMixingRationale}\n\n` +
          `🎶 **Verfügbare Mix-In Varianten:**\n${candidateListText}\n\n` +
          `Klicke unten, um den optimalen Mix-In Punkt direkt anzuspringen und als Hot Cue A zu verankern:`,
        actions: [
          {
            id: `act-mixin-${opt.barNumber}`,
            type: 'SET_MIX_IN_POINT',
            label: `Optimalen Mix-In setzen (Takt ${opt.barNumber}.1 - ${opt.timeFormatted})`,
            description: `Springt zu Takt ${opt.barNumber}.1, setzt Hot Cue ${opt.suggestedCueSlot || 'A'} und wählt 16 Bars für den Übergang aus.`,
            params: {
              time: opt.timeSeconds,
              bar: opt.barNumber,
              cueSlot: opt.suggestedCueSlot || 'A',
              cueName: 'MIX-IN',
              zoomPreset: '16_BARS',
              selectBars: 16,
            },
          },
          ...(candidates.length > 1 && candidates[1]
            ? [
                {
                  id: `act-mixin-alt-${candidates[1].barNumber}`,
                  type: 'SET_MIX_IN_POINT',
                  label: `${candidates[1].label} (${candidates[1].timeFormatted})`,
                  description: candidates[1].djMixingRationale,
                  params: {
                    time: candidates[1].timeSeconds,
                    bar: candidates[1].barNumber,
                    cueSlot: candidates[1].suggestedCueSlot || 'B',
                    cueName: `MIX-${candidates[1].barNumber}`,
                    zoomPreset: '16_BARS',
                    selectBars: candidates[1].transitionLengthBars || 16,
                  },
                },
              ]
            : []),
          {
            id: 'act-zoom-16-mixin',
            type: 'SET_ZOOM',
            label: 'Auf 16 Bars zoomen',
            description: 'Stellt das Sichtfenster auf die 16-Bar Übergangsphase.',
            params: { preset: '16_BARS' },
          },
        ],
      };
    } else {
      const optBar = 17;
      const optTime = (optBar - 1) * secPerBar;
      const optTimeStr = `${Math.floor(optTime / 60)}:${Math.floor(optTime % 60).toString().padStart(2, '0')}.00`;
      return {
        text: `🎯 **Mix-In Empfehlung für "${ctx.title || 'Aktueller Track'}":**\n\n` +
          `Basierend auf der Rekordbox 4/4-Standardstruktur (${bpm.toFixed(1)} BPM) liegt der goldene Standard-Mix-In Punkt bei **Takt 17.1 (${optTimeStr})**.\n\n` +
          `• **Struktur:** 16 Takte Intro-Aufbau (Kicks setzen ab Takt 17 mit vollem Fundament ein)\n` +
          `• **Übergangsfenster:** 16 bis 32 Takte sauberer Vorlauf vor dem Drop\n` +
          `• **Empfohlene Aktion:** Hot Cue A setzen und 16 Bars loopen.`,
        actions: [
          {
            id: 'act-mixin-fallback',
            type: 'SET_MIX_IN_POINT',
            label: `Optimalen Mix-In setzen (Takt 17.1 - ${optTimeStr})`,
            description: 'Setzt Hot Cue A bei Takt 17.1 für einen 32-Takt-Übergang.',
            params: {
              time: optTime,
              bar: 17,
              cueSlot: 'A',
              cueName: 'MIX-IN',
              zoomPreset: '16_BARS',
              selectBars: 16,
            },
          },
          {
            id: 'act-zoom-16-fallback',
            type: 'SET_ZOOM',
            label: 'Auf 16 Bars zoomen',
            description: 'Übergangs-Phase anzeigen.',
            params: { preset: '16_BARS' },
          },
        ],
      };
    }
  }

  if (q.includes('zoom') || q.includes('takt') || q.includes('bar')) {
    if (q.includes('full') || q.includes('ganz') || q.includes('gesamt')) {
      return {
        text: 'Ich habe den Zoom auf den gesamten Track eingestellt, damit du die komplette Wellenform und Makro-Struktur überblicken kannst.',
        actions: [
          {
            id: 'act-zoom-full',
            type: 'SET_ZOOM',
            label: 'Gesamten Track anzeigen (Full Track)',
            description: 'Zoomt heraus auf die volle Track-Länge.',
            params: { preset: 'FULL_TRACK' },
          },
        ],
      };
    }
    if (q.includes('8')) {
      return {
        text: `Ich passe den Zoom auf 8 Takte (32 Beats = ca. ${(secPerBar * 8).toFixed(1)}s) an. Das ist das klassische Rekordbox-Phrasen-Intervall für Übergänge.`,
        actions: [
          {
            id: 'act-zoom-8',
            type: 'SET_ZOOM',
            label: 'Auf 8 Bars zoomen',
            description: 'Stellt das Detail-Sichtfenster auf 8 Takte ein.',
            params: { preset: '8_BARS' },
          },
        ],
      };
    }
    return {
      text: 'Hier sind schnelle Zoom-Optionen für deine Navigation:',
      actions: [
        {
          id: 'act-zoom-16',
          type: 'SET_ZOOM',
          label: 'Auf 16 Bars zoomen',
          description: 'Optimale Phrasen-Übersicht für Intro / Build-Up.',
          params: { preset: '16_BARS' },
        },
        {
          id: 'act-zoom-8',
          type: 'SET_ZOOM',
          label: 'Auf 8 Bars zoomen',
          description: 'Detailierter Arbeitsbereich für Schnitt & Edit.',
          params: { preset: '8_BARS' },
        },
        {
          id: 'act-zoom-full',
          type: 'SET_ZOOM',
          label: 'Full Track',
          description: 'Gesamtübersicht.',
          params: { preset: 'FULL_TRACK' },
        },
      ],
    };
  }

  if (q.includes('cue') || q.includes('marker') || q.includes('hot')) {
    return {
      text: 'Ich kann am aktuellen Playhead einen Cue-Punkt setzen. Memory Cues werden für CDJ Memory Calls genutzt, Hot Cues für direktes Abfeuern.',
      actions: [
        {
          id: 'act-add-mem-cue',
          type: 'ADD_MEMORY_CUE',
          label: '+MEM Cue am Playhead setzen',
          description: 'Erstellt einen CDJ-kompatiblen Memory Cue.',
          params: {},
        },
      ],
    };
  }

  if (q.includes('grid') || q.includes('beatgrid') || q.includes('align') || q.includes('ausrichten')) {
    return {
      text: 'Ich kann das Beatgrid automatisch anhand der Transienten der Wellenform ausrichten oder Takt 1.1 exakt an den Playhead verankern.',
      actions: [
        {
          id: 'act-auto-align-grid',
          type: 'AUTO_ALIGN_GRID',
          label: 'Beatgrid automatisch ausrichten (Auto-Align)',
          description: 'Berechnet Transienten und korrigiert den Phasenoffset.',
          params: {},
        },
      ],
    };
  }

  if (q.includes('palette') || q.includes('clip') || q.includes('speichern') || q.includes('loop')) {
    return {
      text: ctx.hasSelection
        ? 'Die aktive Auswahl kann direkt als wiederverwendbarer Clip in die Palette kopiert werden:'
        : 'Wähle zuerst einen Takt oder Beat aus (oder nutze BEAT SELECT 4/8/16), um ihn in die Palette zu übernehmen.',
      actions: ctx.hasSelection
        ? [
            {
              id: 'act-add-palette',
              type: 'ADD_TO_PALETTE',
              label: 'Auswahl in Palette speichern',
              description: 'Erstellt einen neuen Clip in Deck B / Palette.',
              params: { name: `Clip (${ctx.selectionBeats || 16}B)` },
            },
          ]
        : [
            {
              id: 'act-sel-16',
              type: 'SELECT_RANGE',
              label: '16 Beats auswählen',
              description: 'Wählt 4 Takte ab Playhead aus.',
              params: { beats: 16 },
            },
          ],
    };
  }

  if (q.includes('3-band') || q.includes('band') || q.includes('rgb') || q.includes('blau') || q.includes('farbe')) {
    return {
      text: 'Du kannst zwischen den authentischen Rekordbox-Wellenformfarben wählen: 3-Band (High/Mid/Low getrennt), RGB oder klassisches Blau.',
      actions: [
        {
          id: 'act-wf-3band',
          type: 'SET_WAVEFORM_MODE',
          label: '3-Band Wellenform aktivieren',
          description: 'Zeigt Bässe, Mitten und Höhen spektral getrennt.',
          params: { mode: '3BAND' },
        },
        {
          id: 'act-wf-rgb',
          type: 'SET_WAVEFORM_MODE',
          label: 'RGB Wellenform aktivieren',
          description: 'Pioneer Rekordbox Standard-Farbprofil.',
          params: { mode: 'RGB' },
        },
      ],
    };
  }

  if (q.includes('quantize')) {
    return {
      text: `Quantize ist aktuell ${ctx.quantize ? 'aktiv' : 'deaktiviert'}. Bei aktivem Quantize rasten alle Schnitte, Cues und Loops exakt auf das Beatgrid ein.`,
      actions: [
        {
          id: 'act-toggle-quantize',
          type: 'SET_QUANTIZE',
          label: ctx.quantize ? 'Quantize deaktivieren' : 'Quantize aktivieren (Beatgrid Lock)',
          description: 'Schaltet Beatgrid-Einrastung um.',
          params: { enabled: !ctx.quantize },
        },
      ],
    };
  }

  // General DJ assistant advice
  return {
    text: `Hallo! Ich bin dein airdox DJ Smart Copilot. ${
      ctx.title ? `Aktuell ist der Track "${ctx.title}" (${ctx.bpm?.toFixed(2)} BPM, Key ${ctx.key}) geladen.` : 'Das Projekt ist aktuell leer. Du kannst eine Rekordbox XML oder Audiodatei importieren.'
    }\n\nWas möchtest du tun? Ich kann Takte zoomen, Cues setzen, Loops in die Palette übernehmen oder Bearbeitungsschritte selbstständig für dich anstoßen.`,
    actions: [
      {
        id: 'act-zoom-16',
        type: 'SET_ZOOM',
        label: 'Auf 16 Bars zoomen',
        description: 'Vollständige Phrasen-Übersicht.',
        params: { preset: '16_BARS' },
      },
      {
        id: 'act-add-mem-cue',
        type: 'ADD_MEMORY_CUE',
        label: '+MEM Cue setzen',
        description: 'Memory Cue am aktuellen Playhead.',
        params: {},
      },
      {
        id: 'act-toggle-quantize',
        type: 'SET_QUANTIZE',
        label: 'Quantize aktivieren',
        description: 'Schnittpunkte am Beatgrid einrasten.',
        params: { enabled: true },
      },
    ],
  };
}

startServer();
