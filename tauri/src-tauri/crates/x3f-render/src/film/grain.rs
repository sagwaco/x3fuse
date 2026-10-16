//! Stock RMS calibration and sublayer grain from spektrafilm experimental 28bf883.
use super::profile::Profile;
use crate::{FilmSettings, GrainParams, RenderError};

const APERTURE_AREA: f64 = std::f64::consts::PI * 24. * 24.;
pub const MAX_TABLE_FLOATS: usize = 3 * 9 + super::CURVE_SAMPLES * (3 + 3 * 3);

#[derive(Clone, Debug)]
pub struct Preset {
    pub rms: [f64; 3],
    pub uniformity: [f64; 3],
    pub floor: [f64; 3],
    pub scales: [f64; 3],
}

impl Preset {
    /// Values from assets/presets/grain.toml. Stocks without a preset use the schema defaults.
    pub fn for_profile(profile: &Profile) -> Self {
        let stock = profile.info.stock.as_str();
        let mut preset = Self {
            rms: [6., 8., 10.],
            uniformity: [0.97; 3],
            floor: [0.03; 3],
            scales: [1., 0.5, 0.25],
        };
        let rms = match stock {
            "kodak_ektar_100" | "fujifilm_c200" | "fujifilm_xtra_400" | "fujifilm_pro_400h" => {
                [4.; 3]
            }
            "kodak_portra_160" => [3.5; 3],
            "kodak_portra_400" => [4.5; 3],
            "kodak_portra_800" | "kodak_ultramax_400" => [6.; 3],
            "kodak_portra_800_push1" => [7.; 3],
            "kodak_portra_800_push2" => [9.; 3],
            "kodak_gold_200" => [5.; 3],
            "kodak_ektachrome_100" | "fujifilm_velvia_100" | "fujifilm_provia_100f" => [8.; 3],
            "kodak_kodachrome_64" => [10.; 3],
            "kodak_vision3_50d" => [7., 7., 12.],
            "kodak_vision3_250d" => [10., 11., 18.],
            "kodak_vision3_200t" => [7., 8., 17.],
            "kodak_vision3_500t" => [9., 13., 30.],
            "kodak_doublex" => [14.; 3],
            "kodak_trix" => [44.; 3],
            _ => return preset,
        };
        preset.rms = rms;
        preset.scales = [1., 0.4, 0.25];
        if profile.is_monochrome() {
            preset.uniformity = [0.6; 3];
            preset.floor = [if profile.is_positive() { 0.003 } else { 0.01 }; 3];
        }
        match stock {
            "kodak_vision3_50d" => preset.uniformity = [0.97, 0.95, 0.97],
            "kodak_vision3_250d" => {
                preset.uniformity = [0.97, 0.94, 0.97];
                preset.floor = [0.10, 0.11, 0.12];
            }
            "kodak_vision3_200t" => preset.floor = [0.03, 0.03, 0.12],
            "kodak_vision3_500t" => {
                preset.uniformity = [0.93, 0.97, 0.99];
                preset.floor = [0.12, 0.10, 0.35];
                preset.scales = [1., 0.3, 0.25];
            }
            _ => {}
        }
        preset
    }
}

#[derive(Clone, Debug)]
pub struct Layer {
    pub floor: [f64; 3],
    pub maximum: [f64; 3],
    pub particles_per_um2: [f64; 3],
}

#[derive(Clone, Debug)]
pub struct Grain {
    pub preset: Preset,
    pub layers: Vec<Layer>,
    pub curve_count: usize,
    table: Vec<f32>,
}

pub struct Spatial {
    pub dye_clouds: Vec<[f32; 3]>,
    pub pixel_area: f32,
    pub blur: f32,
    pub usm_sigma: f32,
    pub usm_amount: f32,
    pub micro_sigma: f32,
    pub micro_blur: f32,
}

