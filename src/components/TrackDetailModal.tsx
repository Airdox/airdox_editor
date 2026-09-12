import React, { useState } from "react";
import {
  X,
  Link2,
  ShieldCheck,
  Play,
  Flame,
  Star,
  Plus,
  Trash2,
  ExternalLink,
  Music,
  ArrowRight,
  Disc,
} from "lucide-react";
import { DJTrack, TrackLink, MixTransitionType } from "../types";
import { getCamelotColor, parseCamelot } from "../utils/harmonicUtils";

interface TrackDetailModalProps {
  track: DJTrack | null;
  allTracks: DJTrack[];
  links: TrackLink[];
  onClose: () => void;
  onSaveLink: (link: Partial<TrackLink>) => void;
  onDeleteLink: (linkId: string) => void;
  onLoadPairToDecks: (trackA: DJTrack, trackB: DJTrack) => void;
  onUpdateTrackMetadata: (trackId: string, updates: Partial<DJTrack>) => void;
}

const TRANSITION_TYPES: { id: MixTransitionType; label: string; desc: string }[] = [
  { id: "smooth_blend", label: "Smooth 32-Beat Blend", desc: "Langes, sanftes Überblenden von Bässen und Mitten" },
  { id: "drop_swap", label: "Drop Swap / Hard Cut", desc: "Direktes Umschalten beim Drop ohne Reverb-Verlust" },
  { id: "bassline_switch", label: "Bassline Switch", desc: "Tiefbass-Tausch bei Takt 16 oder 32" },
  { id: "breakdown_cut", label: "Breakdown Cut & Echo", desc: "Abfangen im Breakdown mit Echo-Out" },
  { id: "energy_boost", label: "Energy Boost (+1 Key)", desc: "Harmonischer Energiesprung für die Peak Time" },
  { id: "vocal_over_dub", label: "Vocal Over Dub", desc: "Acapella/Vocal über den Instrumental-Part legen" },
  { id: "custom", label: "Custom Mix", desc: "Eigene DJ-Technik" },
];

