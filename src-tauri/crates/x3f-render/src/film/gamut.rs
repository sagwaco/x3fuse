//! Default OkLCh output compression from Spektrafilm 28bf883 (GPL-3.0-only).
use super::data;
#[cfg(test)]
use crate::ColorProfile;
use std::{f64::consts::PI, sync::OnceLock};

pub const CMAX_N_L: usize = 64;
pub const CMAX_N_H: usize = 720;
/// Each profile has two row-major 3x3 matrices, then Cmax[L][h].
pub const OUTPUT_GAMUT_PROFILE_STRIDE: usize = 18 + CMAX_N_L * CMAX_N_H;

#[cfg(test)]
const XYZ_TO_LMS: [[f64; 3]; 3] = [
    [0.8189330101, 0.3618667424, -0.1288597137],
    [0.0329845436, 0.9293118715, 0.0361456387],
    [0.0482003018, 0.2643662691, 0.633851707],
];
#[cfg(test)]
const LMS_TO_LAB: [[f64; 3]; 3] = [
    [0.2104542553, 0.7936177850, -0.0040720468],
    [1.9779984951, -2.4285922050, 0.4505937099],
    [0.0259040371, 0.7827717662, -0.8086757660],
];
const LAB_TO_LMS: [[f64; 3]; 3] = [
    [0.9999999984505197, 0.3963377921737678, 0.21580375806075877],
    [
        1.0000000088817607,
        -0.10556134232365633,
        -0.0638541747717059,
    ],
    [
        1.0000000546724108,
        -0.08948418209496574,
        -1.2914855378640917,
    ],
];
const LMS_TO_XYZ: [[f64; 3]; 3] = [
    [1.2270138511035211, -0.5577999806518222, 0.2812561489664678],
    [-0.0405801784232806, 1.11225686961683, -0.07167667866560119],
    [-0.0763812845057069, -0.4214819784180126, 1.5861632204407947],
];

fn vector(m: &[[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
    std::array::from_fn(|i| m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2])
}

#[cfg(test)]
fn xyz_to_oklab(xyz: [f64; 3]) -> [f64; 3] {
    vector(&LMS_TO_LAB, vector(&XYZ_TO_LMS, xyz).map(f64::cbrt))
}

fn oklab_to_xyz(lab: [f64; 3]) -> [f64; 3] {
    vector(&LMS_TO_XYZ, vector(&LAB_TO_LMS, lab).map(|v| v.powi(3)))
}

/// Reinhard knee with an asymptote at 1. Values below the threshold pass through.
pub(super) fn reinhard_knee(d: f64, threshold: f64, power: f64) -> f64 {
    if d <= threshold {
        return d;
    }
    let scale = 1. - threshold;
    let x = (d - threshold) / scale;
    threshold + scale * x / (1. + x.powf(power)).powf(1. / power)
}

struct OutputGamut {
    rgb_to_xyz: [[f64; 3]; 3],
    xyz_to_rgb: [[f64; 3]; 3],
    cmax: Vec<f64>,
}

#[cfg(test)]
fn profile_index(profile: ColorProfile) -> usize {
    match profile {
        ColorProfile::Srgb => 0,
        ColorProfile::AdobeRgb => 1,
        ColorProfile::ProPhotoRgb => 2,
    }
}

fn tables() -> &'static [OutputGamut; 3] {
    static TABLES: OnceLock<[OutputGamut; 3]> = OnceLock::new();
    TABLES.get_or_init(|| {
        // Use the native XYZ white, including D50 for ProPhoto, as upstream does.
        let matrices = [
            (data::SRGB_TO_XYZ, data::XYZ_TO_SRGB),
            (
                [
                    [0.57667, 0.18556, 0.18823],
                    [0.29734, 0.62736, 0.07529],
                    [0.02703, 0.07069, 0.99134],
                ],
                [
                    [2.04159, -0.56501, -0.34473],
                    [-0.96924, 1.87597, 0.04156],
                    [0.01344, -0.11836, 1.01517],
                ],
            ),
            (
                [
                    [0.7977, 0.1352, 0.0313],
                    [0.2880, 0.7119, 0.0001],
                    [0., 0., 0.8249],
                ],
                [
                    [1.3460, -0.2556, -0.0511],
                    [-0.5446, 1.5082, 0.0205],
                    [0., 0., 1.2123],
                ],
            ),
        ];
        matrices.map(|(rgb_to_xyz, xyz_to_rgb)| {
            let mut cmax = Vec::with_capacity(CMAX_N_L * CMAX_N_H);
            for il in 0..CMAX_N_L {
                let lightness = 0.02 + 0.98 * il as f64 / (CMAX_N_L - 1) as f64;
                for ih in 0..CMAX_N_H {
                    let h = -PI + 2. * PI * ih as f64 / CMAX_N_H as f64;
                    let (sin, cos) = h.sin_cos();
                    let (mut lo, mut hi) = (0., 0.5);
                    for _ in 0..18 {
                        let mid = (lo + hi) * 0.5;
                        let rgb =
                            vector(&xyz_to_rgb, oklab_to_xyz([lightness, mid * cos, mid * sin]));
                        if rgb.iter().all(|&v| (-1e-6..=1. + 1e-6).contains(&v)) {
                            lo = mid;
                        } else {
                            hi = mid;
                        }
                    }
                    cmax.push(lo);
                }
            }
            OutputGamut {
                rgb_to_xyz,
                xyz_to_rgb,
                cmax,
            }
        })
    })
}

