//! Film and paper stock list shared with the frontend. The renderer indexes
//! bundled spektrafilm profiles in this order; see film::profile::PROFILE_JSON.
pub const STOCKS_JSON: &str = include_str!("../assets/stocks.json");

pub(crate) fn monochrome_film(index: u32) -> bool {
    static MONOCHROME: std::sync::OnceLock<Vec<bool>> = std::sync::OnceLock::new();
    MONOCHROME
        .get_or_init(|| {
            let stocks: Vec<serde_json::Value> =
                serde_json::from_str(STOCKS_JSON).expect("Bundled stock list");
            stocks
                .into_iter()
                .filter(|stock| stock["isPaper"] == false)
                .map(|stock| stock["monochrome"] == true)
                .collect()
        })
        .get(index as usize)
        .copied()
        .unwrap_or(false)
}
