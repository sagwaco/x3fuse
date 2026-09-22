#[cfg(test)]
use crate::cancelled;
use crate::{Crop, EditRecipe, RenderError, RenderOptions};
#[cfg(test)]
use std::sync::atomic::AtomicBool;
use x3f_core::SceneLinearImage;

/// One mapping shared by preview, native regions, export and the WB eyedropper.
pub(crate) struct Geometry {
    pub width: u32,
    pub height: u32,
    pub full_width: u32,
    pub full_height: u32,
    pub region_x: u32,
    pub region_y: u32,
    pub scale: f32,
    pub native_width: u32,
    pub native_height: u32,
    crop: Crop,
    rotation: u32,
    cosine: f32,
    sine: f32,
    zoom: f32,
    crop_width: f32,
    crop_height: f32,
}
impl Geometry {
    pub fn new(
        image: &SceneLinearImage,
        r: &EditRecipe,
        options: RenderOptions,
    ) -> Result<Self, RenderError> {
        if let Some(region) = options.region {
            region.validate().map_err(RenderError::Invalid)?;
        }
        if options.max_dimension == Some(0) {
            return Err(RenderError::Invalid(
                "Preview dimensions must be positive".into(),
            ));
        }
        let (w, h) = if (5..=8).contains(&image.orientation) {
            (image.height, image.width)
        } else {
            (image.width, image.height)
        };
        let crop = r.crop.unwrap_or_default();
        let cw = (w as f32 * crop.width).round().max(1.);
        let ch = (h as f32 * crop.height).round().max(1.);
        let (nw, nh) = if r.rotation % 2 == 1 {
            (ch, cw)
        } else {
            (cw, ch)
        };
        let region = options.region.unwrap_or_default();
        let region_long = (nw * region.width).max(nh * region.height);
        let factor = options
            .max_dimension
            .map_or(1., |m| (m as f32 / region_long).min(1.));
        let fw = (nw * factor).round().max(1.) as u32;
        let fh = (nh * factor).round().max(1.) as u32;
        let x = (region.x * fw as f32).floor() as u32;
        let y = (region.y * fh as f32).floor() as u32;
        let width = (((region.x + region.width) * fw as f32).ceil() as u32).min(fw) - x;
        let height = (((region.y + region.height) * fh as f32).ceil() as u32).min(fh) - y;
        let angle = r.straighten.to_radians();
        let c = angle.cos().abs();
        let s = angle.sin().abs();
        let zoom = ((cw * c + ch * s) / cw).max((cw * s + ch * c) / ch);
        Ok(Self {
            width,
            height,
            full_width: fw,
            full_height: fh,
            region_x: x,
            region_y: y,
            scale: 1. / (factor * zoom),
            native_width: w,
            native_height: h,
            crop,
            rotation: r.rotation,
            cosine: angle.cos(),
            sine: angle.sin(),
            zoom,
            crop_width: cw,
            crop_height: ch,
        })
    }
    /// Long edge of the whole sensor frame at this render's scale. Physical
    /// film parameters key off this, so cropping or requesting a region never
    /// changes the size of a diffusion or a grain particle.
    pub fn long_edge(&self) -> f32 {
        self.native_width.max(self.native_height) as f32 / self.scale
    }
    pub fn oriented_position(&self, u: f32, v: f32) -> (f32, f32) {
        let (u, v) = match self.rotation {
            1 => (v, 1. - u),
            2 => (1. - u, 1. - v),
            3 => (1. - v, u),
            _ => (u, v),
        };
        let x = (u - 0.5) * self.crop_width / self.zoom;
        let y = (v - 0.5) * self.crop_height / self.zoom;
        let c = self.cosine;
        let s = self.sine;
        let u = self.crop.x + ((c * x + s * y) / self.crop_width + 0.5) * self.crop.width;
        let v = self.crop.y + ((-s * x + c * y) / self.crop_height + 0.5) * self.crop.height;
        (u, v)
    }
    pub fn grain_transform(&self) -> [[f32; 4]; 2] {
        let (x, y) = self.oriented_position(0., 0.);
        let (xx, xy) = self.oriented_position(1., 0.);
        let (yx, yy) = self.oriented_position(0., 1.);
        let w = self.native_width as f32;
        let h = self.native_height as f32;
        [
            [
                (xx - x) * w / self.full_width as f32,
                (yx - x) * w / self.full_height as f32,
                x * w,
                w,
            ],
            [
                (xy - y) * h / self.full_width as f32,
                (yy - y) * h / self.full_height as f32,
                y * h,
                h,
            ],
        ]
    }
    pub fn source_position(&self, image: &SceneLinearImage, u: f32, v: f32) -> (f32, f32) {
        let (u, v) = self.oriented_position(u, v);
        let (u, v) = match image.orientation {
            2 => (1. - u, v),
            3 => (1. - u, 1. - v),
            4 => (u, 1. - v),
            5 => (v, u),
            6 => (v, 1. - u),
            7 => (1. - v, 1. - u),
            8 => (1. - v, u),
            _ => (u, v),
        };
        (u * image.width as f32 - 0.5, v * image.height as f32 - 0.5)
    }
    /// Map global output pixel centers to raw source coordinates on the GPU.
    pub fn source_transform(&self, image: &SceneLinearImage) -> [[f32; 4]; 2] {
        let (x, y) = self.source_position(image, 0., 0.);
        let (xx, xy) = self.source_position(image, 1., 0.);
        let (yx, yy) = self.source_position(image, 0., 1.);
        [
            [
                (xx - x) / self.full_width as f32,
                (yx - x) / self.full_height as f32,
                x,
                0.,
            ],
            [
                (xy - y) / self.full_width as f32,
                (yy - y) / self.full_height as f32,
                y,
                0.,
            ],
        ]
    }
    #[cfg(test)]
    pub fn sample(
        &self,
        image: &SceneLinearImage,
        x: i32,
        y: i32,
        w: u32,
        h: u32,
        cancel: &AtomicBool,
    ) -> Result<Vec<[f32; 4]>, RenderError> {
        let mut pixels = Vec::with_capacity(w as usize * h as usize);
        for row in y..y + h as i32 {
            if row % 32 == 0 {
                cancelled(cancel)?;
            }
            for col in x..x + w as i32 {
                let (sx, sy) = self.source_position(
                    image,
                    (col as f32 + 0.5) / self.full_width as f32,
                    (row as f32 + 0.5) / self.full_height as f32,
                );
                let rgb = sample(image, sx, sy);
                pixels.push([rgb[0], rgb[1], rgb[2], 1.]);
            }
        }
        Ok(pixels)
    }
}
pub(crate) fn sample(image: &SceneLinearImage, x: f32, y: f32) -> [f32; 3] {
    let x = x.clamp(0., (image.width - 1) as f32);
    let y = y.clamp(0., (image.height - 1) as f32);
    let x0 = x.floor() as u32;
    let y0 = y.floor() as u32;
    let x1 = (x0 + 1).min(image.width - 1);
    let y1 = (y0 + 1).min(image.height - 1);
    let a = x - x0 as f32;
    let b = y - y0 as f32;
    std::array::from_fn(|c| {
        let at = |x: u32, y: u32| image.data[(y * image.width + x) as usize * 3 + c];
        (at(x0, y0) * (1. - a) + at(x1, y0) * a) * (1. - b)
            + (at(x0, y1) * (1. - a) + at(x1, y1) * a) * b
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_affine_matches_geometry_for_orientations_crops_and_regions() {
        let mut image = SceneLinearImage {
            width: 5424,
            height: 3616,
            orientation: 1,
            data: Vec::new(),
            white_balance: x3f_core::WhiteBalanceCalibration {
                camera_to_rgb: [1., 0., 0., 0., 1., 0., 0., 0., 1.],
                xyz_to_camera: [1., 0., 0., 0., 1., 0., 0., 0., 1.],
                as_shot_neutral: [1.; 3],
            },
        };
        for orientation in 1..=8 {
            image.orientation = orientation;
            for rotation in 0..4 {
                for straighten in [-31., 0., 23.] {
                    for crop in [
                        None,
                        Some(Crop {
                            x: 0.13,
                            y: 0.21,
                            width: 0.67,
                            height: 0.53,
                        }),
                    ] {
                        let recipe = EditRecipe {
                            rotation,
                            straighten,
                            crop,
                            ..Default::default()
                        };
                        let geometry = Geometry::new(
                            &image,
                            &recipe,
                            RenderOptions {
                                max_dimension: Some(1024),
                                region: Some(Crop {
                                    x: 0.17,
                                    y: 0.23,
                                    width: 0.61,
                                    height: 0.49,
                                }),
                                ..Default::default()
                            },
                        )
                        .unwrap();
                        let affine = geometry.source_transform(&image);
                        let fw = geometry.full_width as f32;
                        let fh = geometry.full_height as f32;
                        for (x, y) in [
                            (0.5, 0.5),
                            (fw - 0.5, fh - 0.5),
                            (fw * 0.37, fh * 0.63),
                            (-64.5, fh + 64.5),
                            (fw + 64.5, -64.5),
                            (
                                geometry.region_x as f32 + 0.5,
                                geometry.region_y as f32 + 0.5,
                            ),
                        ] {
                            let expected = geometry.source_position(&image, x / fw, y / fh);
                            let actual = affine.map(|row| row[0] * x + row[1] * y + row[2]);
                            assert!(
                                (actual[0] - expected.0).abs() < 0.003
                                    && (actual[1] - expected.1).abs() < 0.003,
                                "orientation {orientation}, rotation {rotation}, straighten {straighten}: {actual:?} != {expected:?}"
                            );
                        }
                    }
                }
            }
        }
    }
}
