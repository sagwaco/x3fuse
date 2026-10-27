//! DNG input for X3Fuse through bundled LibRaw 0.22.2.
//!
//! LibRaw parses the file and decodes the samples. This crate owns the
//! normalization and color: black and per-sample white levels, OpcodeList2
//! and OpcodeList3 GainMaps, as-shot white balance, the DNG color matrices,
//! and BaselineExposure. LibRaw also demosaics color filter arrays, in the
//! camera color space and without scaling.
//!
//! `prepare_with_method` can demosaic a 2x2 Bayer array with a native float
//! method instead: the librtprocess kernels, or a port of RawTherapee EAHD.
//! See `Domain` for the float range of these kernels.
//!
//! Opcodes: OpcodeList2 GainMap, and OpcodeList3 GainMap and WarpRectilinear.
//! Optional opcodes of other kinds are skipped.
//!
//! Supported: DNG files with a color filter array of three colors (Bayer,
//! X-Trans, and other patterns that LibRaw demosaics), three-sample LinearRaw,
//! and one-sample monochrome, with uncompressed, lossless JPEG, Deflate,
//! lossy JPEG, or floating-point samples. Not supported, with an error:
//! JPEG XL and VC-5 compression (they need the Adobe DNG SDK), four-color
//! arrays, images above `MAX_PIXELS`, and required opcodes other than those. DefaultScale resamples to square pixels.
//! Floating-point arrays are demosaiced at 16 bits relative to their peak. LibRaw reads
//! BlackLevelDeltaH and BlackLevelDeltaV as their mean. AsShotWhiteXY is
//! used through LibRaw's multipliers for color filter arrays only.

mod color;
mod opcode;

use std::{
    ffi::{c_char, c_int, c_void, CStr},
    path::Path,
    ptr::NonNull,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

use opcode::Opcode;
// LibRaw calls these C libraries; the imports make Cargo link them.
use libz_sys as _;
use mozjpeg_sys as _;

/// The bundled decoder and the adapter revision. Change the revision when a
/// change can alter decoded pixels or metadata.
pub const DECODER_VERSION: &str = "LibRaw 0.22.2, librtprocess 9a85827, x3f-dng 4";
/// The largest active area, in pixels. A color image of this size needs
/// about 23 bytes per pixel while it is prepared.
pub const MAX_PIXELS: u64 = 160_000_000;
/// The longest edge of a `preview` JPEG.
pub const PREVIEW_MAX_EDGE: u32 = 1600;
/// The LibRaw limit for one raw buffer.
const MAX_RAW_MEMORY_MB: u32 = 4096;
/// A normalized integer sample at or above this level is clipped.
const SATURATION: f32 = 0.999;
/// The 16-bit demosaic input keeps negative noise above this offset.
const DEMOSAIC_OFFSET: f32 = 1024.;
/// The shortest edge for a native method. AMaZE mirrors 32 rows and columns
/// at each image edge, and IGV and LMMSE need borders of 8 or more pixels.
pub const MIN_NATIVE_EDGE: u32 = 64;
/// The largest active area for a native method, in pixels: 61 MP sensors
/// with a margin. A native method needs up to about 48 bytes per pixel
/// while it runs (IGV), or 3 GB at this limit; see `native`.
pub const MAX_NATIVE_PIXELS: u64 = 64_000_000;

/// A native float demosaic method for 2x2 Bayer arrays. The tuning is fixed
/// at the RawTherapee 5.13 defaults: DCB 2 iterations with enhancement,
/// LMMSE 2 iterations.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DemosaicMethod {
    Amaze,
    Dcb,
    Ahd,
    Eahd,
    Hphd,
    Igv,
    Lmmse,
    Vng4,
    /// No demosaic: each site keeps its own sample as gray, without white
    /// balance or a color matrix.
    Mono,
    Fast,
}

impl DemosaicMethod {
    /// The method number in demosaic.cpp. Mono has none.
    fn index(self) -> c_int {
        match self {
            Self::Amaze => 0,
            Self::Dcb => 1,
            Self::Ahd => 2,
            Self::Eahd => 3,
            Self::Hphd => 4,
            Self::Igv => 5,
            Self::Lmmse => 6,
            Self::Vng4 => 7,
            Self::Fast => 8,
            Self::Mono => -1,
        }
    }

    /// How far a clipped CFA site changes output pixels by more than 0.5 %
    /// of its step, in pixels. The highlight mask grows by this radius.
    /// `highlight_radius_covers_kernels` measures it.
    fn highlight_radius(self) -> usize {
        match self {
            Self::Mono => 0,
            Self::Vng4 => 3,
            Self::Fast => 4,
            Self::Ahd => 5,
            Self::Eahd => 6,
            Self::Amaze | Self::Lmmse => 8,
            Self::Hphd => 9,
            Self::Igv => 13,
            Self::Dcb => 17,
        }
    }
}

/// Metadata of a DNG that this crate can prepare.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DngInfo {
    /// Active-area width, before orientation.
    pub width: u32,
    /// Active-area height, before orientation.
    pub height: u32,
    /// EXIF orientation, 1 through 8.
    pub orientation: u16,
    /// DefaultCrop with DefaultUserCrop, as normalized `[x, y, width, height]`
    /// of the oriented active area. None is the full active area.
    pub as_shot_crop: Option<[f32; 4]>,
    /// One sample per pixel. White balance does not apply.
    pub monochrome: bool,
    /// A 2x2 Bayer array of a size that the native methods accept, from
    /// `MIN_NATIVE_EDGE` to `MAX_NATIVE_PIXELS`. Only then can
    /// `prepare_with_method` use a `DemosaicMethod` other than Mono.
    pub bayer: bool,
    /// EXIF ISO speed. None when it is absent, zero, or not finite.
    pub iso: Option<f32>,
}

mod ffi {
    use super::*;

    pub const CBLACK_SIZE: usize = 4104;

    #[repr(C)]
    pub struct Color {
        pub illuminant: u32,
        pub calibration: [[f32; 4]; 4],
        pub color_matrix: [[f32; 3]; 4],
        pub forward_matrix: [[f32; 4]; 3],
    }

