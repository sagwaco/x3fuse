# Film model and data provenance

The film model is spektrafilm by Andrea Volpato
(https://github.com/andreavolpato/spektrafilm), experimental revision **28bf883**.
The renderer started from spektrafilm-rs by turbasvin
(https://github.com/turbasvin/spektrafilm-rs), v0.1.2 revision **9dd59b0**.
Source attribution and X3Fuse changes are in [../NOTICE](../NOTICE).

All 31 profiles, neutral print filters, grain presets and Hoya filter curves
are byte-identical to the experimental source under `src/spektrafilm/data/`.
The irradiance table also matches that source, named
`luts/spectral_upsampling/hanatos2025_irradiance_xy_tc.npy` upstream.
These data files retain the CC BY-SA 4.0 terms in the unmodified
[license](../licenses/SPEKTRAFILM_LICENSE.txt). No data file was modified.
`assets/stocks.json` is X3Fuse's index and matches `src/shared/film-stocks.json`.

`src/film/data.rs` samples D65, Incandescent and Kinoton 75P from Colour 0.4.7
on spektrafilm's 380..780 nm grid at 5 nm intervals. The output transforms
also use Colour's matrices and CAT02 adaptation. The source is
`colour/colorimetry/datasets/illuminants/sds.py`,
`colour/colorimetry/datasets/light_sources/sds.py` and the Colour color-space
datasets. Their BSD terms are in [../licenses/COLOUR_LICENSE.txt](../licenses/COLOUR_LICENSE.txt).

Update this file when a shader or asset changes. The license test pins all
three composed shader files and the upstream license.

## Reference values

Generate deterministic patches with the pinned experimental checkout and its
Python dependencies:

```sh
python src-tauri/crates/x3f-render/tests/experimental_reference.py /path/to/spektrafilm
python src-tauri/crates/x3f-render/tests/experimental_calibration.py /path/to/spektrafilm
python src-tauri/crates/x3f-render/tests/experimental_grain.py /path/to/spektrafilm
```

`tests/experimental_patches.json` contains linear output from the real Python
pipeline. It covers negative, reversal, cine and B&W stocks; coupler amounts
0, 0.25 and 1; film and paper contrast 0.5, 1 and 2; and sRGB, Adobe RGB and
ProPhoto RGB. Auto exposure, print exposure compensation, scanner correction,
spatial effects and stochastic effects are disabled for these patch checks.
Input and output gamut compression retain the experimental defaults.

`gpu_experimental_reference` compares those patches with the GPU pipeline.
B&W wide-gamut output is checked for equal RGB channels by the editor GPU tests,
since X3Fuse explicitly removes residual scan tint. Module tests also compare
model curves, couplers, gamut boundaries and grain calibration with independent
Python values. The grain GPU test checks statistical RMS rather than random
sample identity. Geometry, tile, crop, preview and export checks retain the
X3Fuse metering and scanner workflow.

## SHA-256

- `licenses/COLOUR_LICENSE.txt`: cd9efcd4b6ac5218189d90ffc25f9766f8411e62c5526c452145e1cc8b19baf7
- `src/gamut.wgsl`: 28e03614fc6efe2895b5c5161f04ab62d045171f9324d342df77f167f88b4158
- `src/grain.wgsl`: e333d122de0ccded56e2cc330b5c846128cf4f3292f15059b2d725db6beede9d
- `assets/presets/grain.toml`: e3537e9c987b3d9e5f916d697c3726014da4f6387d3f5aae57edc88ba54c9de6
- `licenses/NUMPY_LICENSE.txt`: 1be1df33863f97a7bc1c4d67980bd6c69c9a6fef0a5ee76e6ad6cb91e56e8491

- `assets/camera-tone-deltas.json`: 2ee2bea81844b572b08d4b5eb1e21f0905798ac571aef66038eaa33482d19144

- `src/render.wgsl`: 4b10d0ce5169a218f156d6da4485e0ff138a6b72be1bfdc8d05eec24209c46ef
- `licenses/SPEKTRAFILM_LICENSE.txt`: 76d629501783ae52e8d63aee1e054c1e1a9713b9fe7d36fb306e25b1d14b24e9
- `assets/irradiance_xy_tc.npy`: 52f90c724811f5fab80769f8548bf24d08a521eb09e65ab6e016893258d2a783
- `assets/neutral_print_filters.json`: 22ae6cca433cfbeab87df7f17cd58a2f65e88cab845818819195e6f1a80db67c
- `assets/stocks.json`: ce6053c0c3b0bc56ed0f34b81507fbbde13f4cb68d8a5bc81d8bac06ff0f9e0c
- `assets/profiles/fujifilm_c200.json`: aa32ce52ea414fdd408c20f09cc3924a50801b58de5f0c7ec76a5ffcb06f28b3
- `assets/profiles/fujifilm_crystal_archive_typeii.json`: 983ab9015bc7b4726b64a5bb937596cc215d7e411bb78bc63b431548cb25b42b
- `assets/profiles/fujifilm_pro_400h.json`: d57fe6becc8e418385d92344de1588b3b70d7e145f320ab4f89a83265a5b8c19
- `assets/profiles/fujifilm_provia_100f.json`: fed3f45ae581996b2a5b826b8b5d19ccd1a6f7854fff475aa64d2755940b9c20
- `assets/profiles/fujifilm_velvia_100.json`: fd572ea29e139145c19e21c47abd7a264c5b858b993dc463799b299b69b3731f
- `assets/profiles/fujifilm_xtra_400.json`: 7cf468b0d056262436f12ecdbdf03def3a14bbc76600551bda8f004d9b8700a1
- `assets/profiles/kodak_2302.json`: 145d7ec07f070c2985d8c5f5845206903e00a6c2a5fed39d402368acbc8252b4
- `assets/profiles/kodak_2383.json`: f61d0dbf2eb2479102add4b16c838b003742be631a32cbbe2b28c0086d339607
- `assets/profiles/kodak_2393.json`: c2f13feaaeca751a55dad689756e9110f42b306c3f741e37e1581d280ee00ebc
- `assets/profiles/kodak_doublex.json`: 4c36da545d10463b6249074bf644501082a11853aa08e8fbc1a8282b3d6709e5
- `assets/profiles/kodak_ektachrome_100.json`: dc7c5589d109f7944c0615a366368951768fb5560327379cc9d78b587866c765
- `assets/profiles/kodak_ektacolor_edge.json`: d6f9f8cdfef19e50139e90e5b800f38851de92c65e9cee1d681c6a7f1dc3918f
- `assets/profiles/kodak_ektar_100.json`: ec772dd4424c0b4e468697a8a64b37e73af765b1e6cbf050497155e80e72750f
- `assets/profiles/kodak_endura_premier.json`: bf5af37f1ee657f93e54367a212ae9f7dfa65dfea8b0bcfcc2b087b0cfb3a028
- `assets/profiles/kodak_gold_200.json`: e1fb1fb3b728c67be42524cfca77e03ebded2d53d81ca89f5f8d58bf5ab3291e
- `assets/profiles/kodak_kodachrome_64.json`: eada9c17da095730b348970513d3333bc972494e92d9e16e671d252dab61ad48
- `assets/profiles/kodak_portra_160.json`: a39036dabbda1227c9ffd1d0fb3cddc18aa7da29ae96b369301fe56516029f9f
- `assets/profiles/kodak_portra_400.json`: eb8b733fd8f79223b93ee389f1f32774378ea1905364ed658e4ce1d46ec1c069
- `assets/profiles/kodak_portra_800.json`: a9554e3f75f95dab547379401c37c6da37044f15c2f94ada49ac85f928f33a7b
- `assets/profiles/kodak_portra_800_push1.json`: 43bfbe92d2a8f8ffea39c057768b2d694176b022b4e6ab143dc1b275f5dbdfab
- `assets/profiles/kodak_portra_800_push2.json`: 633f7374b67fba21cc308dc70a25d64c7eb3efc8b9451433887ccc34a266e913
- `assets/profiles/kodak_portra_endura.json`: e3450fd941155c88e63060dcf202542ccb6da151e9ab6c56c295d7b2d4837969
- `assets/profiles/kodak_supra_endura.json`: 9f2c8ca36f53440a6e61b599b59682605e4234963e54cf130adb0321b728ae80
- `assets/profiles/kodak_trix.json`: 223b6c940b7536558ff952ade5069c58d4ef1fd7a98949d3160e4e92d3b7869c
- `assets/profiles/kodak_ultra_endura.json`: 8b117834f50d0838684cc812d665ce0d1c9d32016b1b562d28a6e0defbdaf16f
- `assets/profiles/kodak_ultramax_400.json`: eaa93c6bd212e1ff056b3f678879bab93f5219374210de83eaf5a6264d7c34ed
- `assets/profiles/kodak_verita_200d.json`: 13b8e61365eeca07c3425676efa81533a11dd3fb0a71adbd1af4f3e01b2e5165
- `assets/profiles/kodak_vision3_200t.json`: 9d9718bb3900cafe4b84ba2963427a97dfe2cd9b6ffa5bdc5c708652f6e8a3e2
- `assets/profiles/kodak_vision3_250d.json`: 07d26ffc039be333a05f76ef76f9b97208c8493925d14d95ca8e54c3defb9346
- `assets/profiles/kodak_vision3_500t.json`: dabadd09d329b3b10148028f8061537bf16c4932282cef5d5bc33452e8f64e47
- `assets/profiles/kodak_vision3_50d.json`: a9534523800ae27e572b8f70c1cec9f790f8824c06a3317029e61123785b550f
- `assets/filters/hoya/r1.csv`: 211fec78a84573b769372bbfffa9ceed70813386e4aedb25d230189943c3e4d5
- `assets/filters/hoya/x1.csv`: ab98aa320f521861550316b34e05b99ebe3452ebaec0b4bab7e76dd3f121f3a8
- `assets/filters/hoya/y2.csv`: e96cb228d81f4a258e8ae61fe0515c5bd7845c724429ce089d0c68a1143976f2
- `assets/filters/hoya/ya3.csv`: b8a93c1372b88acbf357b7edd8e4f819fd08d1d5167d998bb17c6c316017e177

## Camera picture modes

The editor reads `CMCM_<mode>`, `CMCC_<mode>`, and `MultiAxisTable_<mode>` from each X3F. It folds the color matrix into the calibrated scene transform and uses the core DNG hue map in linear ProPhoto RGB. The tone curve runs in the editor sRGB display encoding. Endpoint slopes retain signed samples and highlight headroom. This path does not reproduce the full Sigma Photo Pro renderer.

`camera-tone-deltas.json` copies the positive and negative 256-point reference deltas from `x3fuse-core/crates/x3f-core/src/output/dng/tone_curves.rs` (Apache-2.0). The core derives these curves from its reference Sigma-aware DNG. The synthesis uses the same contrast scaling and identity threshold.
