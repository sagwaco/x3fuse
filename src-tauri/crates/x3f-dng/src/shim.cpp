// A small C ABI over the bundled LibRaw. Every entry point catches all C++
// exceptions, so no exception crosses into Rust.

#include <new>
#include <string.h>
#include <vector>
#include <zlib.h>
// Declares LibRaw's internal member functions; it adds no data or virtual
// members, so the class layout matches the library.
#define LIBRAW_LIBRARY_BUILD
#include "libraw/libraw.h"

extern "C" {

struct x3fdng_color {
  unsigned illuminant;
  float calibration[4][4];
  float color_matrix[4][3];
  float forward_matrix[3][4];
};

struct x3fdng_info {
  int dng_version;
  int is_raw;
  int is_float;
  int decoder_supported;
  unsigned filters;
  int colors;
  unsigned raw_width, raw_height, width, height, top_margin, left_margin;
  int flip;
  float pixel_aspect;
  // cleft, ctop, cwidth, cheight of DefaultCrop and DefaultUserCrop.
  unsigned crops[2][4];
  unsigned white_level[4];
  float as_shot_neutral[4];
  float analog_balance[4];
  float baseline_exposure;
  float cam_mul[4];
  // EXIF ISO speed, or 0 when the file has none.
  float iso;
  struct x3fdng_color color[2];
  const unsigned char *opcodes[3];
  unsigned opcode_len[3];
  // Active-area color index of each CFA site, period 24 in both directions.
  unsigned char cfa[24][24];
};

struct x3fdng_raw {
  void *data;
  unsigned pitch;
  unsigned samples;
  int is_float;
  unsigned raw_width, raw_height, top_margin, left_margin;
  unsigned black;
  unsigned cblack[LIBRAW_CBLACK_SIZE];
  unsigned maximum;
};

struct x3fdng_image {
  const unsigned short (*data)[4];
  unsigned width, height;
};
}

namespace {
// LibRaw 0.22.2 selects deflate_dng_load_raw for integer Deflate DNG, but
// that loader accepts floating-point samples only. This subclass adds the
// integer case with LibRaw's own IFD data, strip and tile rules.
class X3fRaw : public LibRaw {
public:
  typedef void (LibRaw::*Loader)();

  X3fRaw() : LibRaw(LIBRAW_OPTIONS_NO_DATAERR_CALLBACK) {}

  static Loader int_deflate() {
    return static_cast<Loader>(&X3fRaw::int_deflate_load_raw);
  }

  void use_int_deflate() {
    if (load_raw == &X3fRaw::deflate_dng_load_raw && !is_floating_point())
      load_raw = int_deflate();
  }

  int get_decoder_info(libraw_decoder_info_t *d) override {
    if (load_raw != int_deflate())
      return LibRaw::get_decoder_info(d);
    d->decoder_name = "x3fdng_int_deflate_load_raw()";
    // LIBRAW_DECODER_3CHANNEL equals LIBRAW_DECODER_SINAR4SHOT in 0.22.2:
    // unpack allocates a four-slot image and keeps the margins.
    d->decoder_flags = libraw_internal_data.unpacker_data.tiff_samples == 3
                           ? LIBRAW_DECODER_3CHANNEL
                           : 0;
    return LIBRAW_SUCCESS;
  }