    #[repr(C)]
    pub struct Info {
        pub dng_version: c_int,
        pub is_raw: c_int,
        pub is_float: c_int,
        pub decoder_supported: c_int,
        pub filters: u32,
        pub colors: c_int,
        pub raw_width: u32,
        pub raw_height: u32,
        pub width: u32,
        pub height: u32,
        pub top_margin: u32,
        pub left_margin: u32,
        pub flip: c_int,
        pub pixel_aspect: f32,
        pub crops: [[u32; 4]; 2],
        pub white_level: [u32; 4],
        pub as_shot_neutral: [f32; 4],
        pub analog_balance: [f32; 4],
        pub baseline_exposure: f32,
        pub cam_mul: [f32; 4],
        pub iso: f32,
        pub color: [Color; 2],
        pub opcodes: [*const u8; 3],
        pub opcode_len: [u32; 3],
        pub cfa: [[u8; 24]; 24],
    }

    #[repr(C)]
    pub struct Raw {
        pub data: *mut c_void,
        pub pitch: u32,
        pub samples: u32,
        pub is_float: c_int,
        pub raw_width: u32,
        pub raw_height: u32,
        pub top_margin: u32,
        pub left_margin: u32,
        pub black: u32,
        pub cblack: [u32; CBLACK_SIZE],
        pub maximum: u32,
    }

    #[repr(C)]
    pub struct Image {
        pub data: *const [u16; 4],
        pub width: u32,
        pub height: u32,
    }

    extern "C" {
        pub fn x3fdng_new(max_raw_memory_mb: u32) -> *mut c_void;
        pub fn x3fdng_free(handle: *mut c_void);
        pub fn x3fdng_cancel(handle: *mut c_void);
        pub fn x3fdng_strerror(code: c_int) -> *const c_char;
        #[cfg(windows)]
        pub fn x3fdng_open(handle: *mut c_void, path: *const u16) -> c_int;
        #[cfg(not(windows))]
        pub fn x3fdng_open(handle: *mut c_void, path: *const c_char) -> c_int;
        pub fn x3fdng_read_info(handle: *mut c_void, out: *mut Info) -> c_int;
        pub fn x3fdng_unpack(handle: *mut c_void, out: *mut Raw) -> c_int;
        pub fn x3fdng_float_to_int(handle: *mut c_void, out: *mut Raw) -> c_int;
        pub fn x3fdng_demosaic(handle: *mut c_void, half_size: c_int, out: *mut Image) -> c_int;
        #[allow(clippy::too_many_arguments)]
        pub fn x3fdng_rt_demosaic(
            method: c_int,
            width: c_int,
            height: c_int,
            mosaic: *const f32,
            out: *mut f32,
            cfa: *const [u8; 2],
            rgb_cam: *const [f32; 3],
            init_gain: f64,
            cancelled: extern "C" fn(*mut c_void) -> c_int,
            context: *mut c_void,
        ) -> c_int;
        #[cfg(test)]
        pub fn x3fdng_sizes(which: c_int) -> usize;
    }
}

/// One LibRaw instance. LibRaw owns all decoded buffers until drop.
struct Handle(NonNull<c_void>);

impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: the pointer came from x3fdng_new and is freed once.
        unsafe { ffi::x3fdng_free(self.0.as_ptr()) }
    }
}

struct CancelTarget(*mut c_void);
// SAFETY: LibRaw sets its cancel flag with an atomic operation.
unsafe impl Send for CancelTarget {}

const CANCELLED: &str = "Cancelled";

fn check(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        Err(CANCELLED.into())
    } else {
        Ok(())
    }
}

impl Handle {
    fn new() -> Result<Self, String> {
        // SAFETY: plain constructor; null means allocation failure.
        NonNull::new(unsafe { ffi::x3fdng_new(MAX_RAW_MEMORY_MB) })
            .map(Self)
            .ok_or_else(|| "Not enough memory to decode the DNG".into())
    }

