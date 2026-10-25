use crate::{cancelled, quantize16, ColorProfile, Pixels, RenderError, RenderedImage};
use image::{imageops::FilterType, GenericImageView, ImageBuffer, Rgb, Rgb32FImage};
use serde::{Deserialize, Serialize};
use std::sync::atomic::AtomicBool;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ResamplingMethod {
    Nearest,
    Bilinear,
    Area,
    Bicubic,
    Lanczos3,
}

/// Maximum dimensions of a developed export, after crop and rotation.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportResize {
    pub max_width: u32,
    pub max_height: u32,
    pub method: ResamplingMethod,
}

impl ExportResize {
    pub fn validate(self) -> Result<(), String> {
        if !(1..=65535).contains(&self.max_width) || !(1..=65535).contains(&self.max_height) {
            return Err("Export width and height must be whole pixels from 1 to 65535".into());
        }
        Ok(())
    }

    fn dimensions(self, width: u32, height: u32) -> Result<(u32, u32), RenderError> {
        self.validate().map_err(RenderError::Invalid)?;
        if width == 0 || height == 0 {
            return Err(RenderError::Invalid(
                "Invalid rendered image dimensions".into(),
            ));
        }
        if width <= self.max_width && height <= self.max_height {
            return Ok((width, height));
        }
        let (w, h) = (u64::from(width), u64::from(height));
        let (mw, mh) = (u64::from(self.max_width), u64::from(self.max_height));
        // Integer ratios keep the limiting edge exact; the other edge rounds to a pixel.
        Ok(if mw * h <= mh * w {
            (self.max_width, ((h * mw + w / 2) / w).max(1) as u32)
        } else {
            (((w * mh + h / 2) / h).max(1) as u32, self.max_height)
        })
    }
}

impl RenderedImage {
    /// Resize the finished 16-bit image without changing its native edited geometry.
    pub fn resize_for_export(
        mut self,
        resize: ExportResize,
        cancel: &AtomicBool,
    ) -> Result<Self, RenderError> {
        cancelled(cancel)?;
        let (width, height) = resize.dimensions(self.width, self.height)?;
        let Pixels::Rgb16(ref samples) = self.data else {
            return Err(RenderError::Invalid(
                "Export resize needs a 16-bit render".into(),
            ));
        };
        let input =
            ImageBuffer::<Rgb<u16>, _>::from_raw(self.width, self.height, samples.as_slice())
                .ok_or_else(|| RenderError::Invalid("Invalid rendered image".into()))?;
        if (width, height) == (self.width, self.height) {
            return Ok(self);
        }
        let data = if resize.method == ResamplingMethod::Nearest {
            image::imageops::resize(&input, width, height, FilterType::Nearest).into_raw()
        } else {
            // Filter light, not encoded values, so edges keep their brightness in each profile.
            let transfer: Vec<_> = (0..=65535)
                .map(|value| decode(value as f32 / 65535., self.color_profile))
                .collect();
            let linear = LinearPixels { input, transfer };
            let filtered = match resize.method {
                ResamplingMethod::Area => area(&linear, width, height, cancel)?,
                method => image::imageops::resize(
                    &linear,
                    width,
                    height,
                    match method {
                        ResamplingMethod::Bilinear => FilterType::Triangle,
                        ResamplingMethod::Bicubic => FilterType::CatmullRom,
                        ResamplingMethod::Lanczos3 => FilterType::Lanczos3,
                        _ => unreachable!(),
                    },
                ),
            };
            cancelled(cancel)?;
            filtered
                .into_raw()
                .into_iter()
                .map(|value| quantize16(encode(value, self.color_profile)))
                .collect()
        };
        cancelled(cancel)?;
        self.data = Pixels::Rgb16(data);
        self.width = width;
        self.height = height;
        Ok(self)
    }
}

struct LinearPixels<'a> {
    input: ImageBuffer<Rgb<u16>, &'a [u16]>,
    transfer: Vec<f32>,
}

impl GenericImageView for LinearPixels<'_> {
    type Pixel = Rgb<f32>;

    fn dimensions(&self) -> (u32, u32) {
        self.input.dimensions()
    }

    fn get_pixel(&self, x: u32, y: u32) -> Self::Pixel {
        Rgb(self
            .input
            .get_pixel(x, y)
            .0
            .map(|v| self.transfer[v as usize]))
    }
}