  void int_deflate_load_raw();
};

unsigned read4(LibRaw_abstract_datastream *in, short order) {
  unsigned char b[4] = {0, 0, 0, 0};
  if (in->read(b, 1, 4) != 4)
    throw LIBRAW_EXCEPTION_IO_EOF;
  return order == 0x4949 ? b[0] | b[1] << 8 | b[2] << 16 | unsigned(b[3]) << 24
                         : unsigned(b[0]) << 24 | b[1] << 16 | b[2] << 8 | b[3];
}

void X3fRaw::int_deflate_load_raw() {
  unpacker_data_t &u = libraw_internal_data.unpacker_data;
  LibRaw_abstract_datastream *in = libraw_internal_data.internal_data.input;
  int iifd = find_ifd_by_offset(u.data_offset);
  if (iifd < 0 || iifd >= int(libraw_internal_data.identify_data.tiff_nifds))
    throw LIBRAW_EXCEPTION_DECODE_RAW;
  const tiff_ifd_t &ifd = tiff_ifd[iifd];
  const unsigned samples = ifd.samples, bytes = ifd.bps / 8;
  if ((samples != 1 && samples != 3) || samples != u.tiff_samples ||
      (ifd.bps != 8 && ifd.bps != 16))
    throw LIBRAW_EXCEPTION_DECODE_RAW;
  // TIFF predictor 2 and the DNG 1.5 wider differences.
  unsigned distance;
  switch (ifd.predictor) {
  case 0:
  case 1:
    distance = 0;
    break;
  case 2:
    distance = 1;
    break;
  case 34892:
    distance = 2;
    break;
  case 34893:
    distance = 4;
    break;
  default:
    throw LIBRAW_EXCEPTION_DECODE_RAW;
  }
  const unsigned rw = imgdata.sizes.raw_width, rh = imgdata.sizes.raw_height;
  const bool tiled = u.tile_width <= rw && u.tile_length <= rh;
  const bool striped = !tiled && ifd.rows_per_strip > 0 &&
                       unsigned(ifd.rows_per_strip) < rh &&
                       ifd.strip_offsets_count > 0 &&
                       ifd.strip_byte_counts_count > 0;
  const unsigned tw = tiled ? u.tile_width : rw;
  const unsigned th = tiled ? u.tile_length : striped ? ifd.rows_per_strip : rh;
  if (!tw || !th)
    throw LIBRAW_EXCEPTION_DECODE_RAW;
  const unsigned across = (rw + tw - 1) / tw, down = (rh + th - 1) / th;
  const size_t count = size_t(across) * down;
  if (count < 1 || count > 1000000)
    throw LIBRAW_EXCEPTION_DECODE_RAW;
  std::vector<INT64> offsets(count), lengths(count);
  if (count == 1) {
    offsets[0] = ifd.offset;
    lengths[0] = ifd.bytes;
  } else if (tiled) {
    // ponytail: tile tables are read as LONG, as LibRaw does; SHORT
    // TileOffsets or TileByteCounts fail. Extend when a file needs it.
    in->seek(ifd.offset, SEEK_SET);
    for (size_t t = 0; t < count; t++)
      offsets[t] = read4(in, u.order);
    in->seek(ifd.bytes, SEEK_SET);
    for (size_t t = 0; t < count; t++)
      lengths[t] = read4(in, u.order);
  } else {
    if (size_t(ifd.strip_offsets_count) < count ||
        size_t(ifd.strip_byte_counts_count) < count)
      throw LIBRAW_EXCEPTION_DECODE_RAW;
    for (size_t t = 0; t < count; t++) {
      offsets[t] = ifd.strip_offsets[t];
      lengths[t] = ifd.strip_byte_counts[t];
    }
  }
  const INT64 limit = INT64(imgdata.rawparams.max_raw_memory_mb) << 20;
  const INT64 row_samples = INT64(tw) * samples;
  const INT64 tile_bytes = row_samples * th * bytes;
  if (tile_bytes > limit)
    throw LIBRAW_EXCEPTION_TOOBIG;
  std::vector<unsigned char> packed;
  std::vector<unsigned char> plain((size_t(tile_bytes)));
  std::vector<unsigned> row((size_t(row_samples)));
  ushort *base;
  size_t step;
  if (samples == 1 && imgdata.rawdata.raw_image) {
    base = imgdata.rawdata.raw_image;
    step = 1;
  } else if (samples == 3 && imgdata.rawdata.color3_image) {
    base = &imgdata.rawdata.color3_image[0][0];
    step = 3;
  } else if (samples == 3 && imgdata.image) {
    base = &imgdata.image[0][0];
    step = 4;
  } else {
    throw LIBRAW_EXCEPTION_DECODE_RAW;
  }
  const size_t pitch = imgdata.sizes.raw_pitch / 2;
  if (pitch < size_t(rw) * step)
    throw LIBRAW_EXCEPTION_DECODE_RAW;
  for (size_t t = 0; t < count; t++) {
    checkCancel();
    if (lengths[t] <= 0 || lengths[t] > limit || offsets[t] < 0 ||
        offsets[t] + lengths[t] > in->size())
      throw LIBRAW_EXCEPTION_IO_CORRUPT;
    packed.assign(size_t(lengths[t]), 0);
    in->seek(offsets[t], SEEK_SET);
    if (in->read(packed.data(), 1, packed.size()) != int(packed.size()))
      throw LIBRAW_EXCEPTION_IO_EOF;
    uLongf size = uLongf(plain.size());
    std::fill(plain.begin(), plain.end(), 0);
    int err = uncompress(plain.data(), &size, packed.data(), uLong(packed.size()));
    const unsigned x0 = unsigned(t % across) * tw, y0 = unsigned(t / across) * th;
    const unsigned rows = th < rh - y0 ? th : rh - y0;
    const unsigned cols = tw < rw - x0 ? tw : rw - x0;
    // A final strip holds fewer rows; a short one is corrupt, not black.
    if (err != Z_OK || INT64(size) < INT64(rows) * row_samples * bytes)
      throw LIBRAW_EXCEPTION_DECODE_RAW;
    for (unsigned r = 0; r < rows; r++) {
      const unsigned char *src = plain.data() + size_t(r) * row_samples * bytes;
      for (INT64 i = 0; i < row_samples; i++)
        row[i] = bytes == 1 ? src[i]
                 : u.order == 0x4949 ? src[2 * i] | src[2 * i + 1] << 8
                                     : src[2 * i] << 8 | src[2 * i + 1];
      const unsigned mask = bytes == 1 ? 0xff : 0xffff;
      if (distance)
        for (INT64 i = INT64(distance) * samples; i < row_samples; i++)
          row[i] = (row[i] + row[i - distance * samples]) & mask;
      ushort *dst = base + size_t(y0 + r) * pitch + size_t(x0) * step;
      for (unsigned c = 0; c < cols; c++)
        for (unsigned k = 0; k < samples; k++)
          dst[c * step + k] = imgdata.color.curve[row[c * samples + k]];
    }
  }
}

const int UNSUPPORTED = -10000;
const int NO_MEMORY = -10001;
const int INTERNAL = -10002;

int guard(int (*body)(X3fRaw *, void *), X3fRaw *raw, void *arg) {
  try {
    return body(raw, arg);
  } catch (const std::bad_alloc &) {
    return NO_MEMORY;
  } catch (...) {
    return INTERNAL;
  }
}

bool decoder_supported(X3fRaw *raw) {
  libraw_decoder_info_t info;
  if (raw->get_decoder_info(&info) != LIBRAW_SUCCESS || !info.decoder_name)
    return false;
  // LibRaw names DNG 1.7 JPEG XL and GoPro VC-5 decoders that need external SDKs.
  return !strstr(info.decoder_name, "placeholder");
}
} // namespace

