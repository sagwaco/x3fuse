//! DNG camera color to extended-linear sRGB, after DNG 1.7 chapter 6.
//! Matrices are row-major 3x3 and operate on column vectors.

pub(crate) type M3 = [f64; 9];

pub(crate) const IDENTITY: M3 = [1., 0., 0., 0., 1., 0., 0., 0., 1.];
/// The DNG profile connection space white, D50.
const D50_XY: [f64; 2] = [0.3457, 0.3585];
const D65_XY: [f64; 2] = [0.3127, 0.3290];
/// D65 XYZ to linear sRGB (IEC 61966-2-1). `srgb` scales its rows so the
/// rounded D65 white maps to exactly one.
const XYZ_TO_SRGB: M3 = [
    3.2404542, -1.5371385, -0.4985314, -0.9692660, 1.8760108, 0.0415560, 0.0556434, -0.2040259,
    1.0572252,
];
const BRADFORD: M3 = [
    0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296,
];

fn srgb() -> M3 {
    let white = apply(&XYZ_TO_SRGB, xy_to_xyz(D65_XY));
    mul(&diag(white.map(|v| 1. / v)), &XYZ_TO_SRGB)
}

pub(crate) fn mul(a: &M3, b: &M3) -> M3 {
    std::array::from_fn(|i| (0..3).map(|k| a[i / 3 * 3 + k] * b[k * 3 + i % 3]).sum())
}

pub(crate) fn apply(m: &M3, v: [f64; 3]) -> [f64; 3] {
    std::array::from_fn(|i| m[i * 3] * v[0] + m[i * 3 + 1] * v[1] + m[i * 3 + 2] * v[2])
}

fn scale(m: &M3, s: f64) -> M3 {
    m.map(|v| v * s)
}

fn diag(v: [f64; 3]) -> M3 {
    [v[0], 0., 0., 0., v[1], 0., 0., 0., v[2]]
}

pub(crate) fn inverse(m: &M3) -> Option<M3> {
    let c = |r: usize, k: usize| m[r * 3 + k];
    let cof = [
        c(1, 1) * c(2, 2) - c(1, 2) * c(2, 1),
        c(1, 2) * c(2, 0) - c(1, 0) * c(2, 2),
        c(1, 0) * c(2, 1) - c(1, 1) * c(2, 0),
    ];
    let det = c(0, 0) * cof[0] + c(0, 1) * cof[1] + c(0, 2) * cof[2];
    if !det.is_finite() || det.abs() < 1e-12 {
        return None;
    }
    let out = [
        cof[0],
        c(0, 2) * c(2, 1) - c(0, 1) * c(2, 2),
        c(0, 1) * c(1, 2) - c(0, 2) * c(1, 1),
        cof[1],
        c(0, 0) * c(2, 2) - c(0, 2) * c(2, 0),
        c(0, 2) * c(1, 0) - c(0, 0) * c(1, 2),
        cof[2],
        c(0, 1) * c(2, 0) - c(0, 0) * c(2, 1),
        c(0, 0) * c(1, 1) - c(0, 1) * c(1, 0),
    ]
    .map(|v| v / det);
    out.iter().all(|v| v.is_finite()).then_some(out)
}

fn xy_to_xyz([x, y]: [f64; 2]) -> [f64; 3] {
    [x / y, 1., (1. - x - y) / y]
}

fn xyz_to_xy(v: [f64; 3]) -> Option<[f64; 2]> {
    let sum = v[0] + v[1] + v[2];
    let xy = [v[0] / sum, v[1] / sum];
    (sum.is_finite() && sum > 0. && xy.iter().all(|v| v.is_finite() && *v > 0.)).then_some(xy)
}

/// Chromatic adaptation from one white to another.
fn bradford(from: [f64; 2], to: [f64; 2]) -> M3 {
    let inv = inverse(&BRADFORD).expect("Bradford matrix is invertible");
    let a = apply(&BRADFORD, xy_to_xyz(from));
    let b = apply(&BRADFORD, xy_to_xyz(to));
    mul(
        &inv,
        &mul(&diag(std::array::from_fn(|i| b[i] / a[i])), &BRADFORD),
    )
}

/// Correlated color temperature, McCamy's approximation.
// ponytail: McCamy is within a few kelvin over 2850 K to 6500 K; the DNG SDK
// uses Robertson isotherms. Only the dual-illuminant weight depends on it.
fn temperature([x, y]: [f64; 2]) -> f64 {
    let n = (x - 0.3320) / (0.1858 - y);
    449. * n.powi(3) + 3525. * n * n + 6823.3 * n + 5520.33
}