    /// Run one LibRaw call while a watcher forwards cancellation into it.
    fn call(
        &self,
        cancel: &AtomicBool,
        f: impl FnOnce(*mut c_void) -> c_int,
    ) -> Result<(), String> {
        check(cancel)?;
        let done = AtomicBool::new(false);
        let target = CancelTarget(self.0.as_ptr());
        let code = std::thread::scope(|scope| {
            let done = &done;
            let watcher = scope.spawn(move || {
                let target = target;
                while !done.load(Ordering::Acquire) {
                    if cancel.load(Ordering::Relaxed) {
                        // SAFETY: the scope ends before the handle can drop.
                        unsafe { ffi::x3fdng_cancel(target.0) };
                        return;
                    }
                    std::thread::park_timeout(Duration::from_millis(10));
                }
            });
            let code = f(self.0.as_ptr());
            done.store(true, Ordering::Release);
            watcher.thread().unpark();
            code
        });
        check(cancel)?;
        if code == 0 {
            return Ok(());
        }
        // SAFETY: LibRaw and the shim return static strings.
        let message = unsafe { CStr::from_ptr(ffi::x3fdng_strerror(code)) };
        Err(format!("DNG decode failed: {}", message.to_string_lossy()))
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Layout {
    Cfa,
    Linear,
    Mono,
}

struct Opened {
    handle: Handle,
    info: Box<ffi::Info>,
    layout: Layout,
}

fn open(path: &Path, cancel: &AtomicBool) -> Result<Opened, String> {
    let handle = Handle::new()?;
    #[cfg(windows)]
    let encoded: Vec<u16> = {
        use std::os::windows::ffi::OsStrExt;
        path.as_os_str().encode_wide().chain([0]).collect()
    };
    #[cfg(not(windows))]
    let encoded = {
        use std::os::unix::ffi::OsStrExt;
        std::ffi::CString::new(path.as_os_str().as_bytes())
            .map_err(|_| "The DNG path contains a NUL character")?
    };
    // SAFETY: the path outlives the call; LibRaw copies it.
    handle.call(cancel, |h| unsafe { ffi::x3fdng_open(h, encoded.as_ptr()) })?;
    // SAFETY: Info is plain data that the shim fills completely.
    let mut info: Box<ffi::Info> = Box::new(unsafe { std::mem::zeroed() });
    handle.call(cancel, |h| unsafe { ffi::x3fdng_read_info(h, &mut *info) })?;
    let layout = layout(&info)?;
    Ok(Opened {
        handle,
        info,
        layout,
    })
}

fn layout(info: &ffi::Info) -> Result<Layout, String> {
    if info.dng_version == 0 {
        return Err("The file is not a DNG".into());
    }
    if info.is_raw == 0 {
        return Err("The DNG has no raw image".into());
    }
    if info.decoder_supported == 0 {
        return Err(
            "This DNG compression (JPEG XL or VC-5) needs the Adobe DNG SDK, which X3Fuse does not include"
                .into(),
        );
    }
    let layout = match (info.filters, info.colors) {
        (0, 1) => Layout::Mono,
        (0, 3) => Layout::Linear,
        (f, 3) if f != 0 => Layout::Cfa,
        (f, 4) if f != 0 => return Err("Four-color filter array DNG is not supported".into()),
        (_, colors) => return Err(format!("DNG with {colors} color channels is not supported")),
    };
    let aspect = info.pixel_aspect;
    if !(0.1..=10.).contains(&aspect) {
        return Err("The DNG DefaultScale is invalid".into());
    }
    let (w, h) = stretched(info.width as usize, info.height as usize, aspect);
    let pixels = u64::from(info.width).max(w as u64) * u64::from(info.height).max(h as u64);
    if info.width == 0 || info.height == 0 || pixels > MAX_PIXELS {
        return Err(format!(
            "The DNG image size {}x{} is outside the supported limit of {MAX_PIXELS} pixels",
            info.width, info.height
        ));
    }
    if info.left_margin + info.width > info.raw_width
        || info.top_margin + info.height > info.raw_height
    {
        return Err("The DNG active area is outside the image".into());
    }
    Ok(layout)
}

/// Square-pixel size for DefaultScale, rounded as LibRaw does. LibRaw keeps
/// the horizontal / vertical scale ratio as `pixel_aspect`.
fn stretched(width: usize, height: usize, aspect: f32) -> (usize, usize) {
    if (aspect - 1.).abs() <= 1e-3 {
        (width, height)
    } else if aspect < 1. {
        (width, (height as f32 / aspect).round() as usize)
    } else {
        (((width as f32) * aspect).round() as usize, height)
    }
}

/// LibRaw flip to EXIF orientation.
fn orientation(flip: c_int) -> u16 {
    match flip {
        1 => 2,
        2 => 4,
        3 => 3,
        4 => 5,
        5 => 8,
        6 => 6,
        7 => 7,
        _ => 1,
    }
}

/// A normalized `[x0, y0, x1, y1]` rectangle of the stored image, oriented.
fn orient_rect([x0, y0, x1, y1]: [f32; 4], orientation: u16) -> [f32; 4] {
    let map = |x: f32, y: f32| match orientation {
        2 => (1. - x, y),
        3 => (1. - x, 1. - y),
        4 => (x, 1. - y),
        5 => (y, x),
        6 => (1. - y, x),
        7 => (1. - y, 1. - x),
        8 => (y, 1. - x),
        _ => (x, y),
    };
    let (a, b) = (map(x0, y0), map(x1, y1));
    let (left, top) = (a.0.min(b.0), a.1.min(b.1));
    [left, top, a.0.max(b.0) - left, a.1.max(b.1) - top]
}

fn as_shot_crop(info: &ffi::Info) -> Option<[f32; 4]> {
    // LibRaw stores DefaultCrop in the first entry and the DefaultUserCrop
    // result in the second, in raw-frame pixels. 0xffff marks no crop.
    let [left, top, width, height] = info
        .crops
        .iter()
        .rev()
        .find(|c| c[0] != 0xffff && c[1] != 0xffff && c[2] > 0 && c[3] > 0)?
        .map(|v| v as f32);
    let (aw, ah) = (info.width as f32, info.height as f32);
    let x0 = ((left - info.left_margin as f32) / aw).clamp(0., 1.);
    let y0 = ((top - info.top_margin as f32) / ah).clamp(0., 1.);
    let x1 = ((left + width - info.left_margin as f32) / aw).clamp(0., 1.);
    let y1 = ((top + height - info.top_margin as f32) / ah).clamp(0., 1.);
    if x1 - x0 <= 0. || y1 - y0 <= 0. || (x0 <= 0. && y0 <= 0. && x1 >= 1. && y1 >= 1.) {
        return None;
    }
    Some(orient_rect([x0, y0, x1, y1], orientation(info.flip)))
}

/// Read metadata only. Fails for files that are not DNG, by content.
/// It also rejects color and opcode metadata that `prepare` cannot use.
pub fn inspect(path: &Path, cancel: &AtomicBool) -> Result<DngInfo, String> {
    let opened = open(path, cancel)?;
    let info = &opened.info;
    calibration(&opened)?;
    opcode_lists(info)?;
    let (width, height) = stretched(info.width as usize, info.height as usize, info.pixel_aspect);
    Ok(DngInfo {
        width: width as u32,
        height: height as u32,
        orientation: orientation(info.flip),
        as_shot_crop: as_shot_crop(info),
        monochrome: opened.layout == Layout::Mono,
        bayer: native_cfa(&opened).is_ok(),
        iso: iso(info.iso),
    })
}

/// LibRaw ISO speed, if it is finite and positive.
fn iso(v: f32) -> Option<f32> {
    (v.is_finite() && v > 0.).then_some(v)
}

/// The 2x2 pattern of a Bayer array in LibRaw colors, where 3 is the second
/// green. The whole 24x24 CFA table must repeat it.
fn bayer_pattern(info: &ffi::Info) -> Option<[[u8; 2]; 2]> {
    let p = [
        [info.cfa[0][0], info.cfa[0][1]],
        [info.cfa[1][0], info.cfa[1][1]],
    ];
    let periodic = (0..24).all(|r| (0..24).all(|c| info.cfa[r][c] == p[r % 2][c % 2]));
    let green = |v: u8| v == 1 || v == 3;
    let sites = p.concat();
    let count = |c: u8| sites.iter().filter(|v| **v == c).count();
    // One red, one blue, and two greens on a diagonal.
    let bayer = count(0) == 1
        && count(2) == 1
        && green(p[0][0]) == green(p[1][1])
        && green(p[0][1]) == green(p[1][0])
        && green(p[0][0]) != green(p[0][1]);
    (periodic && bayer).then_some(p)
}

/// The CFA for a native method, with two distinct greens for VNG4. The
/// green on the blue row becomes 3 when LibRaw gives both greens one color.
fn native_cfa(opened: &Opened) -> Result<[[u8; 2]; 2], String> {
    let info = &opened.info;
    let mut p = match (opened.layout, bayer_pattern(info)) {
        (Layout::Cfa, Some(p)) => p,
        _ => {
            return Err(
                "A native demosaic method needs a DNG with a 2x2 Bayer color filter array".into(),
            )
        }
    };
    let (w, h) = (info.width, info.height);
    if w < MIN_NATIVE_EDGE || h < MIN_NATIVE_EDGE || u64::from(w) * u64::from(h) > MAX_NATIVE_PIXELS
    {
        return Err(format!(
            "A native demosaic method needs an image from {MIN_NATIVE_EDGE} pixels per edge to \
             {MAX_NATIVE_PIXELS} pixels; this DNG is {w}x{h}"
        ));
    }
    let greens: Vec<(usize, usize)> = (0..4)
        .map(|i| (i / 2, i % 2))
        .filter(|&(r, c)| p[r][c] == 1 || p[r][c] == 3)
        .collect();
    let (a, b) = (greens[0], greens[1]);
    if p[a.0][a.1] == p[b.0][b.1] {
        let blue_row = (0..2).find(|&r| p[r].contains(&2)).unwrap_or(1);
        for (r, c) in [a, b] {
            p[r][c] = if r == blue_row { 3 } else { 1 };
        }
    }
    Ok(p)
}

fn baseline_exposure(info: &ffi::Info) -> f64 {
    // LibRaw marks an absent BaselineExposure with -999.
    let ev = f64::from(info.baseline_exposure);
    if ev.is_finite() && ev.abs() < 100. {
        ev
    } else {
        0.
    }
}

fn calibration(opened: &Opened) -> Result<color::Calibration, String> {
    let info = &opened.info;
    if opened.layout == Layout::Mono {
        return Ok(color::monochrome(baseline_exposure(info)));
    }
    let m3 = |rows: &dyn Fn(usize, usize) -> f32| -> color::M3 {
        std::array::from_fn(|i| f64::from(rows(i / 3, i % 3)))
    };
    let neutral = info.as_shot_neutral[..3].iter().map(|v| f64::from(*v));
    let neutral: [f64; 3] = std::array::from_fn(|i| neutral.clone().nth(i).unwrap());
    let as_shot_neutral = if neutral.iter().all(|v| *v > 0.) {
        Some(neutral)
    } else if opened.layout == Layout::Cfa && info.cam_mul[..3].iter().all(|v| *v > 0.) {
        Some(std::array::from_fn(|i| 1. / f64::from(info.cam_mul[i])))
    } else {
        None
    };
    color::DngColor {
        illuminants: info.color.each_ref().map(|c| c.illuminant),
        color_matrix: info
            .color
            .each_ref()
            .map(|c| m3(&|r, k| c.color_matrix[r][k])),
        calibration: info
            .color
            .each_ref()
            .map(|c| m3(&|r, k| c.calibration[r][k])),
        forward_matrix: info
            .color
            .each_ref()
            .map(|c| m3(&|r, k| c.forward_matrix[r][k])),
        analog_balance: std::array::from_fn(|i| match info.analog_balance[i] {
            v if v > 0. && v.is_finite() => f64::from(v),
            _ => 1.,
        }),
        as_shot_neutral,
        baseline_exposure: baseline_exposure(info),
    }
    .calibration()
}

fn opcode_lists(info: &ffi::Info) -> Result<[Vec<Opcode>; 3], String> {
    let lists: [Result<Vec<Opcode>, String>; 3] = std::array::from_fn(|i| {
        let data = match (info.opcodes[i].is_null(), info.opcode_len[i]) {
            (false, n) if n > 0 => {
                // SAFETY: LibRaw owns `n` bytes of the list until the handle drops.
                unsafe { std::slice::from_raw_parts(info.opcodes[i], n as usize) }
            }
            _ => &[],
        };
        opcode::parse(data, i as u32 + 1)
    });
    let [one, two, three] = lists;
    if !one?.is_empty() {
        return Err("DNG OpcodeList1 GainMap and WarpRectilinear are not supported".into());
    }
    Ok([Vec::new(), two?, three?])
}

/// Integer or float samples of one LibRaw buffer.
struct Samples<'a> {
    raw: &'a ffi::Raw,
    elem: usize,
}

impl Samples<'_> {
    fn get(&self, row: usize, col: usize, s: usize) -> f32 {
        let r = self.raw;
        let offset = (r.top_margin as usize + row) * r.pitch as usize
            + ((r.left_margin as usize + col) * r.samples as usize + s) * self.elem;
        // SAFETY: `validate` checked that every active sample is in bounds.
        unsafe {
            let p = (r.data as *const u8).add(offset);
            if r.is_float != 0 {
                (p as *const f32).read_unaligned()
            } else {
                f32::from((p as *const u16).read_unaligned())
            }
        }
    }
}

