/**
 * @license
 * Airdox TitleBar Component
 * Windows-style title bar with app branding, version badge and window controls
 */

import React from 'react';
import { Minus, Square, X } from 'lucide-react';
import { APP_NAME, APP_VERSION_LABEL } from '../version';

interface TitleBarProps {
  onShowAbout?: () => void;
}

export const TitleBar: React.FC<TitleBarProps> = ({ onShowAbout }) => {
  return (
    <div className="h-7 bg-[#0a0b0d] border-b border-[#18191d] flex items-center justify-between px-2 text-xs select-none z-50">
      {/* Left: Pioneer Rekordbox branding logo & name */}
      <div className="flex items-center space-x-2">
        {/* Rekordbox distinctive circle mark */}
        <div className="w-3.5 h-3.5 rounded-full border border-neutral-300 flex items-center justify-center p-0.5">
          <div className="w-1.5 h-1.5 rounded-full bg-white"></div>
        </div>
        <span className="font-semibold text-neutral-300 tracking-tight text-[11px] font-sans">
          {APP_NAME}
        </span>
        <button
          onClick={onShowAbout}
          className="px-1.5 rounded-sm text-[10px] font-mono text-neutral-500 hover:text-white hover:bg-[#202228] transition-colors"
          title={`Über ${APP_NAME}`}
        >
          {APP_VERSION_LABEL}
        </button>
      </div>

      {/* Right: Windows window controls */}
      <div className="flex items-center -mr-2 h-full">
        <button
          className="h-full px-3 hover:bg-[#202228] text-neutral-400 hover:text-white flex items-center justify-center transition-colors"
          title="Minimize"
        >
          <Minus size={12} strokeWidth={2} />
        </button>
        <button
          className="h-full px-3 hover:bg-[#202228] text-neutral-400 hover:text-white flex items-center justify-center transition-colors"
          title="Maximize"
        >
          <Square size={10} strokeWidth={2} />
        </button>
        <button
          className="h-full px-3 hover:bg-[#e81123] text-neutral-400 hover:text-white flex items-center justify-center transition-colors"
          title="Close"
        >
          <X size={12} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
};