/// EXIF LightSource code to kelvin, as in the DNG SDK. Zero is unknown.
fn illuminant_temperature(code: u32) -> f64 {
    match code {
        17 | 3 => 2850.,
        24 => 3200.,
        23 => 5000.,
        1 | 4 | 9 | 18 | 20 => 5500.,
        10 | 19 | 21 => 6500.,
        11 | 22 => 7500.,
        12 => 6400.,
        13 => 5000.,
        2 | 14 => 4200.,
        15 => 3450.,
        16 => 2925.,
        _ => 0.,
    }
}

/// DNG color tags of a three-color image.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct DngColor {
    /// CalibrationIlluminant1 and 2.
    pub illuminants: [u32; 2],
    /// ColorMatrix1 and 2, XYZ to camera. Zero when absent.
    pub color_matrix: [M3; 2],
    /// CameraCalibration1 and 2. Zero when absent.
    pub calibration: [M3; 2],
    /// ForwardMatrix1 and 2, white-balanced camera to D50 XYZ. Zero when absent.
    pub forward_matrix: [M3; 2],
    pub analog_balance: [f64; 3],
    /// AsShotNeutral, or None to use D65.
    pub as_shot_neutral: Option<[f64; 3]>,
    /// BaselineExposure in EV.
    pub baseline_exposure: f64,
}

/// The calibration the renderer receives, see `x3f_core::WhiteBalanceCalibration`.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Calibration {
    /// Normalized camera values to extended-linear sRGB D65, with BaselineExposure.
    pub camera_to_rgb: M3,
    pub xyz_to_camera: M3,
    /// Camera neutral, largest channel one.
    pub neutral: [f64; 3],
}

fn present(m: &M3) -> bool {
    m.iter().any(|v| *v != 0.)
}

impl DngColor {
    /// The weight of the first illuminant at a white; one for a single matrix.
    fn weight(&self, white: [f64; 2]) -> f64 {
        let [t1, t2] = self.illuminants.map(illuminant_temperature);
        if !present(&self.color_matrix[1]) || t1 <= 0. || t2 <= 0. || t1 == t2 {
            return 1.;
        }
        let ((lo, hi), lo_is_first) = if t1 < t2 {
            ((t1, t2), true)
        } else {
            ((t2, t1), false)
        };
        let t = temperature(white);
        let g = if t.is_finite() {
            ((1. / t - 1. / hi) / (1. / lo - 1. / hi)).clamp(0., 1.)
        } else {
            1.
        };
        if lo_is_first {
            g
        } else {
            1. - g
        }
    }

    fn blend(&self, pair: &[M3; 2], g: f64, default: M3) -> M3 {
        let pick = |m: &M3| if present(m) { *m } else { default };
        let (a, b) = (pick(&pair[0]), pick(&pair[1]));
        std::array::from_fn(|i| g * a[i] + (1. - g) * b[i])
    }

    /// AnalogBalance * CameraCalibration at a white.
    fn individual(&self, g: f64) -> M3 {
        mul(
            &diag(self.analog_balance),
            &self.blend(&self.calibration, g, IDENTITY),
        )
    }

    fn xyz_to_camera(&self, white: [f64; 2]) -> M3 {
        let g = self.weight(white);
        mul(
            &self.individual(g),
            &self.blend(&self.color_matrix, g, self.color_matrix[0]),
        )
    }

    pub(crate) fn calibration(&self) -> Result<Calibration, String> {
        if !present(&self.color_matrix[0]) {
            return Err("The DNG has no ColorMatrix1".into());
        }
        let neutral = match self.as_shot_neutral {
            Some(n) => n,
            None => apply(&self.xyz_to_camera(D65_XY), xy_to_xyz(D65_XY)),
        };
        let max = neutral.iter().copied().fold(f64::MIN, f64::max);
        if neutral.iter().any(|v| !v.is_finite() || *v <= 0.) {
            return Err("The DNG camera neutral is invalid".into());
        }
        let neutral = neutral.map(|v| v / max);
        // The white whose camera response is the neutral, as in the DNG SDK.
        let mut white = D50_XY;
        for _ in 0..30 {
            let next = inverse(&self.xyz_to_camera(white))
                .and_then(|m| xyz_to_xy(apply(&m, neutral)))
                .ok_or("The DNG color matrix is singular")?;
            let done = (next[0] - white[0]).abs() + (next[1] - white[1]).abs() < 1e-7;
            white = next;
            if done {
                break;
            }
        }
        let g = self.weight(white);
        let xyz_to_camera = self.xyz_to_camera(white);
        let camera_to_pcs = if present(&self.forward_matrix[0]) {
            let individual = inverse(&self.individual(g)).ok_or("CameraCalibration is singular")?;
            let reference = apply(&individual, neutral);
            if reference.iter().any(|v| !v.is_finite() || *v <= 0.) {
                return Err("The DNG reference neutral is invalid".into());
            }
            let fm = self.blend(&self.forward_matrix, g, self.forward_matrix[0]);
            mul(&fm, &mul(&diag(reference.map(|v| 1. / v)), &individual))
        } else {
            let pcs_to_camera = mul(&xyz_to_camera, &bradford(D50_XY, white));
            let peak = apply(&pcs_to_camera, xy_to_xyz(D50_XY))
                .into_iter()
                .fold(f64::MIN, f64::max);
            if !peak.is_finite() || peak <= 0. {
                return Err("The DNG color matrix is invalid".into());
            }
            inverse(&scale(&pcs_to_camera, 1. / peak)).ok_or("The DNG color matrix is singular")?
        };
        let exposure = 2f64.powf(self.baseline_exposure);
        let camera_to_rgb = scale(
            &mul(&mul(&srgb(), &bradford(D50_XY, D65_XY)), &camera_to_pcs),
            exposure,
        );
        if camera_to_rgb
            .iter()
            .chain(&xyz_to_camera)
            .any(|v| !v.is_finite())
            || inverse(&camera_to_rgb).is_none()
        {
            return Err("The DNG color calibration is invalid".into());
        }
        Ok(Calibration {
            camera_to_rgb,
            xyz_to_camera,
            neutral,
        })
    }
}

