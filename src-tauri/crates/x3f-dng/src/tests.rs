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
    assert!(px[1] > 1.2, "{px:?}");
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
