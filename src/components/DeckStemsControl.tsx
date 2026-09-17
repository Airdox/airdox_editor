import React, { useState, useEffect } from 'react';
import { getModelCatalog, selectModelForProfile } from '../stems/modelRegistry';
import type { StemProfile } from '../stems/types';

interface Props {
  trackName?: string;
  inputPath?: string;
  onSeparate?: (stems: { id: string; filePath: string }[]) => void;
}

export const DeckStemsControl: React.FC<Props> = ({ trackName, inputPath, onSeparate }) => {
  const [profile, setProfile] = useState<StemProfile>('HIGH_QUALITY');
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [progress, setProgress] = useState(0);
  const [stems, setStems] = useState<{ id: string; filePath: string }[]>([]);
  const [models, setModels] = useState<{ id: string; displayName: string }[]>([]);

  useEffect(() => {
    try {
      const catalog = getModelCatalog();
      setModels(catalog.models.map(m => ({ id: m.id, displayName: m.displayName })));
    } catch {}
  }, []);

  const selectedModel = (() => {
    try {
      return selectModelForProfile(profile);
    } catch {
      return null;
    }
  })();

  const handleSeparate = async () => {
    if (!inputPath) return;
    setStatus('running');
    setProgress(0);
    try {
      // @ts-ignore
      const engine = (window as any).stemEngine;
      if (engine) {
        const off = engine.onJobProgress?.((data: any) => {
          setProgress(data.percent || 0);
        });
        const result = await engine.separate({ inputPath, profile, trackName });
        off?.();
        setStems(result.stems || []);
        setStatus('done');
        onSeparate?.(result.stems || []);
      } else {
        throw new Error('Stem engine not available');
      }
    } catch (e) {
      console.error(e);
      setStatus('error');
    }
  };

  const handleCancel = () => {
    try {
      // @ts-ignore
      (window as any).stemEngine?.cancelJob?.('current');
    } catch {}
    setStatus('idle');
    setProgress(0);
  };

  return (
    <div className="p-3 bg-zinc-900 rounded-lg border border-zinc-800">
      <h3 className="text-sm font-semibold text-white mb-2">Stems – {trackName || 'No track'}</h3>
      <div className="flex gap-2 mb-3">
        {(['PREVIEW', 'HIGH_QUALITY', 'MAXIMUM_QUALITY'] as StemProfile[]).map((p) => {
          const model = (() => {
            try { return selectModelForProfile(p); } catch { return null; }
          })();
          return (
            <button
              key={p}
              onClick={() => setProfile(p)}
              className={`px-2 py-1 text-xs rounded ${profile === p ? 'bg-blue-600 text-white' : 'bg-zinc-800 text-zinc-400'}`}
              title={model?.displayName}
            >
              {p} {model ? `· ${model.displayName.slice(0, 20)}` : ''}
            </button>
          );
        })}
      </div>
      {selectedModel && (
        <div className="text-xs text-zinc-400 mb-2">
          Model: {selectedModel.displayName} – Stems: {selectedModel.stemOrder.join(', ')} – Backend: {selectedModel.backend}
        </div>
      )}
      <div className="flex gap-2">
        <button
          onClick={handleSeparate}
          disabled={status === 'running' || !inputPath}
          className="px-3 py-1 bg-green-600 text-white rounded text-sm disabled:opacity-50"
        >
          {status === 'running' ? `Separating ${progress}%` : 'Separate'}
        </button>
        {status === 'running' && (
          <button onClick={handleCancel} className="px-3 py-1 bg-red-600 text-white rounded text-sm">
            Cancel
          </button>
        )}
      </div>
      {stems.length > 0 && (
        <div className="mt-3">
          <div className="text-xs text-zinc-300">Separated stems:</div>
          <ul className="text-xs text-zinc-400">
            {stems.map(s => (
              <li key={s.id}>{s.id}: {s.filePath}</li>
            ))}
          </ul>
        </div>
      )}
      {models.length > 0 && (
        <div className="mt-2 text-[10px] text-zinc-500">
          Available models: {models.map(m => m.id).join(', ')}
        </div>
      )}
    </div>
  );
};

export default DeckStemsControl;
