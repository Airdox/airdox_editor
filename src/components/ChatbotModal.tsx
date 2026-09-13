/**
 * @license
 * airdox DJ Smart Copilot - Dedicated Pop-up Window & Visual Intelligence Center
 * High-resolution multi-turn conversation with Gemini, interactive track structure
 * visualization, energy curves, Camelot harmonic wheel, and direct software operations.
 */

import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import {
  Sparkles,
  Zap,
  RotateCcw,
  X,
  Play,
  Check,
  Layers,
  Mic,
  MicOff,
  Maximize2,
  Minimize2,
  Sliders,
  Flame,
  Target,
  Music,
  Send,
  Radio,
  Bookmark,
  Disc,
  Split,
  Eye,
  MessageSquare,
  HelpCircle,
  Clock,
  ArrowRight,
  TrendingUp,
  Volume2,
  Activity,
} from 'lucide-react';
import {
  ChatMessage,
  ChatbotAction,
  ChatbotModel,
  TrackEditorContext,
} from '../types/chatbot';
import { TrackModel, DataOrigin } from '../types/rekordbox';
import {
  analyzeTrackForMixIn,
  getCamelotInfo,
  formatTimePrecise,
  MixInPointCandidate,
  PhraseEnergySummary,
  createCueForMixIn,
} from '../audio/mixAnalysis';
import { logger } from '../utils/logger';

export interface ChatbotModalProps {
  isOpen: boolean;
  onClose: () => void;
  trackContext: TrackEditorContext;
  activeTrack: TrackModel | null;
  currentTime: number;
  audioBuffer?: AudioBuffer | null;
  onSeek: (time: number) => void;
  onExecuteAction: (action: ChatbotAction) => void;
  onSelectZoomPreset?: (preset: any) => void;
  onLoadDemoTrack?: () => void;
  onOpenXmlCollection?: () => void;
}

export type ViewMode = 'SPLIT' | 'VISUAL_ONLY' | 'CHAT_ONLY';
export type VisualTab = 'STRUCTURE' | 'WAVEFORM' | 'MIXIN' | 'CAMELOT' | 'SPECTRUM';

const DEFAULT_WELCOME_MESSAGE: ChatMessage = {
  id: 'msg-welcome',
  role: 'assistant',
  text: 'Willkommen beim airdox DJ Smart Copilot!\n\nIch habe deinen Track auf Energieprofile, Phrasen, Tonart und Mix-In Punkte analysiert. Nutze links die visuelle Track-Intelligenz oder gib mir direkt einen Schnitt- oder Steuerbefehl.',
  timestamp: Date.now(),
  actions: [
    {
      id: 'init-mixin',
      type: 'SET_MIX_IN_POINT',
      label: '🎯 Optimalen Mix-In Cue setzen',
      description: 'Verankert den berechneten Einstiegspunkt (Takt 17.1) direkt im Rekordbox-Deck.',
      params: { analyzeQuery: true },
    },
    {
      id: 'init-zoom-16',
      type: 'SET_ZOOM',
      label: 'Auf 16 Bars zoomen',
      description: 'Stellt das Hauptdeck auf das 16-Takte Bearbeitungsraster ein.',
      params: { preset: '16_BARS' },
    },
    {
      id: 'init-quantize',
      type: 'SET_QUANTIZE',
      label: 'Quantize aktivieren',
      description: 'Rastet alle Schnitte und Cues exakt auf Beat-Transienten ein.',
      params: { enabled: true },
    },
  ],
};

// Fallback synthetic track model so that visualizers are fully alive and educational even before a track is loaded!
function getSyntheticDemoTrack(): TrackModel {
  return {
    id: 'demo-synth-ref',
    title: "In for the Kill (Skream Let's Get Ravey Remix)",
    artist: 'La Roux',
    album: 'In for the Kill (Remixes)',
    bpm: 140.0,
    key: '8A',
    duration: 240,
    sampleRate: 44100,
    channels: 2,
    originalSha256: 'synthetic-demo-reference-hash',
    isOriginalUntouched: true,
    audioBuffer: null,
    loops: [],
    analysis: null,
    beatGrid: {
      firstBeat: 0.12,
      bpm: 140.0,
      meter: 4,
      beats: [
        { index: 1, time: 0.12, isBarStart: true, barNumber: 1, beatInBar: 1 },
        { index: 5, time: 1.834, isBarStart: true, barNumber: 2, beatInBar: 1 },
        { index: 9, time: 3.548, isBarStart: true, barNumber: 3, beatInBar: 1 },
        { index: 17, time: 6.976, isBarStart: true, barNumber: 5, beatInBar: 1 },
        { index: 33, time: 13.832, isBarStart: true, barNumber: 9, beatInBar: 1 },
        { index: 65, time: 27.544, isBarStart: true, barNumber: 17, beatInBar: 1 },
      ],
      origin: DataOrigin.GENERATED_FALLBACK,
    },
    cues: [
      { id: 'cue-1', type: 'HOT_CUE', letter: 'A', name: 'MIX-IN 16B', position: 13.832, color: '#00e5ff', origin: DataOrigin.GENERATED_FALLBACK },
      { id: 'cue-2', type: 'HOT_CUE', letter: 'B', name: 'MAIN DROP', position: 54.975, color: '#ff3366', origin: DataOrigin.GENERATED_FALLBACK },
      { id: 'cue-3', type: 'HOT_CUE', letter: 'C', name: 'BREAKDOWN', position: 109.832, color: '#ffaa00', origin: DataOrigin.GENERATED_FALLBACK },
      { id: 'cue-4', type: 'HOT_CUE', letter: 'D', name: 'OUTRO MIX', position: 192.14, color: '#00ff88', origin: DataOrigin.GENERATED_FALLBACK },
      { id: 'mem-1', type: 'MEMORY', name: 'START BEAT', position: 0.12, color: '#a855f7', origin: DataOrigin.GENERATED_FALLBACK },
      { id: 'mem-2', type: 'MEMORY', name: 'BASS CUT', position: 27.544, color: '#a855f7', origin: DataOrigin.GENERATED_FALLBACK },
    ],
    phrases: [
      { id: 'p-1', name: 'INTRO', startBar: 1, endBar: 16, startTime: 0, endTime: 27.42, color: '#3b82f6', origin: DataOrigin.GENERATED_FALLBACK },
      { id: 'p-2', name: 'UP', startBar: 17, endBar: 32, startTime: 27.42, endTime: 54.85, color: '#eab308', origin: DataOrigin.GENERATED_FALLBACK },
      { id: 'p-3', name: 'CHORUS', startBar: 33, endBar: 64, startTime: 54.85, endTime: 109.71, color: '#ef4444', origin: DataOrigin.GENERATED_FALLBACK },
      { id: 'p-4', name: 'BREAKDOWN', startBar: 65, endBar: 80, startTime: 109.71, endTime: 137.14, color: '#06b6d4', origin: DataOrigin.GENERATED_FALLBACK },
      { id: 'p-5', name: 'DROP', startBar: 81, endBar: 112, startTime: 137.14, endTime: 192.0, color: '#ec4899', origin: DataOrigin.GENERATED_FALLBACK },
      { id: 'p-6', name: 'OUTRO', startBar: 113, endBar: 128, startTime: 192.0, endTime: 240.0, color: '#8b5cf6', origin: DataOrigin.GENERATED_FALLBACK },
    ],
    workingSegments: [],
    origin: DataOrigin.GENERATED_FALLBACK,
  };
}

