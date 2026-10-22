use image::ImageEncoder;
use std::path::Path;

/// Render an unrotated sRGB JPEG when the RAW has no embedded JPEG.
pub fn raw_preview(path: &Path) -> Result<Vec<u8>, String> {
    let mut reader = x3f_core::Reader::open(path).map_err(|e| e.to_string())?;
    reader.load_property_list().map_err(|e| e.to_string())?;
    reader.load_camf().map_err(|e| e.to_string())?;
    reader.load_raw().map_err(|e| e.to_string())?;
    let options = x3f_core::ProcessOptions {
        color_encoding: x3f_core::ColorEncoding::Srgb,
        denoise_intensity: 0,
        ..Default::default()
    };
    let image = reader.get_image(&options).map_err(|e| e.to_string())?;
    if image.channels != 3 {
        return Err("RAW preview must have three color channels".into());
    }
    let rgb: Vec<_> = image
        .data
        .chunks(image.row_stride as usize)
        .flat_map(|row| row[..image.columns as usize * 3].iter().copied())
        .collect();
    let rgb = image::ImageBuffer::<image::Rgb<u16>, _>::from_raw(image.columns, image.rows, rgb)
        .ok_or("Invalid RAW preview dimensions")?;
    let preview = image::DynamicImage::ImageRgb16(rgb)
        .thumbnail(1600, 1600)
        .into_rgb8();
    let mut bytes = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 85);
    encoder
        .set_icc_profile(x3f_core::srgb_icc_profile())
        .map_err(|e| e.to_string())?;
    encoder
        .encode(
            preview.as_raw(),
            preview.width(),
            preview.height(),
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|e| e.to_string())?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore = "needs X3FUSE_TEST_NO_JPEG"]
    fn raw_preview_is_a_bounded_decodable_jpeg() {
        let path = std::path::PathBuf::from(std::env::var("X3FUSE_TEST_NO_JPEG").unwrap());
        let jpeg = super::raw_preview(&path).unwrap();
        let image = image::load_from_memory(&jpeg).unwrap().into_rgb8();
        assert!(image.width() > 0 && image.width() <= 1600);
        assert!(image.height() > 0 && image.height() <= 1600);
        assert!(image.pixels().any(|pixel| pixel != image.get_pixel(0, 0)));
    }
}
