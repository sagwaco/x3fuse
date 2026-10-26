use super::*;

#[test]
fn ffi_layouts_match_the_shim() {
    // SAFETY: plain query.
    let sizes: [usize; 3] = std::array::from_fn(|i| unsafe { ffi::x3fdng_sizes(i as c_int) });
    assert_eq!(
        sizes,
        [
            std::mem::size_of::<ffi::Info>(),
            std::mem::size_of::<ffi::Raw>(),
            std::mem::size_of::<ffi::Image>()
        ]
    );
}

#[test]
fn flips_map_to_exif_orientations() {
    let exif: Vec<u16> = (0..8).map(orientation).collect();
    assert_eq!(exif, [1, 2, 4, 3, 5, 8, 6, 7]);
    // Orientation 6 turns the stored left edge into the top edge.
    assert_eq!(orient_rect([0.1, 0.2, 0.5, 1.0], 6), [0.0, 0.1, 0.8, 0.4]);
}

// A minimal little-endian DNG writer for synthetic fixtures.

#[derive(Clone)]
enum Value {
    Short(Vec<u16>),
    Long(Vec<u32>),
    Byte(Vec<u8>),
    Ascii(&'static str),
    Rational(Vec<f64>),
    SRational(Vec<f64>),
}

#[derive(Clone, Copy, PartialEq)]
enum Stream {
    Exact,
    /// A valid zlib stream that holds half of the block.
    Short,
    /// A valid zlib stream with more data than the block holds.
    Long,
}

struct Fixture {
    width: u32,
    height: u32,
    samples: u32,
    photometric: u16,
    /// Rows of samples, black level included.
    pixels: Vec<u16>,
    /// Deflate with this TIFF predictor, or uncompressed.
    deflate: Option<u32>,
    stream: Stream,
    /// Tile width and height, or 16-row strips.
    tile: Option<(u32, u32)>,
    extra: Vec<(u16, Value)>,
}

const BLACK: u16 = 64;
const WHITE: u16 = 4095;
/// Linear sRGB as the camera space: XYZ to sRGB, from IEC 61966-2-1.
const COLOR_MATRIX: [f64; 9] = [
    3.2404542, -1.5371385, -0.4985314, -0.9692660, 1.8760108, 0.0415560, 0.0556434, -0.2040259,
    1.0572252,
];
const NEUTRAL: [f64; 3] = [0.5, 1., 0.8];

fn deflate(data: &[u8]) -> Vec<u8> {
    use std::io::Write;
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(data).unwrap();
    encoder.finish().unwrap()
}

impl Fixture {
    /// Strips, or tiles padded with zeros, as rows of samples.
    fn blocks(&self) -> (usize, Vec<Vec<u16>>) {
        let (w, h, spp) = (
            self.width as usize,
            self.height as usize,
            self.samples as usize,
        );
        let Some((tw, th)) = self.tile.map(|(a, b)| (a as usize, b as usize)) else {
            let rows = if self.deflate.is_some() { 16 } else { h };
            return (
                w * spp,
                self.pixels
                    .chunks(w * spp * rows)
                    .map(<[u16]>::to_vec)
                    .collect(),
            );
        };
        let mut blocks = Vec::new();
        for ty in (0..h).step_by(th) {
            for tx in (0..w).step_by(tw) {
                let mut block = vec![0u16; tw * th * spp];
                for (r, c) in (0..th).flat_map(|r| (0..tw).map(move |c| (r, c))) {
                    if ty + r < h && tx + c < w {
                        let src = ((ty + r) * w + tx + c) * spp;
                        block[(r * tw + c) * spp..][..spp]
                            .copy_from_slice(&self.pixels[src..][..spp]);
                    }
                }
                blocks.push(block);
            }
        }
        (tw * spp, blocks)
    }

