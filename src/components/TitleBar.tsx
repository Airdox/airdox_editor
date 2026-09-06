/**
 * @license
 * Airdox_intelligents_Editor TitleBar Component
 * Windows-style title bar with product mark and window controls
 */

import React from 'react';
import { Minus, Square, X } from 'lucide-react';
import { PRODUCT_DISPLAY_NAME, PRODUCT_NAME, PRODUCT_TAGLINE } from '../productName';

export const TitleBar: React.FC = () => {
  return (
    <div
      className="h-7 bg-[#0a0b0d] border-b border-[#18191d] flex items-center justify-between px-2 text-xs select-none z-50"
      title={PRODUCT_NAME}
    >
      {/* Left: Produktmarke – der Name kommt aus src/productName.ts */}
      <div className="flex items-center space-x-2">
        {/* Rekordbox distinctive circle mark */}
        <div className="w-3.5 h-3.5 rounded-full border border-neutral-300 flex items-center justify-center p-0.5">
          <div className="w-1.5 h-1.5 rounded-full bg-white"></div>
        </div>
        <span
          className="font-semibold text-neutral-300 tracking-tight text-[11px] font-sans"
          title={`${PRODUCT_NAME} – ${PRODUCT_TAGLINE}`}
        >
          {PRODUCT_DISPLAY_NAME}
        </span>
        <span
          className="text-[10px] leading-none text-neutral-600 font-mono pt-px"
          title={`Gebaute Fassung ${__APP_VERSION__} (package.json)`}
        >
          v{__APP_VERSION__}
        </span>
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
