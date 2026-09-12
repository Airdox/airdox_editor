/**
 * Regression coverage for the two user-facing controls that used to exist only
 * as dormant components: Smart Copilot and the collapsible edit command panel.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import App from '../../src/App';
import { ChatbotPalette } from '../../src/components/ChatbotPalette';
import type { TrackEditorContext } from '../../src/types/chatbot';

const context: TrackEditorContext = {
  title: 'Night Transit',
  artist: 'Airdox',
  bpm: 128,
  duration: 360,
  currentTime: 8,
  quantize: true,
};

function buttonByText(container: HTMLElement, label: RegExp): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((item) =>
    label.test(item.textContent ?? '')
  ) as HTMLButtonElement | undefined;
  if (!button) throw new Error(`Button ${label} nicht gefunden`);
  return button;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Smart Copilot', () => {
  it('falls back to local, actionable DJ assistance when no chat server is available', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const onExecuteAction = vi.fn();
    const { container } = render(
      <ChatbotPalette
        isOpen
        onClose={vi.fn()}
        trackContext={context}
        onExecuteAction={onExecuteAction}
      />
    );

    const input = container.querySelector('input[placeholder*="Frag Copilot"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Zoome auf 8 Takte' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(container.textContent).toContain('Zoom-Aktion'));
    expect(container.textContent).toContain('Auf 8 BARS zoomen');

    const execute = Array.from(container.querySelectorAll('button')).find(
      (button) =>
        /^Ausführen$/.test(button.textContent ?? '') &&
        (button.parentElement?.parentElement?.textContent ?? '').includes('Auf 8 BARS zoomen')
    ) as HTMLButtonElement | undefined;
    expect(execute).toBeTruthy();
    fireEvent.click(execute!);
    expect(onExecuteAction).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SET_ZOOM', params: expect.objectContaining({ preset: '8_BARS' }) })
    );
  });
});

describe('App workspace controls', () => {
  it('exposes the Smart Copilot and collapses or expands the edit command panel via button and E', () => {
    const { container } = render(<App />);

    fireEvent.click(buttonByText(container, /AI COPILOT/));
    expect(container.textContent).toContain('DJ SMART COPILOT');

    const panelToggle = container.querySelector(
      'button[title*="Editierpalette unten ein-/ausklappen"]'
    ) as HTMLButtonElement;
    expect(panelToggle).toBeTruthy();
    fireEvent.click(panelToggle);
    expect(container.textContent).toContain('EDITIERPALETTE');
    expect(container.querySelector('button[title*="Editierpalette einklappen"]')).toBeNull();

    fireEvent.keyDown(window, { code: 'KeyE' });
    expect(container.querySelector('button[title*="Editierpalette einklappen"]')).toBeTruthy();
  });
});