    fn write(&self) -> TempFile {
        let (row, blocks) = self.blocks();
        let distance = match self.deflate {
            Some(2) => 1,
            Some(34892) => 2,
            Some(34893) => 4,
            _ => 0,
        } * self.samples as usize;
        let mut strips = Vec::new();
        for mut samples in blocks {
            if distance > 0 {
                for line in samples.chunks_mut(row) {
                    for i in (distance..row).rev() {
                        line[i] = line[i].wrapping_sub(line[i - distance]);
                    }
                }
            }
            let mut bytes: Vec<u8> = samples.iter().flat_map(|v| v.to_le_bytes()).collect();
            strips.push(match (self.deflate, self.stream) {
                (None, _) => bytes,
                (Some(_), Stream::Exact) => deflate(&bytes),
                (Some(_), Stream::Short) => deflate(&bytes[..bytes.len() / 2]),
                (Some(_), Stream::Long) => {
                    bytes.extend([0; 64]);
                    deflate(&bytes)
                }
            });
        }
        let lengths = Value::Long(strips.iter().map(|s| s.len() as u32).collect());
        let (offsets_tag, layout) = match self.tile {
            Some((tw, th)) => (
                324,
                vec![
                    (322, Value::Long(vec![tw])),
                    (323, Value::Long(vec![th])),
                    (325, lengths),
                ],
            ),
            None => {
                let rows = if self.deflate.is_some() {
                    16
                } else {
                    self.height
                };
                (273, vec![(278, Value::Long(vec![rows])), (279, lengths)])
            }
        };
        let mut tags = vec![
            (254, Value::Long(vec![0])),
            (256, Value::Long(vec![self.width])),
            (257, Value::Long(vec![self.height])),
            (258, Value::Short(vec![16; self.samples as usize])),
            (
                259,
                Value::Short(vec![if self.deflate.is_some() { 8 } else { 1 }]),
            ),
            (262, Value::Short(vec![self.photometric])),
            (271, Value::Ascii("X3Fuse\0")),
            (272, Value::Ascii("Synthetic\0")),
            (277, Value::Short(vec![self.samples as u16])),
            (284, Value::Short(vec![1])),
            (50706, Value::Byte(vec![1, 4, 0, 0])),
            (50708, Value::Ascii("X3Fuse Synthetic\0")),
            (
                50714,
                Value::Rational(vec![f64::from(BLACK); self.samples as usize]),
            ),
            (50717, Value::Long(vec![u32::from(WHITE)])),
            (50721, Value::SRational(COLOR_MATRIX.to_vec())),
            (50728, Value::Rational(NEUTRAL.to_vec())),
            (50778, Value::Short(vec![21])),
        ];
        if let Some(predictor) = self.deflate {
            tags.push((317, Value::Short(vec![predictor as u16])));
        }
        tags.extend(layout);
        tags.extend(self.extra.iter().cloned());
        // The block offsets are filled in once the layout is known.
        tags.push((offsets_tag, Value::Long(vec![0; strips.len()])));
        tags.sort_by_key(|(t, _)| *t);

        let encode = |v: &Value| -> (u16, u32, Vec<u8>) {
            let fraction = |x: f64| ((x * 1e6).round() as i32, 1_000_000i32);
            match v {
                Value::Byte(b) => (1, b.len() as u32, b.clone()),
                Value::Ascii(s) => (2, s.len() as u32, s.as_bytes().to_vec()),
                Value::Short(s) => (
                    3,
                    s.len() as u32,
                    s.iter().flat_map(|v| v.to_le_bytes()).collect(),
                ),
                Value::Long(l) => (
                    4,
                    l.len() as u32,
                    l.iter().flat_map(|v| v.to_le_bytes()).collect(),
                ),
                Value::Rational(r) => (
                    5,
                    r.len() as u32,
                    r.iter()
                        .flat_map(|x| {
                            let (n, d) = fraction(*x);
                            [(n as u32).to_le_bytes(), (d as u32).to_le_bytes()]
                        })
                        .flatten()
                        .collect(),
                ),
                Value::SRational(r) => (
                    10,
                    r.len() as u32,
                    r.iter()
                        .flat_map(|x| {
                            let (n, d) = fraction(*x);
                            [n.to_le_bytes(), d.to_le_bytes()]
                        })
                        .flatten()
                        .collect(),
                ),
            }
        };
        let ifd_size = 2 + tags.len() * 12 + 4;
        let mut data_offset = 8 + ifd_size;
        let mut extra_data = Vec::new();
        let mut strip_start = 0;
        let mut entries = Vec::new();
        let mut encoded: Vec<(u16, u16, u32, Vec<u8>)> = tags
            .iter()
            .map(|(t, v)| {
                let (ty, n, b) = encode(v);
                (*t, ty, n, b)
            })
            .collect();
        // Out-of-line values first, then strips.
        let out_of_line: usize = encoded
            .iter()
            .map(|e| {
                if e.3.len() > 4 {
                    e.3.len().next_multiple_of(2)
                } else {
                    0
                }
            })
            .sum();
        strip_start += data_offset + out_of_line;
        let mut offsets = Vec::new();
        let mut at = strip_start as u32;
        for s in &strips {
            offsets.push(at);
            at += s.len() as u32;
        }
        for e in &mut encoded {
            if e.0 == offsets_tag {
                e.3 = offsets.iter().flat_map(|v| v.to_le_bytes()).collect();
            }
        }
        for (tag, ty, count, bytes) in &encoded {
            let mut entry = Vec::new();
            entry.extend(tag.to_le_bytes());
            entry.extend(ty.to_le_bytes());
            entry.extend(count.to_le_bytes());
            if bytes.len() <= 4 {
                let mut inline = bytes.clone();
                inline.resize(4, 0);
                entry.extend(inline);
            } else {
                entry.extend((data_offset as u32).to_le_bytes());
                extra_data.extend(bytes);
                if bytes.len() % 2 == 1 {
                    extra_data.push(0);
                }
                data_offset += bytes.len().next_multiple_of(2);
            }
            entries.push(entry);
        }
        let mut file = b"II*\0".to_vec();
        file.extend(8u32.to_le_bytes());
        file.extend((tags.len() as u16).to_le_bytes());
        entries.iter().for_each(|e| file.extend(e));
        file.extend(0u32.to_le_bytes());
        file.extend(extra_data);
        assert_eq!(file.len(), strip_start);
        strips.iter().for_each(|s| file.extend(s));
        TempFile::new(&file)
    }
}

struct TempFile(std::path::PathBuf);

impl TempFile {
    fn new(bytes: &[u8]) -> Self {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("x3f-dng-{}-{n}.dng", std::process::id()));
        std::fs::write(&path, bytes).unwrap();
        Self(path)
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// A flat gray scene at a quarter of the white level.
fn gray(
    samples: usize,
    sites: &dyn Fn(usize, usize) -> usize,
    width: u32,
    height: u32,
) -> Vec<u16> {
    let level = |c: usize| BLACK + (0.25 * NEUTRAL[c] * f64::from(WHITE - BLACK)).round() as u16;
    (0..height as usize)
        .flat_map(|y| (0..width as usize).flat_map(move |x| (0..samples).map(move |s| (y, x, s))))
        .map(|(y, x, s)| level(if samples == 1 { sites(y, x) } else { s }))
        .collect()
}

fn assert_gray(scene: &x3f_core::SceneLinearImage, expected: f32) {
    for px in scene.data.as_chunks::<3>().0 {
        for v in px {
            assert!(
                (v - expected).abs() < 0.004 * expected.max(1.),
                "{px:?} != {expected}"
            );
        }
    }
}

fn bayer() -> Fixture {
    let (width, height) = (64, 48);
    let rggb = |y: usize, x: usize| [[0, 1], [1, 2]][y % 2][x % 2];
    Fixture {
        width,
        height,
        samples: 1,
        photometric: 32803,
        pixels: gray(1, &rggb, width, height),
        deflate: None,
        stream: Stream::Exact,
        tile: None,
        extra: vec![
            (274, Value::Short(vec![6])),
            (33421, Value::Short(vec![2, 2])),
            (33422, Value::Byte(vec![0, 1, 1, 2])),
            (50710, Value::Byte(vec![0, 1, 2])),
            (50711, Value::Short(vec![1])),
            (50719, Value::Long(vec![2, 2])),
            (50720, Value::Long(vec![52, 36])),
            (50730, Value::SRational(vec![1.])),
            (50829, Value::Long(vec![4, 4, 44, 60])),
        ],
    }
}

fn linear(deflate: Option<u32>) -> Fixture {
    let (width, height) = (40, 40);
    Fixture {
        width,
        height,
        samples: 3,
        photometric: 34892,
        pixels: gray(3, &|_, _| 0, width, height),
        deflate,
        stream: Stream::Exact,
        tile: None,
        extra: vec![(274, Value::Short(vec![8]))],
    }
}

#[test]
fn bayer_dng_prepares_a_neutral_scene() {
    let file = bayer().write();
    let cancel = AtomicBool::new(false);
    let info = inspect(&file.0, &cancel).unwrap();
    assert_eq!((info.width, info.height, info.orientation), (56, 40, 6));
    assert!(!info.monochrome);
    // DefaultCrop (2, 2, 52 x 36) of the 56 x 40 active area, turned by 6.
    let crop = info.as_shot_crop.unwrap();
    let expected = [2. / 40., 2. / 56., 36. / 40., 52. / 56.];
    assert!(
        crop.iter().zip(expected).all(|(a, b)| (a - b).abs() < 1e-6),
        "{crop:?}"
    );
    let scene = prepare(&file.0, &cancel).unwrap();
    assert_eq!((scene.width, scene.height, scene.orientation), (56, 40, 6));
    // A quarter of white, doubled by BaselineExposure.
    assert_gray(&scene, 0.5);
    let n = scene.white_balance.as_shot_neutral;
    assert!((n[0] - 0.5).abs() < 1e-6 && n[1] == 1. && (n[2] - 0.8).abs() < 1e-6);
}

#[test]
fn deflate_linear_dng_decodes_each_predictor() {
    let cancel = AtomicBool::new(false);
    for predictor in [1, 2] {
        let file = linear(Some(predictor)).write();
        let info = inspect(&file.0, &cancel).unwrap();
        assert_eq!((info.width, info.height, info.orientation), (40, 40, 8));
        assert_gray(&prepare(&file.0, &cancel).unwrap(), 0.25);
    }
    // The uncompressed form decodes to the same scene.
    assert_gray(&prepare(&linear(None).write().0, &cancel).unwrap(), 0.25);
}

#[test]
fn short_deflate_strips_are_corrupt() {
    let mut fixture = linear(Some(2));
    fixture.stream = Stream::Short;
    let file = fixture.write();
    let err = prepare(&file.0, &AtomicBool::new(false)).unwrap_err();
    assert!(err.starts_with("DNG decode failed"), "{err}");
}

#[test]
fn monochrome_dng_is_gray_in_three_channels() {
    let (width, height) = (32, 32);
    let mut fixture = linear(None);
    fixture.samples = 1;
    fixture.width = width;
    fixture.height = height;
    fixture.pixels = gray(1, &|_, _| 1, width, height);
    fixture.extra = vec![];
    let file = fixture.write();
    let cancel = AtomicBool::new(false);
    assert!(inspect(&file.0, &cancel).unwrap().monochrome);
    let scene = prepare(&file.0, &cancel).unwrap();
    assert_gray(&scene, 0.25);
    let jpeg = preview(&file.0, &cancel).unwrap();
    let image = image::load_from_memory(&jpeg).unwrap();
    assert_eq!(image.color(), image::ColorType::Rgb8);
}

#[test]
fn clipped_highlights_stay_neutral() {
    // Green clips first: the as-shot neutral has its largest value there.
    let mut fixture = linear(None);
    // Unclipped red and blue agree on a balanced level of 1.22.
    let level = |v: f64| BLACK + (f64::from(WHITE - BLACK) * v).round() as u16;
    let clip = [level(0.5 * 1.22), WHITE, level(0.8 * 1.22)];
    fixture.pixels = (0..40 * 40).flat_map(|_| clip).collect();
    let scene = prepare(&fixture.write().0, &AtomicBool::new(false)).unwrap();
    let px = &scene.data[..3];
    assert!(
        (px[0] - px[1]).abs() < 3e-3 && (px[1] - px[2]).abs() < 3e-3,
        "{px:?}"
    );
    // Blending keeps the mean balanced camera level above display white.
    assert!((px[1] - (1.22 + 1. + 1.22) / 3.).abs() < 3e-3, "{px:?}");
}

#[test]
fn warm_clipped_highlights_render_white_in_full_and_half_size() {
    let cancel = AtomicBool::new(false);
    let neutral = [0.26975764, 1., 0.7032967];
    let level = |c: usize| {
        let balanced = [2.04, 1.09, 0.87];
        BLACK + (f64::from(WHITE - BLACK) * balanced[c] * neutral[c]).round() as u16
    };
    for mut fixture in [bayer(), linear(None)] {
        fixture.extra.retain(|(tag, _)| *tag != 50730);
        fixture
            .extra
            .push((50728, Value::Rational(neutral.to_vec())));
        // The Leica M10-R daylight matrix includes negative channel terms.
        fixture.extra.push((
            50721,
            Value::SRational(vec![
                0.48779297,
                -0.12866211,
                -0.04858398,
                -0.58398438,
                1.37011719,
                0.22070313,
                -0.18041992,
                0.33691406,
                0.52514648,
            ]),
        ));
        for (i, v) in fixture.pixels.iter_mut().enumerate() {
            let c = if fixture.samples == 3 {
                i % 3
            } else {
                [[0, 1], [1, 2]][i / fixture.width as usize % 2][i % fixture.width as usize % 2]
            };
            *v = level(c);
        }
        let file = fixture.write();
        for half in [false, true] {
            let (image, cal, _) = decode(&file.0, &cancel, half, None).unwrap();
            let scene = to_scene(image, &cal).unwrap();
            for px in scene.as_chunks::<3>().0 {
                assert!(px.iter().all(|v| *v > 1.), "half={half}: {px:?}");
                let low = px.iter().copied().fold(f32::INFINITY, f32::min);
                let high = px.iter().copied().fold(f32::NEG_INFINITY, f32::max);
                assert!(high / low < 1.25, "half={half}: {px:?}");
            }
        }
        let jpeg = image::load_from_memory(&preview(&file.0, &cancel).unwrap())
            .unwrap()
            .into_rgb8();
        assert!(jpeg.as_raw().iter().all(|v| *v >= 250));
    }
}

#[test]
fn highlight_blend_keeps_reliable_color_and_scene_headroom() {
    // Unclipped color and floating-point HDR have no highlight weight.
    let pixels = [
        [1.5, 0.3, 0.25],
        [6., 3., -0.1],
        [3., 1., 2.],
        [2.; 3],
        [0.5; 3],
    ];
    let mut image = Balanced {
        data: pixels.into_iter().flatten().collect(),
        width: pixels.len(),
        height: 1,
        highlights: vec![0, 0, 255, 255, 255],
        step: 1,
    };
    blend_highlights(&mut image);
    let result = image.data.as_chunks::<3>().0;
    assert_eq!(&result[..2], &pixels[..2]);
    assert_eq!(result[2], [2.; 3]);
    assert_eq!(&result[3..], &pixels[3..]);
}

#[test]
fn highlight_blend_has_no_step_at_sensor_clipping() {
    let mut image = Balanced {
        data: Vec::new(),
        width: 201,
        height: 1,
        highlights: Vec::new(),
        step: 1,
    };
    // The sky has a blue balanced channel above one before green clips.
    for i in 0..image.width {
        let level = 0.85 + i as f32 * 0.001;
        image
            .data
            .extend([0.8 * level, level.min(1.), 1.12 * level]);
        image.highlights.push(highlight_weight(level));
    }
    blend_highlights(&mut image);
    for pair in image.data.as_chunks::<3>().0.windows(2) {
        for c in 0..3 {
            assert!((pair[1][c] - pair[0][c]).abs() < 0.004, "{pair:?}");
        }
    }
    assert_eq!(highlight_weight(0.85), 0);
    assert_eq!(highlight_weight(1.), 255);
    assert_eq!(dilate(&[128, 64, 0], 3, 1, 1), [128, 128, 64]);
}

#[test]
fn dilation_matches_a_direct_window_maximum() {
    let (w, h): (usize, usize) = (37, 23);
    let mut seed = 17;
    let mask: Vec<u8> = (0..w * h)
        .map(|_| {
            if noise(&mut seed) > 0.8 {
                (noise(&mut seed) * 127. + 128.) as u8
            } else {
                0
            }
        })
        .collect();
    for radius in [0, 1, 2, 3, 6, 13, 17, 40] {
        let direct: Vec<u8> = (0..w * h)
            .map(|i| {
                let (y, x) = (i / w, i % w);
                let rows = y.saturating_sub(radius)..(y + radius + 1).min(h);
                rows.flat_map(|r| {
                    (x.saturating_sub(radius)..(x + radius + 1).min(w)).map(move |c| (r, c))
                })
                .map(|(r, c)| mask[r * w + c])
                .max()
                .unwrap()
            })
            .collect();
        assert_eq!(dilate(&mask, w, h, radius), direct, "radius {radius}");
    }
}

#[test]
fn integer_samples_stop_at_white_level() {
    let mut fixture = linear(None);
    fixture.samples = 1;
    fixture.pixels = vec![WHITE + 500; (fixture.width * fixture.height) as usize];
    let scene = prepare(&fixture.write().0, &AtomicBool::new(false)).unwrap();
    assert_gray(&scene, 1.);
}

#[test]
fn non_dng_input_is_rejected() {
    let file = TempFile::new(b"II*\0not a raw file at all");
    assert!(inspect(&file.0, &AtomicBool::new(false)).is_err());
}

#[test]
fn deflate_decodes_wide_predictors_and_partial_tiles() {
    let cancel = AtomicBool::new(false);
    for predictor in [34892, 34893] {
        assert_gray(
            &prepare(&linear(Some(predictor)).write().0, &cancel).unwrap(),
            0.25,
        );
    }
    // 40 x 40 in 16 x 16 tiles: the last row and column of tiles are partial.
    let mut fixture = linear(Some(2));
    fixture.tile = Some((16, 16));
    assert_gray(&prepare(&fixture.write().0, &cancel).unwrap(), 0.25);
    fixture.stream = Stream::Short;
    assert!(prepare(&fixture.write().0, &cancel).is_err());
}

#[test]
fn oversized_deflate_streams_are_corrupt() {
    let mut fixture = linear(Some(1));
    fixture.stream = Stream::Long;
    let err = prepare(&fixture.write().0, &AtomicBool::new(false)).unwrap_err();
    assert!(err.starts_with("DNG decode failed"), "{err}");
}

#[test]
fn default_scale_resamples_to_square_pixels() {
    let mut fixture = linear(None);
    fixture.extra.push((50718, Value::Rational(vec![2., 1.])));
    let file = fixture.write();
    let cancel = AtomicBool::new(false);
    let info = inspect(&file.0, &cancel).unwrap();
    assert_eq!((info.width, info.height), (80, 40));
    let scene = prepare(&file.0, &cancel).unwrap();
    assert_eq!((scene.width, scene.height), (80, 40));
    assert_gray(&scene, 0.25);
}

/// A big-endian opcode list.
fn opcode_list(ops: &[(u32, Vec<u8>)]) -> Vec<u8> {
    let mut out = (ops.len() as u32).to_be_bytes().to_vec();
    for (id, params) in ops {
        for v in [*id, 0x01030000, 0, params.len() as u32] {
            out.extend(v.to_be_bytes());
        }
        out.extend(params);
    }
    out
}

/// One map point per plane, covering the whole image.
fn gain_map(plane: u32, planes: u32, gains: &[f32]) -> Vec<u8> {
    let mut p = Vec::new();
    for v in [0, 0, 1 << 20, 1 << 20, plane, planes, 1, 1, 1, 1] {
        p.extend(u32::to_be_bytes(v));
    }
    for v in [1f64, 1., 0., 0.] {
        p.extend(v.to_be_bytes());
    }
    p.extend((gains.len() as u32).to_be_bytes());
    gains.iter().for_each(|g| p.extend(g.to_be_bytes()));
    p
}

#[test]
fn opcode_gain_maps_and_warps_apply_per_plane() {
    let cancel = AtomicBool::new(false);
    // Stage 2 doubles plane 0 only; stage 3 maps planes 1 and 2 with their
    // own map planes, then an identity warp keeps the image.
    let mut warp = 1u32.to_be_bytes().to_vec();
    for v in [1f64, 0., 0., 0., 0., 0., 0.5, 0.5] {
        warp.extend(v.to_be_bytes());
    }
    let mut fixture = linear(None);
    fixture.extra.push((
        51009,
        Value::Byte(opcode_list(&[(9, gain_map(0, 1, &[2.]))])),
    ));
    fixture.extra.push((
        51022,
        Value::Byte(opcode_list(&[(9, gain_map(1, 2, &[3., 0.5])), (1, warp)])),
    ));
    let scene = prepare(&fixture.write().0, &cancel).unwrap();
    // Camera values: a quarter of the neutral, times the plane gains.
    let n = scene.white_balance.as_shot_neutral;
    let camera = [0.25 * n[0] * 2., 0.25 * n[1] * 3., 0.25 * n[2] * 0.5];
    let expected = color::apply(&scene.white_balance.camera_to_rgb, camera);
    for px in scene.data.as_chunks::<3>().0 {
        for c in 0..3 {
            assert!(
                (f64::from(px[c]) - expected[c]).abs() < 2e-3,
                "{px:?} != {expected:?}"
            );
        }
    }
}

// Native demosaic methods.

const METHODS: [DemosaicMethod; 10] = [
    DemosaicMethod::Amaze,
    DemosaicMethod::Dcb,
    DemosaicMethod::Ahd,
    DemosaicMethod::Eahd,
    DemosaicMethod::Hphd,
    DemosaicMethod::Igv,
    DemosaicMethod::Lmmse,
    DemosaicMethod::Vng4,
    DemosaicMethod::Mono,
    DemosaicMethod::Fast,
];

/// The CFA tag value and the LibRaw 2x2 pattern, 3 is the second green.
const PHASES: [[u8; 4]; 4] = [[0, 1, 1, 2], [1, 0, 2, 1], [1, 2, 0, 1], [2, 1, 1, 0]];

/// A Bayer DNG with an odd ActiveArea origin. The CFA pattern starts at the
/// active area, as DNG requires. `camera` gives camera values in [0, 1].
fn odd_bayer(phase: [u8; 4], camera: &dyn Fn(usize, usize) -> [f64; 3]) -> Fixture {
    let (width, height, top, left) = (72u32, 70u32, 3usize, 5usize);
    let pixels = (0..height as usize)
        .flat_map(|y| (0..width as usize).map(move |x| (y, x)))
        .map(|(y, x)| {
            if y < top || x < left {
                return BLACK;
            }
            let (ay, ax) = (y - top, x - left);
            let c = phase[(ay % 2) * 2 + ax % 2] as usize;
            BLACK + (camera(ay, ax)[c] * f64::from(WHITE - BLACK)).round() as u16
        })
        .collect();
    Fixture {
        width,
        height,
        samples: 1,
        photometric: 32803,
        pixels,
        deflate: None,
        stream: Stream::Exact,
        tile: None,
        extra: vec![
            (33421, Value::Short(vec![2, 2])),
            (33422, Value::Byte(phase.to_vec())),
            (50710, Value::Byte(vec![0, 1, 2])),
            (50711, Value::Short(vec![1])),
            (50829, Value::Long(vec![3, 5, 69, 71])),
        ],
    }
}

fn close3(px: &[f32], expected: [f64; 3], tol: f64, what: &str) {
    for c in 0..3 {
        assert!(
            (f64::from(px[c]) - expected[c]).abs() <= tol * expected[c].abs().max(0.05),
            "{what}: {px:?} != {expected:?}"
        );
    }
}

#[test]
fn native_methods_keep_color_in_every_cfa_phase_and_odd_origin() {
    let cancel = AtomicBool::new(false);
    // A flat color: red and blue sites differ, so a wrong phase shows.
    let camera = [0.3 * NEUTRAL[0], 0.2 * NEUTRAL[1], 0.1 * NEUTRAL[2]];
    for phase in PHASES {
        let file = odd_bayer(phase, &|_, _| camera).write();
        let info = inspect(&file.0, &cancel).unwrap();
        // LibRaw moves odd margins to even ones: the image starts one row
        // and one column into the active area, and the CFA phase follows.
        assert_eq!((info.width, info.height), (65, 65));
        assert!(info.bayer, "{phase:?}");
        let legacy = prepare(&file.0, &cancel).unwrap();
        let expected = color::apply(&legacy.white_balance.camera_to_rgb, camera);
        for method in METHODS {
            let scene = prepare_with_method(&file.0, Some(method), &cancel).unwrap();
            assert_eq!((scene.width, scene.height), (65, 65));
            if method == DemosaicMethod::Mono {
                // Each site keeps its own normalized sample as gray.
                let mono = color::monochrome(0.);
                assert_eq!(scene.white_balance.as_shot_neutral, mono.neutral);
                for (i, px) in scene.data.as_chunks::<3>().0.iter().enumerate() {
                    let c = phase[((i / 65 % 2) ^ 1) * 2 + ((i % 65 % 2) ^ 1)] as usize;
                    assert!(px[0] == px[1] && px[1] == px[2], "{px:?}");
                    assert!(
                        (f64::from(px[0]) - camera[c]).abs() < 2e-4,
                        "{phase:?} {px:?}"
                    );
                }
                continue;
            }
            assert_eq!(
                scene.white_balance.camera_to_rgb,
                legacy.white_balance.camera_to_rgb
            );
            for px in scene.data.as_chunks::<3>().0 {
                close3(px, expected, 2e-3, &format!("{method:?} {phase:?}"));
            }
        }
    }
}

#[test]
fn native_api_keeps_the_legacy_route_and_rejects_other_layouts() {
    let cancel = AtomicBool::new(false);
    let file = odd_bayer(PHASES[0], &|y, x| {
        [0.1 + 0.01 * (x % 7) as f64, 0.2, 0.05 * (y % 3) as f64]
    })
    .write();
    let a = prepare(&file.0, &cancel).unwrap();
    let b = prepare_with_method(&file.0, None, &cancel).unwrap();
    assert_eq!(a.data, b.data);
    assert_eq!(a.white_balance.camera_to_rgb, b.white_balance.camera_to_rgb);

    let small = bayer().write();
    let rgb = linear(None).write();
    let mut mono = linear(None);
    mono.samples = 1;
    mono.pixels = gray(1, &|_, _| 1, mono.width, mono.height);
    mono.extra = vec![];
    let mono = mono.write();
    for (file, why) in [(&small, "64 pixels"), (&rgb, "Bayer"), (&mono, "Bayer")] {
        assert!(!inspect(&file.0, &cancel).unwrap().bayer);
        // The LibRaw route still prepares them.
        prepare(&file.0, &cancel).unwrap();
        for method in METHODS {
            let err = prepare_with_method(&file.0, Some(method), &cancel).unwrap_err();
            assert!(err.contains(why), "{method:?}: {err}");
        }
    }
    let cancelled = AtomicBool::new(true);
    for method in METHODS {
        let err = prepare_with_method(&file.0, Some(method), &cancelled).unwrap_err();
        assert_eq!(err, CANCELLED);
    }
}

fn info_with_cfa(cell: &dyn Fn(usize, usize) -> u8) -> Box<ffi::Info> {
    // SAFETY: Info is plain data.
    let mut info: Box<ffi::Info> = Box::new(unsafe { std::mem::zeroed() });
    for r in 0..24 {
        for c in 0..24 {
            info.cfa[r][c] = cell(r, c);
        }
    }
    info
}

#[test]
fn bayer_pattern_needs_period_two_over_the_whole_table() {
    let rggb = |r: usize, c: usize| [[0, 1], [3, 2]][r % 2][c % 2];
    assert_eq!(bayer_pattern(&info_with_cfa(&rggb)), Some([[0, 1], [3, 2]]));
    // A change at the last site breaks the period.
    let late = |r: usize, c: usize| if (r, c) == (23, 23) { 0 } else { rggb(r, c) };
    assert_eq!(bayer_pattern(&info_with_cfa(&late)), None);
    // Period four in rows.
    let rows = |r: usize, c: usize| {
        if r % 4 < 2 {
            rggb(r, c)
        } else {
            rggb(r + 1, c)
        }
    };
    assert_eq!(bayer_pattern(&info_with_cfa(&rows)), None);
    // X-Trans.
    let xtrans = [
        [1, 1, 0, 1, 1, 2],
        [1, 1, 2, 1, 1, 0],
        [2, 0, 1, 0, 2, 1],
        [1, 1, 2, 1, 1, 0],
        [1, 1, 0, 1, 1, 2],
        [0, 2, 1, 2, 0, 1],
    ];
    assert_eq!(
        bayer_pattern(&info_with_cfa(&|r, c| xtrans[r % 6][c % 6])),
        None
    );
    // Greens side by side, and two reds.
    for p in [[[1, 1], [0, 2]], [[0, 1], [1, 0]]] {
        assert_eq!(bayer_pattern(&info_with_cfa(&|r, c| p[r % 2][c % 2])), None);
    }
}

/// One direct kernel call on kernel-domain input; returns three planes.
fn kernel(
    method: DemosaicMethod,
    (w, h): (usize, usize),
    mosaic: &[f32],
    cfa: [[u8; 2]; 2],
    init_gain: f64,
    cancel: &AtomicBool,
) -> (c_int, Vec<f32>) {
    let mut out = vec![0f32; w * h * 3];
    let rgb_cam = [[1f32, 0., 0.], [0., 1., 0.], [0., 0., 1.]];
    // SAFETY: the buffers have the sizes that the shim reads and writes.
    let code = unsafe {
        ffi::x3fdng_rt_demosaic(
            method.index(),
            w as c_int,
            h as c_int,
            mosaic.as_ptr(),
            out.as_mut_ptr(),
            cfa.as_ptr(),
            rgb_cam.as_ptr(),
            init_gain,
            cancelled,
            cancel as *const AtomicBool as *mut c_void,
        )
    };
    (code, out)
}

const RGGB: [[u8; 2]; 2] = [[0, 1], [3, 2]];

fn unit() -> color::Calibration {
    color::Calibration {
        camera_to_rgb: color::IDENTITY,
        xyz_to_camera: color::IDENTITY,
        neutral: [1.; 3],
    }
}

/// A mosaic of balanced values from a scene of three channels.
fn mosaic(w: usize, h: usize, scene: &dyn Fn(usize, usize) -> [f32; 3]) -> Vec<f32> {
    (0..h)
        .flat_map(|y| (0..w).map(move |x| (y, x)))
        .map(|(y, x)| {
            let c = RGGB[y % 2][x % 2] as usize;
            scene(y, x)[if c == 3 { 1 } else { c }]
        })
        .collect()
}

fn run(method: DemosaicMethod, (w, h): (usize, usize), data: Vec<f32>, integer: bool) -> Vec<f32> {
    let highlights = vec![0u8; w * h];
    native(
        method,
        data,
        &highlights,
        (w, h),
        RGGB,
        &unit(),
        0.,
        integer,
        &AtomicBool::new(false),
    )
    .unwrap()
    .data
}

/// Deterministic noise in [-1, 1).
fn noise(seed: &mut u64) -> f32 {
    *seed = seed
        .wrapping_mul(6364136223846793005)
        .wrapping_add(1442695040888963407);
    (*seed >> 40) as f32 / (1u64 << 23) as f32 - 1.
}

const COLOR_METHODS: [DemosaicMethod; 9] = [
    DemosaicMethod::Amaze,
    DemosaicMethod::Dcb,
    DemosaicMethod::Ahd,
    DemosaicMethod::Eahd,
    DemosaicMethod::Hphd,
    DemosaicMethod::Igv,
    DemosaicMethod::Lmmse,
    DemosaicMethod::Vng4,
    DemosaicMethod::Fast,
];

#[test]
fn valid_domain_input_matches_the_direct_kernel() {
    // No negative sample and a peak below the clip level: no pedestal, and
    // the scale is 65535.
    let (w, h) = (96, 80);
    let mut seed = 7;
    let data: Vec<f32> = (0..w * h).map(|_| 0.45 + 0.4 * noise(&mut seed)).collect();
    let direct: Vec<f32> = data
        .iter()
        .map(|v| (f64::from(*v) * 65535.) as f32)
        .collect();
    for method in COLOR_METHODS {
        let ours = run(method, (w, h), data.clone(), true);
        let (code, planes) = kernel(method, (w, h), &direct, RGGB, 1., &AtomicBool::new(false));
        assert_eq!(code, 0);
        for i in 0..w * h {
            for c in 0..3 {
                let expected = f64::from(planes[c * w * h + i]) / 65535.;
                assert!(
                    (f64::from(ours[i * 3 + c]) - expected).abs() < 1e-6,
                    "{method:?} at {i}"
                );
            }
        }
    }
}

#[test]
fn dark_frame_noise_keeps_its_mean_with_the_pedestal() {
    // Black-subtracted read noise around a small mean: many sites are
    // negative. The pedestal keeps them; clamping them to zero, as the
    // kernels do without a pedestal, biases the mean upward.
    let (w, h) = (128, 128);
    let (mean, sigma) = (0.002f32, 0.01f32);
    let mut seed = 11;
    let data: Vec<f32> = (0..w * h)
        .map(|_| mean + sigma * noise(&mut seed))
        .collect();
    let interior = |out: &[f32]| {
        let mut sum = [0f64; 3];
        let mut n = 0.;
        for y in 8..h - 8 {
            for x in 8..w - 8 {
                for c in 0..3 {
                    sum[c] += f64::from(out[(y * w + x) * 3 + c]);
                }
                n += 1.;
            }
        }
        sum.map(|s| s / n)
    };
    let clamped: Vec<f32> = data.iter().map(|v| v.max(0.)).collect();
    for method in COLOR_METHODS {
        let ours = interior(&run(method, (w, h), data.clone(), true));
        let upstream = interior(&run(method, (w, h), clamped.clone(), true));
        // Without negative samples there is no pedestal: the difference is
        // how much the result depends on the pedestal.
        let lifted: Vec<f32> = data.iter().map(|v| v + 0.02).collect();
        let lifted = interior(&run(method, (w, h), lifted, true)).map(|m| m - 0.02);
        let bias = ours.map(|m| m - f64::from(mean));
        let clamp_bias = upstream.map(|m| m - f64::from(mean));
        let shift: Vec<f64> = (0..3).map(|c| lifted[c] - ours[c]).collect();
        println!("{method:?}: bias {bias:?} clamp bias {clamp_bias:?} pedestal shift {shift:?}");
        for c in 0..3 {
            assert!(
                bias[c].abs() < 0.1 * f64::from(sigma),
                "{method:?} {bias:?}"
            );
            assert!(bias[c].abs() < clamp_bias[c].abs(), "{method:?}");
            assert!(
                shift[c].abs() < 0.1 * f64::from(sigma),
                "{method:?} {shift:?}"
            );
        }
    }
}

type Scene = fn(usize, usize) -> [f32; 3];

/// The largest relative error per distance from the image edge, up to 11.
fn edge_rings(out: &[f32], (w, h): (usize, usize), scene: Scene) -> [f64; 12] {
    let mut rings = [0f64; 12];
    for y in 0..h {
        for x in 0..w {
            let d = y.min(x).min(h - 1 - y).min(w - 1 - x).min(11);
            for (c, t) in scene(y, x).into_iter().enumerate() {
                let err = f64::from((out[(y * w + x) * 3 + c] - t).abs()) / f64::from(t.abs());
                rings[d] = rings[d].max(err);
            }
        }
    }
    rings
}

#[test]
fn flat_fields_are_exact_to_the_edge_including_hdr_and_negative() {
    // A flat field has no detail, so every method must return it, in each
    // channel and up to the edge. This covers the border bands of LMMSE,
    // IGV, and DCB, float values far above one, and signed values.
    let scenes: [Scene; 3] = [
        |_, _| [0.3, 0.2, 0.1],
        |_, _| [6., 3., 1.5],
        |_, _| [-0.04, -0.02, -0.01],
    ];
    for scene in scenes {
        for method in COLOR_METHODS {
            let (w, h) = (96, 80);
            let out = run(method, (w, h), mosaic(w, h, &scene), false);
            let rings = edge_rings(&out, (w, h), scene);
            let worst = rings.iter().copied().fold(0., f64::max);
            println!(
                "{:?} {method:?}: worst relative error {worst:.1e}",
                scene(0, 0)
            );
            // A signed field puts its red sites at the domain floor. AMaZE
            // divides by sample values there, and DCB has thresholds, so
            // neither is exact; the bounds record the measured error.
            let limit = match (method, scene(0, 0)[0] < 0.) {
                (DemosaicMethod::Amaze, true) => 1e-3,
                (DemosaicMethod::Dcb, true) => 1e-4,
                _ => 1e-5,
            };
            assert!(worst < limit, "{:?} {method:?}: {rings:?}", scene(0, 0));
        }
    }
}

#[test]
fn ramps_follow_each_method_model() {
    let (w, h) = (96, 96);
    let neutral: Scene = |y, x| [0.05 + 0.006 * x as f32 + 0.003 * y as f32; 3];
    let hue: Scene = |y, x| {
        let l = 0.1 + 0.006 * x as f32 + 0.002 * y as f32;
        [0.9 * l, 0.6 * l, 0.3 * l]
    };
    for method in COLOR_METHODS {
        // Within 4 pixels of the edge, the kernels interpolate one-sided or
        // from mirrored data; compare from there.
        let interior = |scene: Scene| {
            let rings = edge_rings(
                &run(method, (w, h), mosaic(w, h, &scene), false),
                (w, h),
                scene,
            );
            rings[4..].iter().copied().fold(0., f64::max)
        };
        let (n, c) = (interior(neutral), interior(hue));
        println!("{method:?}: neutral ramp {n:.1e}, constant-hue ramp {c:.1e}");
        // Without chroma, every method interpolates a plane exactly. LMMSE
        // filters in a gamma domain, where the ramp is not a plane.
        let limit = if method == DemosaicMethod::Lmmse {
            1e-3
        } else {
            1e-4
        };
        assert!(n < limit, "{method:?} neutral {n}");
        // Linear color-difference methods are exact on a plane of color.
        // The adaptive methods (AMaZE, DCB, IGV, LMMSE, VNG4) choose among
        // directions by gradient thresholds, and AMaZE also near the edge
        // mirrors the ramp; they are not exact, and these bounds record them.
        let limit = match method {
            DemosaicMethod::Fast
            | DemosaicMethod::Ahd
            | DemosaicMethod::Eahd
            | DemosaicMethod::Hphd => 1e-4,
            DemosaicMethod::Amaze => 0.02,
            _ => 0.015,
        };
        assert!(c < limit, "{method:?} hue {c}");
    }
}

#[test]
fn dead_sites_and_the_pedestal() {
    // A dead site is black: -black / (white - black) after normalization,
    // here -0.06 in a dim noisy scene. Up to `floor_rank` such sites clamp
    // to the floor and do not set the pedestal. More of them set a pedestal
    // of 0.06. Adaptive kernels reorder noise far from any change, so this
    // compares, away from the sites, the mean change (bias) and the RMS
    // change in units of the input noise.
    let (w, h) = (96, 96);
    let sigma = 0.02 / 3f64.sqrt();
    let mut seed = 13;
    let data: Vec<f32> = (0..w * h).map(|_| 0.05 + 0.02 * noise(&mut seed)).collect();
    let rank = floor_rank(w * h);
    let mut failed = Vec::new();
    for method in COLOR_METHODS {
        let base = run(method, (w, h), data.clone(), true);
        let mut stats = Vec::new();
        for count in [rank, rank + 1] {
            let mut dead = data.clone();
            let sites: Vec<(usize, usize)> = (0..count)
                .map(|i| (8 + i / 16 * 2, 8 + i % 16 * 5))
                .collect();
            for &(y, x) in &sites {
                dead[y * w + x] = -0.06;
            }
            let out = run(method, (w, h), dead, true);
            let near = method.highlight_radius() + 2;
            let (mut sum, mut squares, mut n) = (0f64, 0f64, 0f64);
            for y in 0..h {
                for x in 0..w {
                    if sites
                        .iter()
                        .any(|&(sy, sx)| y.abs_diff(sy).max(x.abs_diff(sx)) <= near)
                    {
                        continue;
                    }
                    for c in 0..3 {
                        let i = (y * w + x) * 3 + c;
                        let d = f64::from(out[i] - base[i]);
                        sum += d;
                        squares += d * d;
                        n += 1.;
                    }
                }
            }
            stats.push((sum / n / sigma, (squares / n).sqrt() / sigma));
        }
        println!(
            "{method:?}: away from dead sites, bias and RMS change in noise units: {rank} sites {:.1e} {:.1e}, {} sites (pedestal 0.06) {:.1e} {:.1e}",
            stats[0].0, stats[0].1, rank + 1, stats[1].0, stats[1].1
        );
        if stats[0].0.abs() > 0.01 || stats[1].0.abs() > 0.05 {
            failed.push(method);
        }
    }
    assert!(failed.is_empty(), "{failed:?}");
}

#[test]
fn non_finite_samples_are_errors() {
    for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        let mut data = vec![0.5f32; 64 * 64];
        data[100] = bad;
        let err = native(
            DemosaicMethod::Amaze,
            data,
            &[0; 64 * 64],
            (64, 64),
            RGGB,
            &unit(),
            0.,
            false,
            &AtomicBool::new(false),
        )
        .err();
        assert_eq!(err.as_deref(), Some("The DNG has non-finite samples"));
    }
}

#[test]
fn highlight_radius_covers_kernels() {
    // A clipped site changes output pixels around it. The highlight mask
    // must reach all changes above 0.5 % of the step at the clipped site.
    let (w, h) = (96, 96);
    let mut seed = 3;
    let base: Vec<f32> = (0..w * h).map(|_| 0.3 + 0.05 * noise(&mut seed)).collect();
    let mut failed = Vec::new();
    for method in COLOR_METHODS {
        let before = run(method, (w, h), base.clone(), true);
        let mut reach = [0; 3];
        // Red, green, and blue sites.
        for (sy, sx) in [(48, 48), (48, 49), (49, 49)] {
            let mut data = base.clone();
            let step = 1. - data[sy * w + sx];
            data[sy * w + sx] = 1.;
            let after = run(method, (w, h), data, true);
            for y in 0..h {
                for x in 0..w {
                    let i = (y * w + x) * 3;
                    let change = (0..3)
                        .map(|c| (after[i + c] - before[i + c]).abs() / step)
                        .fold(0., f32::max);
                    for (k, limit) in [1e-3, 5e-3, 2e-2].into_iter().enumerate() {
                        if change > limit {
                            reach[k] = reach[k].max(y.abs_diff(sy).max(x.abs_diff(sx)));
                        }
                    }
                }
            }
        }
        println!("{method:?}: clipped site reach at 0.1, 0.5, 2 % of the step {reach:?}");
        if reach[1] > method.highlight_radius() {
            failed.push((method, reach));
        }
    }
    assert!(failed.is_empty(), "{failed:?}");
}

/// Counts its calls and asks the kernel to stop.
extern "C" fn stop_counting(context: *mut c_void) -> c_int {
    // SAFETY: the test passes an AtomicUsize.
    let calls = unsafe { &*(context as *const std::sync::atomic::AtomicUsize) };
    calls.fetch_add(1, Ordering::Relaxed);
    1
}

#[test]
fn native_kernels_stop_at_their_first_progress_point() {
    // A stopped kernel leaves most of its output unwritten, and asks a few
    // times only. The patches free all buffers on this path.
    let (w, h) = (2048, 2048);
    let data = vec![30000f32; w * h];
    let rgb_cam = [[1f32, 0., 0.], [0., 1., 0.], [0., 0., 1.]];
    for method in COLOR_METHODS {
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let mut out = vec![0f32; w * h * 3];
        // SAFETY: the buffers have the sizes that the shim reads and writes.
        let code = unsafe {
            ffi::x3fdng_rt_demosaic(
                method.index(),
                w as c_int,
                h as c_int,
                data.as_ptr(),
                out.as_mut_ptr(),
                RGGB.as_ptr(),
                rgb_cam.as_ptr(),
                1.,
                stop_counting,
                &calls as *const _ as *mut c_void,
            )
        };
        assert_eq!(code, 0);
        let written = out[w * h..2 * w * h].iter().filter(|v| **v != 0.).count();
        let calls = calls.into_inner();
        println!(
            "{method:?}: {calls} calls, green written {:.1} %",
            100. * written as f64 / (w * h) as f64
        );
        // At the start, at the stop, at the end, and before a border band.
        assert!(calls <= 4, "{method:?}: {calls} calls");
        assert!(written * 2 < w * h, "{method:?}: {written} written");
    }
}

#[test]
#[ignore = "timing: run with --ignored --nocapture"]
fn native_kernel_timing() {
    let (w, h) = (4000, 3000);
    let mut seed = 5;
    let data: Vec<f32> = (0..w * h)
        .map(|_| 30000. + 20000. * noise(&mut seed))
        .collect();
    for method in COLOR_METHODS {
        let start = std::time::Instant::now();
        let (code, _) = kernel(method, (w, h), &data, RGGB, 1., &AtomicBool::new(false));
        let full = start.elapsed();
        let cancel = AtomicBool::new(false);
        let start = std::time::Instant::now();
        let (stopped, _) = std::thread::scope(|scope| {
            scope.spawn(|| {
                std::thread::sleep(full / 4);
                cancel.store(true, Ordering::Relaxed);
            });
            kernel(method, (w, h), &data, RGGB, 1., &cancel)
        });
        let latency = start.elapsed().saturating_sub(full / 4);
        assert_eq!((code, stopped), (0, 0));
        println!("{method:?} 12 MP: full {full:.2?}, stop latency after cancel {latency:.2?}");
    }
}
