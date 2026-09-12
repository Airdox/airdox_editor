import React from "react";
import {
  Folder,
  Link,
  Flame,
  Music2,
  Sparkles,
  Search,
  Filter,
  SlidersHorizontal,
} from "lucide-react";
import { LibraryFilters } from "../types";
import { getCamelotColor } from "../utils/harmonicUtils";

interface LibrarySidebarProps {
  filters: LibraryFilters;
  onFilterChange: (filters: Partial<LibraryFilters>) => void;
  totalTracks: number;
  linkedTracksCount: number;
}

const CAMELOT_KEYS = [
  "1A", "2A", "3A", "4A", "5A", "6A", "7A", "8A", "9A", "10A", "11A", "12A",
  "1B", "2B", "3B", "4B", "5B", "6B", "7B", "8B", "9B", "10B", "11B", "12B",
];

const GENRES = [
  "Alle Genres",
  "Melodic Techno",
  "Progressive House",
  "Tech House",
  "Peak Time Techno",
  "Drum & Bass",
  "Eurodance / Trance",
];

export const LibrarySidebar: React.FC<LibrarySidebarProps> = ({
  filters,
  onFilterChange,
  totalTracks,
  linkedTracksCount,
}) => {
  return (
    <aside className="w-64 bg-zinc-950 border-r border-zinc-800 flex flex-col p-3 gap-4 shrink-0 overflow-y-auto select-none">
      {/* Search Input */}
      <div className="relative">
        <Search className="w-4 h-4 text-zinc-500 absolute left-2.5 top-2.5" />
        <input
          type="text"
          placeholder="Track, Artist, Key..."
          value={filters.search}
          onChange={(e) => onFilterChange({ search: e.target.value })}
          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-cyan-500"
        />
      </div>

      {/* CORE REKORDBOX FILTER: Only Linked Tracks */}
      <div className="bg-gradient-to-r from-blue-950/40 to-cyan-950/40 border border-cyan-900/60 rounded-xl p-3">
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-2">
            <Link className="w-4 h-4 text-cyan-400" />
            <span className="text-xs font-bold text-zinc-100">
              Verknüpfte Tracks
            </span>
          </div>
          <span className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded bg-cyan-950 text-cyan-300 border border-cyan-800">
            {linkedTracksCount}
          </span>
        </div>
        <p className="text-[11px] text-zinc-400 leading-snug mb-2">
          Rekordbox Matches: Zeige nur Tracks mit gespeicherten Übergangs-Links.
        </p>
        <button
          onClick={() => onFilterChange({ onlyLinked: !filters.onlyLinked })}
          className={`w-full py-1.5 px-2.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-all ${
            filters.onlyLinked
              ? "bg-cyan-500 text-zinc-950 shadow-md shadow-cyan-500/20"
              : "bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-800"
          }`}
        >
          <Filter className="w-3.5 h-3.5" />
          <span>{filters.onlyLinked ? "Filter aktiv (Nur Matches)" : "Filter anwenden"}</span>
        </button>
      </div>

      {/* Crates & Playlists */}
      <div>
        <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 font-bold mb-1.5 block">
          Playlists &amp; Crates
        </span>
        <div className="flex flex-col gap-1">
          <button
            onClick={() => onFilterChange({ genre: "", onlyLinked: false })}
            className={`flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
              !filters.genre && !filters.onlyLinked
                ? "bg-zinc-800 text-cyan-400 font-bold"
                : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900"
            }`}
          >
            <div className="flex items-center gap-2">
              <Folder className="w-3.5 h-3.5" />
              <span>Gesamte Library</span>
            </div>
            <span className="text-[10px] font-mono text-zinc-500">{totalTracks}</span>
          </button>

          <button
            onClick={() => onFilterChange({ minEnergy: 5 })}
            className={`flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
              filters.minEnergy === 5
                ? "bg-zinc-800 text-amber-400 font-bold"
                : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900"
            }`}
          >
            <div className="flex items-center gap-2">
              <Flame className="w-3.5 h-3.5 text-amber-500" />
              <span>Peak-Time Weapons</span>
            </div>
          </button>
        </div>
      </div>

      {/* Genre Filter */}
      <div>
        <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 font-bold mb-1.5 block">
          Genre
        </span>
        <select
          value={filters.genre}
          onChange={(e) =>
            onFilterChange({ genre: e.target.value === "Alle Genres" ? "" : e.target.value })
          }
          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-cyan-500"
        >
          {GENRES.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
      </div>

      {/* Harmonic Camelot Key Selector */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 font-bold">
            Camelot Tonart
          </span>
          {filters.camelotKey && (
            <button
              onClick={() => onFilterChange({ camelotKey: "" })}
              className="text-[10px] text-cyan-400 hover:underline"
            >
              Reset
            </button>
          )}
        </div>
        <div className="grid grid-cols-4 gap-1 max-h-36 overflow-y-auto p-1 bg-zinc-900/50 rounded-lg border border-zinc-800">
          {CAMELOT_KEYS.map((k) => {
            const isSelected = filters.camelotKey === k;
            const color = getCamelotColor(k);
            return (
              <button
                key={k}
                onClick={() => onFilterChange({ camelotKey: isSelected ? "" : k })}
                className={`text-[10px] font-mono font-bold py-1 rounded transition-all border ${
                  isSelected
                    ? "text-zinc-950 shadow-sm"
                    : "text-zinc-400 hover:text-zinc-100 bg-zinc-900"
                }`}
                style={{
                  backgroundColor: isSelected ? color : undefined,
                  borderColor: isSelected ? color : `${color}40`,
                }}
              >
                {k}
              </button>
            );
          })}
        </div>
      </div>

      {/* BPM Range Slider */}
      <div>
        <div className="flex items-center justify-between mb-1.5 text-xs">
          <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 font-bold">
            BPM Range
          </span>
          <span className="font-mono text-zinc-300 text-[11px]">
            {filters.bpmMin} - {filters.bpmMax}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min="115"
            max="180"
            value={filters.bpmMax}
            onChange={(e) => onFilterChange({ bpmMax: parseInt(e.target.value, 10) })}
            className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-cyan-500"
          />
        </div>
      </div>
    </aside>
  );
};