export const TrackDetailModal: React.FC<TrackDetailModalProps> = ({
  track,
  allTracks,
  links,
  onClose,
  onSaveLink,
  onDeleteLink,
  onLoadPairToDecks,
  onUpdateTrackMetadata,
}) => {
  if (!track) return null;

  // Filter existing links for this track
  const trackLinks = links.filter(
    (l) => l.sourceTrackId === track.id || l.targetTrackId === track.id
  );

  // New Link form state
  const [showAddForm, setShowAddForm] = useState(false);
  const [targetTrackId, setTargetTrackId] = useState("");
  const [mixType, setMixType] = useState<MixTransitionType>("smooth_blend");
  const [notes, setNotes] = useState("");
  const [rating, setRating] = useState(5);

  // Non-destructive tags state
  const [newTagInput, setNewTagInput] = useState("");

  const handleCreateLink = (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetTrackId) return;

    onSaveLink({
      sourceTrackId: track.id,
      targetTrackId,
      mixType,
      notes: notes || "Harmonischer Übergang",
      rating,
      createdAt: new Date().toISOString().split("T")[0],
    });

    setShowAddForm(false);
    setTargetTrackId("");
    setNotes("");
  };

  const handleAddTag = () => {
    if (!newTagInput.trim()) return;
    const updatedTags = Array.from(new Set([...track.tags, newTagInput.trim()]));
    onUpdateTrackMetadata(track.id, { tags: updatedTags });
    setNewTagInput("");
  };

  const handleRemoveTag = (tagToRemove: string) => {
    const updatedTags = track.tags.filter((t) => t !== tagToRemove);
    onUpdateTrackMetadata(track.id, { tags: updatedTags });
  };

  const camelot = parseCamelot(track.camelotKey);

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-zinc-950 border border-zinc-800 rounded-2xl w-full max-w-4xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/50">
          <div className="flex items-center gap-3">
            <div
              className="w-3.5 h-10 rounded-full"
              style={{ backgroundColor: getCamelotColor(track.camelotKey) }}
            />
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-black text-zinc-100">{track.title}</h2>
                {track.remix && (
                  <span className="text-xs text-zinc-400 font-semibold">
                    ({track.remix})
                  </span>
                )}
                <span
                  className="px-2 py-0.5 rounded text-xs font-mono font-bold border"
                  style={{
                    backgroundColor: `${getCamelotColor(track.camelotKey)}20`,
                    borderColor: `${getCamelotColor(track.camelotKey)}80`,
                    color: getCamelotColor(track.camelotKey),
                  }}
                >
                  {track.camelotKey} ({track.musicalKey})
                </span>
                <span className="px-2 py-0.5 rounded text-xs font-mono font-bold bg-zinc-800 text-zinc-300 border border-zinc-700">
                  {track.bpm} BPM
                </span>
              </div>
              <p className="text-xs text-zinc-400 font-medium">{track.artist}</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Non-Destructive Protection Guarantee Badge */}
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-950/60 border border-emerald-800 text-emerald-300 text-xs font-medium">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <span>Nur Lesezugriff (Quelldatei unverändert)</span>
            </div>

            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto flex flex-col gap-6 flex-1">
          {/* Zoomed Interactive Waveform Display */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex flex-col gap-2">
            <div className="flex items-center justify-between text-xs font-mono text-zinc-400">
              <span className="font-bold text-zinc-200">GROSSE WELLENFORM &amp; CUE POINTS</span>
              <span>Dauer: {Math.floor(track.duration / 60)}:{String(track.duration % 60).padStart(2, "0")} min</span>
            </div>

            <div className="h-24 bg-zinc-950 rounded-lg border border-zinc-800 p-2 flex items-center gap-0.5 relative overflow-hidden">
              {track.waveformPeaks.map((peak, i) => (
                <div
                  key={i}
                  className="flex-1 bg-gradient-to-t from-cyan-600 to-cyan-400 rounded-full"
                  style={{ height: `${Math.max(12, peak * 100)}%` }}
                />
              ))}

              {/* Cue Point Markers */}
              {track.hotCues.map((cue) => {
                const leftPct = (cue.time / track.duration) * 100;
                return (
                  <div
                    key={cue.id}
                    className="absolute top-0 bottom-0 flex flex-col items-center pointer-events-none"
                    style={{ left: `${leftPct}%` }}
                  >
                    <span
                      className="px-1 py-0.5 rounded text-[9px] font-mono font-bold text-zinc-950 shadow-md"
                      style={{ backgroundColor: cue.color }}
                    >
                      {cue.slot}
                    </span>
                    <div
                      className="w-0.5 flex-1 shadow-sm"
                      style={{ backgroundColor: cue.color }}
                    />
                  </div>
                );
              })}
            </div>

            {/* Cue Point List */}
            <div className="grid grid-cols-4 gap-2 mt-1">
              {track.hotCues.map((cue) => (
                <div
                  key={cue.id}
                  className="px-2.5 py-1.5 rounded-lg bg-zinc-950 border border-zinc-800 flex items-center justify-between text-xs"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="w-2.5 h-2.5 rounded-full"
                      style={{ backgroundColor: cue.color }}
                    />
                    <span className="font-medium text-zinc-200">{cue.name}</span>
                  </div>
                  <span className="font-mono text-zinc-500 text-[10px]">
                    {Math.floor(cue.time / 60)}:{String(Math.floor(cue.time % 60)).padStart(2, "0")}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* REKORDBOX TRANSITION LINKS & MATCHES SECTION */}
          <div className="bg-gradient-to-br from-zinc-900 via-zinc-900 to-cyan-950/30 border border-cyan-900/60 rounded-xl p-5 flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Link2 className="w-5 h-5 text-cyan-400" />
                <div>
                  <h3 className="text-sm font-bold text-zinc-100">
                    Rekordbox Verknüpfungen (Track Matches)
                  </h3>
                  <p className="text-xs text-zinc-400">
                    Harmonisch getestete Übergänge, Cue-Punkte und Mix-Notizen speichern.
                  </p>
                </div>
              </div>

              <button
                onClick={() => setShowAddForm(!showAddForm)}
                className="px-3 py-1.5 rounded-lg text-xs font-bold bg-cyan-500 hover:bg-cyan-400 text-zinc-950 flex items-center gap-1.5 transition-all shadow-md shadow-cyan-500/20"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Neues Match verknüpfen</span>
              </button>
            </div>

            {/* Add New Link Inline Form */}
            {showAddForm && (
              <form
                onSubmit={handleCreateLink}
                className="bg-zinc-950 border border-cyan-800/80 rounded-xl p-4 flex flex-col gap-3 animate-in fade-in duration-150"
              >
                <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
                  <span className="text-xs font-bold text-cyan-400">
                    Verknüpfung mit Partner-Track anlegen
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowAddForm(false)}
                    className="text-zinc-500 hover:text-zinc-300"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="text-[11px] font-mono text-zinc-400 block mb-1">
                      Partner-Track auswählen
                    </label>
                    <select
                      value={targetTrackId}
                      onChange={(e) => setTargetTrackId(e.target.value)}
                      required
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-cyan-500"
                    >
                      <option value="">-- Track auswählen --</option>
                      {allTracks
                        .filter((t) => t.id !== track.id)
                        .map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.title} - {t.artist} ({t.camelotKey} • {t.bpm} BPM)
                          </option>
                        ))}
                    </select>
                  </div>

                  <div>
                    <label className="text-[11px] font-mono text-zinc-400 block mb-1">
                      Übergangs-Technik
                    </label>
                    <select
                      value={mixType}
                      onChange={(e) => setMixType(e.target.value as MixTransitionType)}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-cyan-500"
                    >
                      {TRANSITION_TYPES.map((type) => (
                        <option key={type.id} value={type.id}>
                          {type.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="text-[11px] font-mono text-zinc-400 block mb-1">
                    Übergangs-Notizen (z.B. Cue-Zeiten, Bass-Cut, Loop-Länge)
                  </label>
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="z.B. Bei Min 4:20 Outro starten, 16 Beats Loopen, Bassline bei Drop 2 direkt tauschen..."
                    rows={2}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-cyan-500"
                  />
                </div>

                <div className="flex items-center justify-between pt-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-mono text-zinc-400">
                      Übergangs-Bewertung:
                    </span>
                    <div className="flex items-center gap-1">
                      {[1, 2, 3, 4, 5].map((star) => (
                        <button
                          key={star}
                          type="button"
                          onClick={() => setRating(star)}
                          className="text-amber-400"
                        >
                          <Star
                            className={`w-4 h-4 ${
                              star <= rating ? "fill-amber-400" : "text-zinc-700"
                            }`}
                          />
                        </button>
                      ))}
                    </div>
                  </div>

                  <button
                    type="submit"
                    className="px-4 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-zinc-950 font-bold text-xs"
                  >
                    Verknüpfung speichern
                  </button>
                </div>
              </form>
            )}

            {/* List of Existing Links */}
            <div className="flex flex-col gap-2.5">
              {trackLinks.length === 0 ? (
                <div className="p-6 border border-dashed border-zinc-800 rounded-xl text-center text-zinc-500 text-xs">
                  Noch keine Verknüpfungen für diesen Track hinterlegt. Klicke auf "Neues Match verknüpfen", um den perfekten Übergang zu dokumentieren!
                </div>
              ) : (
                trackLinks.map((link) => {
                  const partnerId =
                    link.sourceTrackId === track.id ? link.targetTrackId : link.sourceTrackId;
                  const partnerTrack = allTracks.find((t) => t.id === partnerId);
                  if (!partnerTrack) return null;

                  return (
                    <div
                      key={link.id}
                      className="bg-zinc-950/80 border border-zinc-800 hover:border-cyan-800/60 rounded-xl p-4 flex flex-col gap-2 transition-all shadow-sm"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <div
                            className="w-2.5 h-8 rounded-full"
                            style={{ backgroundColor: getCamelotColor(partnerTrack.camelotKey) }}
                          />
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-zinc-100 text-sm">
                                {partnerTrack.title}
                              </span>
                              <span
                                className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold"
                                style={{
                                  backgroundColor: `${getCamelotColor(partnerTrack.camelotKey)}20`,
                                  color: getCamelotColor(partnerTrack.camelotKey),
                                }}
                              >
                                {partnerTrack.camelotKey}
                              </span>
                              <span className="text-xs font-mono text-zinc-400">
                                {partnerTrack.bpm} BPM
                              </span>
                            </div>
                            <p className="text-xs text-zinc-400">{partnerTrack.artist}</p>
                          </div>
                        </div>

                        {/* Actions for this link */}
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => onLoadPairToDecks(track, partnerTrack)}
                            className="px-3 py-1.5 rounded-lg bg-cyan-950/80 hover:bg-cyan-900 border border-cyan-800 text-cyan-300 font-bold font-mono text-xs flex items-center gap-1.5 transition-colors"
                            title="Lade Track A auf Deck 1 und Partner auf Deck 2"
                          >
                            <Disc className="w-3.5 h-3.5 text-cyan-400" />
                            <span>Auf Decks 1 &amp; 2 laden</span>
                          </button>
                          <button
                            onClick={() => onDeleteLink(link.id)}
                            className="p-1.5 rounded-lg text-zinc-600 hover:text-red-400 hover:bg-red-950/40 transition-colors"
                            title="Verknüpfung löschen"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>

                      {/* Transition Notes & Type */}
                      <div className="bg-zinc-900/60 rounded-lg p-2.5 border border-zinc-800/60 flex items-center justify-between text-xs">
                        <div className="flex items-center gap-2">
                          <span className="px-2 py-0.5 rounded bg-zinc-800 text-cyan-300 text-[10px] font-mono font-bold">
                            {TRANSITION_TYPES.find((t) => t.id === link.mixType)?.label || link.mixType}
                          </span>
                          <span className="text-zinc-300 text-xs italic">
                            "{link.notes}"
                          </span>
                        </div>

                        <div className="flex items-center gap-0.5">
                          {Array.from({ length: 5 }).map((_, i) => (
                            <Star
                              key={i}
                              className={`w-3 h-3 ${
                                i < link.rating
                                  ? "fill-amber-400 text-amber-400"
                                  : "text-zinc-700"
                              }`}
                            />
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Non-Destructive Performance Tags & DJ Notes */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Custom Tags */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex flex-col gap-3">
              <span className="text-xs font-bold font-mono text-zinc-300">
                PERFORMANCE TAGS (Nicht-destruktiv)
              </span>
              <div className="flex flex-wrap gap-1.5">
                {track.tags.map((tag) => (
                  <span
                    key={tag}
                    className="px-2 py-1 rounded-md bg-zinc-950 border border-zinc-700 text-xs text-zinc-200 flex items-center gap-1.5"
                  >
                    <span>{tag}</span>
                    <button
                      onClick={() => handleRemoveTag(tag)}
                      className="text-zinc-500 hover:text-red-400"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex items-center gap-2 mt-auto">
                <input
                  type="text"
                  placeholder="Neuer Tag (z.B. Peak Time, Vocal Drop)..."
                  value={newTagInput}
                  onChange={(e) => setNewTagInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddTag()}
                  className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-cyan-500"
                />
                <button
                  onClick={handleAddTag}
                  className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-bold"
                >
                  Hinzufügen
                </button>
              </div>
            </div>

            {/* Read-Only File Protection Info */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex flex-col justify-between gap-3">
              <span className="text-xs font-bold font-mono text-zinc-300">
                DATEISYSTEM &amp; SCHUTZ-STATUS
              </span>
              <div className="bg-zinc-950 p-3 rounded-lg border border-zinc-800 text-xs font-mono text-zinc-400 break-all leading-relaxed">
                <span className="text-zinc-500 block text-[10px]">ORIGINALPFAD:</span>
                {track.filePath}
              </div>
              <div className="flex items-center gap-2 text-xs text-emerald-400 font-medium">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                <span>Originaldatei bleibt 100% unberührt. Alle Matches liegen in der Airdox-Datenbank.</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
