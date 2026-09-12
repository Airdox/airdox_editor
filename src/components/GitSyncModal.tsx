import React, { useState, useEffect } from "react";
import {
  X,
  GitBranch,
  UploadCloud,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  FolderGit2,
  Terminal,
} from "lucide-react";

interface GitSyncModalProps {
  onClose: () => void;
}

export const GitSyncModal: React.FC<GitSyncModalProps> = ({ onClose }) => {
  const [gitStatus, setGitStatus] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isPushing, setIsPushing] = useState(false);
  const [pushResult, setPushResult] = useState<any>(null);

  const fetchStatus = async () => {
    setIsLoading(true);
    try {
      const res = await fetch("/api/git/status");
      const data = await res.json();
      setGitStatus(data);
    } catch (err: any) {
      console.error("Git status error:", err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  const handlePush = async () => {
    setIsPushing(true);
    setPushResult(null);
    try {
      const res = await fetch("/api/git/push", { method: "POST" });
      const data = await res.json();
      setPushResult(data);
      fetchStatus();
    } catch (err: any) {
      setPushResult({ success: false, error: err.message || "Push failed" });
    } finally {
      setIsPushing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 select-none">
      <div className="bg-zinc-950 border border-zinc-800 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/60">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-orange-950/80 border border-orange-800 text-orange-400 flex items-center justify-center">
              <GitBranch className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-zinc-100">
                GitHub Synchronisation &amp; Quellcodeverwaltung
              </h3>
              <p className="text-[11px] text-zinc-500">
                Clean Repository Management für Airdox
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 flex flex-col gap-4">
          {/* Status Overview */}
          <div className="bg-zinc-900/70 border border-zinc-800 rounded-xl p-3.5 flex flex-col gap-2 text-xs">
            <div className="flex items-center justify-between pb-2 border-b border-zinc-800">
              <span className="text-zinc-400 font-mono">Branch:</span>
              <span className="font-bold text-cyan-400 font-mono">
                {gitStatus?.branch || "main"}
              </span>
            </div>

            <div className="flex items-center justify-between pb-2 border-b border-zinc-800">
              <span className="text-zinc-400 font-mono">Remote Repository:</span>
              <span className="text-zinc-300 font-mono text-[11px] truncate max-w-[260px]">
                github.com/Airdox/airdox_editor.git
              </span>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-zinc-400 font-mono">Repository Status:</span>
              <span
                className={`font-mono font-bold text-[11px] ${
                  gitStatus?.dirty ? "text-amber-400" : "text-emerald-400"
                }`}
              >
                {gitStatus?.dirty ? "Änderungen bereit zum Push" : "Sauber / Synchron"}
              </span>
            </div>
          </div>

          {/* Result Alert */}
          {pushResult && (
            <div
              className={`p-3 rounded-xl border text-xs flex items-start gap-2.5 ${
                pushResult.success
                  ? "bg-emerald-950/40 border-emerald-800 text-emerald-300"
                  : "bg-red-950/40 border-red-800 text-red-300"
              }`}
            >
              {pushResult.success ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              )}
              <div>
                <span className="font-bold block">
                  {pushResult.success ? "GitHub Push erfolgreich!" : "Fehler beim Push"}
                </span>
                <p className="text-[11px] mt-0.5 text-zinc-400">
                  {pushResult.message || pushResult.error}
                </p>
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex items-center justify-between pt-2">
            <button
              onClick={fetchStatus}
              disabled={isLoading}
              className="px-3 py-2 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 text-xs font-mono flex items-center gap-1.5 transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
              <span>Status prüfen</span>
            </button>

            <button
              onClick={handlePush}
              disabled={isPushing}
              className="px-4 py-2 rounded-lg bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white font-bold text-xs flex items-center gap-2 shadow-lg shadow-orange-950/40 transition-all"
            >
              <UploadCloud className={`w-4 h-4 ${isPushing ? "animate-bounce" : ""}`} />
              <span>{isPushing ? "Pushe zu GitHub..." : "Zu GitHub pushen"}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