impl Spatial {
    /// Serial blur supports add. Layer blurs run in parallel, so only the widest matters.
    pub fn margin(&self) -> f32 {
        let radius = |sigma: f32| {
            if sigma < crate::MIN_SIGMA {
                0.
            } else {
                (3. * sigma).ceil()
            }
        };
        let clouds = self
            .dye_clouds
            .iter()
            .copied()
            .map(super::widest)
            .fold(0., f32::max);
        let micro = if self.micro_sigma > 0.05 && self.micro_blur > 0.4 {
            self.micro_blur
        } else {
            0.
        };
        radius(clouds).max(radius(micro))
            + radius(self.blur)
            + if self.usm_amount > 0. {
                3. * radius(self.usm_sigma)
            } else {
                0.
            }
    }
}

impl Grain {
    #[cfg(test)]
    pub fn build(profile: &Profile) -> Result<Self, RenderError> {
        Self::build_with_params(profile, None)
    }

    /// Apply the selected development and chemistry to the profile before this call.
    pub fn build_with_params(
        profile: &Profile,
        params: Option<&GrainParams>,
    ) -> Result<Self, RenderError> {
        let curves = profile.model_layers()?;
        let count = curves.first().map_or(0, Vec::len);
        if count == 0 || count > 3 {
            return Err(RenderError::Invalid(
                "Unsupported grain sublayer count".into(),
            ));
        }
        let mut preset = Preset::for_profile(profile);
        if let Some(params) = params {
            params.validate().map_err(RenderError::Invalid)?;
            preset.rms =
                super::channels(params.rms_granularity, profile.is_monochrome()).map(f64::from);
        }
        let maximum: Vec<[f64; 3]> = (0..count)
            .map(|layer| {
                std::array::from_fn(|c| curves.iter().map(|row| row[layer][c]).fold(0., f64::max))
            })
            .collect();
        let total: [f64; 3] = std::array::from_fn(|c| maximum.iter().map(|row| row[c]).sum());
        if total.iter().any(|v| !v.is_finite() || *v <= 0.) {
            return Err(RenderError::Invalid("Invalid grain density maximum".into()));
        }
        let fractions: Vec<[f64; 3]> = maximum
            .iter()
            .map(|row| std::array::from_fn(|c| row[c] / total[c]))
            .collect();
        let floor: Vec<[f64; 3]> = fractions
            .iter()
            .map(|row| std::array::from_fn(|c| row[c] * preset.floor[c]))
            .collect();
        let absolute: Vec<[f64; 3]> = maximum
            .iter()
            .zip(&floor)
            .map(|(max, min)| std::array::from_fn(|c| max[c] + min[c]))
            .collect();
        let peak: [f64; 3] = std::array::from_fn(|c| {
            curves
                .iter()
                .map(|row| {
                    (0..count)
                        .map(|sl| {
                            let d = row[sl][c] + floor[sl][c];
                            preset.scales[sl] / fractions[sl][c].max(1e-12)
                                * d
                                * (absolute[sl][c] - preset.uniformity[c] * d)
                        })
                        .sum::<f64>()
                })
                .fold(0., f64::max)
        });
        let area: [f64; 3] = std::array::from_fn(|c| {
            (preset.rms[c] / 1000.).powi(2) * APERTURE_AREA / peak[c].max(1e-9)
        });
        let layers: Vec<Layer> = (0..count)
            .map(|sl| Layer {
                floor: floor[sl],
                maximum: absolute[sl],
                particles_per_um2: std::array::from_fn(|c| {
                    if area[c] > 0. {
                        // Bound particle counts so very small RMS stays finite on the GPU.
                        (fractions[sl][c] / (area[c] * preset.scales[sl])).min(1e12)
                    } else {
                        0.
                    }
                }),
            })
            .collect();
        // Per-layer records precede total curves and [exposure][layer][channel] curves.
        let mut table = Vec::new();
        for layer in &layers {
            table.extend(layer.floor.map(|v| v as f32));
            table.extend(layer.maximum.map(|v| v as f32));
            table.extend(layer.particles_per_um2.map(|v| v as f32));
        }
        for row in profile.normalized_curves() {
            table.extend(row.map(|v| v as f32));
        }
        for row in &curves {
            for layer in row {
                table.extend(layer.map(|v| v as f32));
            }
        }
        Ok(Self {
            preset,
            layers,
            curve_count: curves.len(),
            table,
        })
    }

    pub fn append_to(&self, spectral: &mut Vec<f32>) -> usize {
        let offset = spectral.len();
        spectral.extend(&self.table);
        offset
    }

