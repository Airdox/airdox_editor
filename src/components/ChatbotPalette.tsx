/**
 * @license
 * airdox DJ Smart Copilot - Pop-up Window Adapter
 * Wraps and delegates to the dedicated ChatbotModal pop-up window with rich visual intelligence.
 */

import React from 'react';
import { ChatbotModal } from './ChatbotModal';
import { ChatbotAction, TrackEditorContext } from '../types/chatbot';
import { TrackModel } from '../types/rekordbox';

export interface ChatbotPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  trackContext: TrackEditorContext;
  onExecuteAction: (action: ChatbotAction) => void;
  onSelectZoomPreset?: (preset: any) => void;
  activeTrack?: TrackModel | null;
  currentTime?: number;
  onSeek?: (time: number) => void;
}

export const ChatbotPalette: React.FC<ChatbotPaletteProps> = ({
  isOpen,
  onClose,
  trackContext,
  onExecuteAction,
  onSelectZoomPreset,
  activeTrack = null,
  currentTime = 0,
  onSeek = () => {},
}) => {
  return (
    <ChatbotModal
      isOpen={isOpen}
      onClose={onClose}
      trackContext={trackContext}
      activeTrack={activeTrack}
      currentTime={currentTime}
      onSeek={onSeek}
      onExecuteAction={onExecuteAction}
      onSelectZoomPreset={onSelectZoomPreset}
    />
  );
};
