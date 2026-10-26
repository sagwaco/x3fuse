// A C ABI over the pinned librtprocess Bayer kernels and the EAHD port.
// Every entry point catches all C++ exceptions, so no exception crosses into
// Rust. The kernels run serially: the cancellation patches jump out of
// OpenMP blocks, which is valid only without OpenMP.

#ifdef _OPENMP
#error "x3f-dng compiles librtprocess without OpenMP"
#endif

#include <cstddef>
#include <functional>
#include <new>
#include <vector>

#include "librtprocess.h"

rpError x3f_eahd_demosaic(int width, int height, const float *const *raw,
                          float **red, float **green, float **blue,
                          const unsigned cfa[2][2], const float rgb_cam[3][4],
                          const std::function<bool(double)> &cancelled);

namespace {
const int NO_MEMORY = -10001;
const int INTERNAL = -10002;
const int WRONG_CFA = -10003;

// The order of DemosaicMethod in lib.rs, without Mono.
enum Method { AMAZE, DCB, AHD, EAHD, HPHD, IGV, LMMSE, VNG4, FAST };
} // namespace

extern "C" {

// Demosaic one Bayer mosaic of `width` x `height` floats into three planes in
// `out` (red, green, blue). The input is in the kernel domain [0, 65535].
// `cfa` holds LibRaw colors 0 to 3, where 3 is the second green.
// `rgb_cam` maps balanced camera values to linear sRGB, for AHD and EAHD.
// `init_gain` sets the green clip level of AMaZE to 65535 / init_gain; below
// one, the level is above the domain and AMaZE has no clipped highlights.
int x3fdng_rt_demosaic(int method, int width, int height, const float *mosaic,
                       float *out, const unsigned char cfa[2][2],
                       const float rgb_cam[3][3], double init_gain,
                       int (*cancelled)(void *), void *context) {
  try {
    const size_t plane = size_t(width) * size_t(height);
    std::vector<const float *> raw(height);
    std::vector<float *> rows[3];
    for (int c = 0; c < 3; c++)
      rows[c].resize(height);
    for (int y = 0; y < height; y++) {
      raw[y] = mosaic + size_t(y) * width;
      for (int c = 0; c < 3; c++)
        rows[c][y] = out + c * plane + size_t(y) * width;
    }
    // Three-color kernels use one green; VNG4 keeps both.
    unsigned three[2][2], four[2][2];
    for (int y = 0; y < 2; y++)
      for (int x = 0; x < 2; x++) {
        four[y][x] = cfa[y][x];
        three[y][x] = cfa[y][x] == 3 ? 1 : cfa[y][x];
      }
    float cam[3][4] = {};
    for (int y = 0; y < 3; y++)
      for (int x = 0; x < 3; x++)
        cam[y][x] = rgb_cam[y][x];
    const std::function<bool(double)> stop = [&](double) {
      return cancelled(context) != 0;
    };
    const float *const *in = raw.data();
    float **r = rows[0].data(), **g = rows[1].data(), **b = rows[2].data();
    rpError rc;
    // Fixed tuning: the RawTherapee 5.13 defaults.
    switch (method) {
    case AMAZE:
      rc = amaze_demosaic(width, height, 0, 0, width, height, in, r, g, b,
                          three, stop, init_gain, 0, 65535.f, 65535.f);
      break;
    case DCB:
      rc = dcb_demosaic(width, height, in, r, g, b, three, stop, 2, true);
      break;
    case AHD:
      rc = ahd_demosaic(width, height, in, r, g, b, three, cam, stop);
      break;
    case EAHD:
      rc = x3f_eahd_demosaic(width, height, in, r, g, b, three, cam, stop);
      break;
    case HPHD:
      rc = hphd_demosaic(width, height, in, r, g, b, three, stop);
      break;
    case IGV:
      rc = igv_demosaic(width, height, in, r, g, b, three, stop);
      break;
    case LMMSE:
      rc = lmmse_demosaic(width, height, in, r, g, b, three, stop, 2);
      break;
    case VNG4:
      rc = vng4_demosaic(width, height, in, r, g, b, four, stop);
      break;
    case FAST:
      // Fast limits sums of four sites to 4 * 65535 * init_gain.
      rc = bayerfast_demosaic(width, height, in, r, g, b, three, stop,
                              init_gain < 1 ? 1. : init_gain);
      break;
    default:
      return INTERNAL;
    }
    // These kernels leave wrong values near the image edge: in a flat color
    // field, LMMSE up to 160 % in its outer 7 pixels, IGV 17 % in the 2
    // pixels inside its 8-pixel border, and DCB 3 % at 3 pixels. RawTherapee
    // 5.13 has the same edges. The librtprocess border interpolation, which
    // the kernels use for their own outer pixels, replaces these bands.
    const int band = method == LMMSE ? 8 : method == IGV ? 10 : method == DCB ? 4 : 0;
    if (rc == RP_NO_ERROR && band && !cancelled(context))
      rc = bayerborder_demosaic(width, height, band, in, r, g, b, three);
    switch (rc) {
    case RP_NO_ERROR:
      return 0;
    case RP_MEMORY_ERROR:
      return NO_MEMORY;
    case RP_WRONG_CFA:
      return WRONG_CFA;
    default:
      return INTERNAL;
    }
  } catch (const std::bad_alloc &) {
    return NO_MEMORY;
  } catch (...) {
    return INTERNAL;
  }
}
}
