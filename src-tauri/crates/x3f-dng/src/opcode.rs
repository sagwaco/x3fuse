//! DNG opcode lists. GainMap and WarpRectilinear are applied; other opcodes
//! must be optional.

/// GainMap, DNG 1.7 opcode 9.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct GainMap {
    pub top: u32,
    pub left: u32,
    pub bottom: u32,
    pub right: u32,
    pub plane: u32,
    pub planes: u32,
    pub row_pitch: u32,
    pub col_pitch: u32,
    pub points: [u32; 2],
    pub spacing: [f64; 2],
    pub origin: [f64; 2],
    pub map_planes: u32,
    pub gains: Vec<f32>,
}

/// WarpRectilinear, DNG 1.7 opcode 1: radial and tangential lens distortion.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Warp {
    /// Per plane: kr0 through kr3, then kt0 and kt1. One entry serves all planes.
    pub coefficients: Vec<[f64; 6]>,
    /// Optical center, relative to the image width and height.
    pub center: [f64; 2],
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Opcode {
    Gain(GainMap),
    Warp(Warp),
}

const WARP_RECTILINEAR: u32 = 1;
const GAIN_MAP: u32 = 9;
/// The opcode can be skipped by readers that do not support it.
const OPTIONAL: u32 = 1;

struct Reader<'a>(&'a [u8]);

impl Reader<'_> {
    fn take(&mut self, n: usize) -> Result<&[u8], String> {
        if self.0.len() < n {
            return Err("Truncated DNG opcode list".into());
        }
        let (head, tail) = self.0.split_at(n);
        self.0 = tail;
        Ok(head)
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn f64(&mut self) -> Result<f64, String> {
        Ok(f64::from_be_bytes(self.take(8)?.try_into().unwrap()))
    }
}

/// Parse one opcode list (big-endian). `list` is 1 through 3. A warp is
/// read in OpcodeList3 only, where it applies to the demosaiced image.
pub(crate) fn parse(data: &[u8], list: u32) -> Result<Vec<Opcode>, String> {
    let mut maps = Vec::new();
    if data.is_empty() {
        return Ok(maps);
    }
    let mut r = Reader(data);
    for _ in 0..r.u32()? {
        let (id, _version, flags, size) = (r.u32()?, r.u32()?, r.u32()?, r.u32()?);
        let mut p = Reader(r.take(size as usize)?);
        if id == WARP_RECTILINEAR && list == 3 {
            maps.push(Opcode::Warp(warp(&mut p)?));
            continue;
        }
        if id != GAIN_MAP {
            if flags & OPTIONAL == 0 {
                return Err(format!(
                    "DNG OpcodeList{list} opcode {id} is required and not supported"
                ));
            }
            continue;
        }
        let rect = [p.u32()?, p.u32()?, p.u32()?, p.u32()?];
        let [plane, planes, row_pitch, col_pitch] = [p.u32()?, p.u32()?, p.u32()?, p.u32()?];
        let points = [p.u32()?, p.u32()?];
        let spacing = [p.f64()?, p.f64()?];
        let origin = [p.f64()?, p.f64()?];
        let map_planes = p.u32()?;
        let count = (points[0] as usize)
            .checked_mul(points[1] as usize)
            .and_then(|n| n.checked_mul(map_planes as usize))
            .filter(|n| *n > 0 && n * 4 <= p.0.len())
            .ok_or("Invalid DNG GainMap size")?;
        let gains: Vec<f32> = p
            .take(count * 4)?
            .as_chunks::<4>()
            .0
            .iter()
            .map(|b| f32::from_be_bytes(*b))
            .collect();
        if planes == 0
            || row_pitch == 0
            || col_pitch == 0
            || rect[0] > rect[2]
            || rect[1] > rect[3]
            || spacing.iter().any(|s| !s.is_finite() || *s <= 0.)
            || origin.iter().any(|o| !o.is_finite())
            || gains.iter().any(|g| !g.is_finite() || *g < 0.)
        {
            return Err("Invalid DNG GainMap".into());
        }
        maps.push(Opcode::Gain(GainMap {
            top: rect[0],
            left: rect[1],
            bottom: rect[2],
            right: rect[3],
            plane,
            planes,
            row_pitch,
            col_pitch,
            points,
            spacing,
            origin,
            map_planes,
            gains,
        }));
    }
    Ok(maps)
}

