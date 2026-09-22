//! Enlarger illuminant, per-stock neutral filtration, and print exposure
//! normalisation. Ported from spektrafilm-rs `spektrafilm-core/src/enlarger.rs`
//! and `neutral_filters.rs` (v0.1.2 / 9dd59b0, GPL-3.0-only).
use super::{
    data::{self, N_WL},
    profile::Profile,
};
use crate::RenderError;

const NEUTRAL_JSON: &str = include_str!("../../assets/neutral_print_filters.json");

/// Per-stock neutral C/M/Y dichroic settings in Kodak CC units, looked up as
/// `paper -> illuminant -> film`. Every shipped pair has a TH-KG3 entry.
pub fn neutral_filters(paper: &str, film: &str) -> Result<[f64; 3], RenderError> {
    let db: serde_json::Value = serde_json::from_str(NEUTRAL_JSON)
        .map_err(|e| RenderError::Invalid(format!("Invalid neutral filter database: {e}")))?;
    let entry = db
        .get(paper)
        .and_then(|v| v.get("TH-KG3"))
        .and_then(|v| v.get(film))
        .and_then(|v| v.as_array())
        .ok_or_else(|| {
            RenderError::Invalid(format!("No neutral print filters for {film} on {paper}"))
        })?;
    if entry.len() != 3 || entry.iter().any(|v| !v.is_f64() && !v.is_i64()) {
        return Err(RenderError::Invalid(
            "Malformed neutral print filter entry".into(),
        ));
    }
    Ok(std::array::from_fn(|i| entry[i].as_f64().unwrap_or(0.)))
}

/// Dichroic C/M/Y transmission curves of the enlarger head.
fn dichroics() -> [[f64; 3]; N_WL] {
    let edges = [516.0f64, 500., 610., 607.];
    let transitions = [12.0f64, 8., 8., 8.];
    std::array::from_fn(|i| {
        let wl = data::WL_MIN + i as f64 * data::WL_STEP;
        [
            -libm::erf((wl - edges[3]) / transitions[3]) / 2. + 0.5,
            if wl <= 550. {
                -libm::erf((wl - edges[1]) / transitions[1]) / 2. + 0.5
            } else {
                libm::erf((wl - edges[2]) / transitions[2]) / 2. + 0.5
            },
            libm::erf((wl - edges[0]) / transitions[0]) / 2. + 0.5,
        ]
    })
}

/// TH-KG3 tungsten-halogen source through the dichroic C/M/Y filters.
/// Filter values are Kodak CC units: 100 = 1.0 density.
pub fn filtered_illuminant(cmy: [f64; 3]) -> Vec<f64> {
    let dichroics = dichroics();
    let transmittance = cmy.map(|cc| 10f64.powf(-cc / 100.));
    (0..N_WL)
        .map(|i| {
            let dimming: f64 = (0..3)
                .map(|f| 1. - (1. - dichroics[i][f]) * (1. - transmittance[f]))
                .product();
            data::ILLUMINANT_TH_KG3[i] * dimming
        })
        .collect()
}

/// Spectral density of a mid-gray card through the film, from its sensor raw.
/// spektrafilm's midgray calibration deliberately uses the *raw* (un-normalised)
/// density curves; the full develop path normalises them.
pub fn midgray_density(raw: [f64; 3], film: &Profile, gamma: f64) -> Vec<f64> {
    let log_raw = raw.map(|v| (v + 1e-10).log10());
    let axis = &film.data.log_exposure;
    let curves = &film.data.density_curves;
    let cmy: [f64; 3] = std::array::from_fn(|c| {
        let x: Vec<f64> = axis.iter().map(|&v| v / gamma).collect();
        let q = log_raw[c];
        if q <= x[0] {
            curves[0][c]
        } else if q >= x[x.len() - 1] {
            curves[x.len() - 1][c]
        } else {
            let hi = x.partition_point(|&v| v <= q);
            let dx = x[hi] - x[hi - 1];
            let f = if dx != 0. { (q - x[hi - 1]) / dx } else { 0. };
            curves[hi - 1][c] + f * (curves[hi][c] - curves[hi - 1][c])
        }
    });
    (0..film.data.channel_density.len())
        .map(|wl| {
            let cd = film.data.channel_density[wl];
            cmy[0] * cd[0]
                + cmy[1] * cd[1]
                + cmy[2] * cd[2]
                + film.data.base_density.get(wl).copied().unwrap_or(0.)
        })
        .collect()
}

/// `1 / geomean(midgray raw through the enlarger)` — the print exposure that
/// lands a mid-gray card on the paper's mid-gray.
pub fn exposure_factor(density: &[f64], illuminant: &[f64], sensitivity: &[[f64; 3]]) -> f64 {
    let n = density.len().min(illuminant.len()).min(sensitivity.len());
    let light: Vec<f64> = (0..n)
        .map(|wl| {
            let t = 10f64.powf(-density[wl]) * illuminant[wl];
            if t.is_finite() {
                t
            } else {
                0.
            }
        })
        .collect();
    let raw: [f64; 3] = std::array::from_fn(|c| {
        super::pairwise_sum(
            &(0..n)
                .map(|wl| light[wl] * sensitivity[wl][c])
                .collect::<Vec<_>>(),
        )
    });
    let log_mean = raw.iter().map(|&v| v.max(1e-10).ln()).sum::<f64>() / 3.;
    1. / log_mean.exp()
}
