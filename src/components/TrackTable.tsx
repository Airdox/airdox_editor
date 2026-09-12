import React, { useState } from "react";
import {
  Play,
  Pause,
  Link2,
  Sparkles,
  Maximize2,
  ChevronDown,
  ChevronRight,
  Flame,
  Star,
  Plus,
} from "lucide-react";
import { DJTrack, TrackLink, CamelotHarmonicMatch } from "../types";
import { getCamelotColor, findHarmonicMatchesForTrack } from "../utils/harmonicUtils";

interface TrackTableProps {
  tracks: DJTrack[];
  allTracks: DJTrack[];
  links: TrackLink[];
  deck1TrackId?: string;
  deck2TrackId?: string;
  onLoadDeck: (track: DJTrack, deckId: 1 | 2) => void;
  onOpenTrackInspector: (track: DJTrack) => void;
  onQuickLinkTracks: (sourceTrackId: string, targetTrackId: string) => void;
}

export const TrackTable: React.FC<TrackTableProps> = ({
  tracks,
  allTracks,
  links,
  deck1TrackId,
  deck2TrackId,
  onLoadDeck,
  onOpenTrackInspector,
  onQuickLinkTracks,
}) => {
  const [expandedTrackId, setExpandedTrackId] = useState<string | null>(null);

  const getTrackLinkCount = (trackId: string) => {
    return links.filter(
      (l) => l.sourceTrackId === trackId || l.targetTrackId === trackId
    ).length;
  };

  const toggleMatches = (trackId: string) => {
    setExpandedTrackId((prev) => (prev === trackId ? null : trackId));
  };

  return (
    <div className="flex-1 bg-zinc-950 flex flex-col overflow-hidden select-none">
      {/* Table Header */}
      <div className="border-b border-zinc-800 bg-zinc-900/60 px-4 py-2 text-[11px] font-mono font-bold text-zinc-400 grid grid-cols-[30px_2.5fr_1.5fr_80px_90px_80px_100px_160px] gap-2 items-center">
        <span>#</span>
        <span>TITEL / REMIX</span>
        <span>KÜNSTLER</span>
        <span>BPM</span>
        <span>KEY</span>
        <span>ENERGIE</span>
        <span>REKORDBOX MATCH</span>
        <span className="text-right">DECKS &amp; INSPECTOR</span>
      </div>

      {/* Track List */}
      <div className="flex-1 overflow-y-auto divide-y divide-zinc-900/80">
        {tracks.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-12 text-center text-zinc-500">
            <Link2 className="w-10 h-10 mb-2 stroke-[1.5] text-zinc-600" />
            <p className="text-sm font-medium text-zinc-400">Keine Tracks gefunden</p>
            <p className="text-xs text-zinc-600 mt-1">
              Passe deine Filter an oder deaktiviere den "Nur verknüpfte Tracks"-Modus.
            </p>
          </div>
        ) : (
          tracks.map((track, idx) => {
            const isDeck1 = deck1TrackId === track.id;
            const isDeck2 = deck2TrackId === track.id;
            const linkCount = getTrackLinkCount(track.id);
            const isExpanded = expandedTrackId === track.id;
            const harmonicMatches = isExpanded
              ? findHarmonicMatchesForTrack(track, allTracks, links)
              : [];

            return (
              <div key={track.id} className="flex flex-col transition-colors hover:bg-zinc-900/40">
                {/* Track Row */}
                <div
                  className={`px-4 py-2.5 grid grid-cols-[30px_2.5fr_1.5fr_80px_90px_80px_100px_160px] gap-2 items-center text-xs group ${
                    isDeck1
                      ? "bg-cyan-950/20 border-l-2 border-cyan-400"
                      : isDeck2
                      ? "bg-amber-950/20 border-l-2 border-amber-400"
                      : ""
                  }`}
                >
                  {/* Number / Expand Arrow */}
                  <button
                    onClick={() => toggleMatches(track.id)}
                    className="text-zinc-600 hover:text-zinc-300 flex items-center justify-center"
                    title="Harmonische Matches ausklappen"
                  >
                    {isExpanded ? (
                      <ChevronDown className="w-4 h-4 text-cyan-400" />
                    ) : (
                      <span className="font-mono text-[11px] group-hover:hidden">
                        {idx + 1}
                      </span>
                    )}
                    {!isExpanded && (
                      <ChevronRight className="w-4 h-4 hidden group-hover:block text-zinc-400" />
                    )}
                  </button>

                  {/* Title & Remix */}
                  <div className="flex items-center gap-2 min-w-0 pr-2">
                    <div
                      className="w-1.5 h-6 rounded-full shrink-0"
                      style={{ backgroundColor: track.colorTag || "#3b82f6" }}
                    />
                    <div className="truncate">
                      <div className="flex items-center gap-1.5">
                        <span className="font-bold text-zinc-100 truncate">
                          {track.title}
                        </span>
                        {track.remix && (
                          <span className="text-[10px] text-zinc-500 font-medium truncate">
                            ({track.remix})
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 mt-0.5">
                        {track.tags.slice(0, 2).map((tag) => (
                          <span
                            key={tag}
                            className="text-[9px] px-1 py-0.2 rounded bg-zinc-800/80 text-zinc-400 border border-zinc-700/60"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Artist */}
                  <div className="text-zinc-400 truncate font-medium">
                    {track.artist}
                  </div>

                  {/* BPM */}
                  <div className="font-mono text-zinc-300 font-semibold">
                    {track.bpm}
                  </div>

                  {/* Camelot Key Badge */}
                  <div>
                    <span
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-bold border"
                      style={{
                        backgroundColor: `${getCamelotColor(track.camelotKey)}18`,
                        borderColor: `${getCamelotColor(track.camelotKey)}60`,
                        color: getCamelotColor(track.camelotKey),
                      }}
                    >
                      <span>{track.camelotKey}</span>
                      <span className="text-[9px] opacity-70">({track.musicalKey})</span>
                    </span>
                  </div>

                  {/* Energy Meter */}
                  <div className="flex items-center gap-0.5">
                    {Array.from({ length: 5 }).map((_, i) => (
                      <Flame
                        key={i}
                        className={`w-3 h-3 ${
                          i < track.energy ? "text-amber-500 fill-amber-500" : "text-zinc-800"
                        }`}
                      />
                    ))}
                  </div>

                  {/* Rekordbox Matches Badge */}
                  <div>
                    {linkCount > 0 ? (
                      <button
                        onClick={() => onOpenTrackInspector(track)}
                        className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-cyan-950/80 border border-cyan-700 text-cyan-300 text-[10px] font-bold font-mono hover:bg-cyan-900/80 transition-all shadow-sm"
                        title={`${linkCount} gespeicherte Verknüpfungen mit Übergängen anzeigen`}
                      >
                        <Link2 className="w-3 h-3 text-cyan-400" />
                        <span>{linkCount} Match{linkCount > 1 ? "es" : ""}</span>
                      </button>
                    ) : (
                      <button
                        onClick={() => toggleMatches(track.id)}
                        className="inline-flex items-center gap-1 text-[10px] text-zinc-600 hover:text-cyan-400 transition-colors"
                        title="Verknüpfung erstellen"
                      >
                        <Plus className="w-3 h-3" />
                        <span>Verknüpfen</span>
                      </button>
                    )}
                  </div>

                  {/* Action Buttons: D1, D2, Inspector Pop-up */}
                  <div className="flex items-center justify-end gap-1.5">
                    <button
                      onClick={() => onLoadDeck(track, 1)}
                      className={`px-2 py-1 rounded text-[11px] font-bold font-mono transition-all ${
                        isDeck1
                          ? "bg-cyan-500 text-zinc-950 shadow-md shadow-cyan-500/30"
                          : "bg-zinc-800 hover:bg-cyan-950 hover:text-cyan-300 border border-zinc-700 text-zinc-300"
                      }`}
                      title="Auf Deck 1 (Links) laden"
                    >
                      D1
                    </button>
                    <button
                      onClick={() => onLoadDeck(track, 2)}
                      className={`px-2 py-1 rounded text-[11px] font-bold font-mono transition-all ${
                        isDeck2
                          ? "bg-amber-500 text-zinc-950 shadow-md shadow-amber-500/30"
                          : "bg-zinc-800 hover:bg-amber-950 hover:text-amber-300 border border-zinc-700 text-zinc-300"
                      }`}
                      title="Auf Deck 2 (Rechts) laden"
                    >
                      D2
                    </button>
                    <button
                      onClick={() => onOpenTrackInspector(track)}
                      className="p-1.5 rounded bg-zinc-800/80 hover:bg-zinc-700 border border-zinc-700/60 text-zinc-400 hover:text-zinc-100 transition-colors"
                      title="In Pop-up Inspector öffnen (Wellenform, Cue Points &amp; Transition Links)"
                    >
                      <Maximize2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Expanded Harmonic Matches Drawer */}
                {isExpanded && (
                  <div className="bg-zinc-900/90 border-t border-b border-zinc-800 p-3 pl-10">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
                        <span className="text-xs font-bold text-zinc-200">
                          Harmonische Rekordbox-Empfehlungen für "{track.title}"
                        </span>
                        <span className="text-[10px] text-zinc-500 font-mono">
                          (Camelot {track.camelotKey} • {track.bpm} BPM)
                        </span>
                      </div>
                      <span className="text-[10px] text-zinc-500">
                        Klicke auf Match, um Tracks dauerhaft miteinander zu verbinden
                      </span>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                      {harmonicMatches.slice(0, 3).map((match) => {
                        return (
                          <div
                            key={match.targetTrack.id}
                            className={`p-2.5 rounded-lg border flex flex-col justify-between gap-1.5 transition-all ${
                              match.isExistingLink
                                ? "bg-cyan-950/30 border-cyan-800/80 shadow-sm"
                                : "bg-zinc-950/80 border-zinc-800"
                            }`}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div>
                                <h5 className="text-xs font-bold text-zinc-100 truncate">
                                  {match.targetTrack.title}
                                </h5>
                                <p className="text-[11px] text-zinc-400 truncate">
                                  {match.targetTrack.artist}
                                </p>
                              </div>
                              <div className="text-right shrink-0">
                                <span className="text-xs font-mono font-extrabold text-cyan-400">
                                  {match.score}%
                                </span>
                                <div className="text-[9px] text-zinc-500 font-mono">
                                  {match.targetTrack.bpm} BPM
                                </div>
                              </div>
                            </div>

                            <p className="text-[10px] text-zinc-400 leading-tight line-clamp-2">
                              {match.description}
                            </p>

                            <div className="flex items-center justify-between pt-1 border-t border-zinc-800/60">
                              <span
                                className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded"
                                style={{
                                  backgroundColor: `${getCamelotColor(match.targetTrack.camelotKey)}20`,
                                  color: getCamelotColor(match.targetTrack.camelotKey),
                                }}
                              >
                                {match.targetTrack.camelotKey}
                              </span>

                              <div className="flex items-center gap-1">
                                {!match.isExistingLink ? (
                                  <button
                                    onClick={() => onQuickLinkTracks(track.id, match.targetTrack.id)}
                                    className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-cyan-950 hover:text-cyan-300 text-[10px] font-bold border border-zinc-700 text-zinc-300 transition-colors flex items-center gap-1"
                                  >
                                    <Link2 className="w-2.5 h-2.5" />
                                    <span>Verknüpfen</span>
                                  </button>
                                ) : (
                                  <span className="text-[10px] font-mono text-cyan-400 flex items-center gap-1">
                                    <Link2 className="w-3 h-3" /> Verknüpft
                                  </span>
                                )}
                                <button
                                  onClick={() => onLoadDeck(match.targetTrack, 2)}
                                  className="px-2 py-0.5 rounded bg-amber-950/80 hover:bg-amber-900 border border-amber-800 text-amber-300 text-[10px] font-bold font-mono"
                                  title="Direkt auf Deck 2 laden"
                                >
                                  ➔ Deck 2
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
