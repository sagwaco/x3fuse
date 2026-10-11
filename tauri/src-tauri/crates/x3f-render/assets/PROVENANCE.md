# Film model and data provenance

The film simulation is the spektrafilm model by Andrea Volpato
(https://github.com/andreavolpato/spektrafilm), ported to this crate from
spektrafilm-rs by turbasvin (https://github.com/turbasvin/spektrafilm-rs),
pinned at **v0.1.2, revision `9dd59b0`**, which tracks upstream spektrafilm
v0.3.4 (0.3.2 parity for the stages ported here). Licensing and the list of
X3Fuse modifications are in [../NOTICE](../NOTICE); the data terms are
CC BY-SA 4.0 per [../licenses/SPEKTRAFILM_LICENSE.txt](../licenses/SPEKTRAFILM_LICENSE.txt),
shipped unmodified.

Every bundled data file below is a byte-identical copy of the corresponding
file in the pinned spektrafilm-rs checkout (`data/profiles/`,
`data/luts/spectral_upsampling/irradiance_xy_tc.npy`,
`data/filters/neutral_print_filters.json`), so the license's `CHANGELOG.txt`
obligation for modified files does not apply.

The B&W profiles `kodak_doublex.json`, `kodak_trix.json` and `kodak_2302.json`,
and the Hoya taking-filter curves in `assets/filters/hoya/`, are byte-identical
copies from the spektrafilm `experimental` branch at revision `28bf883`
(2026-07-08): `src/spektrafilm/data/profiles/` and
`src/spektrafilm/data/filters/colored/hoya/`. `assets/stocks.json` is X3Fuse's
own index over those profiles and is byte-identical to
`src/shared/film-stocks.json`.

**Any edit to `src/render.wgsl` or to an asset must update this file.**
`spektrafilm_license_ships_unmodified` in `src/tests.rs` asserts the shader and
license hashes below.

## Reference values

`spektrafilm_calibration_matches_reference` pins the tc LUT, the filtered
enlarger illuminant and the print exposure factor for Kodak Portra 400 on Kodak
Portra Endura, read from `Pipeline::{tc_lut, print_illuminant_slice,
print_exposure_factor}` on a spektrafilm-rs `Pipeline::new_with_spectral` built
with `camera.auto_exposure = false` and `io.input_color_space = "sRGB"`. They
match to 1e-9 relative; the print exposure factor differs by 7e-9 because the
mid-gray LUT sample uses this crate's own bicubic.

The pinned patches in `gpu_pipeline` come from the same pipeline run through
`process` on the CPU backend, with the stages this crate does not implement
switched off:

```
camera.auto_exposure               = false
camera.exposure_compensation_ev    = <recipe ev_film>
enlarger.print_exposure_compensation = false
io.input_color_space               = "sRGB"    io.input_cctf_decoding  = false
io.output_color_space              = "sRGB"    io.output_cctf_encoding = false
io.scan_film                       = <recipe negative>
io.output_gamut_compress.algorithm = "off"
film_render.grain.active           = false
film_render.halation.active        = false
film_render.glare.active           = false
print_render.glare.active          = false
scanner.unsharp_mask               = [0.0, 0.0]
film_render.dir_couplers.amount    = <recipe couplers>
enlarger.m_filter_shift            = <recipe tune_m> * 20
enlarger.y_filter_shift            = <recipe tune_y> * 20
```

`print_exposure_compensation` is off because X3Fuse's film exposure slider has
to move print brightness; see NOTICE. It only matters at a non-zero `ev_film`,
where spektrafilm's default would re-solve the enlarger and cancel the slider
out - the patches below are all pinned at `ev_film = 0`, where the two agree.

The ignored `spektrafilm_parity` test re-checks the same chain against the real
`spektrafilm` CLI; see its doc comment for the command. Both currently agree to
1/65535 on 16-bit output.

## SHA-256

- `src/render.wgsl`: 2bee97ebe5c4e2591a94c62ff0d6fc0223336164b1b8b475502c3c7ab232dd0f
- `licenses/SPEKTRAFILM_LICENSE.txt`: 76d629501783ae52e8d63aee1e054c1e1a9713b9fe7d36fb306e25b1d14b24e9
- `assets/irradiance_xy_tc.npy`: 52f90c724811f5fab80769f8548bf24d08a521eb09e65ab6e016893258d2a783
- `assets/neutral_print_filters.json`: 8c96ba7089629aa38914492dc65c526551a1decbbb8769c2383d40e4e9632b38
- `assets/stocks.json`: ad6cf316bdceb8ebffd5e62288bee530db0787c7d6498ba62e8902a7ed6bc3f1
- `assets/profiles/fujifilm_c200.json`: 30db07d88090aadc62e03d18c2c51f67a20a1673390c69f99933b7ed5406d2c8
- `assets/profiles/fujifilm_crystal_archive_typeii.json`: 0db98e5b8e2ed5248696e62bc39b7f21459a8812d64049b1275d7be995af873b
- `assets/profiles/fujifilm_pro_400h.json`: da1be731ab79fb5535c43042494fa7298c942179abb68270b928aa012c629b31
- `assets/profiles/fujifilm_provia_100f.json`: f061f7aa55e3fefe1c89ee2edb8555a2d44fe8167d02f663c787067d131137b6
- `assets/profiles/fujifilm_velvia_100.json`: af696fa9662e0483cb9428d2939675044f2016fc3fad760b50a20a0a586fc04b
- `assets/profiles/fujifilm_xtra_400.json`: 5f2a3642c7c8db5e750d7366c34b47d24b89ad78d2abe41da4b5282fd4286e58
- `assets/profiles/kodak_2302.json`: 145d7ec07f070c2985d8c5f5845206903e00a6c2a5fed39d402368acbc8252b4
- `assets/profiles/kodak_2383.json`: eb7fdfa3b75a909bf5c400802f7401160c8017ed1ac3e8e0d1c8448d56fbe184
- `assets/profiles/kodak_2393.json`: b564aece5e9fe43a5c7878d661a8c260c9f73a647a55899596c78487c79678dc
- `assets/profiles/kodak_doublex.json`: 4c36da545d10463b6249074bf644501082a11853aa08e8fbc1a8282b3d6709e5
- `assets/profiles/kodak_ektachrome_100.json`: ef194fd80c60a1ac42bbbf1df458b4d047fc07bc17eebce674bb3bcba2ccf62a
- `assets/profiles/kodak_ektacolor_edge.json`: 5db23694d478c35cc0f96d42f94da79e552b2f8eb0853767449a24ac0f0f890e
- `assets/profiles/kodak_ektar_100.json`: 60acbd46c75005771569eafb97f534a4495e9d4e1e9c1e419b90cea2676ec7cf
- `assets/profiles/kodak_endura_premier.json`: fd37807d61eb730cda54e85d36640e35a0f8da58666bfc6aa83db888b2e364c2
- `assets/profiles/kodak_gold_200.json`: aa8a0c1c7851fface3752f968cdf6c6d74a26fc9756a4460d3155d2382506b7c
- `assets/profiles/kodak_kodachrome_64.json`: f88ede487219cf75090ed6663af6923c595707b3c48819f2ccf27122130e921d
- `assets/profiles/kodak_portra_160.json`: 1bc9b65a6940f3a4381e8d14d0ac43594aff9495051992ce4d7408e761549992
- `assets/profiles/kodak_portra_400.json`: b5cdc73dbec8f462f488bca70bedf23fd13ce79969c0457e8ac2a2565d92bf5d
- `assets/profiles/kodak_portra_800.json`: 5b0c6e861c6273a2ecdf552525e80738037918e650a0dc206e095acfd02f8b43
- `assets/profiles/kodak_portra_800_push1.json`: dac9cbcd2442442d9dee90bd2d6a28dcc4b996635dcac0b44ac8ecd32c4b3a4f
- `assets/profiles/kodak_portra_800_push2.json`: 5ee01e4a00c157721738314313a43b46fcd5dae62ed3a7e4730f9054b66f6282
- `assets/profiles/kodak_portra_endura.json`: e3bb6069e02d088d8080d38ce28035816038f62786e2aff9176bf4aeeb4820a0
- `assets/profiles/kodak_supra_endura.json`: 3a0928013effbb33e81acd01db426937faa3a12021a267c54b4d96e916286bd6
- `assets/profiles/kodak_trix.json`: 223b6c940b7536558ff952ade5069c58d4ef1fd7a98949d3160e4e92d3b7869c
- `assets/profiles/kodak_ultra_endura.json`: 319fa2514e9a6809fd09ce587c4f714effc035e7f9ebaeb3b55d9bc1b52c2a72
- `assets/profiles/kodak_ultramax_400.json`: 248b78bdcc4fdbe864e30f193f900059ecd98cbdb276c88ad8f6f5b520137901
- `assets/profiles/kodak_verita_200d.json`: 5d71a3f544721a71cfa0b0671ce1b5eda6dc1e6a09273810793d4bc821b272fc
- `assets/profiles/kodak_vision3_200t.json`: 4a28f049fd6bad67be98efdb058b413c6b3c022e2932b357b346d902c4c393c8
- `assets/profiles/kodak_vision3_250d.json`: 9ab85c8627c0533beb925b747e441e93beabe9e98c2429695b0a53866b56fcc7
- `assets/profiles/kodak_vision3_500t.json`: d7beca68bf16db88dbb7373fd13a6a1150a57a911a54bb0309a760a6f9883329
- `assets/profiles/kodak_vision3_50d.json`: fd426abc9de911682080db222020978dee4e8df7ca939bfcd5c9d0f6df249fa1
- `assets/filters/hoya/r1.csv`: 211fec78a84573b769372bbfffa9ceed70813386e4aedb25d230189943c3e4d5
- `assets/filters/hoya/x1.csv`: ab98aa320f521861550316b34e05b99ebe3452ebaec0b4bab7e76dd3f121f3a8
- `assets/filters/hoya/y2.csv`: e96cb228d81f4a258e8ae61fe0515c5bd7845c724429ce089d0c68a1143976f2
- `assets/filters/hoya/ya3.csv`: b8a93c1372b88acbf357b7edd8e4f819fd08d1d5167d998bb17c6c316017e177