/// Weight partial source pixels too; integer block averages alias fractional reductions.
fn area(
    input: &LinearPixels<'_>,
    width: u32,
    height: u32,
    cancel: &AtomicBool,
) -> Result<Rgb32FImage, RenderError> {
    let mut output = Rgb32FImage::new(width, height);
    let sx = f64::from(input.width()) / f64::from(width);
    let sy = f64::from(input.height()) / f64::from(height);
    for y in 0..height {
        let (top, bottom) = (f64::from(y) * sy, f64::from(y + 1) * sy);
        for x in 0..width {
            let (left, right) = (f64::from(x) * sx, f64::from(x + 1) * sx);
            let mut sum = [0.; 3];
            for iy in top.floor() as u32..(bottom.ceil() as u32).min(input.height()) {
                cancelled(cancel)?;
                let wy = bottom.min(f64::from(iy + 1)) - top.max(f64::from(iy));
                for ix in left.floor() as u32..(right.ceil() as u32).min(input.width()) {
                    let wx = right.min(f64::from(ix + 1)) - left.max(f64::from(ix));
                    for (sum, value) in sum.iter_mut().zip(input.get_pixel(ix, iy).0) {
                        *sum += f64::from(value) * wx * wy;
                    }
                }
            }
            output.put_pixel(x, y, Rgb(sum.map(|value| (value / (sx * sy)) as f32)));
        }
    }
    Ok(output)
}

// These transfer functions match the output encoding in render.wgsl.
fn decode(value: f32, profile: ColorProfile) -> f32 {
    match profile {
        ColorProfile::Srgb if value <= 0.04045 => value / 12.92,
        ColorProfile::Srgb => ((value + 0.055) / 1.055).powf(2.4),
        ColorProfile::AdobeRgb => value.powf(563. / 256.),
        ColorProfile::ProPhotoRgb if value < 1. / 32. => value / 16.,
        ColorProfile::ProPhotoRgb => value.powf(1.8),
    }
}

