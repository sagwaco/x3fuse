//! spektrafilm film/paper profiles, updated from experimental 28bf883.
//! Curves follow `runtime/pipeline.py` and `model/density_curves.py`.
//! Only the fields the shipped profiles need are deserialized; the bundled
//! JSON files are byte-identical copies of the upstream data.
use crate::RenderError;
use serde::Deserialize;

/// `null` in the JSON means "no measurement at this wavelength". Spectral
/// tables keep it as NaN so the light integration can drop that wavelength.
/// A NaN log sensitivity becomes zero sensitivity, as in spektrafilm.
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
    #[serde(default)]
    development_time: Option<Vec<f64>>,
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
    #[serde(rename = "use")]
    pub use_kind: String,
    #[cfg(test)]
    pub antihalation: String,
    #[serde(default)]
    pub reference_illuminant: String,
    pub viewing_illuminant: String,
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
        let development = if bw {
            data.development_time
                .as_ref()
                .map_or(0, |times| times.len().saturating_sub(1) / 2)
        } else {
            0
        };
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
            density_curves: Vec::new(),
            density_curves_model: model,
        };
        let mut profile = Self { info, data };
        profile.data.density_curves = profile.model_curves().map_err(|e| e.to_string())?;
        Ok(profile)
    }
}

/// Sum-of-CDFs parametric fit of the density curves. Each channel's density is
/// `sum_i amplitudes[i] * Phi((x - centers[i]) / sigmas[i])`, sign-flipped for
/// positive stocks. Both film and paper use this model.
#[derive(Debug, Clone, Deserialize)]
pub struct CurvesModel {
    pub model_type: String,
    pub centers: Vec<Vec<f64>>,
    pub amplitudes: Vec<Vec<f64>>,
    pub sigmas: Vec<Vec<f64>>,
}

impl Profile {
    /// Apply the global chemistry contrast before calibration and grain setup.
    pub fn apply_gamma(&mut self, gamma: f64) -> Result<(), RenderError> {
        if !gamma.is_finite() || gamma <= 0. {
            return Err(RenderError::Invalid("Invalid chemistry contrast".into()));
        }
        if gamma == 1. {
            return Ok(());
        }
        let model = &mut self.data.density_curves_model;
        for c in 0..3 {
            for center in &mut model.centers[c] {
                *center /= gamma;
            }
            for sigma in &mut model.sigmas[c] {
                *sigma = (*sigma / gamma).max(0.05);
            }
        }
        self.data.density_curves = self.model_curves()?;
        Ok(())
    }
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
    /// Evaluate the fitted sum-of-CDFs model on the profile exposure grid.
    pub fn model_curves(&self) -> Result<Vec<[f64; 3]>, RenderError> {
        Ok(self
            .model_layers()?
            .into_iter()
            .map(|layers| std::array::from_fn(|c| layers.iter().map(|row| row[c]).sum()))
            .collect())
    }
    /// Evaluate each fitted sublayer in [exposure][sublayer][channel] order.
    /// B&W channels share the same layer values.
    pub fn model_layers(&self) -> Result<Vec<Vec<[f64; 3]>>, RenderError> {
        let m = &self.data.density_curves_model;
        if (m.model_type != "cdfs" && m.model_type != "norm_cdfs")
            || m.centers.len() != 3
            || m.amplitudes.len() != 3
            || m.sigmas.len() != 3
        {
            return Err(RenderError::Invalid(format!(
                "Unsupported density model in {}",
                self.info.stock
            )));
        }
        for c in 0..3 {
            let layers = m.centers[c].len();
            if layers == 0
                || layers != m.centers[0].len()
                || m.amplitudes[c].len() != layers
                || m.sigmas[c].len() != layers
                || m.centers[c].iter().any(|v| !v.is_finite())
                || m.amplitudes[c].iter().any(|v| !v.is_finite())
                || m.sigmas[c].iter().any(|v| !v.is_finite() || *v <= 0.)
            {
                return Err(RenderError::Invalid(format!(
                    "Invalid density model parameters in {}",
                    self.info.stock
                )));
            }
        }
        let positive = self.is_positive();
        Ok(self
            .data
            .log_exposure
            .iter()
            .map(|&x| {
                (0..m.centers[0].len())
                    .map(|i| {
                        std::array::from_fn(|c| {
                            let z = (x - m.centers[c][i]) / m.sigmas[c][i];
                            m.amplitudes[c][i] * norm_cdf(if positive { -z } else { z })
                        })
                    })
                    .collect()
            })
            .collect())
    }
}

