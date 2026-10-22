# Empirical Aerochrome-style preset

The preset uses raw BMT layer gains, a 3x3 mix, and the Ektachrome 100 slide model.
It bypasses FCBlue and calibrated Kelvin/tint. It does not estimate separate NIR
and visible bands or use measured Aerochrome spectral data.

## Basis and method

The capture owner confirmed a 550/660/850 nm filter for both sample sessions.
All 16 captures are from a Sigma DP2 Merrill: four August 2026 beach/hotel photos
and twelve November 2025 corpus files. Seven corpus files show the same street
within 40 seconds, so these are not 16 independent scenes.

Kodak AS-77 describes infrared as red, red as green, and green as blue, with
healthy foliage often red or magenta. It supplies no numeric RGB targets for
these photographs. See [Kodak AS-77 / TI-2562 (mirror)](https://125px.com/docs/unsorted/kodak/EN_ti2562.pdf).

A cloud, foliage, and clear-sky patch from `aero_P2M1109.X3F` were measured in
unrotated source coordinates. An exact three-patch solve was rejected: its input
matrix has infinity-norm condition number 572.46. One trial target required a
coefficient above 23, outside the recipe limit of 4. Clamping that solve would
break neutral preservation. No such solve is used by the application.

The shipped mix is manually tuned by eye on `aero_P2M1159.X3F` and is empirical:

```
 1.6874   0.7225  -1.4099
-0.7473   2.965   -1.2177
-1.5352   1.93     0.6052
```

The first row increases the bottom/top layer difference. Before film, measured
foliage is red to orange (hue 24 to 36 degrees) and the clear sky stays blue.
Every row sums to 1,
so a picked neutral remains neutral before film. These are creative coefficients,
not a fitted sensor response. The source means and rectangles are recorded in
`src/shared/aerochrome-patches.json`. Tests check the bounds, row totals, and
measured development/check patch colors; they do not claim to recover this mix
from target colors.

## Checks and limits

The checks in this section used the previous mix, `[1.7, 0, -0.7; -1, 3, -1;
0.5, -3.5, 4]`, which gave foliage a red/magenta bias. They were not repeated
for the current mix.

All 16 captures rendered through the GPU with denoise and grain disabled for
inspection. Neutral choices were explicit: clouds where available, crosswalk
paint for the street sequence, and car paint for the overhead street scene.
The succulent close-up reused the terrace cloud gains. The hotel photo reused
the beach cloud gains because it has no cloud or known NIR-neutral surface.
The paint patches are unverified NIR neutrals. Those eight street renders check
that the preset renders and preserves useful material differences; they do not
establish neutral accuracy. These choices are review settings, not automatic
white balance in the product.

For the beach capture, encoded-sRGB means after film were:

| Patch | R | G | B |
| --- | --- | --- | --- |
| Picked cloud | 0.5521 | 0.5548 | 0.5528 |
| Separate cloud | 0.7063 | 0.7058 | 0.6972 |
| Clear sky | 0.2595 | 0.3277 | 0.3641 |
| Foliage | 0.2801 | 0.1749 | 0.1905 |

The real 5x5 neutral picker was also checked at five nearby cloud points with
the editor's default denoise strength. Blue-gain spread was about 0.36% on the
beach and 1.06% on the terrace. The two center picks were rendered through the
same Ektachrome path. No picker-radius change was needed for these samples.

The four measured beach patches have positive mean film-input RGB. About 0.13%
of foliage pixels have a negative component; no pixel in those patches has a
nonpositive XYZ sum. Signed components remain in the pipeline until its normal
film/output transforms. These statistics do not establish that the RAW was never
clipped or that every output pixel is in gamut.

The overcast terrace and hotel foliage also remain red to magenta. Hazy hotel
sky is cyan rather than deep blue. Overcast sky that closely matches cloud in the
raw layers stays gray or warm gray, not blue. A second terrace cloud has more color than
the selected cloud; one neutral pick cannot remove all spatial or illumination
variation. A painted wall is not an NIR neutral and can remove foliage color if
used as the white-balance target.

The blue row has a coefficient norm of 5.34 at unit gains and can amplify layer
noise. Use the existing RAW denoise controls. Other cameras, filters, seasons,
and illumination can require different gains or a different matrix. As-shot
camera gains are only the starting point; use the neutral picker before judging
the look. No matched Aerochrome exposures, visible-red reference object, or
measured spectral target was available, so spectral fidelity is unverified.

## Reproduce patch measurements

`raw_patches` accepts a JSON array of `{name,x,y,width,height}` rectangles, with
coordinates normalized to the unrotated active area. It prints signed layer
means and extrema, source/output signed counts, and the raw matrix output.
A recipe file may be a direct recipe or a sidecar containing `recipe`.

```sh
cargo run --manifest-path src-tauri/Cargo.toml -p x3f-render --example raw_patches -- \
  input.X3F new-preview.png patches.json recipe.json
```

Without a recipe, it renders raw identity at as-shot gains with denoise disabled.
An output file must not already exist. The input and its sidecar are never changed.
