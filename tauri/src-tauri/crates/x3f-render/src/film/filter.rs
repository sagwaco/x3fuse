//! Coloured taking filters for B&W film: measured Hoya transmittance curves
//! from spektrafilm (`data/filters/colored/hoya`, experimental `28bf883`),
//! bundled unmodified. As in spektrafilm, the transmittance multiplies the
//! film's spectral sensitivity.
use super::data::{N_WL, WL_MIN, WL_STEP};
use crate::MonochromeFilter;

/// The measured curve for a filter. There is no blue curve in the library, so
/// `Blue` and `Neutral` mean no filter.
fn csv(filter: MonochromeFilter) -> Option<&'static str> {
    match filter {
        MonochromeFilter::Yellow => Some(include_str!("../../assets/filters/hoya/y2.csv")),
        MonochromeFilter::Orange => Some(include_str!("../../assets/filters/hoya/ya3.csv")),
        MonochromeFilter::Red => Some(include_str!("../../assets/filters/hoya/r1.csv")),
        MonochromeFilter::Green => Some(include_str!("../../assets/filters/hoya/x1.csv")),
        MonochromeFilter::Neutral | MonochromeFilter::Blue => None,
    }
}

/// True when the filter changes the film exposure.
pub fn has_curve(filter: MonochromeFilter) -> bool {
    csv(filter).is_some()
}

/// Transmittance on the renderer's wavelength grid, or `None` for no filter.
/// Duplicate wavelengths keep their first sample, as spektrafilm does.
///
/// ponytail: linear interpolation where spektrafilm uses Akima; the curves
/// have 3-5 nm spacing, so the two agree closely. Port Akima if parity tests
/// ever need it.
pub fn transmittance(filter: MonochromeFilter) -> Option<[f64; N_WL]> {
    let mut points: Vec<(f64, f64)> = Vec::new();
    for line in csv(filter)?.lines() {
        let mut fields = line.split(',').map(|v| v.trim().parse::<f64>());
        if let (Some(Ok(wl)), Some(Ok(t))) = (fields.next(), fields.next()) {
            if points.last().is_none_or(|&(last, _)| wl > last) {
                points.push((wl, t));
            }
        }
    }
    Some(std::array::from_fn(|i| {
        let wl = WL_MIN + i as f64 * WL_STEP;
        let hi = points
            .partition_point(|&(x, _)| x < wl)
            .clamp(1, points.len() - 1);
        let ((x0, y0), (x1, y1)) = (points[hi - 1], points[hi]);
        (y0 + (y1 - y0) * (wl - x0) / (x1 - x0)).clamp(0., 1.)
    }))
}
