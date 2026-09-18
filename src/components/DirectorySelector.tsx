/**
 * @license
 * DirectorySelector Component
 * Provides a dropdown of preset directories and a direct button to select
 * any folder via the native file explorer (Electron dialog) with graceful fallback.
 */

import React, { useCallback, useId } from 'react';
import { Folder, HardDrive, Check, ChevronDown, Compass } from 'lucide-react';

export interface DirectoryPreset {
  id: string;
  label: string;
  path: string;
  description?: string;
}

export interface DirectorySelectorProps {
  label: string;
  value: string;
  onChange: (path: string) => void;
  presets: DirectoryPreset[];
  dialogTitle: string;
  helperText?: string;
  icon?: React.ReactNode;
  badgeText?: string;
  className?: string;
}

export const DirectorySelector: React.FC<DirectorySelectorProps> = ({
  label,
  value,
  onChange,
  presets,
  dialogTitle,
  helperText,
  icon,
  badgeText,
  className = '',
}) => {
  const selectId = useId();

  // Find if current value matches any preset
  const matchedPreset = presets.find(
    (p) => p.path.toLowerCase() === (value || '').trim().toLowerCase()
  );

  const handlePresetChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const selectedId = e.target.value;
      if (selectedId === '__custom__') {
        // Keep current custom value
        return;
      }
      const found = presets.find((p) => p.id === selectedId);
      if (found) {
        onChange(found.path);
      }
    },
    [presets, onChange]
  );

  const handleBrowseExplorer = useCallback(async () => {
    if (typeof window !== 'undefined' && window.rekordboxDesktop?.chooseDirectory) {
      try {
        const chosen = await window.rekordboxDesktop.chooseDirectory({
          title: dialogTitle,
          defaultPath: value.startsWith('~') ? undefined : value,
        });
        if (chosen) {
          onChange(chosen);
        }
      } catch (err) {
        console.warn('Native folder chooser error:', err);
      }
    } else {
      // Browser fallback: prompt
      const manual = window.prompt(dialogTitle, value);
      if (manual) {
        onChange(manual.trim());
      }
    }
  }, [dialogTitle, value, onChange]);

  return (
    <div className={`space-y-2 bg-[#0c0e14] border border-[#202434] rounded-xs p-3 ${className}`}>
      {/* Header with Label and Preset Badge */}
      <div className="flex items-center justify-between">
        <label htmlFor={selectId} className="text-neutral-200 font-semibold text-[11px] flex items-center gap-1.5">
          {icon || <HardDrive size={12} className="text-[#00c8ff]" />}
          <span>{label}</span>
        </label>
        {badgeText && (
          <span className="text-[9.5px] font-mono text-[#00c8ff] bg-[#00c8ff]/10 border border-[#00c8ff]/30 px-1.5 py-0.2 rounded">
            {badgeText}
          </span>
        )}
      </div>

      {/* Preset Dropdown & Explorer Button in 1 compact grid */}
      <div className="grid grid-cols-1 sm:grid-cols-12 gap-2">
        {/* Preset Dropdown */}
        <div className="sm:col-span-8 relative">
          <select
            id={selectId}
            value={matchedPreset ? matchedPreset.id : '__custom__'}
            onChange={handlePresetChange}
            className="w-full bg-[#141722] border border-[#2b3044] hover:border-[#3b4360] focus:border-[#0088ff] text-neutral-200 text-xs rounded px-2.5 py-1.5 outline-none appearance-none cursor-pointer pr-7 transition-colors"
          >
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label} ({preset.path})
              </option>
            ))}
            {!matchedPreset && (
              <option value="__custom__">
                Eigener Pfad ({value || 'Auswählen…'})
              </option>
            )}
          </select>
          <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-neutral-400">
            <ChevronDown size={13} />
          </div>
        </div>

        {/* Native Explorer Button */}
        <button
          type="button"
          onClick={handleBrowseExplorer}
          className="sm:col-span-4 flex items-center justify-center space-x-1.5 px-3 py-1.5 rounded bg-[#1c2234] hover:bg-[#27304a] text-[#00c8ff] hover:text-white border border-[#2f3956] text-xs font-semibold shadow-sm transition-all cursor-pointer group"
          title="Verzeichnis im Datei-Explorer / Finder auswählen"
        >
          <Folder size={13} className="text-[#00c8ff] group-hover:scale-110 transition-transform" />
          <span>Explorer…</span>
        </button>
      </div>

      {/* Current Active Path Display */}
      <div className="flex items-center space-x-1.5 bg-[#07080c] border border-[#1b1e2a] rounded px-2.5 py-1 text-[10.5px] font-mono text-neutral-300">
        <Compass size={11} className="text-neutral-500 shrink-0" />
        <span className="text-neutral-500 shrink-0">Aktiver Pfad:</span>
        <span className="truncate text-white font-medium" title={value}>
          {value || '(Kein Pfad festgelegt)'}
        </span>
      </div>

      {/* Helper Text */}
      {helperText && (
        <div className="text-[10px] text-neutral-400 leading-normal">
          {helperText}
        </div>
      )}
    </div>
  );
};
