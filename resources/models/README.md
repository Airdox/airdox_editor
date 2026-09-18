Platzhalter – dieser Ordner wird beim Bundling mit den Stem-Gewichten gefüllt.

Erwartet werden hier (siehe `src/stems/modelCatalog.json`):

- `model_bs_roformer_ep_17_sdr_9.6568.ckpt` (ca. 503 MiB, sha256 `3e9daecd70aaed5b5a0d1f861cc4d77eaa45afb3fc6301b1cf32c1be0f5868fb`)
- `config_bs_roformer_384_8_2_485100.yaml`

Optional für den DJ-/ONNX-Pfad (schnell, ohne Python):

- `htdemucs_fp16weights.onnx` (ca. 166 MiB, opset 17, Quelle siehe
  `docs/STEM_ONNX_FASTPATH.md`)

Bündeln mit SHA256-Prüfung:

```
npm run stems:bundle                              # lädt das primäre BS-RoFormer-Modell
npm run stems:bundle -- --models htdemucs-onnx-4stem-fp16   # ONNX-Modell für den schnellen Pfad
npm run stems:bundle:check                        # prüft nur den Bestand (CI/Freigabe)
npm run stems:onnx:doctor                         # Provider/Modell/Hash + optional --bench
```

Nur der BS-RoFormer-Checkpoint hat einen gepinnten SHA256. Für das ONNX-Modell
steht im Katalog `"unverified"`; nach dem ersten Download den vom Doctor
gemeldeten Hash dort eintragen, damit Bundling und Lauf ihn prüfen.

Die README bleibt versioniert, damit `extraResources` im Build diesen Ordner
immer vorfindet; Gewichte selbst (und `*.onnx`) sind per `.gitignore`
ausgenommen. Genaue Anleitung: `docs/STEM_BUNDLING.md` und
`docs/STEM_ONNX_FASTPATH.md`.