extern "C" {

void *x3fdng_new(unsigned max_raw_memory_mb) {
  try {
    X3fRaw *raw = new X3fRaw();
    raw->imgdata.rawparams.max_raw_memory_mb = max_raw_memory_mb;
    // Keep floating-point samples. The Rust side owns all normalization.
    raw->imgdata.rawparams.options &= ~LIBRAW_RAWOPTIONS_CONVERTFLOAT_TO_INT;
    return raw;
  } catch (...) {
    return nullptr;
  }
}

// Lets Rust check its struct layouts: 0 info, 1 raw, 2 image.
size_t x3fdng_sizes(int which) {
  return which == 0   ? sizeof(x3fdng_info)
         : which == 1 ? sizeof(x3fdng_raw)
                      : sizeof(x3fdng_image);
}

void x3fdng_free(void *handle) { delete static_cast<X3fRaw *>(handle); }

void x3fdng_cancel(void *handle) {
  static_cast<X3fRaw *>(handle)->setCancelFlag();
}

const char *x3fdng_strerror(int code) {
  switch (code) {
  case UNSUPPORTED:
    return "Unsupported DNG layout";
  case NO_MEMORY:
    return "Not enough memory to decode the DNG";
  case INTERNAL:
    return "Internal DNG decoder error";
  default:
    return libraw_strerror(code);
  }
}

#ifdef _WIN32
int x3fdng_open(void *handle, const wchar_t *path) {
#else
int x3fdng_open(void *handle, const char *path) {
#endif
  return guard(
      [](X3fRaw *raw, void *arg) {
#ifdef _WIN32
        int rc = raw->open_file(static_cast<const wchar_t *>(arg));
#else
        int rc = raw->open_file(static_cast<const char *>(arg));
#endif
        if (rc == LIBRAW_SUCCESS)
          raw->use_int_deflate();
        return rc;
      },
      static_cast<X3fRaw *>(handle), (void *)path);
}

int x3fdng_read_info(void *handle, x3fdng_info *out) {
  return guard(
      [](X3fRaw *raw, void *arg) {
        x3fdng_info *info = static_cast<x3fdng_info *>(arg);
        memset(info, 0, sizeof *info);
        libraw_data_t &d = raw->imgdata;
        info->dng_version = d.idata.dng_version != 0;
        info->is_raw = d.idata.raw_count > 0;
        info->is_float = raw->is_floating_point();
        info->decoder_supported = decoder_supported(raw);
        info->filters = d.idata.filters;
        info->colors = d.idata.colors;
        info->raw_width = d.sizes.raw_width;
        info->raw_height = d.sizes.raw_height;
        info->width = d.sizes.width;
        info->height = d.sizes.height;
        info->top_margin = d.sizes.top_margin;
        info->left_margin = d.sizes.left_margin;
        info->flip = d.sizes.flip;
        info->pixel_aspect = float(d.sizes.pixel_aspect);
        for (int i = 0; i < 2; i++) {
          const libraw_raw_inset_crop_t &c = d.sizes.raw_inset_crops[i];
          info->crops[i][0] = c.cleft;
          info->crops[i][1] = c.ctop;
          info->crops[i][2] = c.cwidth;
          info->crops[i][3] = c.cheight;
        }
        const libraw_dng_levels_t &l = d.color.dng_levels;
        memcpy(info->white_level, l.dng_whitelevel, sizeof info->white_level);
        memcpy(info->as_shot_neutral, l.asshotneutral,
               sizeof info->as_shot_neutral);
        memcpy(info->analog_balance, l.analogbalance,
               sizeof info->analog_balance);
        info->baseline_exposure = l.baseline_exposure;
        memcpy(info->cam_mul, d.color.cam_mul, sizeof info->cam_mul);
        info->iso = d.other.iso_speed;
        for (int i = 0; i < 2; i++) {
          const libraw_dng_color_t &c = d.color.dng_color[i];
          info->color[i].illuminant = c.illuminant;
          memcpy(info->color[i].calibration, c.calibration,
                 sizeof c.calibration);
          memcpy(info->color[i].color_matrix, c.colormatrix,
                 sizeof c.colormatrix);
          memcpy(info->color[i].forward_matrix, c.forwardmatrix,
                 sizeof c.forwardmatrix);
        }
        for (int i = 0; i < 3; i++) {
          info->opcodes[i] =
              static_cast<const unsigned char *>(l.rawopcodes[i].data);
          info->opcode_len[i] = l.rawopcodes[i].data ? l.rawopcodes[i].len : 0;
        }
        if (d.idata.filters)
          for (int r = 0; r < 24; r++)
            for (int c = 0; c < 24; c++)
              info->cfa[r][c] = (unsigned char)raw->COLOR(r, c);
        return 0;
      },
      static_cast<X3fRaw *>(handle), out);
}

static int fill_raw(X3fRaw *raw, x3fdng_raw *r) {
  memset(r, 0, sizeof *r);
  libraw_rawdata_t &d = raw->imgdata.rawdata;
  if (d.raw_image) {
    r->data = d.raw_image;
    r->samples = 1;
  } else if (d.color3_image) {
    r->data = d.color3_image;
    r->samples = 3;
  } else if (d.color4_image) {
    r->data = d.color4_image;
    r->samples = 4;
  } else if (d.float_image) {
    r->data = d.float_image;
    r->samples = 1;
    r->is_float = 1;
  } else if (d.float3_image) {
    r->data = d.float3_image;
    r->samples = 3;
    r->is_float = 1;
  } else if (d.float4_image) {
    r->data = d.float4_image;
    r->samples = 4;
    r->is_float = 1;
  } else {
    return UNSUPPORTED;
  }
  r->pitch = d.sizes.raw_pitch;
  r->raw_width = d.sizes.raw_width;
  r->raw_height = d.sizes.raw_height;
  r->top_margin = d.sizes.top_margin;
  r->left_margin = d.sizes.left_margin;
  r->black = d.color.black;
  memcpy(r->cblack, d.color.cblack, sizeof r->cblack);
  r->maximum = d.color.maximum;
  return 0;
}

int x3fdng_unpack(void *handle, x3fdng_raw *out) {
  return guard(
      [](X3fRaw *raw, void *arg) {
        int rc = raw->unpack();
        if (rc != LIBRAW_SUCCESS)
          return rc;
        return fill_raw(raw, static_cast<x3fdng_raw *>(arg));
      },
      static_cast<X3fRaw *>(handle), out);
}

// Replace floating-point samples with a 16-bit buffer for the demosaic.
int x3fdng_float_to_int(void *handle, x3fdng_raw *out) {
  return guard(
      [](X3fRaw *raw, void *arg) {
        raw->convertFloatToInt();
        return fill_raw(raw, static_cast<x3fdng_raw *>(arg));
      },
      static_cast<X3fRaw *>(handle), out);
}

// Demosaic the CFA after the caller rewrote raw_image as black-free 16-bit
// values. LibRaw keeps the camera color space and applies no scaling.
int x3fdng_demosaic(void *handle, int half_size, x3fdng_image *out) {
  struct Args {
    int half_size;
    x3fdng_image *out;
  } args = {half_size, out};
  return guard(
      [](X3fRaw *raw, void *arg) {
        Args *a = static_cast<Args *>(arg);
        libraw_data_t &d = raw->imgdata;
        libraw_output_params_t &p = d.params;
        p.half_size = a->half_size;
        p.no_auto_scale = 1;
        p.no_auto_bright = 1;
        p.use_camera_wb = 0;
        p.use_auto_wb = 0;
        p.use_camera_matrix = 0;
        p.output_color = 0;
        p.output_bps = 16;
        p.gamm[0] = p.gamm[1] = 1.0;
        p.highlight = 0;
        p.adjust_maximum_thr = 0.f;
        p.user_flip = 0;
        p.user_qual = -1;
        p.four_color_rgb = 0;
        p.green_matching = 0;
        p.med_passes = 0;
        p.exp_correc = 0;
        p.use_fuji_rotate = 0;
        d.rawdata.color.black = 0;
        memset(d.rawdata.color.cblack, 0, sizeof d.rawdata.color.cblack);
        d.rawdata.color.maximum = 0xffff;
        d.rawdata.color.data_maximum = 0;
        d.rawdata.ioparams.zero_is_bad = 0;
        int rc = raw->dcraw_process();
        if (rc != LIBRAW_SUCCESS)
          return rc;
        if (!d.image)
          return UNSUPPORTED;
        a->out->data = d.image;
        a->out->width = d.sizes.iwidth;
        a->out->height = d.sizes.iheight;
        return 0;
      },
      static_cast<X3fRaw *>(handle), &args);
}
}