fn validate(raw: &ffi::Raw, info: &ffi::Info, layout: Layout) -> Result<(), String> {
    let samples_ok = match layout {
        Layout::Cfa | Layout::Mono => raw.samples == 1,
        Layout::Linear => raw.samples >= 3,
    };
    let elem = if raw.is_float != 0 { 4 } else { 2 };
    let row_bytes = (raw.left_margin as u64 + info.width as u64) * raw.samples as u64 * elem;
    let pattern = raw.cblack[4] as usize * raw.cblack[5] as usize;
    if !samples_ok
        || raw.data.is_null()
        || raw.top_margin + info.height > raw.raw_height
        || raw.left_margin + info.width > raw.raw_width
        || u64::from(raw.pitch) < row_bytes
        || pattern > ffi::CBLACK_SIZE - 6
    {
        return Err("LibRaw returned an unexpected DNG sample layout".into());
    }
    Ok(())
}

/// Scene-linear camera image, white balanced: camera value / neutral.
struct Balanced {
    data: Vec<f32>,
    width: usize,
    height: usize,
    /// Per pixel, the highlight blend weight from 0 to 255, before gain maps.
    highlights: Vec<u8>,
    /// Image pixel size in opcode pixels.
    step: usize,
}

fn decode(
    path: &Path,
    cancel: &AtomicBool,
    half_size: bool,
    method: Option<DemosaicMethod>,
) -> Result<(Balanced, color::Calibration, u16), String> {
    let opened = open(path, cancel)?;
    let info = &opened.info;
    // Mono of a monochrome DNG is its usual one-sample route.
    let cfa_pattern = match (method, opened.layout) {
        (None, _) | (Some(DemosaicMethod::Mono), Layout::Mono) => None,
        _ => Some(native_cfa(&opened)?),
    };
    let cal = match method {
        Some(DemosaicMethod::Mono) => color::monochrome(baseline_exposure(info)),
        _ => calibration(&opened)?,
    };
    let lists = opcode_lists(info)?;
    // SAFETY: Raw is plain data that the shim fills on success.
    let mut raw: Box<ffi::Raw> = Box::new(unsafe { std::mem::zeroed() });
    opened
        .handle
        .call(cancel, |h| unsafe { ffi::x3fdng_unpack(h, &mut *raw) })?;
    validate(&raw, info, opened.layout)?;
    let (width, height) = (info.width as usize, info.height as usize);
    let samples = Samples {
        raw: &raw,
        elem: if raw.is_float != 0 { 4 } else { 2 },
    };
    let planes = if opened.layout == Layout::Linear {
        3
    } else {
        1
    };
    let cfa = |row: usize, col: usize| info.cfa[row % 24][col % 24] as usize;
    // CFA site colors as LibRaw numbers them; 3 is the second green.
    let channel = |row: usize, col: usize, s: usize| match opened.layout {
        Layout::Cfa => cfa(row, col),
        _ => s,
    };
    let black = |row: usize, col: usize, c: usize| {
        let pattern = match (raw.cblack[4] as usize, raw.cblack[5] as usize) {
            (h, w) if h > 0 && w > 0 => raw.cblack[6 + (row % h) * w + col % w],
            _ => 0,
        };
        (raw.black + raw.cblack[c.min(3)] + pattern) as f32
    };
    // One WhiteLevel value serves all samples.
    let white: [f32; 4] = std::array::from_fn(|s| match (info.white_level[s], raw.is_float != 0) {
        (w, _) if w > 0 => w as f32,
        _ if info.white_level[0] > 0 => info.white_level[0] as f32,
        (_, true) => 1.,
        (_, false) => raw.maximum as f32,
    });
    let integer = raw.is_float == 0;

    // Linear, black-free samples in [0, 1] of the white level.
    let mut data = vec![0f32; width * height * planes];
    let mut highlights = vec![0u8; width * height];
    for row in 0..height {
        if row % 256 == 0 {
            check(cancel)?;
        }
        for col in 0..width {
            for s in 0..planes {
                let c = channel(row, col, s);
                let b = black(row, col, c);
                let w = white[if opened.layout == Layout::Cfa { 0 } else { s }];
                if w <= b {
                    return Err("The DNG white level is not above the black level".into());
                }
                let v = (samples.get(row, col, s) - b) / (w - b);
                let i = row * width + col;
                data[i * planes + s] = if integer { v.min(1.) } else { v };
                if integer {
                    highlights[i] = highlights[i].max(highlight_weight(v));
                }
            }
        }
    }
    for op in &lists[1] {
        op.apply(&mut data, &mut highlights, width, height, planes, 1);
    }
    let n = cal.neutral.map(|v| v as f32);
    let mut out = match opened.layout {
        Layout::Mono => Balanced {
            data,
            width,
            height,
            highlights,
            step: 1,
        },
        Layout::Linear => {
            for px in data.as_chunks_mut::<3>().0 {
                for (v, n) in px.iter_mut().zip(n) {
                    *v /= n;
                }
            }
            Balanced {
                data,
                width,
                height,
                highlights,
                step: 1,
            }
        }
        // Gray sites without white balance; the calibration is monochrome.
        Layout::Cfa if method == Some(DemosaicMethod::Mono) => Balanced {
            data,
            width,
            height,
            highlights,
            step: 1,
        },
        Layout::Cfa => {
            for row in 0..height {
                for col in 0..width {
                    let c = cfa(row, col);
                    data[row * width + col] /= n[if c == 3 { 1 } else { c }];
                }
            }
            if let (Some(method), Some(pattern)) = (method, cfa_pattern) {
                native(
                    method,
                    data,
                    &highlights,
                    (width, height),
                    pattern,
                    &cal,
                    baseline_exposure(info),
                    integer,
                    cancel,
                )?
            } else {
                if raw.is_float != 0 {
                    // LibRaw demosaics 16-bit samples only; this allocates them.
                    opened.handle.call(cancel, |h| unsafe {
                        ffi::x3fdng_float_to_int(h, &mut *raw)
                    })?;
                    validate(&raw, info, Layout::Cfa)?;
                }
                demosaic(
                    &opened, &raw, data, highlights, width, height, half_size, cancel,
                )?
            }
        }
    };
    check(cancel)?;
    let planes = out.data.len() / (out.width * out.height);
    for op in &lists[2] {
        op.apply(
            &mut out.data,
            &mut out.highlights,
            out.width,
            out.height,
            planes,
            out.step,
        );
    }
    Ok((stretch(out, info.pixel_aspect), cal, orientation(info.flip)))
}