fn warp(p: &mut Reader<'_>) -> Result<Warp, String> {
    let planes = p.u32()?;
    if !(1..=4).contains(&planes) {
        return Err("Invalid DNG WarpRectilinear".into());
    }
    let mut coefficients = Vec::new();
    for _ in 0..planes {
        let mut k = [0.; 6];
        for v in &mut k {
            *v = p.f64()?;
        }
        coefficients.push(k);
    }
    let center = [p.f64()?, p.f64()?];
    if coefficients
        .iter()
        .flatten()
        .chain(&center)
        .any(|v| !v.is_finite())
    {
        return Err("Invalid DNG WarpRectilinear".into());
    }
    Ok(Warp {
        coefficients,
        center,
    })
}

impl Opcode {
    /// Apply to an interleaved image of `samples` planes and its per-pixel
    /// clip mask. `step` is the size of one image pixel in opcode pixels.
    pub(crate) fn apply(
        &self,
        data: &mut Vec<f32>,
        mask: &mut Vec<u8>,
        width: usize,
        height: usize,
        samples: usize,
        step: usize,
    ) {
        match self {
            Opcode::Gain(map) => map.apply(data, width, height, samples, step),
            Opcode::Warp(warp) => warp.apply(data, mask, width, height, samples),
        }
    }
}

impl Warp {
    /// The source position of a destination pixel center, in pixels.
    fn source(&self, plane: usize, x: f64, y: f64, geometry: &[f64; 3]) -> (f64, f64) {
        let [cx, cy, m] = *geometry;
        let k = self.coefficients[plane.min(self.coefficients.len() - 1)];
        let (dx, dy) = ((x - cx) / m, (y - cy) / m);
        let r2 = dx * dx + dy * dy;
        let f = k[0] + r2 * (k[1] + r2 * (k[2] + r2 * k[3]));
        let tx = k[4] * 2. * dx * dy + k[5] * (r2 + 2. * dx * dx);
        let ty = k[5] * 2. * dx * dy + k[4] * (r2 + 2. * dy * dy);
        (cx + m * (f * dx + tx), cy + m * (f * dy + ty))
    }

    /// Resample each plane bilinearly; edges clamp. The mask follows the
    /// nearest source pixel of the first plane.
    fn apply(
        &self,
        data: &mut Vec<f32>,
        mask: &mut Vec<u8>,
        width: usize,
        height: usize,
        samples: usize,
    ) {
        let (w, h) = (width as f64, height as f64);
        let (cx, cy) = (self.center[0] * w, self.center[1] * h);
        // The unit distance is from the center to the farthest corner.
        let m = cx.max(w - cx).hypot(cy.max(h - cy));
        let geometry = [cx, cy, m];
        let mut out = vec![0f32; data.len()];
        let mut out_mask = vec![0u8; mask.len()];
        let at = |x: f64, y: f64| {
            let fx = (x - 0.5).clamp(0., w - 1.);
            let fy = (y - 0.5).clamp(0., h - 1.);
            let (x0, y0) = (fx as usize, fy as usize);
            let (x1, y1) = ((x0 + 1).min(width - 1), (y0 + 1).min(height - 1));
            (
                x0,
                y0,
                x1,
                y1,
                (fx - x0 as f64) as f32,
                (fy - y0 as f64) as f32,
            )
        };
        for y in 0..height {
            for x in 0..width {
                let (px, py) = (x as f64 + 0.5, y as f64 + 0.5);
                let o = y * width + x;
                for p in 0..samples {
                    let (sx, sy) = self.source(p, px, py, &geometry);
                    let (x0, y0, x1, y1, tx, ty) = at(sx, sy);
                    let v = |xx: usize, yy: usize| data[(yy * width + xx) * samples + p];
                    let top = v(x0, y0) + (v(x1, y0) - v(x0, y0)) * tx;
                    let bottom = v(x0, y1) + (v(x1, y1) - v(x0, y1)) * tx;
                    out[o * samples + p] = top + (bottom - top) * ty;
                    if p == 0 {
                        let nx = if tx < 0.5 { x0 } else { x1 };
                        let ny = if ty < 0.5 { y0 } else { y1 };
                        out_mask[o] = mask[ny * width + nx];
                    }
                }
            }
        }
        *data = out;
        *mask = out_mask;
    }
}

