//! Hardware smoke check: cargo run --release -p x3f-render --example render -- photo.X3F preview.png [film-index] [monochrome-filter]
use std::{path::PathBuf, sync::atomic::AtomicBool};
use x3f_core::{prepare_scene_linear, SceneLinearOptions};
use x3f_render::{EditRecipe, FilmSettings, MonochromeSettings, RenderOptions, Renderer};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() < 2 {
        return Err(
            "usage: render input.X3F output.png|jpg|tiff [film-index] [monochrome-filter]".into(),
        );
    }
    let input = PathBuf::from(&args[0]);
    let output = PathBuf::from(&args[1]);
    let cancel = AtomicBool::new(false);
    let start = std::time::Instant::now();
    let mut recipe = EditRecipe::default();
    if let Some(stock) = args.get(2) {
        let stock = stock.to_string_lossy().parse()?;
        recipe.film = Some(FilmSettings {
            film: stock,
            negative: (15..=18).contains(&stock),
            ..Default::default()
        });
    }
    if let Some(filter) = args.get(3) {
        recipe.monochrome = Some(MonochromeSettings {
            filter: serde_json::from_value(serde_json::Value::String(
                filter.to_string_lossy().into_owned(),
            ))?,
        });
    }
    let image = prepare_scene_linear(
        &input,
        &SceneLinearOptions {
            denoise_intensity: recipe.denoise,
            ..Default::default()
        },
        &cancel,
        |stage| eprintln!("{stage:?}"),
    )?;
    eprintln!(
        "Prepared {}x{} in {:?}",
        image.width,
        image.height,
        start.elapsed()
    );
    let renderer = Renderer::new()?;
    eprintln!("GPU: {}", renderer.adapter_name);
    let preview = output.extension().is_some_and(|e| e == "png");
    let result = renderer.render(
        &image,
        &recipe,
        RenderOptions {
            max_dimension: preview.then_some(1600),
            ..Default::default()
        },
        &cancel,
    )?;
    match output.extension().and_then(|e| e.to_str()) {
        Some("jpg" | "jpeg") => std::fs::write(&output, result.jpeg(95)?)?,
        Some("tif" | "tiff") => result.write_tiff(&output, true, &cancel)?,
        Some("png") => std::fs::write(&output, result.png()?)?,
        _ => return Err("output extension must be png, jpg, or tiff".into()),
    }
    eprintln!(
        "Rendered {}x{} in {:?}",
        result.width,
        result.height,
        start.elapsed()
    );
    Ok(())
}