/// Demosaic through LibRaw: the balanced mosaic goes back into LibRaw's raw
/// buffer as offset 16-bit values, scaled so the brightest site fits.
#[allow(clippy::too_many_arguments)]
fn demosaic(
    opened: &Opened,
    raw: &ffi::Raw,
    data: Vec<f32>,
    highlights: Vec<u8>,
    width: usize,
    height: usize,
    half_size: bool,
    cancel: &AtomicBool,
) -> Result<Balanced, String> {
    let peak = data
        .iter()
        .copied()
        .filter(|v| v.is_finite())
        .fold(1f32, f32::max);
    let scale = (65535. - DEMOSAIC_OFFSET) / peak;
    for row in 0..height {
        // SAFETY: `validate` checked the active area against the raw buffer;
        // LibRaw owns it and nothing else reads it during this loop.
        let dst = unsafe {
            let base = (raw.data as *mut u8)
                .add((raw.top_margin as usize + row) * raw.pitch as usize)
                .cast::<u16>()
                .add(raw.left_margin as usize);
            std::slice::from_raw_parts_mut(base, width)
        };
        for (d, v) in dst.iter_mut().zip(&data[row * width..][..width]) {
            *d = (DEMOSAIC_OFFSET + v * scale).round().clamp(0., 65535.) as u16;
        }
    }
    drop(data);
    // SAFETY: Image is plain data that the shim fills on success.
    let mut image: ffi::Image = unsafe { std::mem::zeroed() };
    opened.handle.call(cancel, |h| unsafe {
        ffi::x3fdng_demosaic(h, c_int::from(half_size), &mut image)
    })?;
    let step = if half_size { 2 } else { 1 };
    let (w, h) = (image.width as usize, image.height as usize);
    if image.data.is_null() || w != width.div_ceil(step) || h != height.div_ceil(step) {
        return Err("LibRaw returned an unexpected demosaic size".into());
    }
    // SAFETY: LibRaw owns w * h pixels until the handle drops.
    let pixels = unsafe { std::slice::from_raw_parts(image.data, w * h) };
    let data = pixels
        .iter()
        .flat_map(|p| [p[0], p[1], p[2]])
        .map(|v| (f32::from(v) - DEMOSAIC_OFFSET) / scale)
        .collect();
    // Use the strongest weight among the nearby CFA sites.
    let radius = if half_size { 1 } else { 2 };
    let near = dilate(&highlights, width, height, radius);
    let highlights = (0..h)
        .flat_map(|y| (0..w).map(move |x| (y, x)))
        .map(|(y, x)| near[(y * step).min(height - 1) * width + (x * step).min(width - 1)])
        .collect();
    Ok(Balanced {
        data,
        width: w,
        height: h,
        highlights,
        step,
    })
}