/// Standard-normal CDF via the cephes `ndtr` split that `scipy.stats.norm.cdf`
/// uses. This keeps the fitted curves close to the reference values.
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

#[cfg(test)]
mod tests {
    use super::*;

    fn stock(key: &str) -> Profile {
        load(PROFILE_JSON.iter().position(|(k, _)| *k == key).unwrap()).unwrap()
    }

    fn close(actual: [f64; 3], expected: [f64; 3]) {
        for c in 0..3 {
            assert!(
                (actual[c] - expected[c]).abs() < 1e-12,
                "{actual:?} != {expected:?}"
            );
        }
    }

    #[test]
    fn model_totals_match_upstream_samples() {
        // Values from 28bf883 refresh_density_curves_from_model, then select_development_time(None).
        for (key, expected) in [
            (
                "kodak_portra_400",
                [0.9556629848883033, 0.9608902585340342, 1.1721366861413787],
            ),
            (
                "kodak_portra_endura",
                [2.0054176335700187, 1.630431509447592, 1.6611256670371635],
            ),
            (
                "kodak_ektachrome_100",
                [0.13738097706040422, 0.12247186751276927, 0.1354996607256183],
            ),
            ("kodak_doublex", [1.0960335481154473; 3]),
            ("kodak_trix", [0.07677439065787486; 3]),
            ("kodak_2302", [1.952995735899058; 3]),
        ] {
            close(stock(key).data.density_curves[128], expected);
        }
        close(
            stock("kodak_portra_400").normalized_curves()[128],
            [0.9556629027583362, 0.9608899529738826, 1.1721357015945104],
        );
    }

    #[test]
    fn sampled_json_curves_are_not_runtime_inputs() {
        for key in ["kodak_portra_400", "kodak_portra_endura", "kodak_doublex"] {
            let (_, json) = PROFILE_JSON.iter().find(|(k, _)| *k == key).unwrap();
            let mut stored: serde_json::Value = serde_json::from_str(json).unwrap();
            stored["data"]
                .as_object_mut()
                .unwrap()
                .remove("density_curves");
            let profile: Profile = serde_json::from_value(stored).unwrap();
            assert_eq!(profile.data.density_curves, stock(key).data.density_curves);
        }
    }

    #[test]
    fn model_layers_match_upstream_and_sum_to_totals() {
        close(
            stock("kodak_portra_400").model_layers().unwrap()[128][1],
            [0.3506788030626824, 0.3838471578446277, 0.49654581074013376],
        );
        close(
            stock("kodak_doublex").model_layers().unwrap()[128][1],
            [0.3571119156579875; 3],
        );
        for index in 0..PROFILE_JSON.len() {
            let profile = load(index).unwrap();
            let layers = profile.model_layers().unwrap();
            assert_eq!(layers.len(), profile.data.log_exposure.len());
            for (layers, total) in layers.iter().zip(&profile.data.density_curves) {
                close(
                    std::array::from_fn(|c| layers.iter().map(|layer| layer[c]).sum()),
                    *total,
                );
                if profile.is_monochrome() {
                    assert!(layers.iter().all(|layer| *layer == [layer[0]; 3]));
                }
            }
        }
    }

    #[test]
    fn bw_development_and_stock_metadata_are_preserved() {
        let film = stock("kodak_doublex");
        assert_eq!(film.data.base_density[0], 0.209166);
        assert!(film
            .data
            .channel_density
            .iter()
            .all(|row| *row == [1. / 3.; 3]));
        assert_eq!(film.sensitivity()[60], [0.; 3]);
        assert_eq!(film.info.use_kind, "cine");
        assert_eq!(film.info.antihalation, "strong");
        let gold = stock("kodak_gold_200");
        assert_eq!(gold.info.use_kind, "still");
        assert_eq!(gold.info.antihalation, "weak");
    }

