/**
 * @license
 * airdox DJ Smart Copilot - Collapsible AI Assistant Palette
 * Provides multi-turn conversation with Gemini, autonomous editing actions,
 * and direct software operation control.
 */

import React, { useState, useRef, useEffect } from 'react';
import {
  Bot,
  Send,
  Sparkles,
  Zap,
  RotateCcw,
  X,
  Play,
  Check,
  Compass,
  Scissors,
  Bookmark,
  Layers,
  Mic,
  MicOff,
  Sliders,
  Maximize2,
  Volume2,
  ChevronRight,
  AlertCircle,
} from 'lucide-react';
import {
  ChatMessage,
  ChatbotAction,
  ChatbotModel,
  TrackEditorContext,
} from '../types/chatbot';

interface ChatbotPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  trackContext: TrackEditorContext;
  onExecuteAction: (action: ChatbotAction) => void;
  onSelectZoomPreset?: (preset: any) => void;
}

const DEFAULT_WELCOME_MESSAGE: ChatMessage = {
  id: 'msg-welcome',
  role: 'assistant',
  text: 'Willkommen beim airdox DJ Smart Copilot! Ich kann deinen Track automatisch auf Energielevel & Phrasenstrukturen analysieren, den optimalen Mix-In Punkt berechnen, Beatgrids feinjustieren oder Cue-Punkte setzen.',
  timestamp: Date.now(),
  actions: [
    {
      id: 'init-mixin',
      type: 'SET_MIX_IN_POINT',
      label: '🎯 Optimalen Mix-In analysieren',
      description: 'Scannt Phrasen & Energielevel für den perfekten Übergangspunkt.',
      params: { analyzeQuery: true },
    },
    {
      id: 'init-zoom-16',
      type: 'SET_ZOOM',
      label: 'Auf 16 Bars zoomen',
      description: 'Stellt das Sichtfenster optimal auf 16 Takte ein.',
      params: { preset: '16_BARS' },
    },
    {
      id: 'init-cue',
      type: 'ADD_MEMORY_CUE',
      label: 'Memory Cue am Playhead setzen',
      description: 'Platziert einen Marker für CDJ Memory Jump.',
      params: {},
    },
    {
      id: 'init-quantize',
      type: 'SET_QUANTIZE',
      label: 'Quantize aktivieren',
      description: 'Rastet alle Schnitte exakt auf Beats ein.',
      params: { enabled: true },
    },
  ],
};