/// GPU storage scalars in sRGB, Adobe RGB, ProPhoto RGB order.
/// Each block stores RGB-to-XYZ, XYZ-to-RGB, then 64x720 Cmax values with hue last.
/// L spans [0.02, 1]; hue spans [-pi, pi) and wraps at the seam.
pub fn output_gamut_tables() -> Vec<f32> {
    let mut out = Vec::with_capacity(3 * OUTPUT_GAMUT_PROFILE_STRIDE);
    for table in tables() {
        out.extend(table.rgb_to_xyz.iter().flatten().map(|&v| v as f32));
        out.extend(table.xyz_to_rgb.iter().flatten().map(|&v| v as f32));
        out.extend(table.cmax.iter().map(|&v| v as f32));
    }
    out
}

#[cfg(test)]
fn cmax_lookup(table: &[f64], lightness: f64, hue: f64) -> f64 {
    let li = (lightness.clamp(0.02, 1.) - 0.02) / 0.98 * (CMAX_N_L - 1) as f64;
    let l0 = (li.floor() as usize).min(CMAX_N_L - 2);
    let lf = li - l0 as f64;
    let hi = (hue + PI) / (2. * PI / CMAX_N_H as f64);
    let h0 = (hi.floor() as isize).rem_euclid(CMAX_N_H as isize) as usize;
    let h1 = (h0 + 1) % CMAX_N_H;
    let hf = hi - hi.floor();
    table[l0 * CMAX_N_H + h0] * (1. - lf) * (1. - hf)
        + table[l0 * CMAX_N_H + h1] * (1. - lf) * hf
        + table[(l0 + 1) * CMAX_N_H + h0] * lf * (1. - hf)
        + table[(l0 + 1) * CMAX_N_H + h1] * lf * hf
}

