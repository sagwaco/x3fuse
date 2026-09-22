# x3f-render

GPU RAW editing for X3Fuse, licensed GPL-3.0-only. It lives in the X3Fuse
repository and depends on the Apache-2.0 x3fuse-core decoder. See
[NOTICE](NOTICE) for source and asset attribution, and
[asset provenance](assets/PROVENANCE.md) for pinned hashes.

`Renderer::new()` selects a hardware wgpu adapter (Metal, Vulkan, or DX12).
Editing requires that GPU; failure is returned to the caller without a CPU
rendering fallback. Callers should serialize interactive/export jobs and retain
the last successful preview until a replacement finishes.

`Renderer::render(&SceneLinearImage, &EditRecipe, RenderOptions, &AtomicBool)`
returns interleaved, transfer-encoded RGB16 plus native output dimensions and
the actual normalized preview region. JPEG/PNG encoders and the core TIFF writer
embed the matching sRGB, Adobe RGB (1998), or ProPhoto RGB ICC profile.
`output_dimensions` and `pick_white_balance` use the same geometry as rendering.
For repeated adjustments, retain `PreparedImage::new(scene, &cancel)` and call
`Renderer::render_prepared(&prepared, ...)`. It owns immutable source pixels and
validates them once and lazily uploads an rgba32float source texture on its first
render. Repeated adjustments reuse that texture; a different renderer reuploads
it to its own device. `prepared.image()` exposes the source for dimensions and
white-balance picking. Rebuild it after changing RAW preparation settings.

Input is calibrated extended linear sRGB/D65, with negative components and
highlight headroom preserved by x3f-core. Set `SceneLinearOptions.denoise_intensity`
to the recipe's `denoise` when preparing the RAW; changing that setting requires
preparing it again. The renderer does not denoise twice. Other adjustments reuse
the prepared float image. Camera-calibrated temperature/tint applies relative
sensor-channel gains, normalized to green to preserve exposure.

Processing is geometric sampling → white balance/exposure → optional sensor-layer
monochrome → global tonal controls → optional spectral film → contrast/saturation/vibrance/HSL/curves → luminance
sharpening → output primaries/transfer curve. With film disabled, a luminance
shoulder is identity through 18% gray and smoothly approaches display white.
With film enabled, the measured paper/film response supplies the tone transform.
`EditRecipe::default()` enables film; an explicit `film: None` selects digital rendering.
Curves operate in a perceptual sRGB representation with linear interpolation and
endpoint extrapolation to retain out-of-gamut color until final output conversion.

`monochrome: null` preserves color and is also the default for older recipes.
Enable it with `monochrome: { filter: "neutral" }`; the filter can be `neutral`,
`red`, `orange`, `yellow`, `green`, or `blue`. The inverse camera-to-RGB matrix
recovers corrected, normalized Foveon Bottom/Middle/Top samples. Every layer is
normalized to the camera response to neutral scene RGB before mixing, preserving
neutral brightness and ISO exposure across filters. Bottom is red-sensitive,
Middle green-sensitive, and Top blue-sensitive. The virtual mixes are:

| Filter | Bottom | Middle | Top |
|---|---:|---:|---:|
| Neutral | 1/3 | 1/3 | 1/3 |
| Red | 1 | 0 | 0 |
| Orange | 3/4 | 1/4 | 0 |
| Yellow | 1/2 | 1/2 | 0 |
| Green | 0 | 1 | 0 |
| Blue | 0 | 0 | 1 |

These are layer mixes, rather than measured optical-filter transmission curves.
They retain preceding RAW corrections and Quattro layer reconstruction. White
balance adjusts the layer gains before mixing. A final luminance projection
removes film, grain, and channel-curve tint; all supported output profiles receive
equal RGB channels with the appropriate transfer curve.

Film rendering is the spektrafilm model, ported from spektrafilm-rs. Linear
sRGB is spectrally upsampled through a per-film 192x192 chromaticity LUT built
from the bundled 81-wavelength irradiance table and the film's own log
sensitivity - with spektrafilm's input gamut compression baked into that LUT,
so out-of-gamut input chromaticities are handled before any per-pixel work -
then developed against the measured density curves, coupled by DIR
couplers with spatial inhibitor diffusion, grained by a Poisson-binomial
particle model, printed through a dichroic enlarger solved to a per-stock
neutral, developed on the paper's fitted curves, and scanned back to linear
sRGB across the same 81 wavelengths. Optional halation adds spectral scatter
and a three-bounce reflection off the film base. These are physical-model
stages, not a baked RGB look LUT.

