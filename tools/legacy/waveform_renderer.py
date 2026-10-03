"""
Generierung der 3-Band-RGB-Wellenform (Low, Mid, High) für DJ Airdox Editor.
"""
import numpy as np
import librosa

def generate_3band_rgb_waveform(audio_path, target_width=800):
    try:
        y, sr = librosa.load(audio_path, sr=22050, mono=True)
        S = np.abs(librosa.stft(y, n_fft=2048, hop_length=512))
        
        low_band = np.mean(S[0:24, :], axis=0)
        mid_band = np.mean(S[24:370, :], axis=0)
        high_band = np.mean(S[370:, :], axis=0)
        
        def resample_array(arr, length):
            if len(arr) == 0:
                return np.zeros(length)
            return np.interp(np.linspace(0, len(arr) - 1, length), np.arange(len(arr)), arr)
            
        return {
            "r": resample_array(low_band, target_width),
            "g": resample_array(mid_band, target_width),
            "b": resample_array(high_band, target_width)
        }
    except Exception as e:
        print(f"Wellenform-Fehler: {e}")
        return None