/// Compress linear output-space RGB before encoding, with both default knees.
/// The caller retains the final output clamp, as upstream does.
#[cfg(test)]
pub fn compress_output_gamut(rgb: [f64; 3], profile: ColorProfile) -> [f64; 3] {
    let table = &tables()[profile_index(profile)];
    let [lightness, a, b] = xyz_to_oklab(vector(&table.rgb_to_xyz, rgb));
    let lightness = reinhard_knee(lightness, 0.95, 1.6);
    let chroma = a.hypot(b);
    let hue = b.atan2(a);
    let max_chroma = cmax_lookup(&table.cmax, lightness, hue).max(1e-9);
    let chroma = reinhard_knee(chroma / max_chroma, 0.95, 1.6) * max_chroma;
    let xyz = oklab_to_xyz([lightness, chroma * hue.cos(), chroma * hue.sin()]);
    vector(&table.xyz_to_rgb, xyz)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knees_match_upstream_and_preserve_black() {
        // Expected values come from Spektrafilm 28bf883, not this port.
        let distances = [0., 0.5, 0.815, 0.9, 0.95, 1., 1.2, 2., 10.];
        for (d, expected) in distances.into_iter().zip([
            0.0,
            0.5,
            0.815,
            0.8794745251241758,
            0.9023907207162248,
            0.918827739468617,
            0.9535288136274875,
            0.9848865786624066,
            0.9985899130475758,
        ]) {
            assert!((reinhard_knee(d, 0.815, 1.2) - expected).abs() < 2e-14);
        }
        for (d, expected) in distances.into_iter().zip([
            0.0,
            0.5,
            0.815,
            0.9,
            0.95,
            0.9824209888662753,
            0.9977584768230301,
            0.9997619849026073,
            0.9999923708149596,
        ]) {
            assert!((reinhard_knee(d, 0.95, 1.6) - expected).abs() < 2e-14);
        }
        assert_eq!(reinhard_knee(-0.1, 0.95, 1.6), -0.1);
    }

    #[test]
    fn cmax_tables_match_upstream_in_all_output_spaces() {
        // Expected values come from the upstream 18-step bisection.
        for ((l, h), expected) in [
            (0, 0),
            (0, 719),
            (1, 360),
            (20, 123),
            (32, 0),
            (32, 360),
            (62, 500),
            (63, 360),
        ]
        .into_iter()
        .zip([
            0.0041141510009765625,
            0.00412750244140625,
            0.014707565307617188,
            0.07787132263183594,
            0.09396934509277344,
            0.20995140075683594,
            0.011074066162109375,
            0.0,
        ]) {
            assert_eq!(tables()[0].cmax[l * CMAX_N_H + h], expected);
        }
        for ((l, h), expected) in [
            (0, 0),
            (0, 719),
            (1, 360),
            (20, 123),
            (32, 0),
            (32, 360),
            (62, 500),
            (63, 360),
        ]
        .into_iter()
        .zip([
            0.00716400146484375,
            0.00719451904296875,
            0.014703750610351562,
            0.123046875,
            0.1625080108642578,
            0.20988082885742188,
            0.016672134399414062,
            0.0,
        ]) {
            assert_eq!(tables()[1].cmax[l * CMAX_N_H + h], expected);
        }
        for ((l, h), expected) in [
            (0, 0),
            (0, 719),
            (1, 360),
            (20, 123),
            (32, 0),
            (32, 360),
            (62, 500),
            (63, 360),
        ]
        .into_iter()
        .zip([
            0.012189865112304688,
            0.012151718139648438,
            0.022552490234375,
            0.34677886962890625,
            0.2712268829345703,
            0.3222084045410156,
            0.08148574829101562,
            0.0,
        ]) {
            assert_eq!(tables()[2].cmax[l * CMAX_N_H + h], expected);
        }
        for table in tables() {
            let hue = -0.724;
            assert!(
                (cmax_lookup(&table.cmax, 0.5, hue) - cmax_lookup(&table.cmax, 0.5, hue + 2. * PI))
                    .abs()
                    < 1e-14
            );
            assert_eq!(
                cmax_lookup(&table.cmax, -1., 0.),
                cmax_lookup(&table.cmax, 0.02, 0.)
            );
            assert_eq!(
                cmax_lookup(&table.cmax, 2., 0.),
                cmax_lookup(&table.cmax, 1., 0.)
            );
        }
        let packed = output_gamut_tables();
        assert_eq!(packed.len(), 138294);
        assert_eq!(packed[0], 0.4124);
        assert_eq!(packed[OUTPUT_GAMUT_PROFILE_STRIDE], 0.57667);
        assert_eq!(packed[2 * OUTPUT_GAMUT_PROFILE_STRIDE], 0.7977);
    }

    #[test]
    fn output_chroma_and_lightness_match_upstream() {
        // Includes black, midgray, highlights, primaries and signed RGB.
        let inputs = [
            [0.0, 0.0, 0.0],
            [0.18, 0.18, 0.18],
            [1.0, 1.0, 1.0],
            [4.0, 4.0, 4.0],
            [1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.5, -0.2, 0.4],
            [0.02, 0.8, 1.2],
            [-0.01, 0.001, 0.02],
        ];
        let expected = [
            [0.0, 0.0, 0.0],
            [0.1800026819999998, 0.18000972899999998, 0.1800028530000001],
            [0.9481910594582368, 0.9482324516970554, 0.9482088131502052],
            [0.9982845242864028, 0.9984714309562805, 0.9988688463001022],
            [
                0.9786049805149066,
                0.007264778824486394,
                0.004030694796978559,
            ],
            [
                -7.958524758272604e-05,
                0.029156833067588407,
                0.7940614099944844,
            ],
            [
                0.9677030441003739,
                0.0012147021088617733,
                0.35019006538877023,
            ],
            [0.20648419432796225, 0.753607477363516, 0.9997137846174116],
            [
                -1.0846876271219182e-06,
                9.33977244924055e-05,
                9.74667709369749e-05,
            ],
        ];
        for (rgb, expected) in inputs.into_iter().zip(expected) {
            let actual = compress_output_gamut(rgb, ColorProfile::Srgb);
            for c in 0..3 {
                assert!(
                    (actual[c] - expected[c]).abs() < 2e-9,
                    "{actual:?} != {expected:?}"
                );
            }
        }
        let expected = [
            [0.0, 0.0, 0.0],
            [0.18000245298599957, 0.1799979702299999, 0.17999935311600018],
            [0.9481999447124271, 0.9481814066361922, 0.9482014149472102],
            [0.9982941158526412, 0.9984449656362421, 0.9988931896982696],
            [
                0.9807561744944625,
                0.010532761151892936,
                0.006058589702880796,
            ],
            [
                0.0014207711836326375,
                0.006038841954086478,
                0.9604469421084696,
            ],
            [0.9998868138066306, 0.09893525616953051, 0.4204922492852012],
            [0.15337269527615213, 0.7433483230117001, 0.9995683687211424],
            [
                -0.0006001093498447407,
                -0.0003712327330933117,
                -0.00015752544252726767,
            ],
        ];
        for (rgb, expected) in inputs.into_iter().zip(expected) {
            let actual = compress_output_gamut(rgb, ColorProfile::AdobeRgb);
            for c in 0..3 {
                assert!(
                    (actual[c] - expected[c]).abs() < 2e-9,
                    "{actual:?} != {expected:?}"
                );
            }
        }
        let expected = [
            [0.0, 0.0, 0.0],
            [0.18001094579999985, 0.1800012834000001, 0.1800047286],
            [0.9469973450319543, 0.9460347427736226, 0.9410587386210508],
            [0.9685350452902198, 1.010280242425699, 1.2911194258962253],
            [0.979314995089757, 0.0113805337646847, 0.00831573044423638],
            [
                0.009840563653416767,
                0.005055913244948862,
                0.1193419846231723,
            ],
            [0.9997328014876912, 0.07733205761210722, 0.46685722409876257],
            [0.1335607613971408, 0.7108254207984112, 0.9998246452524492],
            [
                -0.0027145120431169133,
                -0.002592357977375295,
                -0.0014248284289708959,
            ],
        ];
        for (rgb, expected) in inputs.into_iter().zip(expected) {
            let actual = compress_output_gamut(rgb, ColorProfile::ProPhotoRgb);
            for c in 0..3 {
                assert!(
                    (actual[c] - expected[c]).abs() < 2e-9,
                    "{actual:?} != {expected:?}"
                );
            }
        }
    }
}