Halation, grain and DIR couplers are optional; `negative: true` scans the
developed film and skips the paper entirely. Stages spektrafilm has that this
crate omits - glare, output gamut compression, highlight boost, its own unsharp
mask, diffusion filters and lens blur, and the coupler diffusion tail - are
listed in [NOTICE](NOTICE). The 20 film and 8 paper indices and names are fixed
in the bundled profiles; use `STOCKS_JSON` for the UI.

Spatial parameters are physical (micrometres over a 35 mm frame) and are
converted using the whole sensor frame at the current render scale, so a crop
or a requested region never changes a diffusion size or a grain particle. The
per-film upsampling LUT and the per-pair enlarger solve are cached separately:
changing paper, print trim or exposure reuses the LUT.

`RENDER_VERSION` identifies the rendered output rather than the API. Callers
that persist rendered images must mix it into their cache keys, and it must be
bumped whenever a change moves pixels; otherwise previews written by an older
build are served next to freshly rendered exports.

Crop coordinates refer to the full EXIF-oriented image before user quarter-turn
rotation/straighten. Straighten fits the rotated rectangle inside the selected
crop to avoid empty corners. `RenderOptions.region` refers to the final edited
output; `max_dimension` caps that region's resolution. GPU affine sampling uses
explicit bilinear interpolation of the f32 source, retaining signed/HDR samples
without requiring optional float-texture filtering. Gaussian
support is `ceil(3σ)`, normalized, separable, with actual sensor-edge clamping.
Overlap extends outside crop/region edges, and grain coordinates are anchored to
the original oriented image. Previews up to 2048 px render in one submission and
readback when their expanded buffers fit the adapter limits; native exports and
larger regions use 1024 px tiles, falling back to 512 px when a large diffusion
radius would push the expanded tile past the buffer limit. Both paths retain the same overlap. One cached
working set reuses scratch/readback buffers, bind groups, and separate aligned
uniform slots for each pass; its capacity grows to the largest preview/tile,
with each buffer capped at 128 MiB as well as the device limits.
Cancellation discards work/results between submissions and during readback;
already submitted GPU commands remain owned by wgpu until completion. Device
loss, allocation/validation errors, and a 60-second per-tile timeout are surfaced.

Checks:

```sh
cargo test --manifest-path src-tauri/Cargo.toml -p x3f-render
cargo test --manifest-path src-tauri/Cargo.toml -p x3f-render gpu_pipeline -- --ignored --nocapture
cargo run --release --manifest-path src-tauri/Cargo.toml -p x3f-render --example render -- input.X3F preview.png 2
cargo run --release --manifest-path src-tauri/Cargo.toml -p x3f-render --example benchmark -- input.X3F 5
cargo run --release --manifest-path src-tauri/Cargo.toml -p x3f-render --example benchmark -- input.X3F 5 red
```

The explicit GPU test fails if hardware is unavailable. It covers all 160
film/paper combinations, patches pinned against spektrafilm-rs, output encoders/profiles,
crop/region/tile/grain consistency, GPU/CPU geometry parity, and cancellation.
A PNG example is a 1600-pixel
preview; JPEG/TIFF examples render native resolution. Reference math and data
come from spektrafilm via the spektrafilm-rs revision pinned in
[assets/PROVENANCE.md](assets/PROVENANCE.md), which also documents how to
regenerate the pinned patches and run the optional `spektrafilm_parity` oracle.

The bounded benchmark warms each resolution, changes exposure on every measured
request, and reports median rendering and lossless PNG encoding separately for
512/768/1024/2048-pixel digital and physical-film previews. It retains one renderer
and one validated source, matching an editing session; source decode and GPU
startup are excluded from adjustment latency.

For desktop development, optimize `x3f-render`, `x3f-core`, `image`, and `png`
through the application's `[profile.dev.package.<name>]` overrides. Optimizing
`image` alone leaves PNG row filtering unoptimized: on the M1 Max Quattro sample,
that made a 2048-pixel preview take about one second to encode despite a 143 ms
GPU render. The benchmark exposes the encoding cost separately for this reason.
