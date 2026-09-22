//! Repeatable warm adjustment latency, including separate lossless preview encoding.
//! cargo run --release -p x3f-render --example benchmark -- photo.X3F [repeats] [monochrome-filter]
use std::{path::PathBuf, sync::atomic::AtomicBool, time::Instant};
use x3f_core::{prepare_scene_linear, SceneLinearOptions};
use x3f_render::{
    EditRecipe, FilmSettings, MonochromeSettings, PreparedImage, RenderOptions, Renderer,
};

fn median(values: &mut [f64]) -> f64 {
    values.sort_by(f64::total_cmp);
    values[values.len() / 2]
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let input = PathBuf::from(
        args.first()
            .ok_or("usage: benchmark photo.X3F [repeats] [monochrome-filter]")?,
    );
    let repeats: usize = args
        .get(1)
        .map(|a| a.to_string_lossy().parse())
        .transpose()?
        .unwrap_or(5);
    if !(1..=30).contains(&repeats) {
        return Err("repeats must be 1..30".into());
    }
    let monochrome = args
        .get(2)
        .map(|filter| {
            serde_json::from_value(serde_json::Value::String(
                filter.to_string_lossy().into_owned(),
            ))
            .map(|filter| MonochromeSettings { filter })
        })
        .transpose()?;
    let cancel = AtomicBool::new(false);
    let image = prepare_scene_linear(&input, &SceneLinearOptions::default(), &cancel, |_| {})?;
    let renderer = Renderer::new()?;
    eprintln!(
        "{}: {}x{}, {}, monochrome={monochrome:?}",
        input.display(),
        image.width,
        image.height,
        renderer.adapter_name
    );
    let image = PreparedImage::new(image, &cancel)?;
    println!("mode,edge,render_median_ms,png_median_ms,render_min_ms,png_bytes");
    for film in [false, true] {
        let mut recipe = EditRecipe {
            film: film.then(FilmSettings::default),
            monochrome,
            ..Default::default()
        };
        for edge in [512, 768, 1024, 2048] {
            let options = RenderOptions {
                max_dimension: Some(edge),
                ..Default::default()
            };
            let _ = renderer
                .render_prepared(&image, &recipe, options, &cancel)?
                .png()?;
            let (mut renders, mut encodes) = (Vec::new(), Vec::new());
            let mut bytes = 0;
            for i in 0..repeats {
                recipe.exposure = (i as f32 - repeats as f32 / 2.) * 0.1;
                let start = Instant::now();
                let result = renderer.render_prepared(&image, &recipe, options, &cancel)?;
                renders.push(start.elapsed().as_secs_f64() * 1000.);
                let start = Instant::now();
                bytes = result.png()?.len();
                encodes.push(start.elapsed().as_secs_f64() * 1000.);
            }
            let render = median(&mut renders);
            let png = median(&mut encodes);
            println!(
                "{},{edge},{render:.2},{png:.2},{:.2},{bytes}",
                if film { "film" } else { "digital" },
                renders[0]
            );
        }
    }
    Ok(())
}