    #[test]
    fn chemistry_gamma_matches_upstream_total_and_layer_curves() {
        // 28bf883 apply_print_curves_morph_with_layers, exposure index 128, layer 1.
        for (key, gamma, total, layer) in [
            (
                "kodak_portra_400",
                0.5,
                [0.8127721187602818, 0.8290843821523483, 1.0151215919888312],
                [0.22201418681711685, 0.26646098237266413, 0.3562152184358579],
            ),
            (
                "kodak_portra_400",
                1.0,
                [0.9556629848883033, 0.9608902585340342, 1.1721366861413787],
                [0.3506788030626824, 0.3838471578446277, 0.49654581074013376],
            ),
            (
                "kodak_portra_400",
                2.0,
                [1.2529780884557624, 1.2181784693247841, 1.4710709949747718],
                [0.5788165071280293, 0.5547930926632398, 0.6861783387937229],
            ),
            (
                "kodak_ektachrome_100",
                0.5,
                [0.28920922545869426, 0.2730684080547511, 0.2884800295093356],
                [
                    0.005941191559822337,
                    0.005225898650084037,
                    0.004976726196127794,
                ],
            ),
            (
                "kodak_ektachrome_100",
                1.0,
                [0.13738097706040422, 0.12247186751276927, 0.1354996607256183],
                [
                    0.0010023082220906613,
                    0.0008255996699839058,
                    0.0007967400107108458,
                ],
            ),
            (
                "kodak_ektachrome_100",
                2.0,
                [
                    0.013900061721339478,
                    0.010755456483281616,
                    0.013535581103623533,
                ],
                [
                    1.1084289043124522e-05,
                    7.849088669833307e-06,
                    7.952956460237962e-06,
                ],
            ),
            (
                "kodak_portra_endura",
                0.5,
                [1.352575156053414, 1.1388243344671796, 1.1775987249930753],
                [0.4662915407332867, 0.4414772593413771, 0.3681754626602072],
            ),
            (
                "kodak_portra_endura",
                1.0,
                [2.0054176335700187, 1.630431509447592, 1.6611256670371635],
                [0.8214248262250107, 0.7157908908560228, 0.6256591934823413],
            ),
            (
                "kodak_portra_endura",
                2.0,
                [2.4229150050001262, 2.0117877805313755, 1.818815362626367],
                [0.8978315558731471, 0.7661816649037713, 0.6755600007469199],
            ),
            (
                "kodak_doublex",
                0.5,
                [0.9193240131938395; 3],
                [0.266973758645772; 3],
            ),
            (
                "kodak_doublex",
                1.0,
                [1.0960335481154473; 3],
                [0.3571119156579875; 3],
            ),
            (
                "kodak_doublex",
                2.0,
                [1.4094675291582317; 3],
                [0.4935187335959667; 3],
            ),
            (
                "kodak_trix",
                0.5,
                [0.2297088989624695; 3],
                [0.010652730386630133; 3],
            ),
            (
                "kodak_trix",
                1.0,
                [0.07677439065787486; 3],
                [0.0011247674822128485; 3],
            ),
            (
                "kodak_trix",
                2.0,
                [0.0026047392647019474; 3],
                [2.407511230151801e-06; 3],
            ),
            (
                "kodak_2302",
                0.5,
                [1.2887358163524145; 3],
                [0.6566656582636692; 3],
            ),
            (
                "kodak_2302",
                1.0,
                [1.952995735899058; 3],
                [0.9291321145771804; 3],
            ),
            (
                "kodak_2302",
                2.0,
                [3.1707478676320666; 3],
                [1.3591007103859014; 3],
            ),
        ] {
            let mut profile = stock(key);
            let original = profile.data.density_curves.clone();
            profile.apply_gamma(gamma).unwrap();
            let layers = profile.model_layers().unwrap();
            close(profile.data.density_curves[128], total);
            close(layers[128][1], layer);
            for (layers, total) in layers.iter().zip(&profile.data.density_curves) {
                close(
                    std::array::from_fn(|c| layers.iter().map(|layer| layer[c]).sum()),
                    *total,
                );
            }
            if gamma == 1. {
                assert_eq!(profile.data.density_curves, original);
            }
        }
    }

    #[test]
    fn invalid_chemistry_gamma_preserves_the_profile() {
        let mut profile = stock("kodak_portra_400");
        let original = profile.data.density_curves.clone();
        for gamma in [0., -1., f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert!(profile.apply_gamma(gamma).is_err());
            assert_eq!(profile.data.density_curves, original);
        }
    }

    #[test]
    fn invalid_model_parameters_return_errors() {
        let mut profile = stock("kodak_portra_400");
        profile.data.density_curves_model.sigmas[0][0] = 0.;
        assert!(profile.model_curves().is_err());
        let mut profile = stock("kodak_portra_400");
        profile.data.density_curves_model.centers[1].pop();
        assert!(profile.model_layers().is_err());
    }
}
