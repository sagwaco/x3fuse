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
    /// Corrected image to oriented source, in oriented pixels. None is the identity.
    homography: Option<Mat3>,
}
type Mat3 = [[f64; 3]; 3];

fn multiply(a: &Mat3, b: &Mat3) -> Mat3 {
    std::array::from_fn(|i| std::array::from_fn(|j| (0..3).map(|k| a[i][k] * b[k][j]).sum()))
}
/// Matrix of an affine map, found from its values at (0,0), (1,0) and (0,1).
fn affine(f: impl Fn(f32, f32) -> (f32, f32)) -> Mat3 {
    let (x, y) = f(0., 0.);
    let (xx, xy) = f(1., 0.);
    let (yx, yy) = f(0., 1.);
    let [x, y, xx, xy, yx, yy] = [x, y, xx, xy, yx, yy].map(f64::from);
    [[xx - x, yx - x, x], [xy - y, yy - y, y], [0., 0., 1.]]
}
/// The inverse of the perspective turn in `perspective.ts`: corrected pixel to source pixel.
fn perspective(pitch: f32, yaw: f32, w: f64, h: f64) -> Option<Mat3> {
    if pitch == 0. && yaw == 0. {
        return None;
    }
    let (sp, cp) = f64::from(pitch).to_radians().sin_cos();
    let (sy, cy) = f64::from(yaw).to_radians().sin_cos();
    let rx = [[1., 0., 0.], [0., cp, -sp], [0., sp, cp]];
    let ry = [[cy, 0., sy], [0., 1., 0.], [-sy, 0., cy]];
    let r = multiply(&rx, &ry);
    let l = w.max(h);
    // The turned optical axis (0, 0, 1) lands here; it stays at the image center.
    let (cx, cy) = (r[0][2] / r[2][2], r[1][2] / r[2][2]);
    let transpose: Mat3 = std::array::from_fn(|i| std::array::from_fn(|j| r[j][i]));
    let to_ray = [
        [1. / l, 0., cx - w / (2. * l)],
        [0., 1. / l, cy - h / (2. * l)],
        [0., 0., 1.],
    ];
    let to_pixel = [[l, 0., w / 2.], [0., l, h / 2.], [0., 0., 1.]];
    Some(multiply(&to_pixel, &multiply(&transpose, &to_ray)))
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
            homography: perspective(r.pitch, r.yaw, w as f64, h as f64),
        })
    }
    /// Long edge of the whole sensor frame at this render's scale. Physical
    /// film parameters key off this, so cropping or requesting a region never
    /// changes the size of a diffusion or a grain particle.
    pub fn long_edge(&self) -> f32 {
        self.native_width.max(self.native_height) as f32 / self.scale
    }
    /// Output position to the corrected image (after crop, rotation and straighten), all affine.
    fn corrected_position(&self, u: f32, v: f32) -> (f32, f32) {
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
    /// Output position to the EXIF-oriented source, through the perspective turn.
    pub fn oriented_position(&self, u: f32, v: f32) -> (f32, f32) {
        let (u, v) = self.corrected_position(u, v);
        let Some(m) = &self.homography else {
            return (u, v);
        };
        let (w, h) = (f64::from(self.native_width), f64::from(self.native_height));
        let (x, y) = (f64::from(u) * w, f64::from(v) * h);
        let z = m[2][0] * x + m[2][1] * y + m[2][2];
        (
            ((m[0][0] * x + m[0][1] * y + m[0][2]) / z / w) as f32,
            ((m[1][0] * x + m[1][1] * y + m[1][2]) / z / h) as f32,
        )
    }
    /// Grain stays affine and ignores the perspective turn: the grain pattern is
    /// anchored to the corrected image, and a projective map would change it
    /// between tiles of one render.
    pub fn grain_transform(&self) -> [[f32; 4]; 2] {
        let (x, y) = self.corrected_position(0., 0.);
        let (xx, xy) = self.corrected_position(1., 0.);
        let (yx, yy) = self.corrected_position(0., 1.);
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
        let (u, v) = orient(image.orientation, u, v);
        (u * image.width as f32 - 0.5, v * image.height as f32 - 0.5)
    }
    /// Map global output pixel centers to raw source coordinates on the GPU as
    /// a projective matrix, composed exactly from the steps of `source_position`.
    pub fn source_transform(&self, image: &SceneLinearImage) -> [[f32; 4]; 3] {
        let scale = |x: f64, y: f64| [[x, 0., 0.], [0., y, 0.], [0., 0., 1.]];
        let (w, h) = (f64::from(self.native_width), f64::from(self.native_height));
        let mut m = multiply(
            &affine(|u, v| self.corrected_position(u, v)),
            &scale(
                1. / f64::from(self.full_width),
                1. / f64::from(self.full_height),
            ),
        );
        m = multiply(&scale(w, h), &m);
        m = multiply(&self.homography.unwrap_or(scale(1., 1.)), &m);
        m = multiply(&scale(1. / w, 1. / h), &m);
        m = multiply(&affine(|u, v| orient(image.orientation, u, v)), &m);
        let to_pixel = [
            [f64::from(image.width), 0., -0.5],
            [0., f64::from(image.height), -0.5],
            [0., 0., 1.],
        ];
        m = multiply(&to_pixel, &m);
        m.map(|row| [row[0] as f32, row[1] as f32, row[2] as f32, 0.])
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
/// Oriented image position to raw sensor position, both normalized.
fn orient(orientation: u16, u: f32, v: f32) -> (f32, f32) {
    match orientation {
        2 => (1. - u, v),
        3 => (1. - u, 1. - v),
        4 => (u, 1. - v),
        5 => (v, u),
        6 => (v, 1. - u),
        7 => (1. - v, 1. - u),
        8 => (1. - v, u),
        _ => (u, v),
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

    /// Pitch, yaw, size, picture quad, forward of (1234, 2345), inverse of (1000, 500).
    type Reference = (f32, f32, u32, u32, [[f64; 2]; 4], [f64; 2], [f64; 2]);

    #[test]
    fn source_projective_matches_geometry_for_orientations_crops_and_regions() {
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
            color_mode_calibration: None,
        };
        for orientation in 1..=8 {
            image.orientation = orientation;
            for rotation in 0..4 {
                for (straighten, pitch, yaw) in [
                    (-31., 0., 0.),
                    (0., 0., 0.),
                    (23., 0., 0.),
                    (-11., 14., -9.),
                    (0., -25., 31.),
                ] {
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
                            pitch,
                            yaw,
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
                        let matrix = geometry.source_transform(&image);
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
                            let [a, b, c] = matrix.map(|row| row[0] * x + row[1] * y + row[2]);
                            let actual = [a / c, b / c];
                            assert!(
                                (actual[0] - expected.0).abs() < 0.003
                                    && (actual[1] - expected.1).abs() < 0.003,
                                "orientation {orientation}, rotation {rotation}, straighten {straighten}, pitch {pitch}, yaw {yaw}: {actual:?} != {expected:?}"
                            );
                        }
                    }
                }
            }
        }
    }

    /// Reference numbers shared with tests/perspective.test.ts.
    #[test]
    fn homography_matches_the_typescript_reference() {
        let cases: [Reference; 3] = [
            (
                12.,
                0.,
                6000,
                4000,
                [
                    [-300.8976, -249.7611],
                    [6300.8976, -249.7611],
                    [5864.0944, 3952.0533],
                    [135.9056, 3952.0533],
                ],
                [1216.3463, 2356.2333],
                [1138.3547, 634.2771],
            ),
            (
                0.,
                -9.,
                4000,
                6000,
                [
                    [-164.4426, -206.6921],
                    [3947.3607, 114.9218],
                    [3947.3607, 5885.0782],
                    [-164.4426, 6206.6921],
                ],
                [1198.5793, 2323.1491],
                [1048.9623, 592.7688],
            ),
            (
                -15.,
                7.,
                6000,
                4000,
                [
                    [202.2386, 124.2573],
                    [5998.2838, -99.6523],
                    [6795.9072, 4544.9437],
                    [-174.8024, 4223.2655],
                ],
                [1193.2278, 2365.0212],
                [934.5895, 455.6806],
            ),
        ];
        for (pitch, yaw, w, h, quad, forward, inverse) in cases {
            let image = SceneLinearImage {
                width: w,
                height: h,
                orientation: 1,
                data: Vec::new(),
                white_balance: x3f_core::WhiteBalanceCalibration {
                    camera_to_rgb: [1., 0., 0., 0., 1., 0., 0., 0., 1.],
                    xyz_to_camera: [1., 0., 0., 0., 1., 0., 0., 0., 1.],
                    as_shot_neutral: [1.; 3],
                },
                color_mode_calibration: None,
            };
            let recipe = EditRecipe {
                pitch,
                yaw,
                ..Default::default()
            };
            let geometry = Geometry::new(&image, &recipe, RenderOptions::default()).unwrap();
            // Source pixel centers are offset by half a pixel in `source_position`.
            let at = |x: f64, y: f64| {
                let (sx, sy) =
                    geometry.source_position(&image, (x / w as f64) as f32, (y / h as f64) as f32);
                (sx as f64 + 0.5, sy as f64 + 0.5)
            };
            let close = |a: (f64, f64), b: [f64; 2]| {
                assert!(
                    (a.0 - b[0]).abs() < 1e-3 && (a.1 - b[1]).abs() < 1e-3,
                    "{pitch} {yaw}: {a:?} != {b:?}"
                );
            };
            close(at(1000., 500.), inverse);
            // Forward of (1234, 2345) maps back to it; the quad corners map back to the corners.
            close(at(forward[0], forward[1]), [1234., 2345.]);
            for (corner, p) in [
                [0., 0.],
                [w as f64, 0.],
                [w as f64, h as f64],
                [0., h as f64],
            ]
            .iter()
            .zip(quad)
            {
                close(at(p[0], p[1]), *corner);
            }
        }
    }
}
