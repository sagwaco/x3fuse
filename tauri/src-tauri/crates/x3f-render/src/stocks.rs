//! Film and paper stock list shared with the frontend. The renderer indexes
//! bundled spektrafilm profiles in this order; see film::profile::PROFILE_JSON.
pub const STOCKS_JSON: &str = include_str!("../assets/stocks.json");