export const ChatbotModal: React.FC<ChatbotModalProps> = ({
  isOpen,
  onClose,
  trackContext,
  activeTrack,
  currentTime,
  audioBuffer,
  onSeek,
  onExecuteAction,
  onSelectZoomPreset,
  onLoadDemoTrack,
  onOpenXmlCollection,
}) => {
  const [messages, setMessages] = useState<ChatMessage[]>([DEFAULT_WELCOME_MESSAGE]);
  const [inputQuery, setInputQuery] = useState('');
  const [selectedModel, setSelectedModel] = useState<ChatbotModel>('gemini-3.5-flash');
  const [autoExecute, setAutoExecute] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [executedActionIds, setExecutedActionIds] = useState<Set<string>>(new Set());
  const [activeVisualTab, setActiveVisualTab] = useState<VisualTab>('STRUCTURE');
  const [viewMode, setViewMode] = useState<ViewMode>('SPLIT');
  const [isMaximized, setIsMaximized] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const speechRecognitionRef = useRef<any>(null);

  // Resolved track: either real active track or educational synthetic demo track
  const effectiveTrack = useMemo(() => {
    return activeTrack || getSyntheticDemoTrack();
  }, [activeTrack]);

  const isUsingSyntheticDemo = !activeTrack;

  // Compute live analysis report
  const mixReport = useMemo(() => {
    return analyzeTrackForMixIn(effectiveTrack);
  }, [effectiveTrack]);

  // Compute Camelot harmonic information
  const camelotInfo = useMemo(() => {
    return getCamelotInfo(effectiveTrack.key || trackContext.key || '8A');
  }, [effectiveTrack.key, trackContext.key]);

  // Keyboard shortcut listener for Esc
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen, onClose]);

  // Auto-scroll message list
  useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isOpen]);

  // Focus input field when modal opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 150);
      logger.info('CHATBOT', 'DJ Smart Copilot Pop-up Fenster geöffnet', {
        track: effectiveTrack.title,
        viewMode,
        activeTab: activeVisualTab,
      });
    }
  }, [isOpen]);

  // Web Speech API Voice Recognition setup
  useEffect(() => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      const recognizer = new SpeechRecognition();
      recognizer.continuous = false;
      recognizer.interimResults = false;
      recognizer.lang = 'de-DE';

      recognizer.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        setInputQuery(transcript);
        setIsListening(false);
        logger.info('CHATBOT', `Sprachbefehl erkannt: "${transcript}"`);
      };

      recognizer.onerror = (err: any) => {
        setIsListening(false);
        logger.warn('CHATBOT', 'Spracherkennungsfehler', err);
      };

      recognizer.onend = () => {
        setIsListening(false);
      };

      speechRecognitionRef.current = recognizer;
    }
  }, []);

  const toggleVoiceInput = () => {
    if (!speechRecognitionRef.current) {
      alert('Spracherkennung wird in diesem Browser nicht unterstützt.');
      return;
    }

    if (isListening) {
      speechRecognitionRef.current.stop();
      setIsListening(false);
    } else {
      try {
        speechRecognitionRef.current.start();
        setIsListening(true);
        logger.info('CHATBOT', 'Spracherkennung gestartet (Mikrofon aktiv)');
      } catch (e) {
        console.warn('SpeechRecognition start failed', e);
        setIsListening(false);
      }
    }
  };

  const handleSendMessage = async (textToSend?: string) => {
    const query = (textToSend || inputQuery).trim();
    if (!query || isLoading) return;

    logger.info('CHATBOT', `Copilot-Anfrage: "${query}"`, { model: selectedModel });

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      text: query,
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInputQuery('');
    setIsLoading(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [...messages, userMsg].slice(-10),
          model: selectedModel,
          trackContext: {
            ...trackContext,
            title: effectiveTrack.title,
            artist: effectiveTrack.artist,
            bpm: effectiveTrack.bpm,
            key: effectiveTrack.key,
            duration: effectiveTrack.duration,
            currentTime,
            mixInAnalysis: mixReport,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`Server antwortete mit Status ${response.status}`);
      }

      const data = await response.json();

      const assistantMsg: ChatMessage = {
        id: `asst-${Date.now()}`,
        role: 'assistant',
        text: data.text || 'Anfrage verarbeitet.',
        timestamp: Date.now(),
        actions: data.actions || [],
        model: data.model || selectedModel,
      };

      setMessages((prev) => [...prev, assistantMsg]);
      logger.info('CHATBOT', `Copilot Antwort erhalten (${assistantMsg.actions?.length || 0} Aktionen vorgeschlagen)`);

      // If auto-execute is enabled and actions were proposed, run the first action automatically
      if (autoExecute && data.actions && data.actions.length > 0) {
        const firstAct = data.actions[0];
        triggerAction(firstAct);
      }
    } catch (err: any) {
      logger.error('CHATBOT', 'Fehler bei Copilot-Anfrage', err);
      const errorMsg: ChatMessage = {
        id: `err-${Date.now()}`,
        role: 'system',
        text: `Kommunikationsfehler: ${err.message || 'Verbindung fehlgeschlagen'}`,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsLoading(false);
    }
  };

  const triggerAction = (action: ChatbotAction) => {
    setExecutedActionIds((prev) => new Set(prev).add(action.id));
    logger.info('CHATBOT', `Software-Aktion ausgeführt: "${action.label}" (${action.type})`, action.params);

    if (action.params?.analyzeQuery) {
      handleSendMessage(
        'Analysiere den aktuellen Track und schlage den optimalen Mix-In Punkt basierend auf Energie und Phrasen vor.'
      );
      return;
    }
    onExecuteAction(action);
  };

  const handleApplyCandidate = (candidate: MixInPointCandidate) => {
    const action: ChatbotAction = {
      id: `candidate-apply-${Date.now()}`,
      type: 'SET_MIX_IN_POINT',
      label: candidate.label,
      description: candidate.djMixingRationale,
      params: {
        bar: candidate.barNumber,
        time: candidate.timeSeconds,
        cueSlot: candidate.suggestedCueSlot === 'MEMORY' ? 'A' : candidate.suggestedCueSlot,
        cueName: `MIX-IN ${candidate.barNumber}.1`,
        selectBars: candidate.transitionLengthBars,
        zoomPreset: '16_BARS',
      },
    };
    triggerAction(action);
  };

  const handleClearHistory = () => {
    setMessages([DEFAULT_WELCOME_MESSAGE]);
    setExecutedActionIds(new Set());
    logger.info('CHATBOT', 'Copilot Chat-Historie zurückgesetzt');
  };

  const handleSwitchTab = (tab: VisualTab) => {
    setActiveVisualTab(tab);
    logger.debug('CHATBOT', `Visual-Tab gewechselt zu: ${tab}`);
  };

  const handleSwitchViewMode = (mode: ViewMode) => {
    setViewMode(mode);
    logger.debug('CHATBOT', `Ansichtsmodus gewechselt zu: ${mode}`);
  };

  if (!isOpen) return null;

  const duration = effectiveTrack.duration || 240;
  const playheadPercent = Math.min(100, Math.max(0, (currentTime / duration) * 100));
  const optimalTime = mixReport?.optimalPoint.timeSeconds || 30;
  const optimalPercent = Math.min(100, Math.max(0, (optimalTime / duration) * 100));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-2 sm:p-4 select-none animate-in fade-in duration-150">
      <div
        className={`w-full flex flex-col overflow-hidden text-neutral-200 bg-[#0a0c13] border border-[#22273a] shadow-[0_25px_70px_rgba(0,0,0,0.95)] transition-all ${
          isMaximized
            ? 'h-full max-w-none rounded-none'
            : 'max-w-[1400px] h-[92vh] max-h-[960px] rounded-xl'
        }`}
      >
        {/* 1. Modal Studio Title Bar */}
        <div className="h-13 bg-[#111420] border-b border-[#202538] px-4 flex items-center justify-between flex-shrink-0">
          {/* Logo & Title */}
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#0088ff] via-[#6366f1] to-[#a855f7] flex items-center justify-center text-white shadow-md shadow-blue-500/20">
              <Sparkles size={18} />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="text-white text-xs font-bold font-mono tracking-wider">
                  AIRDOX DJ SMART COPILOT
                </span>
                <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-[9px] font-mono font-bold flex items-center space-x-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  <span>ONLINE</span>
                </span>
              </div>
              <span className="text-[10px] text-neutral-400 font-mono">
                Visuelle Track-Intelligenz &amp; Autonome Rekordbox-Steuerung
              </span>
            </div>
          </div>

          {/* Center: Active Track Badge */}
          <div className="hidden lg:flex items-center space-x-2.5 px-3 py-1 rounded bg-[#161928] border border-[#272d44] text-[11px] font-mono">
            {isUsingSyntheticDemo ? (
              <span className="text-amber-400 font-bold flex items-center space-x-1">
                <Flame size={13} />
                <span>Demo-Referenztrack:</span>
              </span>
            ) : (
              <span className="text-emerald-400 font-bold">🎵 Deck-Track:</span>
            )}
            <span className="text-[#00e5ff] font-semibold truncate max-w-[240px]" title={effectiveTrack.title}>
              {effectiveTrack.title}
            </span>
            <span className="text-neutral-500">|</span>
            <span className="text-amber-300 font-bold">{effectiveTrack.bpm.toFixed(1)} BPM</span>
            <span className="text-neutral-500">|</span>
            <span className="px-1.5 py-0.2 rounded bg-blue-500/20 text-blue-300 font-bold border border-blue-500/30">
              {effectiveTrack.key || '8A'}
            </span>
          </div>

          {/* Right Window Controls & View Mode Toggles */}
          <div className="flex items-center space-x-2">
            {/* View Mode Selector: Split, Visual Only, Chat Only */}
            <div className="flex items-center bg-[#0d0f17] p-0.5 rounded-md border border-[#21263a]">
              <button
                onClick={() => handleSwitchViewMode('SPLIT')}
                className={`px-2 py-1 rounded text-[10px] font-mono font-bold flex items-center space-x-1 transition-colors ${
                  viewMode === 'SPLIT'
                    ? 'bg-[#0088ff] text-white shadow-sm'
                    : 'text-neutral-400 hover:text-white'
                }`}
                title="Splitscreen (Visualisierung + Chat)"
              >
                <Split size={12} />
                <span className="hidden sm:inline">Split</span>
              </button>
              <button
                onClick={() => handleSwitchViewMode('VISUAL_ONLY')}
                className={`px-2 py-1 rounded text-[10px] font-mono font-bold flex items-center space-x-1 transition-colors ${
                  viewMode === 'VISUAL_ONLY'
                    ? 'bg-[#0088ff] text-white shadow-sm'
                    : 'text-neutral-400 hover:text-white'
                }`}
                title="Nur Visualisierung (Maximale Breite für Wellenform & Analyse)"
              >
                <Eye size={12} />
                <span className="hidden sm:inline">Visuals</span>
              </button>
              <button
                onClick={() => handleSwitchViewMode('CHAT_ONLY')}
                className={`px-2 py-1 rounded text-[10px] font-mono font-bold flex items-center space-x-1 transition-colors ${
                  viewMode === 'CHAT_ONLY'
                    ? 'bg-[#0088ff] text-white shadow-sm'
                    : 'text-neutral-400 hover:text-white'
                }`}
                title="Nur Chat-Konversation"
              >
                <MessageSquare size={12} />
                <span className="hidden sm:inline">Chat</span>
              </button>
            </div>

            {/* Maximize Toggle */}
            <button
              onClick={() => setIsMaximized(!isMaximized)}
              className="p-1.5 rounded bg-[#161928] hover:bg-[#22273d] text-neutral-400 hover:text-white transition-colors cursor-pointer border border-[#272d44]"
              title={isMaximized ? 'Fenster verkleinern' : 'Fenster maximieren (Vollbild)'}
            >
              {isMaximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>

            {/* Close Button */}
            <button
              onClick={onClose}
              className="p-1.5 rounded bg-[#1f151e] hover:bg-red-600/80 text-neutral-400 hover:text-white transition-colors cursor-pointer border border-[#3d242e]"
              title="Schließen (Esc)"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* 2. Modal Sub-Header: Global Controls & Model Picker */}
        <div className="h-10 bg-[#0e111a] border-b border-[#1b2030] px-4 flex items-center justify-between text-xs font-mono flex-shrink-0">
          <div className="flex items-center space-x-3">
            {/* Visual Tabs Navigation */}
            {viewMode !== 'CHAT_ONLY' && (
              <div className="flex items-center space-x-1">
                {[
                  { id: 'STRUCTURE', label: 'Phrasen & Energie', icon: Layers },
                  { id: 'WAVEFORM', label: 'Wellenform & Cues', icon: Activity },
                  { id: 'MIXIN', label: 'Mix-In Punkte', icon: Target },
                  { id: 'CAMELOT', label: 'Camelot Rad', icon: Disc },
                  { id: 'SPECTRUM', label: '3-Band Frequenz', icon: Sliders },
                ].map((tab) => {
                  const Icon = tab.icon;
                  const isActive = activeVisualTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => handleSwitchTab(tab.id as VisualTab)}
                      className={`px-2.5 py-1 rounded text-[11px] font-bold flex items-center space-x-1.5 transition-colors cursor-pointer border ${
                        isActive
                          ? 'bg-[#0088ff]/20 text-[#00c3ff] border-[#0088ff]/50 shadow-sm'
                          : 'bg-transparent text-neutral-400 hover:text-neutral-200 border-transparent hover:border-[#272d42]'
                      }`}
                    >
                      <Icon size={13} />
                      <span>{tab.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex items-center space-x-3">
            {/* Model Selector */}
            <div className="flex items-center space-x-1.5">
              <span className="text-[10px] text-neutral-400">Modell:</span>
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value as ChatbotModel)}
                className="bg-[#141724] border border-[#272e42] rounded px-2 py-0.5 text-[11px] text-white focus:outline-none focus:border-[#0088ff]"
              >
                <option value="gemini-3.5-flash">Gemini 3.5 Flash (Empfohlen)</option>
                <option value="gemini-3.1-flash-lite">Gemini 3.1 Flash-Lite (Ultraschnell)</option>
                <option value="gemini-3.1-pro-preview">Gemini 3.1 Pro (Tiefe Analyse)</option>
              </select>
            </div>

            {/* Auto Execute Toggle */}
            <label className="flex items-center space-x-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={autoExecute}
                onChange={(e) => setAutoExecute(e.target.checked)}
                className="rounded border-[#292f44] text-[#0088ff] focus:ring-0 cursor-pointer"
              />
              <span className="text-[10.5px] text-neutral-300">Auto-Execute</span>
            </label>

            {/* Clear History */}
            <button
              onClick={handleClearHistory}
              className="p-1 text-neutral-500 hover:text-white transition-colors cursor-pointer"
              title="Chat-Verlauf löschen"
            >
              <RotateCcw size={13} />
            </button>
          </div>
        </div>

        {/* 3. Modal Main Content Body */}
        <div className="flex-1 min-h-0 flex overflow-hidden">
          {/* LEFT: VISUAL TRACK INTELLIGENCE CANVAS (Visible in SPLIT or VISUAL_ONLY) */}
          {viewMode !== 'CHAT_ONLY' && (
            <div
              className={`${
                viewMode === 'VISUAL_ONLY' ? 'w-full' : 'w-full lg:w-[58%] border-r border-[#1c2030]'
              } flex flex-col bg-[#0b0d14] min-h-0 overflow-y-auto`}
            >
              {/* If using synthetic track, show quick start banner to load real track */}
              {isUsingSyntheticDemo && (
                <div className="m-3 p-2.5 bg-gradient-to-r from-amber-950/40 via-blue-950/30 to-[#0e1220] border border-amber-500/30 rounded-lg flex items-center justify-between">
                  <div className="flex items-center space-x-2.5">
                    <Flame size={16} className="text-amber-400 flex-shrink-0" />
                    <div>
                      <div className="text-xs font-bold text-white">
                        Interaktive Vorschau mit EDM-Referenztrack
                      </div>
                      <div className="text-[10px] text-neutral-400">
                        Aktuell ist kein Deck-Track geladen. Du kannst hier alle Visualisierungen testen oder einen echten Track laden:
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center space-x-2">
                    {onLoadDemoTrack && (
                      <button
                        onClick={onLoadDemoTrack}
                        className="px-2.5 py-1 bg-amber-500 hover:bg-amber-400 text-black font-bold text-[11px] rounded transition-colors shadow-sm cursor-pointer whitespace-nowrap"
                      >
                        Demo-Track laden
                      </button>
                    )}
                    {onOpenXmlCollection && (
                      <button
                        onClick={onOpenXmlCollection}
                        className="px-2.5 py-1 bg-[#1a2032] hover:bg-[#27304b] border border-[#333d5e] text-white font-bold text-[11px] rounded transition-colors cursor-pointer whitespace-nowrap"
                      >
                        XML öffnen
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* TAB 1: STRUCTURE & ENERGY (Rekordbox PSSI) */}
              {activeVisualTab === 'STRUCTURE' && (
                <div className="p-4 space-y-4 flex-1">
                  {/* Phrase Timeline Bar */}
                  <div className="p-3 bg-[#111420] border border-[#202538] rounded-lg space-y-2">
                    <div className="flex items-center justify-between text-xs font-mono">
                      <span className="text-white font-bold flex items-center space-x-1.5">
                        <Layers size={14} className="text-[#00e5ff]" />
                        <span>Rekordbox PSSI Phrasen-Struktur</span>
                      </span>
                      <span className="text-[11px] text-neutral-400">
                        Playhead: {formatTimePrecise(currentTime)} / {formatTimePrecise(duration)}
                      </span>
                    </div>

                    {/* Interactive Phrase Ribbon */}
                    <div className="relative h-10 w-full rounded-md bg-[#0a0c12] border border-[#1e2336] overflow-hidden flex cursor-pointer">
                      {mixReport?.phraseEnergies.map((p, idx) => {
                        const durationSeconds = p.endTime - p.startTime;
                        const widthPct = Math.max(2, (durationSeconds / duration) * 100);
                        const isCurrent = currentTime >= p.startTime && currentTime <= p.endTime;
                        return (
                          <div
                            key={idx}
                            style={{
                              width: `${widthPct}%`,
                              backgroundColor: `${p.color}25`,
                              borderColor: p.color,
                            }}
                            onClick={() => onSeek(p.startTime)}
                            className={`h-full border-r relative flex flex-col justify-center px-1 transition-all hover:brightness-125 ${
                              isCurrent ? 'ring-2 ring-white/80 z-10' : ''
                            }`}
                            title={`${p.name}: Takt ${p.startBar}-${p.endBar} (${formatTimePrecise(p.startTime)} - ${formatTimePrecise(p.endTime)}) - Energie ${p.energyPercent}%`}
                          >
                            <span
                              style={{ color: p.color }}
                              className="text-[9.5px] font-bold truncate leading-tight"
                            >
                              {p.name}
                            </span>
                            <span className="text-[8px] text-neutral-400 font-mono">
                              B.{p.startBar}
                            </span>
                          </div>
                        );
                      })}

                      {/* Live Playhead Line */}
                      <div
                        style={{ left: `${playheadPercent}%` }}
                        className="absolute top-0 bottom-0 w-0.5 bg-white shadow-[0_0_8px_white] pointer-events-none z-20"
                      />

                      {/* Optimal Mix-In Marker */}
                      <div
                        style={{ left: `${optimalPercent}%` }}
                        className="absolute top-0 bottom-0 w-1 bg-[#00ff88] shadow-[0_0_10px_#00ff88] pointer-events-none z-20"
                        title={`Optimaler Mix-In Punkt: Takt ${mixReport?.optimalPoint.barNumber}.1`}
                      />
                    </div>

                    <div className="flex items-center justify-between text-[10px] text-neutral-400 font-mono">
                      <span>Takt 1.1</span>
                      <span className="text-[#00ff88] font-bold flex items-center space-x-1">
                        <Target size={11} />
                        <span>Mix-In Target: Takt {mixReport?.optimalPoint.barNumber}.1 ({formatTimePrecise(optimalTime)})</span>
                      </span>
                      <span>Ende ({formatTimePrecise(duration)})</span>
                    </div>
                  </div>

                  {/* Energy Contour SVG Area Curve */}
                  <div className="p-3 bg-[#111420] border border-[#202538] rounded-lg space-y-2">
                    <div className="flex items-center justify-between text-xs font-mono">
                      <span className="text-white font-bold flex items-center space-x-1.5">
                        <TrendingUp size={14} className="text-amber-400" />
                        <span>Dynamische Track-Energiekurve (0 - 100%)</span>
                      </span>
                      <span className="text-[10px] text-neutral-400">
                        Peak: {mixReport?.optimalPoint.energyPercent || 85}% Energie
                      </span>
                    </div>

                    <div className="h-28 w-full bg-[#080a10] rounded-md border border-[#1a1e2c] relative overflow-hidden flex items-end">
                      <svg className="w-full h-full" preserveAspectRatio="none" viewBox="0 0 1000 100">
                        <defs>
                          <linearGradient id="energyGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                            <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.7" />
                            <stop offset="60%" stopColor="#3b82f6" stopOpacity="0.4" />
                            <stop offset="100%" stopColor="#1e1b4b" stopOpacity="0.05" />
                          </linearGradient>
                        </defs>

                        {/* Background Energy Curve */}
                        {mixReport && (
                          <path
                            d={generateSvgAreaPath(mixReport.phraseEnergies, duration)}
                            fill="url(#energyGrad)"
                            stroke="#f59e0b"
                            strokeWidth="2"
                          />
                        )}

                        {/* Optimal Mix-In Vertical Pin */}
                        <line
                          x1={optimalPercent * 10}
                          y1="0"
                          x2={optimalPercent * 10}
                          y2="100"
                          stroke="#00ff88"
                          strokeWidth="2.5"
                          strokeDasharray="3 3"
                        />
                      </svg>

                      {/* Playhead in Energy Curve */}
                      <div
                        style={{ left: `${playheadPercent}%` }}
                        className="absolute top-0 bottom-0 w-0.5 bg-white shadow-[0_0_6px_white] pointer-events-none"
                      />
                    </div>
                  </div>

                  {/* DJ Mixing Strategy Advice Card */}
                  {mixReport && (
                    <div className="p-3.5 bg-gradient-to-r from-blue-950/40 to-[#121524] border border-blue-500/30 rounded-lg space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-2">
                          <Zap size={15} className="text-amber-400" />
                          <span className="text-xs font-bold text-white uppercase tracking-wider">
                            DJ Misch-Strategie &amp; Phrasenübergang
                          </span>
                        </div>
                        <button
                          onClick={() => handleApplyCandidate(mixReport.optimalPoint)}
                          className="px-2.5 py-1 bg-[#0088ff] hover:bg-[#0077ee] text-white font-mono font-bold text-[10.5px] rounded transition-colors shadow-sm cursor-pointer"
                        >
                          1-Click Mix-In Cue setzen
                        </button>
                      </div>

                      <p className="text-xs text-neutral-300 leading-relaxed">
                        {mixReport.optimalPoint.djMixingRationale}
                      </p>

                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 text-[11px] font-mono">
                        <div className="p-2 rounded bg-[#0b0e18] border border-[#1c2234]">
                          <span className="text-neutral-400 block text-[9.5px]">Einstiegs-Takt</span>
                          <span className="text-white font-bold">Takt {mixReport.optimalPoint.barNumber}.1</span>
                        </div>
                        <div className="p-2 rounded bg-[#0b0e18] border border-[#1c2234]">
                          <span className="text-neutral-400 block text-[9.5px]">Einstiegs-Zeit</span>
                          <span className="text-[#00e5ff] font-bold">{formatTimePrecise(mixReport.optimalPoint.timeSeconds)}</span>
                        </div>
                        <div className="p-2 rounded bg-[#0b0e18] border border-[#1c2234]">
                          <span className="text-neutral-400 block text-[9.5px]">Übergangslänge</span>
                          <span className="text-amber-300 font-bold">{mixReport.optimalPoint.transitionLengthBars} Takte ({mixReport.optimalPoint.transitionLengthBars * 4} Beats)</span>
                        </div>
                        <div className="p-2 rounded bg-[#0b0e18] border border-[#1c2234]">
                          <span className="text-neutral-400 block text-[9.5px]">Energie-Match</span>
                          <span className="text-emerald-400 font-bold">{mixReport.optimalPoint.recommendationScore}% Match</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* TAB 2: INTERACTIVE WAVEFORM & CUES */}
              {activeVisualTab === 'WAVEFORM' && (
                <div className="p-4 space-y-4 flex-1">
                  <div className="p-3 bg-[#111420] border border-[#202538] rounded-lg space-y-3">
                    <div className="flex items-center justify-between text-xs font-mono">
                      <span className="text-white font-bold flex items-center space-x-1.5">
                        <Activity size={14} className="text-[#00e5ff]" />
                        <span>Interaktive Wellenform &amp; Cue-Punkte</span>
                      </span>
                      <span className="text-[10px] text-neutral-400">
                        Klicke auf die Wellenform zum präzisen Scrubben
                      </span>
                    </div>

                    {/* Waveform Canvas Simulation */}
                    <div
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        const clickX = e.clientX - rect.left;
                        const pct = Math.max(0, Math.min(1, clickX / rect.width));
                        onSeek(pct * duration);
                      }}
                      className="h-32 w-full bg-[#07090f] rounded-md border border-[#1e2336] relative overflow-hidden cursor-crosshair group"
                    >
                      {/* Grid Bars */}
                      <div className="absolute inset-0 flex justify-between pointer-events-none opacity-20">
                        {Array.from({ length: 16 }).map((_, i) => (
                          <div key={i} className="h-full border-r border-neutral-400" />
                        ))}
                      </div>

                      {/* Render Waveform Bars */}
                      <WaveformBars duration={duration} audioBuffer={audioBuffer} />

                      {/* Hot Cues Pins */}
                      {effectiveTrack.cues?.filter(c => c.type === 'HOT_CUE').map((cue) => {
                        const cuePct = (cue.position / duration) * 100;
                        return (
                          <div
                            key={cue.id}
                            style={{ left: `${cuePct}%` }}
                            className="absolute top-0 bottom-0 w-0.5 z-20 pointer-events-none"
                          >
                            <div
                              style={{ backgroundColor: cue.color || '#00e5ff' }}
                              className="w-4 h-4 -ml-2 rounded-xs flex items-center justify-center text-[9px] font-black text-black shadow-md"
                            >
                              {cue.letter || 'A'}
                            </div>
                            <div
                              style={{ backgroundColor: cue.color || '#00e5ff' }}
                              className="h-full w-0.5 opacity-75"
                            />
                          </div>
                        );
                      })}

                      {/* Playhead */}
                      <div
                        style={{ left: `${playheadPercent}%` }}
                        className="absolute top-0 bottom-0 w-0.5 bg-white shadow-[0_0_10px_white] z-30 pointer-events-none"
                      >
                        <div className="w-2.5 h-2.5 -ml-1 bg-white rounded-full shadow-md" />
                      </div>
                    </div>

                    {/* Quick Cue & Zoom Actions */}
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                      <div className="flex items-center space-x-2">
                        <button
                          onClick={() =>
                            triggerAction({
                              id: `act-cue-a-${Date.now()}`,
                              type: 'ADD_CUE',
                              label: 'Hot Cue A setzen',
                              params: { slot: 'A', time: currentTime, name: 'HOT CUE A' },
                            })
                          }
                          className="px-2.5 py-1 bg-emerald-600/30 hover:bg-emerald-600/50 border border-emerald-500/50 text-emerald-300 rounded text-[11px] font-bold font-mono transition-colors cursor-pointer"
                        >
                          + Hot Cue A
                        </button>
                        <button
                          onClick={() =>
                            triggerAction({
                              id: `act-mem-${Date.now()}`,
                              type: 'ADD_MEMORY_CUE',
                              label: 'Memory Cue setzen',
                              params: { time: currentTime, name: 'MEM CUE' },
                            })
                          }
                          className="px-2.5 py-1 bg-purple-600/30 hover:bg-purple-600/50 border border-purple-500/50 text-purple-300 rounded text-[11px] font-bold font-mono transition-colors cursor-pointer"
                        >
                          + Memory Cue
                        </button>
                        <button
                          onClick={() =>
                            triggerAction({
                              id: `act-loop-16-${Date.now()}`,
                              type: 'SELECT_RANGE',
                              label: '16 Takte Loop auswählen',
                              params: { selectBars: 16 },
                            })
                          }
                          className="px-2.5 py-1 bg-blue-600/30 hover:bg-blue-600/50 border border-blue-500/50 text-blue-300 rounded text-[11px] font-bold font-mono transition-colors cursor-pointer"
                        >
                          🔄 16-Takte Loop
                        </button>
                      </div>

                      <div className="flex items-center space-x-1.5 text-xs font-mono">
                        <span className="text-neutral-400 text-[10px]">Zoom:</span>
                        {['16_BARS', '32_BARS', 'FULL_TRACK'].map((p) => (
                          <button
                            key={p}
                            onClick={() =>
                              triggerAction({
                                id: `act-zoom-${p}-${Date.now()}`,
                                type: 'SET_ZOOM',
                                label: `Zoom ${p}`,
                                params: { preset: p },
                              })
                            }
                            className="px-2 py-0.5 bg-[#171a28] hover:bg-[#23283d] text-neutral-300 rounded border border-[#272d42] text-[10px] cursor-pointer"
                          >
                            {p.replace('_', ' ')}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Hot Cues Overview List */}
                  <div className="space-y-2">
                    <span className="text-xs font-bold uppercase tracking-wider text-white">
                      Gespeicherte Cue-Punkte ({effectiveTrack.cues?.filter(c => c.type === 'HOT_CUE').length || 0} Hot Cues)
                    </span>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {effectiveTrack.cues?.filter(c => c.type === 'HOT_CUE').map((c) => (
                        <div
                          key={c.id}
                          onClick={() => onSeek(c.position)}
                          className="p-2.5 rounded-lg bg-[#111420] border border-[#202538] hover:border-[#353d5c] transition-colors flex items-center justify-between cursor-pointer"
                        >
                          <div className="flex items-center space-x-2.5">
                            <span
                              style={{ backgroundColor: c.color || '#00e5ff' }}
                              className="w-6 h-6 rounded flex items-center justify-center font-bold text-xs text-black font-mono"
                            >
                              {c.letter || 'A'}
                            </span>
                            <div>
                              <span className="text-xs font-bold text-white block">
                                {c.name || `Hot Cue ${c.letter || 'A'}`}
                              </span>
                              <span className="text-[10px] text-neutral-400 font-mono">
                                Zeit: {formatTimePrecise(c.position)}
                              </span>
                            </div>
                          </div>
                          <span className="text-[10px] text-blue-400 font-mono font-semibold">
                            Anspringen &gt;
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 3: MIX-IN CANDIDATES */}
              {activeVisualTab === 'MIXIN' && (
                <div className="p-4 space-y-3 flex-1">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-xs font-bold text-white uppercase tracking-wider block">
                        Intelligente Mix-In Einstiegspunkte
                      </span>
                      <span className="text-[11px] text-neutral-400">
                        Berechnet anhand von Phrasen-Transienten, Energiedynamik und Bass-Präsenz.
                      </span>
                    </div>
                  </div>

                  <div className="space-y-2.5">
                    {mixReport?.allCandidates.map((cand, idx) => (
                      <div
                        key={cand.id}
                        className={`p-3.5 rounded-lg border transition-all ${
                          idx === 0
                            ? 'bg-gradient-to-r from-emerald-950/30 to-[#121524] border-emerald-500/50 shadow-md'
                            : 'bg-[#111420] border-[#202538] hover:border-[#333b58]'
                        }`}
                      >
                        <div className="flex items-start justify-between">
                          <div className="space-y-1">
                            <div className="flex items-center space-x-2">
                              {idx === 0 && (
                                <span className="px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-[9px] font-bold font-mono">
                                  BESTER MATCH
                                </span>
                              )}
                              <span className="text-xs font-bold text-white">
                                {cand.label} (Takt {cand.barNumber}.1)
                              </span>
                              <span className="text-[10px] text-neutral-400 font-mono">
                                @ {formatTimePrecise(cand.timeSeconds)}
                              </span>
                            </div>
                            <p className="text-xs text-neutral-300 leading-snug">
                              {cand.djMixingRationale}
                            </p>
                          </div>

                          <div className="flex items-center space-x-2 flex-shrink-0 ml-3">
                            <button
                              onClick={() => onSeek(cand.timeSeconds)}
                              className="px-2.5 py-1 bg-[#181d2e] hover:bg-[#252c46] text-neutral-200 rounded text-xs font-mono font-bold transition-colors cursor-pointer"
                            >
                              Anhören
                            </button>
                            <button
                              onClick={() => handleApplyCandidate(cand)}
                              className="px-3 py-1 bg-[#0088ff] hover:bg-[#0077ee] text-white rounded text-xs font-mono font-bold transition-colors shadow-sm cursor-pointer"
                            >
                              Als Mix-In Cue setzen
                            </button>
                          </div>
                        </div>

                        {/* Suitability stats */}
                        <div className="grid grid-cols-3 gap-2 mt-2 pt-2 border-t border-[#1b2032] text-[10px] font-mono text-neutral-400">
                          <div>
                            Eignung:{' '}
                            <strong className="text-emerald-400">{cand.recommendationScore}%</strong>
                          </div>
                          <div>
                            Übergangslänge:{' '}
                            <strong className="text-white">{cand.transitionLengthBars} Bars</strong>
                          </div>
                          <div>
                            Energie:{' '}
                            <strong className="text-amber-400">{cand.energyPercent}%</strong>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* TAB 4: CAMELOT HARMONIC WHEEL */}
              {activeVisualTab === 'CAMELOT' && (
                <div className="p-4 space-y-4 flex-1">
                  {/* Wheel & Current Key Header */}
                  <div className="p-3.5 bg-[#111420] border border-[#202538] rounded-lg flex flex-col md:flex-row items-center justify-between gap-4">
                    <div className="space-y-1">
                      <div className="flex items-center space-x-2">
                        <Disc size={16} className="text-[#00e5ff]" />
                        <span className="text-xs font-bold text-white uppercase tracking-wider">
                          Camelot Harmonik-Rad &amp; Tonarten-Matrix
                        </span>
                      </div>
                      <p className="text-xs text-neutral-400 leading-relaxed max-w-lg">
                        Harmonisches Mischen verhindert Dissonanzen. Wechsle im Uhrzeigersinn (+1) für Energieanstieg, gegen den Uhrzeigersinn (-1) für sanftes Ausklingen, oder zwischen A (Moll) und B (Dur).
                      </p>
                    </div>

                    {/* Active Key Badge */}
                    <div className="p-3 rounded-lg bg-[#161a28] border border-[#282f48] flex items-center space-x-3 flex-shrink-0">
                      <div className="w-12 h-12 rounded-lg bg-blue-600/30 border border-blue-400/50 flex flex-col items-center justify-center font-mono font-bold text-white">
                        <span className="text-lg text-[#00e5ff]">{camelotInfo.code}</span>
                        <span className="text-[9px] text-neutral-400">{camelotInfo.musicalKey}</span>
                      </div>
                      <div>
                        <span className="text-xs font-bold text-white block">Aktuelle Tonart</span>
                        <span className="text-[10.5px] text-neutral-400">
                          {camelotInfo.code.endsWith('A') ? 'Moll-Tonleiter' : 'Dur-Tonleiter'}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Circular SVG Camelot Wheel Visualizer */}
                  <div className="p-4 bg-[#0a0c12] border border-[#1c2132] rounded-lg flex flex-col items-center justify-center">
                    <CamelotWheelSvg
                      activeCode={camelotInfo.code}
                      onSelectKey={(key) => {
                        handleSendMessage(
                          `Erkläre mir die DJ-Mischtechnik von meiner aktuellen Tonart ${camelotInfo.code} zu ${key}.`
                        );
                      }}
                    />
                    <span className="text-[10px] text-neutral-500 font-mono mt-2">
                      Klicke auf eine Tonart im Rad, um Copilot nach Misch-Tipps zu fragen
                    </span>
                  </div>

                  {/* Harmonic Match Cards */}
                  <div className="space-y-2">
                    <span className="text-xs font-bold uppercase tracking-wider text-white">
                      Harmonisch kompatible Übergänge für {camelotInfo.code}
                    </span>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      {camelotInfo.matches.map((m) => (
                        <div
                          key={m.code}
                          className="p-3 rounded-lg bg-[#111420] border border-[#202538] flex items-start space-x-3 hover:border-[#313955] transition-colors"
                        >
                          <div
                            style={{ borderColor: `${m.badgeColor}60`, backgroundColor: `${m.badgeColor}20` }}
                            className="w-10 h-10 rounded-lg border flex flex-col items-center justify-center font-mono font-bold text-white flex-shrink-0"
                          >
                            <span style={{ color: m.badgeColor }} className="text-sm">
                              {m.code}
                            </span>
                            <span className="text-[8px] text-neutral-400">{m.musicalKey}</span>
                          </div>
                          <div className="space-y-0.5">
                            <span className="text-xs font-bold text-white block">{m.label}</span>
                            <p className="text-[11px] text-neutral-400 leading-snug">
                              {m.description}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 5: 3-BAND FREQUENCY SPECTRUM */}
              {activeVisualTab === 'SPECTRUM' && (
                <div className="p-4 space-y-4 flex-1">
                  <div className="p-3.5 bg-[#111420] border border-[#202538] rounded-lg space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-2">
                        <Sliders size={15} className="text-[#00e5ff]" />
                        <span className="text-xs font-bold uppercase tracking-wider text-white">
                          Dreifrequenz-Frequenzbalance (Rekordbox 3-Band Waveform)
                        </span>
                      </div>
                      <span className="text-[10px] text-neutral-400 font-mono">
                        Spektrale Energieverteilung
                      </span>
                    </div>

                    {/* 3-Band Visual Bars */}
                    <div className="space-y-3 pt-1">
                      {/* Low Band */}
                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-xs font-mono">
                          <span className="text-blue-400 font-bold flex items-center space-x-1.5">
                            <span className="w-2.5 h-2.5 rounded-full bg-[#0088ff]" />
                            <span>LOW / BASS (20 Hz - 250 Hz)</span>
                          </span>
                          <span className="text-white font-bold">
                            {mixReport?.optimalPoint.bassEnergyPercent || 55}%
                          </span>
                        </div>
                        <div className="h-3 rounded-full bg-[#0a0c12] border border-[#1e2336] overflow-hidden p-0.5">
                          <div
                            style={{ width: `${mixReport?.optimalPoint.bassEnergyPercent || 55}%` }}
                            className="h-full rounded-full bg-gradient-to-r from-blue-600 to-cyan-400 shadow-sm"
                          />
                        </div>
                        <span className="text-[10px] text-neutral-400">
                          Sub-Bässe, Kickdrum-Fundament und Bassline-Druck.
                        </span>
                      </div>

                      {/* Mid Band */}
                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-xs font-mono">
                          <span className="text-amber-400 font-bold flex items-center space-x-1.5">
                            <span className="w-2.5 h-2.5 rounded-full bg-[#f59e0b]" />
                            <span>MID / VOCALS (250 Hz - 4 kHz)</span>
                          </span>
                          <span className="text-white font-bold">
                            {mixReport?.optimalPoint.midEnergyPercent || 32}%
                          </span>
                        </div>
                        <div className="h-3 rounded-full bg-[#0a0c12] border border-[#1e2336] overflow-hidden p-0.5">
                          <div
                            style={{ width: `${mixReport?.optimalPoint.midEnergyPercent || 32}%` }}
                            className="h-full rounded-full bg-gradient-to-r from-amber-600 to-yellow-400 shadow-sm"
                          />
                        </div>
                        <span className="text-[10px] text-neutral-400">
                          Gesang, Synth-Hooks, Snare-Drums und melodische Führung.
                        </span>
                      </div>

                      {/* High Band */}
                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-xs font-mono">
                          <span className="text-neutral-200 font-bold flex items-center space-x-1.5">
                            <span className="w-2.5 h-2.5 rounded-full bg-neutral-200" />
                            <span>HIGH / AIR (4 kHz - 20 kHz)</span>
                          </span>
                          <span className="text-white font-bold">
                            {mixReport?.optimalPoint.highEnergyPercent || 18}%
                          </span>
                        </div>
                        <div className="h-3 rounded-full bg-[#0a0c12] border border-[#1e2336] overflow-hidden p-0.5">
                          <div
                            style={{ width: `${mixReport?.optimalPoint.highEnergyPercent || 18}%` }}
                            className="h-full rounded-full bg-gradient-to-r from-neutral-400 to-white shadow-sm"
                          />
                        </div>
                        <span className="text-[10px] text-neutral-400">
                          Hi-Hats, Ride-Becken, Rauschen und Transienten-Definition.
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Switch to 3-Band Mode button */}
                  <div className="p-3.5 bg-[#11131e] border border-[#21263c] rounded-lg flex items-center justify-between">
                    <div className="space-y-0.5">
                      <span className="text-xs font-bold text-white block">
                        3-Band Wellenform-Modus im Deck aktivieren
                      </span>
                      <p className="text-[11px] text-neutral-400">
                        Schaltet das Hauptdeck auf die dreifarbige Rekordbox-Frequenzanzeige um.
                      </p>
                    </div>
                    <button
                      onClick={() =>
                        triggerAction({
                          id: `act-3band-${Date.now()}`,
                          type: 'SET_WAVEFORM_MODE',
                          label: '3-Band Wellenform',
                          params: { mode: '3BAND' },
                        })
                      }
                      className="px-3 py-1.5 bg-[#0088ff] hover:bg-[#0077ee] text-white rounded text-xs font-bold font-mono transition-colors shadow-sm cursor-pointer"
                    >
                      Umschalten (3-Band)
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* RIGHT: CONVERSATIONAL AI COPILOT (Visible in SPLIT or CHAT_ONLY) */}
          {viewMode !== 'VISUAL_ONLY' && (
            <div
              className={`${
                viewMode === 'CHAT_ONLY' ? 'w-full' : 'flex-1'
              } flex flex-col bg-[#0d0f17] min-h-0`}
            >
              {/* Thread Header */}
              <div className="px-4 py-2 bg-[#121420] border-b border-[#1c2030] flex items-center justify-between text-xs font-mono">
                <span className="text-white font-bold flex items-center space-x-1.5">
                  <Sparkles size={13} className="text-[#00a2ff]" />
                  <span>COPILOT KONVERSATION</span>
                </span>
                <span className="text-neutral-500 text-[10px]">
                  {messages.length - 1} {messages.length - 1 === 1 ? 'Nachricht' : 'Nachrichten'}
                </span>
              </div>

              {/* Message Thread List */}
              <div className="flex-1 overflow-y-auto p-4 space-y-3.5 font-sans text-xs">
                {messages.map((msg) => {
                  const isUser = msg.role === 'user';
                  const isSystem = msg.role === 'system';

                  if (isSystem) {
                    return (
                      <div
                        key={msg.id}
                        className="flex items-center space-x-2 p-2.5 rounded bg-red-950/30 border border-red-800/40 text-red-300 text-xs"
                      >
                        <HelpCircle size={14} className="flex-shrink-0 text-red-400" />
                        <span>{msg.text}</span>
                      </div>
                    );
                  }

                  return (
                    <div
                      key={msg.id}
                      className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} space-y-1`}
                    >
                      <div
                        className={`max-w-[92%] p-3 rounded-xl leading-relaxed ${
                          isUser
                            ? 'bg-[#0088ff] text-white font-medium shadow-md'
                            : 'bg-[#151825] text-neutral-200 border border-[#252a3e] shadow-sm'
                        }`}
                      >
                        <div className="whitespace-pre-wrap">{msg.text}</div>

                        {/* Render Proposed Actions in Rich Cards */}
                        {msg.actions && msg.actions.length > 0 && (
                          <div className="mt-3 pt-2.5 border-t border-[#2a3048] flex flex-col space-y-2">
                            <span className="text-[10px] font-mono uppercase tracking-wider text-[#00a2ff] font-bold flex items-center space-x-1">
                              <Zap size={11} />
                              <span>Vorgeschlagene Software-Schritte:</span>
                            </span>

                            {msg.actions.map((act) => {
                              const isExecuted = executedActionIds.has(act.id);
                              return (
                                <div
                                  key={act.id}
                                  className="rounded-lg p-2.5 bg-[#1a1e2f] border border-[#2b324a] flex items-center justify-between space-x-2"
                                >
                                  <div className="min-w-0 pr-2 space-y-0.5">
                                    <div className="text-xs font-bold text-white truncate">
                                      {act.label}
                                    </div>
                                    {act.description && (
                                      <div className="text-[10.5px] text-neutral-400 leading-tight">
                                        {act.description}
                                      </div>
                                    )}
                                  </div>
                                  <button
                                    onClick={() => triggerAction(act)}
                                    disabled={isExecuted}
                                    className={`px-3 py-1 rounded text-xs font-bold font-mono transition-all flex items-center space-x-1 flex-shrink-0 shadow-sm ${
                                      isExecuted
                                        ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 cursor-default'
                                        : 'bg-[#0088ff] hover:bg-[#0077ee] text-white cursor-pointer active:scale-95'
                                    }`}
                                  >
                                    {isExecuted ? (
                                      <>
                                        <Check size={11} />
                                        <span>Ausgeführt</span>
                                      </>
                                    ) : (
                                      <>
                                        <Play size={10} fill="currentColor" />
                                        <span>Ausführen</span>
                                      </>
                                    )}
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      <span className="text-[9.5px] font-mono text-neutral-500 px-1">
                        {new Date(msg.timestamp).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                  );
                })}

                {isLoading && (
                  <div className="flex items-center space-x-2 p-2.5 rounded-lg bg-[#151825] border border-[#252a3e] w-32 text-neutral-300">
                    <span className="w-2 h-2 rounded-full bg-[#0088ff] animate-bounce" />
                    <span className="w-2 h-2 rounded-full bg-[#0088ff] animate-bounce [animation-delay:0.2s]" />
                    <span className="w-2 h-2 rounded-full bg-[#0088ff] animate-bounce [animation-delay:0.4s]" />
                    <span className="text-xs font-mono ml-1">Analysiere...</span>
                  </div>
                )}

                <div ref={messagesEndRef} />
              </div>

              {/* Quick Prompt Chips */}
              <div className="px-3 py-2 bg-[#0a0c12] border-t border-[#1a1e2c] flex space-x-1.5 overflow-x-auto scrollbar-none text-[10px]">
                <button
                  onClick={() =>
                    handleSendMessage(
                      'Analysiere den aktuellen Track und schlage den optimalen Mix-In Punkt basierend auf Energie und Phrasen vor.'
                    )
                  }
                  className="px-2.5 py-1 bg-gradient-to-r from-emerald-950/80 to-blue-950/80 hover:from-emerald-900 hover:to-blue-900 border border-emerald-500/50 text-emerald-300 rounded-full whitespace-nowrap transition-colors flex items-center space-x-1 cursor-pointer font-medium"
                >
                  <Sparkles size={11} className="text-emerald-400" />
                  <span>🎯 Mix-In analysieren</span>
                </button>
                <button
                  onClick={() => handleSendMessage('Zoome auf 16 Takte (Bars)')}
                  className="px-2.5 py-1 bg-[#151826] hover:bg-[#202538] border border-[#262c42] text-neutral-300 rounded-full whitespace-nowrap transition-colors cursor-pointer"
                >
                  🔍 16 Bars
                </button>
                <button
                  onClick={() => handleSendMessage('Zoome auf den gesamten Track (Full Track)')}
                  className="px-2.5 py-1 bg-[#151826] hover:bg-[#202538] border border-[#262c42] text-neutral-300 rounded-full whitespace-nowrap transition-colors cursor-pointer"
                >
                  🌊 Full Track
                </button>
                <button
                  onClick={() => handleSendMessage('Setze einen Memory Cue am aktuellen Playhead')}
                  className="px-2.5 py-1 bg-[#151826] hover:bg-[#202538] border border-[#262c42] text-neutral-300 rounded-full whitespace-nowrap transition-colors cursor-pointer"
                >
                  🎯 +MEM Cue
                </button>
                <button
                  onClick={() => handleSendMessage('Richte das Beatgrid automatisch aus (Auto-Align)')}
                  className="px-2.5 py-1 bg-[#151826] hover:bg-[#202538] border border-[#262c42] text-neutral-300 rounded-full whitespace-nowrap transition-colors cursor-pointer"
                >
                  ⚡ Auto-Grid
                </button>
                <button
                  onClick={() => handleSendMessage('Schalte auf 3-Band Wellenform um')}
                  className="px-2.5 py-1 bg-[#151826] hover:bg-[#202538] border border-[#262c42] text-neutral-300 rounded-full whitespace-nowrap transition-colors cursor-pointer"
                >
                  🎨 3-Band
                </button>
              </div>

              {/* Input Bar */}
              <div className="p-3 bg-[#11131d] border-t border-[#1c2032] flex flex-col space-y-2">
                {isListening && (
                  <div className="flex items-center justify-between px-3 py-1.5 rounded bg-red-950/40 border border-red-800/50 text-red-300 text-xs animate-pulse font-mono">
                    <span className="flex items-center space-x-2">
                      <Mic size={13} className="text-red-400" />
                      <span>Spracherkennung aktiv... Sprich deinen Befehl</span>
                    </span>
                    <button
                      onClick={toggleVoiceInput}
                      className="text-[11px] underline hover:text-white cursor-pointer font-bold"
                    >
                      Stopp
                    </button>
                  </div>
                )}

                <div className="flex items-center space-x-2">
                  <button
                    onClick={toggleVoiceInput}
                    className={`p-2 rounded-lg transition-colors cursor-pointer ${
                      isListening
                        ? 'bg-red-600 text-white animate-pulse'
                        : 'bg-[#181a28] text-neutral-400 hover:text-white border border-[#282d42]'
                    }`}
                    title="Sprachbefehl aufnehmen (Mikrofon)"
                  >
                    {isListening ? <MicOff size={16} /> : <Mic size={16} />}
                  </button>

                  <input
                    ref={inputRef}
                    type="text"
                    value={inputQuery}
                    onChange={(e) => setInputQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSendMessage();
                      }
                    }}
                    placeholder="Frag Copilot oder z.B. 'Setze Mix-In Cue', 'Zoome auf 8 Takte'..."
                    className="flex-1 bg-[#161926] border border-[#2a3048] focus:border-[#0088ff] focus:outline-none rounded-lg px-3 py-2 text-xs text-white placeholder-neutral-500 font-sans"
                    disabled={isLoading}
                  />

                  <button
                    onClick={() => handleSendMessage()}
                    disabled={!inputQuery.trim() || isLoading}
                    className="p-2 bg-[#0088ff] hover:bg-[#0077ee] disabled:opacity-30 disabled:hover:bg-[#0088ff] text-white rounded-lg transition-colors shadow-md cursor-pointer disabled:cursor-not-allowed"
                    title="Senden"
                  >
                    <Send size={15} />
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// Helper to generate smooth SVG path for the area curve
function generateSvgAreaPath(phrases: PhraseEnergySummary[], totalDuration: number): string {
  if (!phrases || phrases.length === 0) return 'M 0 100 L 1000 100 Z';

  const points: { x: number; y: number }[] = [];
  points.push({ x: 0, y: 100 - (phrases[0].energyPercent || 20) });

  for (const p of phrases) {
    const endX = (p.endTime / totalDuration) * 1000;
    const y = 100 - p.energyPercent;
    points.push({ x: endX, y });
  }

  let d = `M 0 100 L 0 ${points[0].y}`;
  for (let i = 0; i < points.length; i++) {
    d += ` L ${points[i].x} ${points[i].y}`;
  }
  d += ' L 1000 100 Z';
  return d;
}

// Waveform bar visualizer component
const WaveformBars: React.FC<{ duration: number; audioBuffer?: AudioBuffer | null }> = ({
  duration,
  audioBuffer,
}) => {
  const bars = useMemo(() => {
    const barCount = 120;
    if (audioBuffer) {
      const channelData = audioBuffer.getChannelData(0);
      const step = Math.floor(channelData.length / barCount);
      const result: number[] = [];
      for (let i = 0; i < barCount; i++) {
        let max = 0;
        const start = i * step;
        const end = Math.min(channelData.length, start + step);
        for (let j = start; j < end; j += 8) {
          const val = Math.abs(channelData[j]);
          if (val > max) max = val;
        }
        result.push(Math.min(1, max * 1.5));
      }
      return result;
    }

    // Default aesthetic EDM envelope
    const synth: number[] = [];
    for (let i = 0; i < barCount; i++) {
      const pos = i / barCount;
      let height = 0.25;
      if (pos < 0.12) height = 0.25 + Math.sin(pos * 30) * 0.1;
      else if (pos < 0.25) height = 0.55 + Math.sin(pos * 40) * 0.15;
      else if (pos < 0.5) height = 0.85 + Math.sin(pos * 50) * 0.12;
      else if (pos < 0.62) height = 0.35 + Math.sin(pos * 20) * 0.1;
      else if (pos < 0.88) height = 0.95 + Math.sin(pos * 60) * 0.05;
      else height = 0.3 + Math.sin(pos * 30) * 0.08;
      synth.push(height);
    }
    return synth;
  }, [audioBuffer]);

  return (
    <div className="absolute inset-0 flex items-center justify-between px-2">
      {bars.map((height, i) => {
        const heightPct = Math.max(8, height * 100);
        return (
          <div
            key={i}
            style={{ height: `${heightPct}%` }}
            className="w-1 rounded-full bg-gradient-to-t from-blue-500 via-cyan-400 to-amber-400 opacity-80"
          />
        );
      })}
    </div>
  );
};

// Camelot Wheel SVG component (12 segments minor, 12 segments major)
const CamelotWheelSvg: React.FC<{
  activeCode: string;
  onSelectKey: (code: string) => void;
}> = ({ activeCode, onSelectKey }) => {
  const cx = 150;
  const cy = 150;
  const outerR = 140;
  const midR = 95;
  const innerR = 50;

  // 12 Camelot positions: 1 at ~30 deg, 12 at ~0/360 deg
  const camelotKeys = [
    { num: 1, minor: '1A', major: '1B', color: '#00d2ff' },
    { num: 2, minor: '2A', major: '2B', color: '#00a8ff' },
    { num: 3, minor: '3A', major: '3B', color: '#0070ff' },
    { num: 4, minor: '4A', major: '4B', color: '#4a00e0' },
    { num: 5, minor: '5A', major: '5B', color: '#8e2de2' },
    { num: 6, minor: '6A', major: '6B', color: '#f000ff' },
    { num: 7, minor: '7A', major: '7B', color: '#ff007f' },
    { num: 8, minor: '8A', major: '8B', color: '#ff2a2a' },
    { num: 9, minor: '9A', major: '9B', color: '#ff7700' },
    { num: 10, minor: '10A', major: '10B', color: '#ffb700' },
    { num: 11, minor: '11A', major: '11B', color: '#e2ff00' },
    { num: 12, minor: '12A', major: '12B', color: '#00ff66' },
  ];

  return (
    <svg width="300" height="300" viewBox="0 0 300 300" className="select-none">
      {/* Center circle */}
      <circle cx={cx} cy={cy} r={innerR} fill="#111422" stroke="#252b42" strokeWidth="2" />
      <text
        x={cx}
        y={cy - 4}
        textAnchor="middle"
        className="fill-[#00e5ff] font-mono font-bold text-base"
      >
        {activeCode}
      </text>
      <text
        x={cx}
        y={cy + 14}
        textAnchor="middle"
        className="fill-neutral-400 font-mono text-[9px]"
      >
        AKTIV
      </text>

      {/* Outer Rings: 1B to 12B (Major) */}
      {camelotKeys.map((item, idx) => {
        const angleStart = (idx * 30 - 15 - 90) * (Math.PI / 180);
        const angleEnd = ((idx + 1) * 30 - 15 - 90) * (Math.PI / 180);
        const angleMid = (idx * 30 - 90) * (Math.PI / 180);

        const x1Outer = cx + outerR * Math.cos(angleStart);
        const y1Outer = cy + outerR * Math.sin(angleStart);
        const x2Outer = cx + outerR * Math.cos(angleEnd);
        const y2Outer = cy + outerR * Math.sin(angleEnd);

        const x1Mid = cx + midR * Math.cos(angleStart);
        const y1Mid = cy + midR * Math.sin(angleStart);
        const x2Mid = cx + midR * Math.cos(angleEnd);
        const y2Mid = cy + midR * Math.sin(angleEnd);

        const x1Inner = cx + innerR * Math.cos(angleStart);
        const y1Inner = cy + innerR * Math.sin(angleStart);
        const x2Inner = cx + innerR * Math.cos(angleEnd);
        const y2Inner = cy + innerR * Math.sin(angleEnd);

        const textMajorX = cx + ((outerR + midR) / 2) * Math.cos(angleMid);
        const textMajorY = cy + ((outerR + midR) / 2) * Math.sin(angleMid) + 4;

        const textMinorX = cx + ((midR + innerR) / 2) * Math.cos(angleMid);
        const textMinorY = cy + ((midR + innerR) / 2) * Math.sin(angleMid) + 4;

        const isMajorActive = activeCode === item.major;
        const isMinorActive = activeCode === item.minor;

        return (
          <g key={item.num} className="cursor-pointer">
            {/* Major Outer Segment */}
            <path
              d={`M ${x1Mid} ${y1Mid} L ${x1Outer} ${y1Outer} A ${outerR} ${outerR} 0 0 1 ${x2Outer} ${y2Outer} L ${x2Mid} ${y2Mid} A ${midR} ${midR} 0 0 0 ${x1Mid} ${y1Mid} Z`}
              fill={isMajorActive ? item.color : '#141826'}
              stroke={isMajorActive ? '#ffffff' : '#22283d'}
              strokeWidth={isMajorActive ? '2' : '1'}
              onClick={() => onSelectKey(item.major)}
              className="hover:brightness-150 transition-colors"
            />
            <text
              x={textMajorX}
              y={textMajorY}
              textAnchor="middle"
              onClick={() => onSelectKey(item.major)}
              className={`font-mono text-[10px] font-bold ${
                isMajorActive ? 'fill-black' : 'fill-neutral-300'
              } pointer-events-none`}
            >
              {item.major}
            </text>

            {/* Minor Inner Segment */}
            <path
              d={`M ${x1Inner} ${y1Inner} L ${x1Mid} ${y1Mid} A ${midR} ${midR} 0 0 1 ${x2Mid} ${y2Mid} L ${x2Inner} ${y2Inner} A ${innerR} ${innerR} 0 0 0 ${x1Inner} ${y1Inner} Z`}
              fill={isMinorActive ? item.color : '#0e111d'}
              stroke={isMinorActive ? '#ffffff' : '#1f2538'}
              strokeWidth={isMinorActive ? '2' : '1'}
              onClick={() => onSelectKey(item.minor)}
              className="hover:brightness-150 transition-colors"
            />
            <text
              x={textMinorX}
              y={textMinorY}
              textAnchor="middle"
              onClick={() => onSelectKey(item.minor)}
              className={`font-mono text-[10px] font-bold ${
                isMinorActive ? 'fill-black' : 'fill-neutral-400'
              } pointer-events-none`}
            >
              {item.minor}
            </text>
          </g>
        );
      })}
    </svg>
  );
};