    #[cfg(test)]
    pub fn spatial(&self, long_edge: f32, grain_size: f32) -> Spatial {
        self.spatial_params(long_edge, grain_size, None)
    }

    pub fn spatial_for(&self, long_edge: f32, settings: &FilmSettings) -> Spatial {
        self.spatial_params(
            long_edge,
            settings.grain_size,
            settings.grain_params.as_ref(),
        )
    }

    fn spatial_params(
        &self,
        long_edge: f32,
        grain_size: f32,
        params: Option<&GrainParams>,
    ) -> Spatial {
        let pixel_um = 35_000. / long_edge.max(1.) as f64;
        let size = if params.is_some() {
            1.
        } else {
            grain_size as f64
        };
        let pixel_area = (pixel_um / size).powi(2);
        Spatial {
            dye_clouds: self
                .layers
                .iter()
                .map(|layer| {
                    std::array::from_fn(|c| {
                        if layer.particles_per_um2[c] > 0. {
                            (2. * (layer.maximum[c] / (pixel_area * layer.particles_per_um2[c]))
                                .sqrt()) as f32
                        } else {
                            0.
                        }
                    })
                })
                .collect(),
            pixel_area: pixel_area as f32,
            blur: params.map_or(0.89 * grain_size, |p| p.blur),
            usm_sigma: 0.7 * size as f32,
            usm_amount: params.map_or(1.5, |p| p.mult_usm_amount),
            micro_sigma: (0.03 / pixel_um) as f32,
            micro_blur: (0.2 / pixel_um) as f32,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::film::profile::{load, PROFILE_JSON};

    fn stock(name: &str) -> Profile {
        load(
            PROFILE_JSON
                .iter()
                .position(|(key, _)| *key == name)
                .unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn calibration_recovers_catalogue_peak_rms() {
        for index in 0..22 {
            let profile = load(index).unwrap();
            let grain = Grain::build(&profile).unwrap();
            let curves = profile.model_layers().unwrap();
            for c in 0..3 {
                let peak = curves
                    .iter()
                    .map(|row| {
                        grain
                            .layers
                            .iter()
                            .enumerate()
                            .map(|(sl, layer)| {
                                let d = row[sl][c] + layer.floor[c];
                                d * (layer.maximum[c] - grain.preset.uniformity[c] * d)
                                    / (APERTURE_AREA * layer.particles_per_um2[c])
                            })
                            .sum::<f64>()
                    })
                    .fold(0., f64::max)
                    .sqrt()
                    * 1000.;
                assert!(
                    (peak - grain.preset.rms[c]).abs() < 1e-10,
                    "{} {c}: {peak}",
                    profile.info.stock
                );
                let floor: f64 = grain.layers.iter().map(|layer| layer.floor[c]).sum();
                assert!((floor - grain.preset.floor[c]).abs() < 1e-12);
            }
        }
    }

    #[test]
    fn bw_layers_and_noise_parameters_are_shared() {
        for name in ["kodak_doublex", "kodak_trix"] {
            let grain = Grain::build(&stock(name)).unwrap();
            assert_eq!(grain.preset.uniformity, [0.6; 3]);
            for layer in &grain.layers {
                assert_eq!(layer.floor, [layer.floor[0]; 3]);
                assert_eq!(layer.maximum, [layer.maximum[0]; 3]);
                assert_eq!(layer.particles_per_um2, [layer.particles_per_um2[0]; 3]);
            }
        }
    }

    #[test]
    fn grain_size_scales_particle_area_and_cloud_radius() {
        let grain = Grain::build(&stock("kodak_portra_400")).unwrap();
        let small = grain.spatial(6000., 1.);
        let large = grain.spatial(6000., 2.);
        assert_eq!(small.pixel_area, 4. * large.pixel_area);
        for (a, b) in small.dye_clouds.iter().zip(&large.dye_clouds) {
            for c in 0..3 {
                assert_eq!(2. * a[c], b[c]);
            }
        }
    }

    #[test]
    fn calibration_matches_python_layer_parameters() {
        // _layer_grain_params at 5 um pitch, from experimental 28bf883.
        for (name, expected) in [
            (
                "kodak_portra_400",
                [68.68245511393326, 61.24199786867303, 82.32063482053088],
            ),
            (
                "kodak_vision3_500t",
                [19.97532512036519, 7.665645863600723, 2.859846610602452],
            ),
            (
                "kodak_ektachrome_100",
                [65.05631721464168, 83.23956209552364, 84.1621226793509],
            ),
            ("kodak_doublex", [13.277579526129495; 3]),
            ("kodak_trix", [3.339046960218026; 3]),
            (
                "kodak_verita_200d",
                [40.46505879863956, 19.376700259787466, 13.433043732467727],
            ),
        ] {
            let grain = Grain::build(&stock(name)).unwrap();
            for (c, expected) in expected.iter().enumerate() {
                let actual = 25. * grain.layers[0].particles_per_um2[c];
                assert!(
                    (actual - expected).abs() < expected * 1e-10,
                    "{name}: {actual} vs {expected}"
                );
            }
        }
    }

    #[test]
    #[ignore = "requires hardware GPU"]
    fn gpu_stock_grain_statistics() {
        use crate::*;
        let renderer = Renderer::new().unwrap();
        let cancel = AtomicBool::new(false);
        const N: u32 = 512;
        let mut image = SceneLinearImage {
            width: N,
            height: N,
            orientation: 1,
            data: vec![1.; (N * N * 3) as usize],
            white_balance: x3f_core::WhiteBalanceCalibration {
                camera_to_rgb: [1., 0., 0., 0., 1., 0., 0., 0., 1.],
                xyz_to_camera: [1., 0., 0., 0., 1., 0., 0., 0., 1.],
                as_shot_neutral: [1.; 3],
            },
            color_mode_calibration: None,
        };
        // Python apply_grain on density 1 at 5 um pitch, including all texture stages.
        for (name, grain_size, roughness, checker, expected_std) in [
            (
                "kodak_portra_400",
                1.,
                0.,
                0,
                Some([0.01285254, 0.01222312, 0.01273978]),
            ),
            (
                "kodak_vision3_500t",
                1.,
                0.,
                0,
                Some([0.02747872, 0.03494511, 0.06074249]),
            ),
            ("kodak_doublex", 1., 0., 0, Some([0.04809773; 3])),
            ("kodak_trix", 1., 0., 0, Some([0.08651276; 3])),
            ("kodak_trix", 4., 1., 0, None),
            ("kodak_trix", 1., 0., 4, None),
            ("kodak_trix", 4., 1., 16, None),
        ] {
            image.data = (0..N * N)
                .flat_map(|i| {
                    [if let Some(x) = (i % N).checked_div(checker) {
                        2. * ((x + (i / N) / checker) % 2) as f32
                    } else {
                        1.
                    }; 3]
                })
                .collect();
            let source = renderer.upload(&image, &cancel).unwrap();
            let profile = stock(name);
            let grain = Grain::build(&profile).unwrap();
            let spatial = grain.spatial(7000., grain_size);
            let mut spectral = Vec::new();
            grain.append_to(&mut spectral);
            let mut base = [[0.; 4]; PARAMETER_SLOTS];
            base[17] = [0., 0., 1., 1.];
            base[22] = [1., 0., 0., N as f32];
            base[23] = [0., 1., 0., N as f32];
            base[24] = [1., 0., -0.5, 0.];
            base[25] = [0., 1., -0.5, 0.];
            base[40][2] = 1.;
            base[32][3] = f32::from(profile.is_positive());
            base[34][3] = f32::from_bits(17);
            base[35][3] = roughness;
            base[36][3] = 8. * grain_size;
            base[37][3] = f32::from(profile.is_monochrome());
            base[52] = [0., grain.layers.len() as f32, grain.curve_count as f32, 0.];
            base[53] = [
                grain.preset.uniformity[0] as f32,
                grain.preset.uniformity[1] as f32,
                grain.preset.uniformity[2] as f32,
                spatial.micro_sigma,
            ];
            base[54] = [
                grain.preset.floor[0] as f32,
                grain.preset.floor[1] as f32,
                grain.preset.floor[2] as f32,
                1.5,
            ];
            base[55][0] = spatial.pixel_area;
            let mut chain = Chain::new(base);
            let sampled = chain.alloc();
            let scratch = chain.alloc();
            chain
                .passes
                .push(("sample", [scratch, scratch, sampled], base));
            chain.release(scratch);
            let output = chain.grain(sampled, &spatial);
            let size = u64::from(N * N) * 16;
            let mut workspace = renderer.new_workspace(size);
            renderer
                .queue
                .write_buffer(&workspace.spectral, 0, bytemuck::cast_slice(&spectral));
            let tile = Tile {
                x: 0,
                y: 0,
                width: N,
                height: N,
                origin: [0, 0],
            };
            let mut plan = Plan {
                width: N,
                height: N,
                full_width: N,
                full_height: N,
                region: None,
                margin: 0,
                tiles: vec![tile],
                passes: chain
                    .passes
                    .into_iter()
                    .map(|(entry, buffers, params)| Pass {
                        entry,
                        buffers,
                        params,
                    })
                    .collect(),
                output,
                buffer_bytes: size,
                tables: None,
                curves: Vec::new(),
                fill: None,
            };
            let readback = renderer.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Grain statistics"),
                size,
                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                mapped_at_creation: false,
            });
            let run = |workspace: &mut Workspace, plan: &Plan| -> Vec<[f32; 4]> {
                let mut encoder = renderer.encode(&source, workspace, plan, &tile, false);
                encoder.copy_buffer_to_buffer(
                    &workspace.buffers[plan.output],
                    0,
                    &readback,
                    0,
                    size,
                );
                renderer.queue.submit(Some(encoder.finish()));
                renderer
                    .read(&readback, size, &cancel, |bytes| {
                        Ok(bytemuck::cast_slice(bytes).to_vec())
                    })
                    .unwrap()
            };
            let before_sharpen = if expected_std.is_none() {
                let at = plan
                    .passes
                    .iter()
                    .position(|pass| pass.entry == "grain_usm")
                    .unwrap();
                let rest = plan.passes.split_off(at);
                plan.output = rest[0].buffers[0];
                let before = run(&mut workspace, &plan);
                plan.passes.extend(rest);
                plan.output = output;
                Some(before)
            } else {
                None
            };
            let pixels = run(&mut workspace, &plan);
            assert!(pixels.iter().flatten().all(|v| v.is_finite()));
            let interior: Vec<_> = (64..N - 64)
                .flat_map(|y| (64..N - 64).map(move |x| (y * N + x) as usize))
                .map(|i| pixels[i])
                .collect();
            for c in 0..3 {
                let mean =
                    interior.iter().map(|v| v[c] as f64).sum::<f64>() / interior.len() as f64;
                let std = (interior
                    .iter()
                    .map(|v| (v[c] as f64 - mean).powi(2))
                    .sum::<f64>()
                    / interior.len() as f64)
                    .sqrt();
                eprintln!("{name} size {grain_size} roughness {roughness} checker {checker} channel {c}: mean={mean:.6}, std={std:.6}");
                if let Some(expected_std) = expected_std {
                    assert!((mean - 1.).abs() < 0.003, "{name}: mean {mean}");
                    assert!(
                        (std / expected_std[c] - 1.).abs() < 0.05,
                        "{name} channel {c}: RMS {std} vs {}",
                        expected_std[c]
                    );
                }
                if let Some(before) = &before_sharpen {
                    let before =
                        before.iter().map(|v| v[c] as f64).sum::<f64>() / before.len() as f64;
                    let after = pixels
                        .iter()
                        .map(|v| v[c] as f64 + grain.preset.floor[c])
                        .sum::<f64>()
                        / pixels.len() as f64;
                    eprintln!(
                        "{name} size {grain_size} checker {checker}: normalized mass delta {:.6}%",
                        (after / before - 1.) * 100.
                    );
                    assert!(
                        (after / before - 1.).abs() < 0.001,
                        "USM changed density mass: {before} to {after}"
                    );
                }
            }
            if profile.is_monochrome() {
                assert!(pixels.iter().all(|v| v[0] == v[1] && v[1] == v[2]));
            }
        }
    }
}
