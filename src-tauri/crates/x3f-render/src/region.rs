use crate::RenderError;
use image::{ImageDecoder, ImageEncoder};
use std::io::Cursor;

/// Crops a normalized rectangle after EXIF orientation and limits output to 4096 pixels per side.
pub fn jpeg_region(bytes: &[u8], region: [f64; 4]) -> Result<Vec<u8>, RenderError> {
    let [x, y, width, height] = region;
    if !region.iter().all(|v| v.is_finite())
        || x < 0.0
        || y < 0.0
        || x >= 1.0
        || y >= 1.0
        || width <= 0.0
        || height <= 0.0
        || x + width > 1.0
        || y + height > 1.0
    {
        return Err(RenderError::Invalid("Invalid preview region".into()));
    }
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), image::ImageFormat::Jpeg);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(32768);
    limits.max_image_height = Some(32768);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader.into_decoder()?;
    let (w, h) = decoder.dimensions();
    if u64::from(w) * u64::from(h) > 64 * 1024 * 1024 {
        return Err(RenderError::Invalid(
            "Preview exceeds region decode limit".into(),
        ));
    }
    let orientation = decoder.orientation()?;
    let profile = decoder.icc_profile()?;
    let mut image = image::DynamicImage::from_decoder(decoder)?;
    image.apply_orientation(orientation);
    let (w, h) = (image.width(), image.height());
    let source = image.into_rgb8();
    let crop_width = width * f64::from(w);
    let crop_height = height * f64::from(h);
    let scale = (4096.0 / crop_width.max(crop_height)).min(1.0);
    let output_width = (crop_width * scale).ceil().clamp(1.0, 4096.0) as u32;
    let output_height = (crop_height * scale).ceil().clamp(1.0, 4096.0) as u32;
    let rgb = image::RgbImage::from_fn(output_width, output_height, |column, row| {
        // Image edges use integer coordinates; the sampler uses pixel centers.
        let sample_x = (x * f64::from(w)
            + (f64::from(column) + 0.5) * crop_width / f64::from(output_width)
            - 0.5)
            .clamp(0.0, f64::from(w - 1)) as f32;
        let sample_y = (y * f64::from(h)
            + (f64::from(row) + 0.5) * crop_height / f64::from(output_height)
            - 0.5)
            .clamp(0.0, f64::from(h - 1)) as f32;
        image::imageops::interpolate_bilinear(&source, sample_x, sample_y)
            .expect("Clamped coordinates are inside the decoded image")
    });
    drop(source);
    let mut output = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, 90);
    // Pixels are upright. Do not copy the source orientation.
    encoder
        .set_exif_metadata(
            b"II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0\x01\0\0\0\0\0\0\0".to_vec(),
        )
        .map_err(image::ImageError::Unsupported)?;
    if let Some(profile) = profile {
        encoder
            .set_icc_profile(profile)
            .map_err(image::ImageError::Unsupported)?;
    }
    encoder.encode(
        &rgb,
        rgb.width(),
        rgb.height(),
        image::ExtendedColorType::Rgb8,
    )?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jpeg(width: u32, height: u32) -> Vec<u8> {
        let rgb = image::RgbImage::from_fn(width, height, |x, _| {
            if x < width / 2 {
                image::Rgb([240, 0, 0])
            } else {
                image::Rgb([0, 0, 240])
            }
        });
        let mut bytes = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 95)
            .encode(&rgb, width, height, image::ExtendedColorType::Rgb8)
            .unwrap();
        bytes
    }

    #[test]
    fn crops_upright_coordinates_and_removes_orientation() {
        let bytes = jpeg(80, 40);
        // EXIF orientation 6 rotates the red left half to the top.
        let mut tagged = bytes[..2].to_vec();
        tagged.extend_from_slice(b"\xff\xe1\x00\x22Exif\0\0II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0\x06\0\0\0\0\0\0\0");
        tagged.extend_from_slice(&bytes[2..]);
        let result = jpeg_region(&tagged, [0.0, 0.0, 1.0, 0.5]).unwrap();
        let decoded = image::load_from_memory(&result).unwrap().into_rgb8();
        assert_eq!(decoded.dimensions(), (40, 40));
        let center = decoded.get_pixel(20, 20);
        assert!(center[0] > 220 && center[2] < 20);
        let mut decoder = image::codecs::jpeg::JpegDecoder::new(Cursor::new(result)).unwrap();
        assert_eq!(
            decoder.orientation().unwrap(),
            image::metadata::Orientation::NoTransforms
        );
        assert!(decoder.exif_metadata().unwrap().is_some());
    }

    #[test]
    fn fractional_edges_sample_the_requested_rectangle_without_expansion() {
        let ramp = image::RgbImage::from_fn(8, 4, |x, _| image::Rgb([x as u8 * 32; 3]));
        let profile = b"region test ICC profile";
        let mut bytes = Vec::new();
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 100);
        encoder.set_icc_profile(profile.to_vec()).unwrap();
        encoder
            .encode(&ramp, 8, 4, image::ExtendedColorType::Rgb8)
            .unwrap();
        // The fractional span [1.25, 4.75] maps four centers to 1.1875 ... 3.8125.
        let output = jpeg_region(&bytes, [1.25 / 8.0, 0.0, 3.5 / 8.0, 1.0]).unwrap();
        let image = image::load_from_memory(&output).unwrap().into_rgb8();
        assert_eq!(image.dimensions(), (4, 4));
        for (column, expected) in [38i16, 66, 94, 122].into_iter().enumerate() {
            let actual = i16::from(image.get_pixel(column as u32, 2)[0]);
            assert!(
                (actual - expected).abs() <= 3,
                "column {column}: {actual} != {expected}"
            );
        }
        let mut decoder = image::codecs::jpeg::JpegDecoder::new(Cursor::new(output)).unwrap();
        assert_eq!(
            decoder.icc_profile().unwrap().as_deref(),
            Some(profile.as_slice())
        );
    }

    #[test]
    fn output_bounds_and_tiny_regions() {
        let bytes = jpeg(4100, 4);
        let result = jpeg_region(&bytes, [0.0, 0.0, 1.0, 1.0]).unwrap();
        let image = image::load_from_memory(&result).unwrap();
        assert_eq!(image.width(), 4096);
        assert!(image.height() <= 4096);
        let tiny = jpeg_region(&bytes, [0.5, 0.5, f64::EPSILON, f64::EPSILON]).unwrap();
        let image = image::load_from_memory(&tiny).unwrap();
        assert!(image.width() >= 1 && image.height() >= 1);
        assert!(jpeg_region(&bytes, [0.0, 0.0, f64::NAN, 1.0]).is_err());
    }
}
