/**
 * @license
 * About Modal
 * Shows the application name, version and build time.
 */

import React from 'react';
import { X } from 'lucide-react';
import { APP_NAME, APP_VERSION, APP_BUILD_TIME } from '../../version';

interface AboutModalProps {
  onClose: () => void;
}

export const AboutModal: React.FC<AboutModalProps> = ({ onClose }) => {
  let buildTime = APP_BUILD_TIME;
  try {
    buildTime = new Date(APP_BUILD_TIME).toLocaleString('de-DE');
  } catch {
    /* keep raw value */
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[100]">
      <div className="w-[420px] bg-[#16171b] border border-[#2b2d35] rounded-md shadow-2xl text-neutral-200">
        <div className="flex items-center justify-between px-4 h-9 border-b border-[#2b2d35]">
          <span className="text-[12px] font-semibold">Über {APP_NAME}</span>
          <button
            onClick={onClose}
            className="text-neutral-400 hover:text-white"
            title="Schließen"
          >
            <X size={14} />
          </button>
        </div>

        <div className="px-5 py-5 space-y-4">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-full border border-neutral-400 flex items-center justify-center">
              <div className="w-4 h-4 rounded-full bg-white" />
            </div>
            <div>
              <div className="text-[15px] font-semibold text-white">{APP_NAME}</div>
              <div className="text-[11.5px] text-neutral-400">Version {APP_VERSION}</div>
            </div>
          </div>

          <div className="text-[11.5px] text-neutral-400 space-y-1">
            <div className="flex justify-between">
              <span>Version</span>
              <span className="text-neutral-200 font-mono">{APP_VERSION}</span>
            </div>
            <div className="flex justify-between">
              <span>Build</span>
              <span className="text-neutral-200 font-mono">{buildTime}</span>
            </div>
          </div>

          <p className="text-[11px] text-neutral-500 leading-relaxed">
            Nicht-destruktiver Audio-Editor für Rekordbox-Bibliotheken. Originaldateien
            werden niemals verändert – alle Bearbeitungen bleiben in der Projektdatei.
          </p>
        </div>

        <div className="px-5 pb-4 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-[11.5px] rounded bg-[#0088ff] hover:bg-[#3aa0ff] text-white"
          >
            Schließen
          </button>
        </div>
      </div>
    </div>
  );
};
