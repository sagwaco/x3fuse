//! spektrafilm film/paper profile JSON, ported from
//! `spektrafilm-core/src/profile.rs` (v0.1.2 / 9dd59b0, GPL-3.0-only).
//! Only the fields the shipped profiles need are deserialized; the bundled
//! JSON files are byte-identical copies of the upstream data.
use crate::RenderError;
use serde::Deserialize;

/// `null` in the JSON means "no measurement at this wavelength". Spectral
/// tables keep it as NaN so the light integration can drop that wavelength.
/// Curves read it as zero, and a NaN log sensitivity becomes zero
/// sensitivity, matching spektrafilm.
type Rows = Vec<Vec<Option<f64>>>;

/// A spektrafilm profile as stored. B&W profiles (`channel_model: "bw"`) have
/// one emulsion channel and one column per development time.
#[derive(Deserialize)]
struct Stored {
    info: Info,
    data: StoredData,
}
#[derive(Deserialize)]
struct StoredData {
    log_sensitivity: Rows,
    #[serde(default)]
    hanatos2025_adaptation_window_params: Option<Vec<f64>>,
    channel_density: Rows,
    base_density: BaseDensity,
    log_exposure: Vec<f64>,
    density_curves: Rows,
    density_curves_model: CurvesModel,
}
#[derive(Deserialize)]
#[serde(untagged)]
enum BaseDensity {
    Color(Vec<Option<f64>>),
    Bw(Rows),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(try_from = "Stored")]
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
    #[serde(default)]
    pub channel_model: String,
}
#[derive(Debug, Clone)]
pub struct Data {
    pub log_sensitivity: Vec<[f64; 3]>,
    pub hanatos2025_adaptation_window_params: Vec<f64>,
    pub channel_density: Vec<[f64; 3]>,
    pub base_density: Vec<f64>,
    pub log_exposure: Vec<f64>,
    pub density_curves: Vec<[f64; 3]>,
    pub density_curves_model: CurvesModel,
}

impl TryFrom<Stored> for Profile {
    type Error = String;
    /// A B&W profile becomes three identical channels, so the colour pipeline
    /// runs it unchanged. Each channel carries a third of the silver density,
    /// so the three channels together give the measured density. The middle
    /// development time is used, as in spektrafilm when no time is chosen.
    fn try_from(stored: Stored) -> Result<Self, String> {
        let Stored { info, data } = stored;
        let bw = info.channel_model == "bw";
        let column = |rows: &Rows| rows.first().map_or(0, |row| (row.len().max(1) - 1) / 2);
        let development = if bw { column(&data.density_curves) } else { 0 };
        let rows = |rows: &Rows, column: usize, missing: f64, scale: f64| -> Vec<[f64; 3]> {
            rows.iter()
                .map(|row| {
                    std::array::from_fn(|c| {
                        row.get(if bw { column } else { c })
                            .copied()
                            .flatten()
                            .map_or(missing, |v| v * scale)
                    })
                })
                .collect()
        };
        let base_density = match data.base_density {
            BaseDensity::Color(values) if !bw => values,
            BaseDensity::Bw(values) if bw => values
                .iter()
                .map(|row| row.get(development).copied().flatten())
                .collect(),
            _ => {
                return Err(format!(
                    "{}: base density does not match its channel model",
                    info.stock
                ))
            }
        };
        let mut model = data.density_curves_model;
        if bw {
            // B&W models have one row per development time, each a sum over
            // sublayers. Keep the selected row for all three channels.
            for table in [&mut model.centers, &mut model.amplitudes, &mut model.sigmas] {
                let row = table
                    .get(development)
                    .cloned()
                    .ok_or_else(|| format!("{}: missing development time", info.stock))?;
                *table = vec![row; 3];
            }
        }
        let data = Data {
            log_sensitivity: rows(&data.log_sensitivity, 0, f64::NAN, 1.),
            hanatos2025_adaptation_window_params: data
                .hanatos2025_adaptation_window_params
                .unwrap_or_default(),
            channel_density: rows(
                &data.channel_density,
                0,
                f64::NAN,
                if bw { 1. / 3. } else { 1. },
            ),
            base_density: base_density
                .into_iter()
                .map(|v| v.unwrap_or(f64::NAN))
                .collect(),
            log_exposure: data.log_exposure,
            density_curves: rows(&data.density_curves, development, 0., 1.),
            density_curves_model: model,
        };
        Ok(Self { info, data })
    }
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
    /// One silver layer (spektrafilm `channel_model: "bw"`), loaded as three
    /// identical channels.
    pub fn is_monochrome(&self) -> bool {
        self.info.channel_model == "bw"
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
        /// Every bundled profile, in `stocks.json` order: films then papers.
        pub const PROFILE_JSON: [(&str, &str); 31] = [
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
    "kodak_doublex",
    "kodak_trix",
    "kodak_endura_premier",
    "kodak_ektacolor_edge",
    "kodak_supra_endura",
    "kodak_portra_endura",
    "fujifilm_crystal_archive_typeii",
    "kodak_2383",
    "kodak_2393",
    "kodak_ultra_endura",
    "kodak_2302",
];

/// Films come first in [`PROFILE_JSON`]; paper `n` is profile `FILM_COUNT + n`.
pub const FILM_COUNT: usize = 22;

pub fn load(index: usize) -> Result<Profile, RenderError> {
    let (key, json) = PROFILE_JSON[index];
    serde_json::from_str(json)
        .map_err(|e| RenderError::Invalid(format!("Bundled profile {key} is invalid: {e}")))
}