fn encode(value: f32, profile: ColorProfile) -> f32 {
    let value = value.clamp(0., 1.);
    match profile {
        ColorProfile::Srgb if value <= 0.0031308 => value * 12.92,
        ColorProfile::Srgb => 1.055 * value.powf(1. / 2.4) - 0.055,
        ColorProfile::AdobeRgb => value.powf(256. / 563.),
        ColorProfile::ProPhotoRgb if value < 1. / 512. => value * 16.,
        ColorProfile::ProPhotoRgb => value.powf(1. / 1.8),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const METHODS: [ResamplingMethod; 5] = [
        ResamplingMethod::Nearest,
        ResamplingMethod::Bilinear,
        ResamplingMethod::Area,
        ResamplingMethod::Bicubic,
        ResamplingMethod::Lanczos3,
    ];

    fn limits(width: u32, height: u32, method: ResamplingMethod) -> ExportResize {
        ExportResize {
            max_width: width,
            max_height: height,
            method,
        }
    }

    fn image(
        width: u32,
        height: u32,
        data: Vec<u16>,
        color_profile: ColorProfile,
    ) -> RenderedImage {
        RenderedImage {
            width,
            height,
            full_width: width,
            full_height: height,
            data: Pixels::Rgb16(data),
            color_profile,
            region: None,
        }
    }

    #[test]
    fn dimensions_fit_both_bounds_without_enlargement() {
        let bounds = limits(1600, 1200, ResamplingMethod::Lanczos3);
        for (input, expected) in [
            ((6000, 4000), (1600, 1067)),
            ((4000, 6000), (800, 1200)),
            ((4000, 4000), (1200, 1200)),
            ((1600, 1200), (1600, 1200)),
            ((600, 400), (600, 400)),
            ((u32::MAX, 1), (1600, 1)),
            ((1, u32::MAX), (1, 1200)),
        ] {
            assert_eq!(bounds.dimensions(input.0, input.1).unwrap(), expected);
        }
        assert!(bounds.dimensions(0, 20).is_err());
        assert!(limits(0, 1200, ResamplingMethod::Area).validate().is_err());
        assert!(limits(100, 65536, ResamplingMethod::Area)
            .validate()
            .is_err());
    }

    #[test]
    fn unchanged_dimensions_keep_the_exact_pixels() {
        let original = vec![1, 32767, 65534, 1234, 5678, 23456];
        for method in METHODS {
            let result = image(2, 1, original.clone(), ColorProfile::ProPhotoRgb)
                .resize_for_export(limits(100, 100, method), &AtomicBool::new(false))
                .unwrap();
            assert_eq!(result.rgb16().unwrap(), original);
            assert_eq!((result.width, result.height), (2, 1));
        }
    }

    #[test]
    fn fractional_area_preserves_light_in_each_output_profile() {
        for profile in [
            ColorProfile::Srgb,
            ColorProfile::AdobeRgb,
            ColorProfile::ProPhotoRgb,
        ] {
            // Each 1.5-pixel footprint contains half of the white pixel.
            let result = image(3, 1, vec![0, 0, 0, 65535, 65535, 65535, 0, 0, 0], profile)
                .resize_for_export(
                    limits(2, 1, ResamplingMethod::Area),
                    &AtomicBool::new(false),
                )
                .unwrap();
            for &sample in result.rgb16().unwrap() {
                assert!((decode(sample as f32 / 65535., profile) - 1. / 3.).abs() < 0.00003);
            }
            assert_eq!(result.color_profile, profile);
            assert_eq!((result.full_width, result.full_height), (3, 1));
        }
        let mut data = vec![0; 27];
        data[12..15].fill(65535);
        let result = image(3, 3, data, ColorProfile::Srgb)
            .resize_for_export(
                limits(2, 2, ResamplingMethod::Area),
                &AtomicBool::new(false),
            )
            .unwrap();
        for &sample in result.rgb16().unwrap() {
            assert!((decode(sample as f32 / 65535., ColorProfile::Srgb) - 1. / 9.).abs() < 0.00003);
        }
    }

    #[test]
    fn all_filters_keep_constant_color_and_16_bit_precision() {
        for method in METHODS {
            for profile in [
                ColorProfile::Srgb,
                ColorProfile::AdobeRgb,
                ColorProfile::ProPhotoRgb,
            ] {
                let result = image(7, 5, [1234, 23456, 45678].repeat(35), profile)
                    .resize_for_export(limits(4, 4, method), &AtomicBool::new(false))
                    .unwrap();
                assert_eq!((result.width, result.height), (4, 3));
                for pixel in result.rgb16().unwrap().as_chunks::<3>().0.iter() {
                    for (&actual, expected) in pixel.iter().zip([1234, 23456, 45678]) {
                        assert!(
                            actual.abs_diff(expected) <= 1,
                            "{method:?}: {actual} != {expected}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn selected_filters_produce_distinct_pixels_and_jpeg_dimensions() {
        let data: Vec<u16> = (0..11 * 7 * 3)
            .map(|i| ((i * i * 7919) % 65536) as u16)
            .collect();
        let mut outputs = std::collections::HashSet::new();
        for method in METHODS {
            let result = image(11, 7, data.clone(), ColorProfile::Srgb)
                .resize_for_export(limits(7, 5, method), &AtomicBool::new(false))
                .unwrap();
            assert_eq!((result.width, result.height), (7, 4));
            let jpeg = image::load_from_memory(&result.jpeg(95).unwrap()).unwrap();
            assert_eq!(jpeg.dimensions(), (7, 4));
            if method == ResamplingMethod::Nearest {
                assert!(result
                    .rgb16()
                    .unwrap()
                    .as_chunks::<3>()
                    .0
                    .iter()
                    .all(|pixel| { data.as_chunks::<3>().0.iter().any(|source| pixel == source) }));
            }
            outputs.insert(result.rgb16().unwrap().to_vec());
        }
        assert_eq!(outputs.len(), METHODS.len());
    }

    #[test]
    fn resize_rejects_cancelled_or_invalid_buffers() {
        let settings = limits(1, 1, ResamplingMethod::Area);
        assert!(matches!(
            image(2, 2, vec![0; 12], ColorProfile::Srgb)
                .resize_for_export(settings, &AtomicBool::new(true)),
            Err(RenderError::Cancelled)
        ));
        assert!(image(2, 2, vec![0; 3], ColorProfile::Srgb)
            .resize_for_export(settings, &AtomicBool::new(false))
            .is_err());
    }
}
