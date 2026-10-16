//! DIR-coupler presets and saturation from spektrafilm experimental 28bf883.
use super::profile::Profile;

pub const TAIL_UM: f64 = 200.0;
pub const TAIL_WEIGHT: f32 = 0.03;
pub const EXPONENTIAL_GAUSSIANS: [(f32, f32); 3] =
    [(0.1633, 0.5360), (0.6496, 1.5236), (0.1870, 2.7684)];
pub const EXPONENTIAL_MAX_SIGMA: f32 = EXPONENTIAL_GAUSSIANS[2].1;

/// The row is the donor layer; the column is the receiver layer.
pub fn matrix(profile: &Profile) -> [[f64; 3]; 3] {
    if profile.is_monochrome() {
        let gamma = if profile.is_positive() {
            0.2291
        } else {
            0.5159
        };
        return [[gamma, 0., 0.], [0., gamma, 0.], [0., 0., gamma]];
    }
    match profile.info.stock.as_str() {
        "fujifilm_velvia_100" => [
            [0.2398, 0.0707, 0.2367],
            [0.0119, 0.0662, 0.0380],
            [0.0111, 0.1413, 0.1440],
        ],
        "kodak_kodachrome_64" => [
            [0.2942, 0.1699, 0.2188],
            [0.0625, 0.0841, 0.0692],
            [0.1153, 0.2359, 0.2492],
        ],
        "fujifilm_provia_100f" => [
            [0.2786, 0.1448, 0.2003],
            [0.0516, 0.1257, 0.1250],
            [0.0518, 0.3089, 0.3480],
        ],
        _ if profile.is_positive() => [
            [0.2291, 0.1449, 0.1560],
            [0.0496, 0.1029, 0.0874],
            [0.0571, 0.2462, 0.2651],
        ],
        _ if profile.info.use_kind == "cine" => {
            if profile
                .info
                .reference_illuminant
                .to_uppercase()
                .starts_with('T')
            {
                [
                    [0.4601, 0.4313, 0.3157],
                    [0.3145, 0.4433, 0.3890],
                    [0.2423, 0.2506, 0.4414],
                ]
            } else {
                [
                    [0.5456, 0.4263, 0.2781],
                    [0.2051, 0.5434, 0.5015],
                    [0.2950, 0.2449, 0.3766],
                ]
            }
        }
        _ => [
            [0.5159, 0.4032, 0.2488],
            [0.2227, 0.5934, 0.4340],
            [0.1829, 0.1799, 0.2829],
        ],
    }
}

/// Derive the receiver knee before the user's amount scales the matrix.
pub fn receiver_reference(density_max: [f64; 3], unit_matrix: &[[f64; 3]; 3]) -> [f64; 3] {
    std::array::from_fn(|m| {
        (0..3)
            .map(|k| 0.5 * density_max[k] * unit_matrix[k][m])
            .sum()
    })
}