/// The affine map of the balanced mosaic into the kernel domain [0, 65535]:
/// `y = (x - lo) * scale`. The largest sample, or `clip` when it is larger,
/// maps to 65535. `lo` is zero, or the sample at rank `floor_rank` from the
/// bottom when it is negative: the pedestal `-lo * scale` keeps negative
/// noise, and is zero when fewer samples are negative. The few samples below
/// `lo`, such as dead sites, clamp to it, so one of them cannot move the
/// pedestal of the whole image. The kernels clamp their output to the
/// domain, so the output stays from `lo` to the top. With integer samples
/// and no pedestal, this is the RawTherapee scale, where the channel with
/// the largest gain clips at 65535.
///
/// A pedestal is not neutral for every kernel. AMaZE divides by sample
/// values, so it is not exact on a flat field at the domain floor, and its
/// result in dark noise moves with the pedestal; see the tests.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Domain {
    lo: f64,
    scale: f64,
}

impl Domain {
    fn new(data: &[f32], clip: f32) -> Result<Self, String> {
        #[derive(PartialEq)]
        struct Key(f32);
        impl Eq for Key {}
        impl PartialOrd for Key {
            fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
                Some(self.cmp(other))
            }
        }
        impl Ord for Key {
            fn cmp(&self, other: &Self) -> std::cmp::Ordering {
                self.0.total_cmp(&other.0)
            }
        }
        // The `floor_rank + 1` smallest negative samples.
        let rank = floor_rank(data.len());
        let mut lowest = std::collections::BinaryHeap::with_capacity(rank + 1);
        let mut hi = clip;
        for &v in data {
            if !v.is_finite() {
                return Err("The DNG has non-finite samples".into());
            }
            hi = hi.max(v);
            if v < 0. && (lowest.len() <= rank || lowest.peek().is_some_and(|k: &Key| v < k.0)) {
                lowest.push(Key(v));
                if lowest.len() > rank + 1 {
                    lowest.pop();
                }
            }
        }
        let lo = match lowest.peek() {
            Some(k) if lowest.len() > rank => k.0,
            _ => 0.,
        };
        let scale = 65535. / (f64::from(hi) - f64::from(lo));
        if !(scale.is_finite() && scale > 0.) {
            return Err("The DNG sample range is too large to demosaic".into());
        }
        Ok(Self {
            lo: f64::from(lo),
            scale,
        })
    }

    /// The clamp floors the samples below `lo` (see `floor_rank`), and
    /// removes rounding at the top.
    fn map(self, x: f32) -> f32 {
        ((f64::from(x) - self.lo) * self.scale).clamp(0., 65535.) as f32
    }

    fn unmap(self, y: f32) -> f32 {
        (f64::from(y) / self.scale + self.lo) as f32
    }
}

/// How many of the lowest samples cannot set the pedestal: 64, or one in
/// 10000 samples of a large image (2400 at 24 MP, 6400 at 64 MP). A dead
/// row or column longer than this sets the pedestal again.
fn floor_rank(samples: usize) -> usize {
    (samples / 10_000).max(64)
}

fn zeroed(len: usize) -> Result<Vec<f32>, String> {
    let mut v = Vec::new();
    v.try_reserve_exact(len)
        .map_err(|_| "Not enough memory to demosaic the DNG")?;
    v.resize(len, 0.);
    Ok(v)
}

extern "C" fn cancelled(context: *mut c_void) -> c_int {
    // SAFETY: `native` passes its live AtomicBool.
    let cancel = unsafe { &*(context as *const AtomicBool) };
    c_int::from(cancel.load(Ordering::Relaxed))
}

