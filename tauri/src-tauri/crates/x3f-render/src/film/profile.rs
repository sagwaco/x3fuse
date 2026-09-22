//! spektrafilm film/paper profile JSON, ported from
//! `spektrafilm-core/src/profile.rs` (v0.1.2 / 9dd59b0, GPL-3.0-only).
//! Only the fields the shipped colour profiles need are deserialized; the
//! bundled JSON files are byte-identical copies of the upstream data.
use crate::RenderError;
use serde::Deserialize;

/// `null` in the JSON means "no measurement at this wavelength". Spectral
/// tables keep it as NaN so the light integration can drop that wavelength;
/// curves and sensitivities read it as zero, matching spektrafilm.
fn nan_matrix<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<[f64; 3]>, D::Error> {
    let rows: Vec<Vec<Option<f64>>> = Deserialize::deserialize(d)?;
    Ok(rows
        .into_iter()
        .map(|row| std::array::from_fn(|c| row.get(c).copied().flatten().unwrap_or(f64::NAN)))
        .collect())
}
fn nan_vec<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<f64>, D::Error> {
    let v: Vec<Option<f64>> = Deserialize::deserialize(d)?;
    Ok(v.into_iter().map(|x| x.unwrap_or(f64::NAN)).collect())
}
fn zero_matrix<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<[f64; 3]>, D::Error> {
    let rows: Vec<Vec<Option<f64>>> = Deserialize::deserialize(d)?;
    Ok(rows
        .into_iter()
        .map(|row| std::array::from_fn(|c| row.get(c).copied().flatten().unwrap_or(0.)))
        .collect())
}

#[derive(Debug, Clone, Deserialize)]
pub struct Profile {
    pub info: Info,
    pub data: Data,
}
#[derive(Debug, Clone, Deserialize)]
pub struct Info {
    pub stock: String,
    #[serde(rename = "type")]
    pub film_type: String,
    #[serde(default)]
    pub reference_illuminant: String,
}
#[derive(Debug, Clone, Deserialize)]
pub struct Data {
    #[serde(deserialize_with = "zero_matrix")]
    pub log_sensitivity: Vec<[f64; 3]>,
    #[serde(default)]
    pub hanatos2025_adaptation_window_params: Vec<f64>,
    #[serde(deserialize_with = "nan_matrix")]
    pub channel_density: Vec<[f64; 3]>,
    #[serde(deserialize_with = "nan_vec")]
    pub base_density: Vec<f64>,
    pub log_exposure: Vec<f64>,
    #[serde(deserialize_with = "zero_matrix")]
    pub density_curves: Vec<[f64; 3]>,
    pub density_curves_model: CurvesModel,
}

/// Sum-of-CDFs parametric fit of the density curves. Each channel's density is
/// `sum_i amplitudes[i] * Phi((x - centers[i]) / sigmas[i])`, sign-flipped for
/// positive stocks. spektrafilm's print develop always evaluates this model.
#[derive(Debug, Clone, Deserialize)]
pub struct CurvesModel {
    pub model_type: String,
    pub centers: Vec<Vec<f64>>,
    pub amplitudes: Vec<Vec<f64>>,
    pub sigmas: Vec<Vec<f64>>,
}

impl Profile {
    pub fn is_positive(&self) -> bool {
        self.info.film_type == "positive"
    }
    /// Sensitivity as `10^log_sensitivity`, with non-finite entries dropped to
    /// zero (Python `np.nan_to_num(10 ** log_sensitivity)`).
    pub fn sensitivity(&self) -> Vec<[f64; 3]> {
        self.data
            .log_sensitivity
            .iter()
            .map(|row| {
                row.map(|v| {
                    let s = 10f64.powf(v);
                    if s.is_finite() {
                        s
                    } else {
                        0.
                    }
                })
            })
            .collect()
    }
    /// Density curves with the per-channel minimum removed, as the filming
    /// develop stage uses them.
    pub fn normalized_curves(&self) -> Vec<[f64; 3]> {
        let mut min = [f64::INFINITY; 3];
        for row in &self.data.density_curves {
            for c in 0..3 {
                if row[c].is_finite() && row[c] < min[c] {
                    min[c] = row[c];
                }
            }
        }
        self.data
            .density_curves
            .iter()
            .map(|row| std::array::from_fn(|c| row[c] - min[c]))
            .collect()
    }
    /// Evaluate the fitted sum-of-CDFs model at every `log_exposure` sample —
    /// spektrafilm's `morph_density_curves` with the morph inactive. The
    /// s023 coupled-gamma morph itself is not ported.
    pub fn model_curves(&self) -> Result<Vec<[f64; 3]>, RenderError> {
        let m = &self.data.density_curves_model;
        if (m.model_type != "cdfs" && m.model_type != "norm_cdfs")
            || m.centers.len() != 3
            || m.amplitudes.len() != 3
            || m.sigmas.len() != 3
        {
            return Err(RenderError::Invalid(format!(
                "Unsupported print density model in {}",
                self.info.stock
            )));
        }
        let positive = self.is_positive();
        Ok(self
            .data
            .log_exposure
            .iter()
            .map(|&x| {
                std::array::from_fn(|c| {
                    (0..m.centers[c].len())
                        .map(|i| {
                            let z = (x - m.centers[c][i]) / m.sigmas[c][i];
                            m.amplitudes[c][i] * norm_cdf(if positive { -z } else { z })
                        })
                        .sum()
                })
            })
            .collect())
    }
}

/// Standard-normal CDF via the cephes `ndtr` split that `scipy.stats.norm.cdf`
/// uses, so the fitted print curves match the reference bit for bit.
fn norm_cdf(a: f64) -> f64 {
    const SQRTH: f64 = std::f64::consts::FRAC_1_SQRT_2;
    let x = a * SQRTH;
    if x.abs() < SQRTH {
        0.5 + 0.5 * libm::erf(x)
    } else {
        let y = 0.5 * libm::erfc(x.abs());
        if x > 0. {
            1. - y
        } else {
            y
        }
    }
}

macro_rules! profiles {
    ($($key:literal),* $(,)?) => {
        /// Every bundled profile, in `stocks.json` order: 20 films then 8 papers.
        pub const PROFILE_JSON: [(&str, &str); 28] = [
            $(($key, include_str!(concat!("../../assets/profiles/", $key, ".json")))),*
        ];
    };
}
profiles![
    "kodak_ektar_100",
    "kodak_portra_160",
    "kodak_portra_400",
    "kodak_portra_800",
    "kodak_portra_800_push1",
    "kodak_portra_800_push2",
    "kodak_gold_200",
    "kodak_ultramax_400",
    "kodak_vision3_50d",
    "kodak_vision3_250d",
    "kodak_vision3_200t",
    "kodak_vision3_500t",
    "fujifilm_pro_400h",
    "fujifilm_xtra_400",
    "fujifilm_c200",
    "kodak_ektachrome_100",
    "kodak_kodachrome_64",
    "fujifilm_provia_100f",
    "fujifilm_velvia_100",
    "kodak_verita_200d",
    "kodak_endura_premier",
    "kodak_ektacolor_edge",
    "kodak_supra_endura",
    "kodak_portra_endura",
    "fujifilm_crystal_archive_typeii",
    "kodak_2383",
    "kodak_2393",
    "kodak_ultra_endura",
];

pub fn load(index: usize) -> Result<Profile, RenderError> {
    let (key, json) = PROFILE_JSON[index];
    serde_json::from_str(json)
        .map_err(|e| RenderError::Invalid(format!("Bundled profile {key} is invalid: {e}")))
}