export const ChatbotPalette: React.FC<ChatbotPaletteProps> = ({
  isOpen,
  onClose,
  trackContext,
  onExecuteAction,
  onSelectZoomPreset,
}) => {
  const [messages, setMessages] = useState<ChatMessage[]>([DEFAULT_WELCOME_MESSAGE]);
  const [inputQuery, setInputQuery] = useState('');
  const [selectedModel, setSelectedModel] = useState<ChatbotModel>('gemini-3.5-flash');
  const [autoExecute, setAutoExecute] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [executedActionIds, setExecutedActionIds] = useState<Set<string>>(new Set());

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const speechRecognitionRef = useRef<any>(null);

  // Auto-scroll to bottom of thread
  useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isOpen]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 150);
    }
  }, [isOpen]);

  // Web Speech recognition initialization
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
      };

      recognizer.onerror = () => {
        setIsListening(false);
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
      } catch (e) {
        console.warn('SpeechRecognition start failed', e);
        setIsListening(false);
      }
    }
  };

  const handleSendMessage = async (textToSend?: string) => {
    const query = (textToSend || inputQuery).trim();
    if (!query || isLoading) return;

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
          trackContext,
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

      // If auto-execute is enabled and actions are returned, execute the first action autonomously!
      if (autoExecute && data.actions && data.actions.length > 0) {
        const firstAct = data.actions[0];
        triggerAction(firstAct);
      }
    } catch (err: any) {
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
    if (action.params?.analyzeQuery) {
      handleSendMessage(
        'Analysiere den aktuellen Track und schlage den optimalen Mix-In Punkt basierend auf Energie und Phrasen vor.'
      );
      return;
    }
    onExecuteAction(action);
  };

  const handleClearHistory = () => {
    setMessages([DEFAULT_WELCOME_MESSAGE]);
    setExecutedActionIds(new Set());
  };

  if (!isOpen) return null;

  return (
    <div className="w-96 flex flex-col h-full bg-[#0d0e13] border-l border-[#1c1f2b] shadow-2xl select-none z-30 flex-shrink-0 animate-in slide-in-from-right duration-200">
      {/* 1. Header with Model Picker and Controls */}
      <div className="p-2.5 bg-[#10121a] border-b border-[#1c1f2b] flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <div className="w-6 h-6 rounded bg-gradient-to-br from-[#0088ff] to-[#7928ca] flex items-center justify-center text-white shadow-sm">
            <Sparkles size={13} />
          </div>
          <div>
            <div className="flex items-center space-x-1.5">
              <span className="text-white text-[12px] font-bold tracking-wide font-mono">
                DJ SMART COPILOT
              </span>
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            </div>
            <span className="text-[9.5px] text-neutral-400 font-mono">Gemini AI Assistant</span>
          </div>
        </div>

        <div className="flex items-center space-x-1">
          {/* Clear history */}
          <button
            onClick={handleClearHistory}
            className="p-1 rounded text-neutral-400 hover:text-white hover:bg-[#1a1c26] transition-colors"
            title="Chat-Verlauf leeren"
          >
            <RotateCcw size={12} />
          </button>

          {/* Close palette */}
          <button
            onClick={onClose}
            className="p-1 rounded text-neutral-400 hover:text-white hover:bg-[#1a1c26] transition-colors"
            title="Palette schließen"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* 2. Sub-Bar: Model Selector & Auto-Run Toggle */}
      <div className="px-2.5 py-1.5 bg-[#0b0c10] border-b border-[#191b26] flex items-center justify-between text-[10px]">
        {/* Model Dropdown */}
        <div className="flex items-center space-x-1">
          <span className="text-neutral-500 font-mono">Modell:</span>
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value as ChatbotModel)}
            className="bg-[#141620] text-[#00a2ff] font-mono text-[10px] px-1.5 py-0.5 rounded border border-[#232738] focus:outline-none cursor-pointer"
          >
            <option value="gemini-3.5-flash">Gemini 3.5 Flash (Standard)</option>
            <option value="gemini-3.1-flash-lite">Gemini 3.1 Flash-Lite (Schnell)</option>
            <option value="gemini-3.1-pro-preview">Gemini 3.1 Pro (Tiefenanalyse)</option>
          </select>
        </div>

        {/* Auto-Execute Toggle */}
        <button
          onClick={() => setAutoExecute(!autoExecute)}
          className={`flex items-center space-x-1 px-1.5 py-0.5 rounded border text-[9.5px] font-mono transition-colors ${
            autoExecute
              ? 'bg-[#0088ff]/20 border-[#0088ff]/60 text-[#00a2ff]'
              : 'bg-[#141620] border-[#232738] text-neutral-400 hover:text-neutral-200'
          }`}
          title="Schritte der Software bei Vorschlag sofort autonom ausführen"
        >
          <Zap size={10} className={autoExecute ? 'text-[#00a2ff] fill-current' : ''} />
          <span>Auto-Run</span>
        </button>
      </div>

      {/* 3. Live Deck Context Chip */}
      <div className="px-2.5 py-1.5 bg-[#12141d]/70 border-b border-[#181a24] flex items-center justify-between text-[9.5px] font-mono text-neutral-400">
        <span className="truncate max-w-[170px] text-white font-medium" title={trackContext.title}>
          {trackContext.title ? `🎵 ${trackContext.title}` : '⚠️ Kein Track im Deck'}
        </span>
        <div className="flex items-center space-x-1.5">
          {trackContext.bpm && <span className="text-[#00a2ff]">{trackContext.bpm.toFixed(1)} BPM</span>}
          {trackContext.title && (
            <button
              onClick={() =>
                handleSendMessage(
                  'Analysiere den aktuellen Track und schlage den optimalen Mix-In Punkt basierend auf Energie und Phrasen vor.'
                )
              }
              className="flex items-center space-x-1 px-1.5 py-0.5 rounded bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-300 text-[9px] font-bold transition-all shadow-xs cursor-pointer active:scale-95"
              title="Optimalen Mix-In Punkt anhand von Phrasen und Energie analysieren"
            >
              <Sparkles size={9} />
              <span>Mix-In Scan</span>
            </button>
          )}
        </div>
      </div>

      {/* 4. Messages Thread */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3 font-sans text-xs">
        {messages.map((msg) => {
          const isUser = msg.role === 'user';
          const isSystem = msg.role === 'system';

          if (isSystem) {
            return (
              <div
                key={msg.id}
                className="flex items-center space-x-1.5 p-2 rounded bg-red-950/20 border border-red-900/30 text-red-400 text-[10.5px]"
              >
                <AlertCircle size={12} className="flex-shrink-0" />
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
                className={`max-w-[90%] p-2.5 rounded-lg leading-relaxed ${
                  isUser
                    ? 'bg-[#0088ff] text-white font-medium shadow-md'
                    : 'bg-[#151722] text-neutral-200 border border-[#242838]'
                }`}
              >
                <div className="whitespace-pre-wrap">{msg.text}</div>

                {/* Render Proposed Actions */}
                {msg.actions && msg.actions.length > 0 && (
                  <div className="mt-2.5 pt-2 border-t border-[#2a2e40] flex flex-col space-y-1.5">
                    <span className="text-[9.5px] font-mono uppercase tracking-wider text-[#00a2ff] font-bold flex items-center space-x-1">
                      <Zap size={10} />
                      <span>Vorgeschlagene Software-Schritte:</span>
                    </span>

                    {msg.actions.map((act) => {
                      const isExecuted = executedActionIds.has(act.id);
                      const isMixin = act.type === 'SET_MIX_IN_POINT';
                      return (
                        <div
                          key={act.id}
                          className={`rounded p-2 flex flex-col space-y-1 transition-colors ${
                            isMixin
                              ? 'bg-gradient-to-r from-[#0e271e] to-[#141b2a] border border-emerald-500/40 shadow-xs'
                              : 'bg-[#1b1e2c] border border-[#2c3144]'
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center space-x-1.5 min-w-0 pr-1">
                              {isMixin && (
                                <span className="px-1 py-0.2 rounded text-[8px] font-mono font-bold bg-emerald-500/30 text-emerald-300 border border-emerald-500/50 flex-shrink-0">
                                  MIX-IN
                                </span>
                              )}
                              <span className="text-[11px] font-semibold text-white truncate">
                                {act.label}
                              </span>
                            </div>
                            <button
                              onClick={() => triggerAction(act)}
                              disabled={isExecuted}
                              className={`flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-bold font-mono transition-colors shadow-sm flex-shrink-0 ${
                                isExecuted
                                  ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 cursor-default'
                                  : isMixin
                                  ? 'bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer active:scale-95'
                                  : 'bg-[#0088ff] hover:bg-[#0077ee] text-white cursor-pointer active:scale-95'
                              }`}
                            >
                              {isExecuted ? (
                                <>
                                  <Check size={10} />
                                  <span>Ausgeführt</span>
                                </>
                              ) : (
                                <>
                                  <Play size={9} fill="currentColor" />
                                  <span>Ausführen</span>
                                </>
                              )}
                            </button>
                          </div>
                          {act.description && (
                            <span className="text-[10px] text-neutral-400 leading-tight">
                              {act.description}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <span className="text-[9px] font-mono text-neutral-600 px-1">
                {new Date(msg.timestamp).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </div>
          );
        })}

        {isLoading && (
          <div className="flex items-center space-x-2 p-2 rounded bg-[#151722] border border-[#242838] w-28 text-neutral-400">
            <span className="w-1.5 h-1.5 rounded-full bg-[#0088ff] animate-bounce" />
            <span className="w-1.5 h-1.5 rounded-full bg-[#0088ff] animate-bounce [animation-delay:0.2s]" />
            <span className="w-1.5 h-1.5 rounded-full bg-[#0088ff] animate-bounce [animation-delay:0.4s]" />
            <span className="text-[10px] font-mono ml-1">Denkt...</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* 5. Quick Prompt Chips */}
      <div className="p-2 bg-[#0a0b0e] border-t border-[#181a24] flex space-x-1.5 overflow-x-auto scrollbar-none text-[9.5px]">
        <button
          onClick={() =>
            handleSendMessage(
              'Analysiere den aktuellen Track und schlage den optimalen Mix-In Punkt basierend auf Energie und Phrasen vor.'
            )
          }
          className="px-2.5 py-1 bg-gradient-to-r from-emerald-950/80 to-blue-950/80 hover:from-emerald-900 hover:to-blue-900 border border-emerald-500/50 text-emerald-300 hover:text-white rounded-full whitespace-nowrap transition-colors flex-shrink-0 font-medium flex items-center space-x-1 shadow-sm"
        >
          <Sparkles size={10} className="text-emerald-400" />
          <span>🎯 Mix-In analysieren</span>
        </button>
        <button
          onClick={() => handleSendMessage('Zoome auf 16 Takte (Bars)')}
          className="px-2 py-1 bg-[#141622] hover:bg-[#1f2233] border border-[#242738] text-neutral-300 hover:text-white rounded-full whitespace-nowrap transition-colors flex-shrink-0"
        >
          🔍 16 Bars
        </button>
        <button
          onClick={() => handleSendMessage('Zoome auf den gesamten Track (Full Track)')}
          className="px-2 py-1 bg-[#141622] hover:bg-[#1f2233] border border-[#242738] text-neutral-300 hover:text-white rounded-full whitespace-nowrap transition-colors flex-shrink-0"
        >
          🌊 Full Track
        </button>
        <button
          onClick={() => handleSendMessage('Setze einen Memory Cue am aktuellen Playhead')}
          className="px-2 py-1 bg-[#141622] hover:bg-[#1f2233] border border-[#242738] text-neutral-300 hover:text-white rounded-full whitespace-nowrap transition-colors flex-shrink-0"
        >
          🎯 +MEM Cue
        </button>
        <button
          onClick={() => handleSendMessage('Richte das Beatgrid automatisch aus (Auto-Align)')}
          className="px-2 py-1 bg-[#141622] hover:bg-[#1f2233] border border-[#242738] text-neutral-300 hover:text-white rounded-full whitespace-nowrap transition-colors flex-shrink-0"
        >
          ⚡ Auto-Grid
        </button>
        <button
          onClick={() => handleSendMessage('Schalte auf 3-Band Wellenform um')}
          className="px-2 py-1 bg-[#141622] hover:bg-[#1f2233] border border-[#242738] text-neutral-300 hover:text-white rounded-full whitespace-nowrap transition-colors flex-shrink-0"
        >
          🎨 3-Band
        </button>
      </div>

      {/* 6. Input Area */}
      <div className="p-2.5 bg-[#10121a] border-t border-[#1c1f2b] flex flex-col space-y-1.5">
        {isListening && (
          <div className="flex items-center justify-between px-2 py-1 rounded bg-red-950/30 border border-red-800/40 text-red-400 text-[10px] animate-pulse font-mono">
            <span className="flex items-center space-x-1.5">
              <Mic size={11} />
              <span>Höre zu... Sprich deinen Befehl</span>
            </span>
            <button
              onClick={toggleVoiceInput}
              className="text-[9px] underline hover:text-white cursor-pointer"
            >
              Stop
            </button>
          </div>
        )}

        <div className="flex items-center space-x-1.5">
          <button
            onClick={toggleVoiceInput}
            className={`p-1.5 rounded transition-colors ${
              isListening
                ? 'bg-red-600 text-white animate-pulse'
                : 'bg-[#181a24] text-neutral-400 hover:text-white border border-[#262938]'
            }`}
            title="Sprachbefehl aufnehmen (Mikrofon)"
          >
            {isListening ? <MicOff size={14} /> : <Mic size={14} />}
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
            placeholder="Frag Copilot oder z.B. 'Zoome auf 8 Takte'..."
            className="flex-1 bg-[#161824] border border-[#282d3e] focus:border-[#0088ff] focus:outline-none rounded px-2.5 py-1.5 text-xs text-white placeholder-neutral-500 font-sans"
            disabled={isLoading}
          />

          <button
            onClick={() => handleSendMessage()}
            disabled={!inputQuery.trim() || isLoading}
            className="p-1.5 bg-[#0088ff] hover:bg-[#0077ee] disabled:opacity-30 disabled:hover:bg-[#0088ff] text-white rounded transition-colors shadow-sm cursor-pointer disabled:cursor-not-allowed"
            title="Senden"
          >
            <Send size={13} />
          </button>
        </div>
      </div>
    </div>
  );
};