/// Demosaic the balanced mosaic with a native method, in float.
/// Peak memory per pixel: the mosaic (4 bytes), the highlight mask (1), the
/// three output planes (12), and the kernel buffers: IGV 24 (12 with SSE2),
/// LMMSE 20, VNG4 16, HPHD 4, the others tiles or rows only. After the
/// kernel, the interleaved result (12) replaces the mosaic. With the LibRaw
/// raw buffer (2 or 4), the peak is about 48 bytes per pixel.
#[allow(clippy::too_many_arguments)]
fn native(
    method: DemosaicMethod,
    mut data: Vec<f32>,
    highlights: &[u8],
    (width, height): (usize, usize),
    cfa: [[u8; 2]; 2],
    cal: &color::Calibration,
    baseline_exposure: f64,
    integer: bool,
    cancel: &AtomicBool,
) -> Result<Balanced, String> {
    // Integer channels clip at 1 / neutral, and green at one. Float samples
    // have no clip level, so AMaZE gets a level above the domain.
    let clip = cal.neutral.iter().copied().fold(1., f64::min).recip() as f32;
    let domain = Domain::new(&data, if integer { clip } else { 1. })?;
    check(cancel)?;
    let init_gain = if integer {
        65535. / ((1. - domain.lo) * domain.scale)
    } else {
        0.5
    };
    for v in &mut data {
        *v = domain.map(*v);
    }
    // Balanced camera values to linear sRGB, with white at one.
    let n = cal.neutral;
    let m = color::mul(
        &cal.camera_to_rgb,
        &[n[0], 0., 0., 0., n[1], 0., 0., 0., n[2]],
    )
    .map(|v| (v / 2f64.powf(baseline_exposure)) as f32);
    let rgb_cam: [[f32; 3]; 3] = std::array::from_fn(|r| std::array::from_fn(|c| m[r * 3 + c]));
    let plane = width * height;
    let mut planes = zeroed(plane * 3)?;
    check(cancel)?;
    // SAFETY: the buffers hold `plane` and `3 * plane` floats, and `native_cfa`
    // checked the size; the kernel reads `cancel` only during the call.
    let code = unsafe {
        ffi::x3fdng_rt_demosaic(
            method.index(),
            width as c_int,
            height as c_int,
            data.as_ptr(),
            planes.as_mut_ptr(),
            cfa.as_ptr(),
            rgb_cam.as_ptr(),
            init_gain,
            cancelled,
            cancel as *const AtomicBool as *mut c_void,
        )
    };
    check(cancel)?;
    match code {
        0 => {}
        -10001 => return Err("Not enough memory to demosaic the DNG".into()),
        _ => return Err(format!("Native {method:?} demosaic failed ({code})")),
    }
    drop(data);
    let mut out = zeroed(plane * 3)?;
    for (i, px) in out.as_chunks_mut::<3>().0.iter_mut().enumerate() {
        for (c, v) in px.iter_mut().enumerate() {
            *v = domain.unmap(planes[c * plane + i]);
        }
    }
    drop(planes);
    check(cancel)?;
    Ok(Balanced {
        data: out,
        width,
        height,
        highlights: dilate(highlights, width, height, method.highlight_radius()),
        step: 1,
    })
}

/// Resample to square pixels with linear interpolation along one axis.
fn stretch(image: Balanced, aspect: f32) -> Balanced {
    let (w, h) = (image.width, image.height);
    let (nw, nh) = stretched(w, h, aspect);
    if (nw, nh) == (w, h) {
        return image;
    }
    let planes = image.data.len() / (w * h);
    let (horizontal, old, new) = if nw != w {
        (true, w, nw)
    } else {
        (false, h, nh)
    };
    let ratio = old as f32 / new as f32;
    let source: Vec<(usize, usize, f32)> = (0..new)
        .map(|i| {
            let f = ((i as f32 + 0.5) * ratio - 0.5).clamp(0., (old - 1) as f32);
            let a = f as usize;
            (a, (a + 1).min(old - 1), f - a as f32)
        })
        .collect();
    let mut data = vec![0f32; nw * nh * planes];
    let mut highlights = vec![0u8; nw * nh];
    for y in 0..nh {
        for x in 0..nw {
            let (a, b, t) = source[if horizontal { x } else { y }];
            let at = |k: usize| if horizontal { y * w + k } else { k * w + x };
            let o = y * nw + x;
            for p in 0..planes {
                let (va, vb) = (
                    image.data[at(a) * planes + p],
                    image.data[at(b) * planes + p],
                );
                data[o * planes + p] = va + (vb - va) * t;
            }
            let (va, vb) = (
                image.highlights[at(a)] as f32,
                image.highlights[at(b)] as f32,
            );
            highlights[o] = (va + (vb - va) * t).round() as u8;
        }
    }
    Balanced {
        data,
        width: nw,
        height: nh,
        highlights,
        step: image.step,
    }
}

/// Maximum over a square window, in two passes.
fn dilate(mask: &[u8], width: usize, height: usize, radius: usize) -> Vec<u8> {
    let mut rows = vec![0u8; mask.len()];
    let mut line = Vec::new();
    for y in 0..height {
        line.clear();
        line.extend_from_slice(&mask[y * width..][..width]);
        running_max(&mut line, radius);
        rows[y * width..][..width].copy_from_slice(&line);
    }
    let mut out = vec![0u8; mask.len()];
    for x in 0..width {
        line.clear();
        line.extend((0..height).map(|y| rows[y * width + x]));
        running_max(&mut line, radius);
        for (y, v) in line.iter().enumerate() {
            out[y * width + x] = *v;
        }
    }
    out
}

/// The maximum over `[i - radius, i + radius]` at each `i`, in linear time
/// (van Herk and Gil-Werman: block prefix and suffix maxima).
fn running_max(line: &mut [u8], radius: usize) {
    if radius == 0 || line.is_empty() {
        return;
    }
    // Zeros outside the line make every window full, and change no maximum.
    let block = 2 * radius + 1;
    let mut prefix = vec![0u8; line.len() + 2 * radius];
    prefix[radius..][..line.len()].copy_from_slice(line);
    let mut suffix = prefix.clone();
    for i in 1..prefix.len() {
        if i % block != 0 {
            prefix[i] = prefix[i].max(prefix[i - 1]);
        }
    }
    for i in (0..suffix.len() - 1).rev() {
        if (i + 1) % block != 0 {
            suffix[i] = suffix[i].max(suffix[i + 1]);
        }
    }
    // The window of `i` is `[i, i + 2 * radius]` in padded indices: the end
    // of one block and the start of the next.
    for (i, v) in line.iter_mut().enumerate() {
        *v = suffix[i].max(prefix[i + 2 * radius]);
    }
}