/// Use the same saturation in the inverse curves and the forward shader.
pub fn correction(
    density: [f64; 3],
    density_max: [f64; 3],
    matrix: &[[f64; 3]; 3],
    positive: bool,
    receiver_reference: [f64; 3],
) -> [f64; 3] {
    let donor: [f64; 3] = std::array::from_fn(|c| {
        if positive {
            density_max[c] - density[c]
        } else {
            density[c] * 1.5 * density_max[c] / (density_max[c] + density[c]).max(1e-20)
        }
    });
    std::array::from_fn(|m| {
        let arrived: f64 = (0..3).map(|k| donor[k] * matrix[k][m]).sum();
        if positive {
            let reference = receiver_reference[m];
            arrived * 3. * reference / (2. * reference + arrived).max(1e-20)
        } else {
            arrived
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stock(name: &str) -> Profile {
        (0..super::super::profile::FILM_COUNT)
            .map(|i| super::super::profile::load(i).unwrap())
            .find(|p| p.info.stock == name)
            .unwrap()
    }

    #[test]
    fn stock_presets_cover_cine_reversal_and_single_emulsion() {
        assert_eq!(
            matrix(&stock("kodak_vision3_50d"))[0],
            [0.5456, 0.4263, 0.2781]
        );
        assert_eq!(
            matrix(&stock("kodak_vision3_500t"))[0],
            [0.4601, 0.4313, 0.3157]
        );
        assert_eq!(
            matrix(&stock("fujifilm_velvia_100"))[1],
            [0.0119, 0.0662, 0.0380]
        );
        assert_eq!(
            matrix(&stock("kodak_trix")),
            [[0.2291, 0., 0.], [0., 0.2291, 0.], [0., 0., 0.2291]]
        );
        assert_eq!(
            matrix(&stock("kodak_doublex")),
            [[0.5159, 0., 0.], [0., 0.5159, 0.], [0., 0., 0.5159]]
        );
    }

    #[test]
    fn langmuir_corrections_match_experimental_python() {
        // model/couplers.py, with Dmax [2,3,4] and D [0.1,1.7,3.5].
        let cases = [
            (
                "kodak_portra_400",
                [
                    [0.237074946808511, 0.381793297872340, 0.383516778115501],
                    [0.948299787234043, 1.527173191489362, 1.534067112462006],
                    [2.844899361702127, 4.581519574468085, 4.602201337386018],
                ],
            ),
            (
                "kodak_ektachrome_100",
                [
                    [0.171072733286476, 0.184097732536291, 0.187873608135609],
                    [0.485464605637521, 0.597453481479381, 0.611035143328266],
                    [0.820585935976466, 1.19241932707306, 1.223360793118986],
                ],
            ),
        ];
        for (name, expected) in cases {
            let profile = stock(name);
            let unit = matrix(&profile);
            let reference = receiver_reference([2., 3., 4.], &unit);
            for (amount, expected) in [0.25, 1., 3.].into_iter().zip(expected) {
                let scaled = unit.map(|row| row.map(|value| value * amount));
                let actual = correction(
                    [0.1, 1.7, 3.5],
                    [2., 3., 4.],
                    &scaled,
                    profile.is_positive(),
                    reference,
                );
                for c in 0..3 {
                    assert!(
                        (actual[c] - expected[c]).abs() < 1e-12,
                        "{name}, amount {amount}, channel {c}"
                    );
                }
            }
        }
        assert_eq!(
            correction([0.; 3], [0.; 3], &[[0.; 3]; 3], false, [0.; 3]),
            [0.; 3]
        );
        assert_eq!(
            correction([0.; 3], [0.; 3], &[[0.; 3]; 3], true, [0.; 3]),
            [0.; 3]
        );
    }

    #[test]
    fn folded_inverse_curves_match_upstream_vector_interpolation() {
        // Scalar np.interp queries can select another branch on a folded axis.
        for (name, channel, expected) in [
            ("fujifilm_pro_400h", 1, 0.9454933729413697),
            ("kodak_kodachrome_64", 0, 0.3972282544727919),
        ] {
            let mut profile = stock(name);
            profile.apply_gamma(2.).unwrap();
            let curves = profile.normalized_curves();
            let maxima =
                std::array::from_fn(|c| curves.iter().map(|row| row[c]).fold(0., f64::max));
            let matrix = matrix(&profile);
            let inverse = super::super::curves_before_dir(
                &curves,
                &profile.data.log_exposure,
                &matrix,
                profile.is_positive(),
                maxima,
                receiver_reference(maxima, &matrix),
            );
            assert!(
                (inverse[79][channel] - expected).abs() < 1e-12,
                "{name}: {}",
                inverse[79][channel]
            );
        }
    }

    #[test]
    fn inverse_curves_match_experimental_python() {
        let expected = [
            (
                "kodak_portra_400",
                [
                    [0.487934476279944, 0.982961709818426, 1.150337238196663],
                    [1.525818838546781, 2.666265456908789, 3.329906413702446],
                    [2., 3., 4.],
                ],
            ),
            (
                "kodak_ektachrome_100",
                [
                    [1.695493882578921, 2.441371359823837, 3.24397930032077],
                    [0.847718910551231, 1.030064684886179, 1.349710997494969],
                    [0.043576945342615, 0., 0.],
                ],
            ),
        ];
        let exposure: Vec<f64> = (0..9).map(|i| -3. + 0.75 * i as f64).collect();
        for (name, expected) in expected {
            let profile = stock(name);
            let unit = matrix(&profile);
            let curves: Vec<[f64; 3]> = (0..9)
                .map(|i| {
                    let fraction = i as f64 / 8.;
                    [2., 3., 4.].map(|maximum| {
                        maximum
                            * if profile.is_positive() {
                                1. - fraction
                            } else {
                                fraction
                            }
                    })
                })
                .collect();
            let inverse = super::super::curves_before_dir(
                &curves,
                &exposure,
                &unit,
                profile.is_positive(),
                [2., 3., 4.],
                receiver_reference([2., 3., 4.], &unit),
            );
            for (i, expected) in [1, 4, 7].into_iter().zip(expected) {
                for c in 0..3 {
                    assert!(
                        (inverse[i][c] - expected[c]).abs() < 1e-12,
                        "{name}, sample {i}, channel {c}"
                    );
                }
            }
        }
    }
}
