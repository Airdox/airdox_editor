#!/usr/bin/env python3
"""Erzeugt das ONNX-Test-Fixture `tests/fixtures/onnx/tiny-stem-separator.onnx`.

Warum ein eigenes Fixture?
  Die ONNX-Separation darf nicht erst auf dem Zielrechner geprüft werden.
  Dieses Modell bildet die *I/O-Signatur* des echten HT-Demucs-ONNX-Exports
  nach – Eingang `mix` (1, 2, N) float32, Ausgang `stems` (1, 4, 2, N) float32,
  Reihenfolge drums/bass/other/vocals – und ist deterministisch:

      stems[i] = mix * gain[i]        gain = [0.50, 0.30, 0.15, 0.05]

  Damit lässt sich jede Eigenschaft der Pipeline prüfen (Tensor-Packing,
  Segment-Overlap-Add, Stem-Reihenfolge, In-Memory-Pfad, Abbruch), ohne
  316 MB Gewichte herunterzuladen. Die Gains sind bewusst so gewählt, dass
  ein vertauschtes Stem-Mapping sofort auffällt.

Aufruf (nur nötig, wenn das Fixture neu erzeugt werden soll):

    python3 tests/fixtures/onnx/make_tiny_stem_separator.py

Das Ergebnis ist eingecheckt, `npm test` braucht kein Python und kein ONNX-Paket.
"""
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

SEGMENT = 4096  # kleine Segmente: Tests laufen in Millisekunden
CHANNELS = 2
STEMS = 4
GAINS = [0.50, 0.30, 0.15, 0.05]
OUT = Path(__file__).with_name("tiny-stem-separator.onnx")


def build() -> onnx.ModelProto:
    mix = helper.make_tensor_value_info("mix", TensorProto.FLOAT, [1, CHANNELS, SEGMENT])
    stems = helper.make_tensor_value_info("stems", TensorProto.FLOAT, [1, STEMS, CHANNELS, SEGMENT])

    initializers = []
    nodes = []
    for index, gain in enumerate(GAINS):
        name = f"gain_{index}"
        initializers.append(
            numpy_helper.from_array(np.asarray([gain], dtype=np.float32), name=name)
        )
        nodes.append(
            helper.make_node("Mul", ["mix", name], [f"stem_{index}"], name=f"scale_{index}")
        )
    nodes.append(
        helper.make_node(
            "Concat",
            [f"stem_{index}" for index in range(STEMS)],
            ["stacked"],
            axis=1,
            name="stack_stems",
        )
    )
    initializers.append(
        numpy_helper.from_array(
            np.asarray([1, STEMS, CHANNELS, -1], dtype=np.int64), name="out_shape"
        )
    )
    nodes.append(helper.make_node("Reshape", ["stacked", "out_shape"], ["stems"], name="reshape_stems"))

    graph = helper.make_graph(nodes, "tiny-stem-separator", [mix], [stems], initializer=initializers)
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    model.producer_name = "airdox-test-fixture"
    model.doc_string = "Deterministisches HT-Demucs-Signatur-Double für die ONNX-Pipeline-Tests."
    onnx.checker.check_model(model)
    return model


def main() -> None:
    model = build()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(model, OUT)
    print(f"geschrieben: {OUT} ({OUT.stat().st_size} Bytes)")
    print(f"  Eingang  mix   (1, {CHANNELS}, {SEGMENT})  float32")
    print(f"  Ausgang  stems (1, {STEMS}, {CHANNELS}, {SEGMENT})  float32, Gains {GAINS}")


if __name__ == "__main__":
    main()
