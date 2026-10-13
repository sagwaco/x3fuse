//! Repeatable warm adjustment latency of editor previews, with separate PNG encoding.
//! cargo run --release -p x3f-render --example benchmark -- photo.X3F [repeats] [monochrome-filter]
//!
//! Cases: a 2048 px preview, and native-resolution regions of 1024 and
//! 2600x1700 px at the frame center (fractions, as the editor requests them).
//! Columns: `render` is the GPU render with readback of packed RGBA8 (the
//! preview path, which also writes the frame header); `rgb16` is the same
//! render on the 16-bit export path; `png` is the encode that previews now
//! run only on demand.
use std::{path::PathBuf, sync::atomic::AtomicBool, time::Instant};
use x3f_core::{prepare_scene_linear, SceneLinearOptions};
use x3f_render::{
    output_dimensions, Crop, EditRecipe, FilmSettings, MonochromeSettings, PreparedImage,
    RenderOptions, Renderer,
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
    let options = SceneLinearOptions {
        highlight_recovery: true,
        ..Default::default()
    };
    let image = prepare_scene_linear(&input, &options, &cancel, |_| {})?;
    let renderer = Renderer::new()?;
    eprintln!(
        "{}: {}x{}, {}, monochrome={monochrome:?}",
        input.display(),
        image.width,
        image.height,
        renderer.adapter_name
    );
    let image = PreparedImage::new(image, &cancel)?;
    println!("mode,case,size,render_ms,rgb16_ms,png_ms,png_bytes");
    for film in [false, true] {
        let mut recipe = EditRecipe {
            film: film.then(FilmSettings::default),
            monochrome,
            ..Default::default()
        };
        let (width, height) = output_dimensions(image.image(), &recipe)?;
        let region = |w: u32, h: u32| {
            let (w, h) = (w.min(width), h.min(height));
            Crop {
                x: ((width - w) / 2) as f32 / width as f32,
                y: ((height - h) / 2) as f32 / height as f32,
                width: w as f32 / width as f32,
                height: h as f32 / height as f32,
            }
        };
        for (case, edge, region) in [
            ("full2048", 2048, None),
            ("native1024", 4096, Some(region(1024, 1024))),
            ("native2600x1700", 4096, Some(region(2600, 1700))),
        ] {
            let options = RenderOptions {
                max_dimension: Some(edge),
                region,
                rgba8: true,
                ..Default::default()
            };
            let export = RenderOptions {
                rgba8: false,
                ..options
            };
            // Warm up: source upload, film LUT and workspace.
            renderer.render_prepared(&image, &recipe, options, &cancel)?;
            renderer.render_prepared(&image, &recipe, export, &cancel)?;
            let mut times = [(); 3].map(|_| Vec::new());
            let (mut bytes, mut size) = (0, (0, 0));
            for i in 0..repeats {
                recipe.exposure = (i as f32 - repeats as f32 / 2.) * 0.1;
                let start = Instant::now();
                let result = renderer.render_prepared(&image, &recipe, options, &cancel)?;
                times[0].push(start.elapsed().as_secs_f64() * 1000.);
                let start = Instant::now();
                renderer.render_prepared(&image, &recipe, export, &cancel)?;
                times[1].push(start.elapsed().as_secs_f64() * 1000.);
                let start = Instant::now();
                bytes = result.png()?.len();
                times[2].push(start.elapsed().as_secs_f64() * 1000.);
                size = (result.width, result.height);
            }
            let [render, rgb16, png] = times.map(|mut t| median(&mut t));
            println!(
                "{},{case},{}x{},{render:.1},{rgb16:.1},{png:.1},{bytes}",
                if film { "film" } else { "digital" },
                size.0,
                size.1,
            );
        }
    }
    Ok(())
}