/// Fade in near sensor clipping to avoid a hard boundary in bright gradients.
fn highlight_weight(value: f32) -> u8 {
    let t = ((value - 0.9) / (SATURATION - 0.9)).clamp(0., 1.);
    (255. * t * t * (3. - 2. * t)).round() as u8
}

/// Reduce highlight chroma as in LibRaw's blend_highlights, while keeping the
/// mean balanced camera value and its scene-linear headroom.
fn blend_highlights(image: &mut Balanced) {
    for (px, &weight) in image
        .data
        .as_chunks_mut::<3>()
        .0
        .iter_mut()
        .zip(&image.highlights)
    {
        if weight == 0 {
            continue;
        }
        let chroma =
            |p: [f32; 3]| (p[0] - p[1]).powi(2) + (p[1] - p[2]).powi(2) + (p[2] - p[0]).powi(2);
        let original = chroma(*px);
        if original == 0. {
            continue;
        }
        // The largest camera neutral is one, so the first balanced clip level is one.
        // shortcut: GainMaps can change this level; carry local ceilings for mapped highlights.
        let ratio = (chroma(px.map(|v| v.min(1.))) / original).sqrt();
        let scale = 1. + f32::from(weight) / 255. * (ratio - 1.);
        let mean = (px[0] + px[1] + px[2]) / 3.;
        for v in px {
            *v = mean + (*v - mean) * scale;
        }
    }
}

/// Balanced camera values to extended-linear sRGB.
fn to_scene(image: Balanced, cal: &color::Calibration) -> Result<Vec<f32>, String> {
    let mut image = image;
    let mut data = if image.data.len() == image.width * image.height {
        // One sample per pixel: gray in each channel.
        image.data.iter().flat_map(|v| [*v; 3]).collect()
    } else {
        blend_highlights(&mut image);
        image.data
    };
    let m = color::mul(
        &cal.camera_to_rgb,
        &[
            cal.neutral[0],
            0.,
            0.,
            0.,
            cal.neutral[1],
            0.,
            0.,
            0.,
            cal.neutral[2],
        ],
    )
    .map(|v| v as f32);
    for px in data.as_chunks_mut::<3>().0 {
        let [r, g, b] = *px;
        for c in 0..3 {
            px[c] = m[c * 3] * r + m[c * 3 + 1] * g + m[c * 3 + 2] * b;
        }
    }
    if data.iter().any(|v| !v.is_finite()) {
        return Err("The DNG produced non-finite samples".into());
    }
    Ok(data)
}

/// Decode the full image as an unrotated, active-area scene for the editor.
/// LibRaw demosaics a color filter array.
pub fn prepare(path: &Path, cancel: &AtomicBool) -> Result<x3f_core::SceneLinearImage, String> {
    prepare_with_method(path, None, cancel)
}

/// `prepare` with a native demosaic method. None is the LibRaw route of
/// `prepare`. A method needs a DNG whose `DngInfo::bayer` is true, else it
/// is an error; no other method replaces it. `DemosaicMethod::Mono` returns
/// a monochrome calibration. It also accepts a monochrome DNG, with the same
/// pixels as None.
pub fn prepare_with_method(
    path: &Path,
    method: Option<DemosaicMethod>,
    cancel: &AtomicBool,
) -> Result<x3f_core::SceneLinearImage, String> {
    let (image, cal, orientation) = decode(path, cancel, false, method)?;
    let (width, height) = (image.width as u32, image.height as u32);
    let data = to_scene(image, &cal)?;
    check(cancel)?;
    Ok(x3f_core::SceneLinearImage {
        data,
        width,
        height,
        orientation,
        white_balance: x3f_core::WhiteBalanceCalibration {
            camera_to_rgb: cal.camera_to_rgb,
            xyz_to_camera: cal.xyz_to_camera,
            as_shot_neutral: cal.neutral,
        },
        color_mode_calibration: None,
    })
}

fn srgb(v: f32) -> u16 {
    let v = v.clamp(0., 1.);
    let e = if v <= 0.003_130_8 {
        12.92 * v
    } else {
        1.055 * v.powf(1. / 2.4) - 0.055
    };
    (e * 65535.).round() as u16
}

/// Map the upright default crop back to the unrotated decoded pixels.
fn preview_crop(info: DngInfo, width: u32, height: u32) -> [u32; 4] {
    let Some([x, y, w, h]) = info.as_shot_crop else {
        return [0, 0, width, height];
    };
    let inverse = match info.orientation {
        6 => 8,
        8 => 6,
        other => other,
    };
    let [x, y, w, h] = orient_rect([x, y, x + w, y + h], inverse);
    let x = (x * width as f32).round().clamp(0., (width - 1) as f32) as u32;
    let y = (y * height as f32).round().clamp(0., (height - 1) as f32) as u32;
    let w = (w * width as f32).round().max(1.) as u32;
    let h = (h * height as f32).round().max(1.) as u32;
    [x, y, w.min(width - x), h.min(height - y)]
}

/// An unrotated sRGB JPEG with an sRGB ICC profile, at most
/// `PREVIEW_MAX_EDGE` pixels on its long edge, with the default crop. Always three channels.
pub fn preview(path: &Path, cancel: &AtomicBool) -> Result<Vec<u8>, String> {
    use image::ImageEncoder;
    let info = inspect(path, cancel)?;
    let (image, cal, _) = decode(path, cancel, true, None)?;
    let (width, height) = (image.width as u32, image.height as u32);
    let data = to_scene(image, &cal)?;
    check(cancel)?;
    let rgb = image::ImageBuffer::<image::Rgb<u16>, _>::from_raw(
        width,
        height,
        data.into_iter().map(srgb).collect(),
    )
    .ok_or("Invalid DNG preview dimensions")?;
    let [x, y, w, h] = preview_crop(info, width, height);
    let preview = image::DynamicImage::ImageRgb16(rgb)
        .crop_imm(x, y, w, h)
        .thumbnail(PREVIEW_MAX_EDGE, PREVIEW_MAX_EDGE)
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
mod tests;