/// A monochrome image keeps gray in all three channels.
pub(crate) fn monochrome(baseline_exposure: f64) -> Calibration {
    // Gray has no camera white balance; this keeps the matrices invertible.
    Calibration {
        camera_to_rgb: scale(&IDENTITY, 2f64.powf(baseline_exposure)),
        xyz_to_camera: srgb(),
        neutral: [1.; 3],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: [f64; 3], b: [f64; 3], tol: f64) {
        for i in 0..3 {
            assert!((a[i] - b[i]).abs() < tol, "{a:?} != {b:?}");
        }
    }

    fn sample() -> DngColor {
        DngColor {
            illuminants: [17, 21],
            color_matrix: [
                [0.85, -0.2, -0.05, -0.45, 1.25, 0.2, -0.1, 0.25, 0.75],
                [0.7, -0.15, -0.05, -0.4, 1.2, 0.2, -0.05, 0.15, 0.6],
            ],
            calibration: [[0.; 9]; 2],
            forward_matrix: [[0.; 9]; 2],
            analog_balance: [1.; 3],
            as_shot_neutral: Some([0.5, 1., 0.7]),
            baseline_exposure: 0.,
        }
    }

    #[test]
    fn neutral_maps_to_white() {
        let mut color = sample();
        let cal = color.calibration().unwrap();
        close(apply(&cal.camera_to_rgb, cal.neutral), [1.; 3], 1e-4);
        // The matrices see the same white as the neutral.
        let white = apply(&inverse(&cal.xyz_to_camera).unwrap(), cal.neutral);
        let n = apply(&cal.xyz_to_camera, white);
        close(n, cal.neutral, 1e-9);
        // BaselineExposure scales the output only.
        color.baseline_exposure = 1.;
        let cal = color.calibration().unwrap();
        close(apply(&cal.camera_to_rgb, cal.neutral), [2.; 3], 2e-4);
    }

    #[test]
    fn forward_matrix_maps_neutral_to_white() {
        let mut color = sample();
        // Forward matrices map the reference neutral [1, 1, 1] to D50.
        let d50 = xy_to_xyz(D50_XY);
        let base: M3 = [0.6, 0.25, 0.1, 0.25, 0.7, 0.05, 0.05, 0.1, 0.65];
        let row = |r: usize| (0..3).map(|k| base[r * 3 + k]).sum::<f64>();
        color.forward_matrix[0] = std::array::from_fn(|i| base[i] * d50[i / 3] / row(i / 3));
        color.calibration[0] = diag([0.9, 1., 1.1]);
        color.analog_balance = [1.05, 1., 0.95];
        let cal = color.calibration().unwrap();
        close(apply(&cal.camera_to_rgb, cal.neutral), [1.; 3], 1e-4);
    }

    #[test]
    fn dual_illuminant_weight_follows_inverse_temperature() {
        let color = sample();
        assert_eq!(color.weight(D65_XY), 0.);
        // McCamy puts illuminant A at 2856 K; the DNG table says 2850 K.
        assert!((color.weight([0.4476, 0.4074]) - 1.).abs() < 0.01);
        let mid = color.weight([0.38, 0.38]);
        assert!(mid > 0. && mid < 1.);
    }

    #[test]
    fn missing_matrix_is_an_error() {
        let mut color = sample();
        color.color_matrix = [[0.; 9]; 2];
        assert!(color.calibration().is_err());
    }

    #[test]
    fn monochrome_is_gray() {
        let cal = monochrome(0.5);
        close(
            apply(&cal.camera_to_rgb, [0.25; 3]),
            [0.25 * 2f64.sqrt(); 3],
            1e-12,
        );
        close(apply(&cal.xyz_to_camera, xy_to_xyz(D65_XY)), [1.; 3], 1e-12);
    }
}
