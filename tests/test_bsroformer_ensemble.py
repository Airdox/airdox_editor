"""Regression for shifted ensemble normalization in the Python adapter."""
import contextlib
import io
import importlib.util
import pathlib
import sys
import types
import unittest

import numpy as np


class FakeTensor:
    def __init__(self, values):
        self.values = np.asarray(values)

    def float(self):
        return self

    def unsqueeze(self, axis):
        return FakeTensor(np.expand_dims(self.values, axis))

    def to(self, *args, **kwargs):
        return self

    def cpu(self):
        return self

    def numpy(self):
        return self.values


fake_torch = types.ModuleType("torch")
fake_torch.Tensor = FakeTensor
fake_torch.float16 = "float16"
fake_torch.bfloat16 = "bfloat16"
fake_torch.from_numpy = FakeTensor
fake_torch.inference_mode = contextlib.nullcontext
fake_torch.set_num_threads = lambda count: None
fake_torch.cuda = types.SimpleNamespace(is_available=lambda: False)

adapter_path = pathlib.Path(__file__).resolve().parents[1] / "python" / "bsroformer_inference.py"
spec = importlib.util.spec_from_file_location("airdox_bsroformer_adapter", adapter_path)
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class EnsembleTest(unittest.TestCase):
    def test_explicit_cuda_never_falls_back_to_cpu(self):
        previous = sys.modules.get("torch")
        sys.modules["torch"] = fake_torch
        out = io.StringIO()
        try:
            with contextlib.redirect_stdout(out):
                code = adapter.main(["--family", "bs_roformer", "--checkpoint", "missing.ckpt",
                                     "--input", "missing.wav", "--output-dir", "unused",
                                     "--stem-order", "drums,bass,other,vocals", "--chunk-size", "1024",
                                     "--device", "cuda"])
        finally:
            if previous is None:
                del sys.modules["torch"]
            else:
                sys.modules["torch"] = previous
        self.assertEqual(code, adapter.EXIT_MODEL)
        self.assertIn('"code": "GPU_UNAVAILABLE"', out.getvalue())

    def test_three_passes_do_not_triple_amplitude(self):
        config = types.SimpleNamespace(audio=types.SimpleNamespace(sample_rate=44100),
                                       model=types.SimpleNamespace(num_stems=1))
        args = types.SimpleNamespace(chunk_size=1024, num_overlap=4, ensemble_passes=3,
                                     precision="f32", sample_rate=44100)
        mix = np.ones((2, 4096), dtype=np.float32)

        def identity_model(tensor):
            return FakeTensor(tensor.values[:, None, :, :])

        previous = sys.modules.get("torch")
        sys.modules["torch"] = fake_torch
        try:
            output, rate = adapter.run_inference(identity_model, mix, args, config, "cpu", 0, 1)
        finally:
            if previous is None:
                del sys.modules["torch"]
            else:
                sys.modules["torch"] = previous
        self.assertEqual(rate, 44100)
        self.assertEqual(output.shape, (1, 2, 4096))
        self.assertLessEqual(float(output.max()), 1.01)
        self.assertGreater(float(output.mean()), 0.95)


if __name__ == "__main__":
    unittest.main()