impl GainMap {
    /// Bilinear gain at a relative image position, clamped to the map edges.
    /// `plane` counts from the first plane of the opcode.
    fn gain(&self, v: f64, h: f64, plane: usize) -> f32 {
        let [nv, nh] = self.points.map(|n| n as usize);
        let index = |pos: f64, origin: f64, spacing: f64, n: usize| {
            let f = ((pos - origin) / spacing).clamp(0., (n - 1) as f64);
            let i = (f as usize).min(n.saturating_sub(2));
            (i, (i + 1).min(n - 1), (f - i as f64) as f32)
        };
        let (r0, r1, fr) = index(v, self.origin[0], self.spacing[0], nv);
        let (c0, c1, fc) = index(h, self.origin[1], self.spacing[1], nh);
        let mp = self.map_planes as usize;
        let at = |r: usize, c: usize| self.gains[(r * nh + c) * mp + plane.min(mp - 1)];
        let top = at(r0, c0) + (at(r0, c1) - at(r0, c0)) * fc;
        let bottom = at(r1, c0) + (at(r1, c1) - at(r1, c0)) * fc;
        top + (bottom - top) * fr
    }

    /// Multiply an interleaved image of `samples` planes. `step` is the size
    /// of one image pixel in opcode pixels: 1, or 2 for a half-size image.
    pub(crate) fn apply(
        &self,
        data: &mut [f32],
        width: usize,
        height: usize,
        samples: usize,
        step: usize,
    ) {
        let (full_w, full_h) = (width * step, height * step);
        let first = self.plane as usize;
        let planes = first..(first + self.planes as usize).min(samples);
        // Opcode coordinates address pixel centers: (row + 0.5) / height.
        for y in 0..height {
            let row = (y * step) as u32;
            let hit_row = (self.top..self.bottom).contains(&row)
                && (step > 1 || (row - self.top).is_multiple_of(self.row_pitch));
            if !hit_row {
                continue;
            }
            let v = (row as f64 + step as f64 * 0.5) / full_h as f64;
            for x in 0..width {
                let col = (x * step) as u32;
                if !(self.left..self.right).contains(&col)
                    || (step == 1 && !(col - self.left).is_multiple_of(self.col_pitch))
                {
                    continue;
                }
                let h = (col as f64 + step as f64 * 0.5) / full_w as f64;
                for p in planes.clone() {
                    data[(y * width + x) * samples + p] *= self.gain(v, h, p - first);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(opcodes: &[(u32, u32, Vec<u8>)]) -> Vec<u8> {
        let mut out = (opcodes.len() as u32).to_be_bytes().to_vec();
        for (id, flags, params) in opcodes {
            for v in [*id, 0x01030000, *flags, params.len() as u32] {
                out.extend(v.to_be_bytes());
            }
            out.extend(params);
        }
        out
    }

    fn gains(data: &[u8], list: u32) -> Vec<GainMap> {
        parse(data, list)
            .unwrap()
            .into_iter()
            .map(|op| match op {
                Opcode::Gain(map) => map,
                Opcode::Warp(_) => panic!("unexpected warp"),
            })
            .collect()
    }

    fn warp_params(k: [f64; 6], center: [f64; 2]) -> Vec<u8> {
        let mut p = 1u32.to_be_bytes().to_vec();
        for v in k.into_iter().chain(center) {
            p.extend(v.to_be_bytes());
        }
        p
    }

    #[test]
    fn identity_warp_keeps_the_image() {
        let ops = parse(
            &list(&[(1, 0, warp_params([1., 0., 0., 0., 0., 0.], [0.5, 0.5]))]),
            3,
        )
        .unwrap();
        let mut image: Vec<f32> = (0..48).map(|v| v as f32).collect();
        let mut mask = vec![0u8; 16];
        mask[5] = 1;
        let before = (image.clone(), mask.clone());
        ops[0].apply(&mut image, &mut mask, 4, 4, 3, 1);
        assert_eq!((image, mask), before);
    }

    #[test]
    fn radial_warp_samples_outward() {
        // kr0 = 2 doubles every distance from the center: a 2x zoom-in.
        let ops = parse(
            &list(&[(1, 0, warp_params([2., 0., 0., 0., 0., 0.], [0.5, 0.5]))]),
            3,
        )
        .unwrap();
        let mut image: Vec<f32> = (0..8).flat_map(|_| (0..8).map(|x| x as f32)).collect();
        let mut mask = vec![0u8; 64];
        ops[0].apply(&mut image, &mut mask, 8, 8, 1, 1);
        // Destination x center 4.5 is 0.5 right of the center; source is 5.0.
        assert!((image[4] - 4.5).abs() < 1e-5, "{}", image[4]);
        // The edge clamps to the last column.
        assert_eq!(image[7], 7.);
        // Warps belong to OpcodeList3 only.
        assert!(parse(&list(&[(1, 0, warp_params([1.; 6], [0.5; 2]))]), 2).is_err());
    }

    fn gain_map(rect: [u32; 4], plane: u32, pitch: u32, gains: &[f32]) -> Vec<u8> {
        let mut p = Vec::new();
        for v in rect.into_iter().chain([plane, 1, pitch, pitch, 1, 2]) {
            p.extend(v.to_be_bytes());
        }
        for v in [1.0f64, 1.0, 0.0, 0.0] {
            p.extend(v.to_be_bytes());
        }
        p.extend(1u32.to_be_bytes());
        for g in gains {
            p.extend(g.to_be_bytes());
        }
        p
    }

    #[test]
    fn gain_map_interpolates_across_columns() {
        let data = list(&[(9, 0, gain_map([0, 0, 2, 4], 1, 1, &[1., 3.]))]);
        let maps = gains(&data, 2);
        let mut image = vec![1f32; 2 * 4 * 3];
        maps[0].apply(&mut image, 4, 2, 3, 1);
        // Only plane 1 changes; gains rise from 1 to 3 across the width.
        let row: Vec<f32> = (0..4).map(|x| image[x * 3 + 1]).collect();
        assert_eq!(row, [1.25, 1.75, 2.25, 2.75]);
        assert!(image.iter().step_by(3).all(|v| *v == 1.));
    }

    #[test]
    fn map_planes_count_from_the_first_plane() {
        // Planes 1 and 2, one map plane: both use map plane 0.
        let mut p = gain_map([0, 0, 1, 1], 1, 1, &[]);
        p[20..24].copy_from_slice(&2u32.to_be_bytes()); // Planes
        p[36..40].copy_from_slice(&1u32.to_be_bytes()); // MapPointsH
        p.extend(2f32.to_be_bytes());
        let maps = gains(&list(&[(9, 0, p)]), 3);
        let mut image = vec![1f32; 3];
        maps[0].apply(&mut image, 1, 1, 3, 1);
        assert_eq!(image, [1., 2., 2.]);
    }

    #[test]
    fn pitch_selects_cfa_sites() {
        let data = list(&[(9, 0, gain_map([0, 1, 4, 4], 0, 2, &[2., 2.]))]);
        let maps = gains(&data, 2);
        let mut image = vec![1f32; 16];
        maps[0].apply(&mut image, 4, 4, 1, 1);
        let changed: Vec<usize> = (0..16).filter(|i| image[*i] == 2.).collect();
        assert_eq!(changed, [1, 3, 9, 11]);
    }

    #[test]
    fn unsupported_opcodes_need_the_optional_flag() {
        // FixBadPixelsConstant.
        assert!(parse(&list(&[(4, 1, vec![0; 8])]), 3).unwrap().is_empty());
        let err = parse(&list(&[(4, 0, vec![0; 8])]), 3).unwrap_err();
        assert!(err.contains("OpcodeList3 opcode 4"));
        assert!(parse(&list(&[(9, 0, vec![0; 8])]), 2).is_err());
    }
}
