"""
Colab Modul - Demucs Processing
Feature Branch: feature/colab-stem-separation
"""
from .demucs_processor import DemucsProcessor, check_gpu, separate_track

__all__ = ["DemucsProcessor", "check_gpu", "separate_track"]
