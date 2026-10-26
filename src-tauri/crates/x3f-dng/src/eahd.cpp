/*
 *  EAHD demosaic, ported from RawTherapee 5.13 rtengine/eahd_demosaic.cc
 *  (commit 1924179107995b01b73cdc7f4fe91e44fc8227a7, sha256
 *  d8bbe5fbdbab0932057f99de81eae14f09eb4be09141a930aef866e9e4aae4cc) and
 *  RawImageSource::interpolate_row_rb_mul_pp in rtengine/rawimagesource_i.h.
 *
 *  Copyright (c) 2004-2018 Gabor Horvath <hgabor@rawtherapee.com> and other
 *  RawTherapee contributors. Split out to own compilation unit and made
 *  speedup 2018 Ingo Weyrich (heckflosse67@gmx.de).
 *  Port to the librtprocess interface for X3Fuse, 2026.
 *
 *  This program is free software: you can redistribute it and/or modify it
 *  under the terms of the GNU General Public License as published by the Free
 *  Software Foundation, either version 3 of the License, or (at your option)
 *  any later version. See <https://www.gnu.org/licenses/>.
 *
 *  Changes from the upstream code:
 *  - Green interpolation keeps float values. Upstream truncates them to int.
 *  - CIELab uses the exact formula instead of a 65536-entry table.
 *  - The CIELab matrix is XYZ_from_sRGB * rgb_cam. Upstream multiplies by
 *    the transpose of rgb_cam. The upstream white scale is kept.
 *  - Rows 0 and H-1 get red and blue from the edge cases in
 *    interpolate_row_rb_mul_pp. Upstream skips these rows, because the
 *    function requires both neighbor rows.
 *  - The kernel stops when `cancelled` returns true.
 */

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <functional>
#include <utility>
#include <vector>

#include "librtprocess.h"

namespace {

struct Eahd {
  int W, H;
  const float *const *rawData;
  unsigned cfa[2][2];

  unsigned FC(int i, int j) const { return cfa[i & 1][j & 1]; }
  bool ISGREEN(int i, int j) const { return FC(i, j) == 1; }
  bool ISRED(int i, int j) const { return FC(i, j) == 0; }
  bool ISBLUE(int i, int j) const { return FC(i, j) == 2; }

  void interpolate_row_g(float *agh, float *agv, int i) const;
  void interpolate_row_rb(float *ar, float *ab, const float *pg,
                          const float *cg, const float *ng, int i) const;
  void interpolate_row_rb_mul_pp(float *ar, float *ab, const float *pg,
                                 const float *cg, const float *ng,
                                 int i) const;
};

inline float clip(float v) { return std::min(std::max(v, 0.f), 65535.f); }

void Eahd::interpolate_row_g(float *agh, float *agv, int i) const {
  for (int j = 0; j < W; j++) {
    if (ISGREEN(i, j)) {
      agh[j] = rawData[i][j];
      agv[j] = rawData[i][j];
    } else {
      float gh = 0;
      float gv = 0;

      if (j > 1 && j < W - 2) {
        gh = (-rawData[i][j - 2] + 2 * rawData[i][j - 1] + 2 * rawData[i][j] +
              2 * rawData[i][j + 1] - rawData[i][j + 2]) /
             4;
        float maxgh = std::max(rawData[i][j - 1], rawData[i][j + 1]);
        float mingh = std::min(rawData[i][j - 1], rawData[i][j + 1]);
        gh = std::min(std::max(gh, mingh), maxgh);
      } else if (j == 0) {
        gh = rawData[i][1];
      } else if (j == 1) {
        gh = (rawData[i][0] + rawData[i][2]) / 2;
      } else if (j == W - 1) {
        gh = rawData[i][W - 2];
      } else if (j == W - 2) {
        gh = (rawData[i][W - 1] + rawData[i][W - 3]) / 2;
      }

      if (i > 1 && i < H - 2) {
        gv = (-rawData[i - 2][j] + 2 * rawData[i - 1][j] + 2 * rawData[i][j] +
              2 * rawData[i + 1][j] - rawData[i + 2][j]) /
             4;
        float maxgv = std::max(rawData[i - 1][j], rawData[i + 1][j]);
        float mingv = std::min(rawData[i - 1][j], rawData[i + 1][j]);
        gv = std::min(std::max(gv, mingv), maxgv);
      } else if (i == 0) {
        gv = rawData[1][j];
      } else if (i == 1) {
        gv = (rawData[0][j] + rawData[2][j]) / 2;
      } else if (i == H - 1) {
        gv = rawData[H - 2][j];
      } else if (i == H - 2) {
        gv = (rawData[H - 1][j] + rawData[H - 3][j]) / 2;
      }

      agh[j] = gh;
      agv[j] = gv;
    }
  }
}

void Eahd::interpolate_row_rb(float *ar, float *ab, const float *pg,
                              const float *cg, const float *ng, int i) const {
  const auto getPg = [pg](int index) { return pg ? pg[index] : 0.f; };
  const auto getNg = [ng](int index) { return ng ? ng[index] : 0.f; };

  float *nonGreen1 = ar;
  float *nonGreen2 = ab;

  if (ISBLUE(i, 0) || ISBLUE(i, 1)) {
    std::swap(nonGreen1, nonGreen2);
  }
  int j = FC(i, 0) & 1;
  if (j) {
    // linear R-G interp. horizontally
    nonGreen1[0] = clip(cg[0] + rawData[i][1] - cg[1]);
    // linear B-G interp. vertically
    float val2;
    if (i == 0) {
      val2 = getNg(0) + rawData[1][0] - cg[0];
    } else if (i == H - 1) {
      val2 = getPg(0) + rawData[H - 2][0] - cg[0];
    } else {
      val2 = cg[0] + (rawData[i - 1][0] - getPg(0) + rawData[i + 1][0] -
                      getNg(0)) /
                         2;
    }
    nonGreen2[0] = val2;
  }
  // RGRGR or GRGRGR line
  for (; j < W - 1; j += 2) {
    // nonGreen of row is simple
    nonGreen1[j] = rawData[i][j];
    // non green of next row: cross interpolation
    float nonGreen = 0.f;
    int n = 0;

    if (i > 0) {
      if (j > 0) {
        nonGreen += rawData[i - 1][j - 1] - getPg(j - 1);
        n++;
      }
      nonGreen += rawData[i - 1][j + 1] - getPg(j + 1);
      n++;
    }

    if (i < H - 1) {
      if (j > 0) {
        nonGreen += rawData[i + 1][j - 1] - getNg(j - 1);
        n++;
      }
      nonGreen += rawData[i + 1][j + 1] - getNg(j + 1);
      n++;
    }

    nonGreen2[j] = cg[j] + nonGreen / std::max(n, 1);

    // linear R-G interp. horizontally
    float val1;
    if (j == W - 2) {
      val1 = cg[W - 1] + rawData[i][W - 2] - cg[W - 2];
    } else {
      val1 = cg[j + 1] +
             (rawData[i][j] - cg[j] + rawData[i][j + 2] - cg[j + 2]) / 2;
    }
    nonGreen1[j + 1] = clip(val1);
    // linear B-G interp. vertically
    float val2;
    if (i == 0) {
      val2 = getNg(j + 1) + rawData[1][j + 1] - cg[j + 1];
    } else if (i == H - 1) {
      val2 = getPg(j + 1) + rawData[H - 2][j + 1] - cg[j + 1];
    } else {
      val2 = cg[j + 1] + (rawData[i - 1][j + 1] - getPg(j + 1) +
                          rawData[i + 1][j + 1] - getNg(j + 1)) /
                             2;
    }
    nonGreen2[j + 1] = val2;
  }

  if (j == W - 1) {
    // nonGreen of row is simple
    nonGreen1[j] = rawData[i][j];
    // non green of next row: cross interpolation
    float nonGreen = 0.f;
    int n = 0;
    if (i > 0) {
      nonGreen += rawData[i - 1][j - 1] - getPg(j - 1);
      n++;
    }
    if (i < H - 1) {
      nonGreen += rawData[i + 1][j - 1] - getNg(j - 1);
      n++;
    }
    nonGreen2[j] = cg[j] + nonGreen / std::max(n, 1);
  }
}

// The multipliers of the upstream function are all one here.
void Eahd::interpolate_row_rb_mul_pp(float *ar, float *ab, const float *pg,
                                     const float *cg, const float *ng,
                                     int i) const {
  if (ISRED(i, 0) || ISRED(i, 1)) {
    // RGRGR or GRGRGR line
    for (int j = 0; j < W; j++) {
      if (ISRED(i, j)) {
        // red is simple
        ar[j] = rawData[i][j];
        // blue: cross interpolation
        float b = 0;
        int n = 0;
        if (i > 0 && j > 0) {
          b += rawData[i - 1][j - 1] - pg[j - 1];
          n++;
        }
        if (i > 0 && j < W - 1) {
          b += rawData[i - 1][j + 1] - pg[j + 1];
          n++;
        }
        if (i < H - 1 && j > 0) {
          b += rawData[i + 1][j - 1] - ng[j - 1];
          n++;
        }
        if (i < H - 1 && j < W - 1) {
          b += rawData[i + 1][j + 1] - ng[j + 1];
          n++;
        }
        b = cg[j] + b / std::max(1, n);
        ab[j] = std::max(0.f, b);
      } else {
        // linear R-G interp. horizontally
        float r;
        if (j == 0) {
          r = cg[0] + rawData[i][1] - cg[1];
        } else if (j == W - 1) {
          r = cg[W - 1] + rawData[i][W - 2] - cg[W - 2];
        } else {
          r = cg[j] +
              (rawData[i][j - 1] - cg[j - 1] + rawData[i][j + 1] - cg[j + 1]) /
                  2;
        }
        ar[j] = std::max(0.f, r);
        // linear B-G interp. vertically
        float b;
        if (i == 0) {
          b = ng[j] + rawData[1][j] - cg[j];
        } else if (i == H - 1) {
          b = pg[j] + rawData[H - 2][j] - cg[j];
        } else {
          b = cg[j] +
              (rawData[i - 1][j] - pg[j] + rawData[i + 1][j] - ng[j]) / 2;
        }
        ab[j] = std::max(0.f, b);
      }
    }
  } else {
    // BGBGB or GBGBGB line
    for (int j = 0; j < W; j++) {
      if (ISBLUE(i, j)) {
        // blue is simple
        ab[j] = rawData[i][j];
        // red: cross interpolation
        float r = 0;
        int n = 0;
        if (i > 0 && j > 0) {
          r += rawData[i - 1][j - 1] - pg[j - 1];
          n++;
        }
        if (i > 0 && j < W - 1) {
          r += rawData[i - 1][j + 1] - pg[j + 1];
          n++;
        }
        if (i < H - 1 && j > 0) {
          r += rawData[i + 1][j - 1] - ng[j - 1];
          n++;
        }
        if (i < H - 1 && j < W - 1) {
          r += rawData[i + 1][j + 1] - ng[j + 1];
          n++;
        }
        r = cg[j] + r / std::max(n, 1);
        ar[j] = std::max(0.f, r);
      } else {
        // linear B-G interp. horizontally
        float b;
        if (j == 0) {
          b = cg[0] + rawData[i][1] - cg[1];
        } else if (j == W - 1) {
          b = cg[W - 1] + rawData[i][W - 2] - cg[W - 2];
        } else {
          b = cg[j] +
              (rawData[i][j - 1] - cg[j - 1] + rawData[i][j + 1] - cg[j + 1]) /
                  2;
        }
        ab[j] = std::max(0.f, b);
        // linear R-G interp. vertically
        float r;
        if (i == 0) {
          r = ng[j] + rawData[1][j] - cg[j];
        } else if (i == H - 1) {
          r = pg[j] + rawData[H - 2][j] - cg[j];
        } else {
          r = cg[j] +
              (rawData[i - 1][j] - pg[j] + rawData[i + 1][j] - ng[j]) / 2;
        }
        ar[j] = std::max(0.f, r);
      }
    }
  }
}

// RawTherapee Color::computeXYZ2Lab and computeXYZ2LabY, scaled by 327.68.
constexpr double kappa = 24389.0 / 27.0;
constexpr double epsilon = 216.0 / 24389.0;

inline float lab_f(float v) {
  const double t = v / 65535.0;
  return float(327.68 * (t > epsilon ? std::cbrt(t) : (kappa * t + 16.0) / 116.0));
}

inline float lab_l(float v) {
  const double t = v / 65535.0;
  return float(327.68 * (t > epsilon ? 116.0 * std::cbrt(t) - 16.0 : kappa * t));
}

void rgb_to_lab(const float *R, const float *G, const float *B, float *L,
                float *a, float *b, const float wp[3][3], int width) {
  for (int i = 0; i < width; ++i) {
    const float x = wp[0][0] * R[i] + wp[0][1] * G[i] + wp[0][2] * B[i];
    const float y = wp[1][0] * R[i] + wp[1][1] * G[i] + wp[1][2] * B[i];
    const float z = wp[2][0] * R[i] + wp[2][1] * G[i] + wp[2][2] * B[i];
    const float fx = lab_f(x), fy = lab_f(y), fz = lab_f(z);
    L[i] = lab_l(y);
    a[i] = 500.f * (fx - fy);
    b[i] = 200.f * (fy - fz);
  }
}

// Rows of a ring buffer.
template <typename T> struct Rows {
  std::vector<T> data;
  int width;
  Rows(int width, int rows) : data(size_t(width) * rows), width(width) {}
  T *operator[](int row) { return data.data() + size_t(row) * width; }
};

inline float dist(float a, float b) { return std::fabs(a - b); }

} // namespace

rpError x3f_eahd_demosaic(int W, int H, const float *const *rawData,
                          float **red, float **green, float **blue,
                          const unsigned cfa[2][2], const float rgb_cam[3][4],
                          const std::function<bool(double)> &cancelled) {
  Eahd e{W, H, rawData, {{cfa[0][0], cfa[0][1]}, {cfa[1][0], cfa[1][1]}}};

  // XYZ from sRGB, without the D65 white scale (as upstream).
  constexpr float xyz_rgb[3][3] = {{0.412453f, 0.357580f, 0.180423f},
                                   {0.212671f, 0.715160f, 0.072169f},
                                   {0.019334f, 0.119193f, 0.950227f}};
  float wp[3][3];
  for (int i = 0; i < 3; i++)
    for (int j = 0; j < 3; j++) {
      wp[i][j] = 0;
      for (int k = 0; k < 3; k++)
        wp[i][j] += xyz_rgb[i][k] * rgb_cam[k][j];
    }

  Rows<float> rh(W, 3), gh(W, 4), bh(W, 3), rv(W, 3), gv(W, 4), bv(W, 3),
      lLh(W, 3), lah(W, 3), lbh(W, 3), lLv(W, 3), lav(W, 3), lbv(W, 3);
  Rows<uint16_t> homh(W, 3), homv(W, 3);

  // interpolate first two lines
  e.interpolate_row_g(gh[0], gv[0], 0);
  e.interpolate_row_g(gh[1], gv[1], 1);
  e.interpolate_row_g(gh[2], gv[2], 2);
  e.interpolate_row_rb(rh[0], bh[0], nullptr, gh[0], gh[1], 0);
  e.interpolate_row_rb(rv[0], bv[0], nullptr, gv[0], gv[1], 0);
  e.interpolate_row_rb(rh[1], bh[1], gh[0], gh[1], gh[2], 1);
  e.interpolate_row_rb(rv[1], bv[1], gv[0], gv[1], gv[2], 1);

  rgb_to_lab(rh[0], gh[0], bh[0], lLh[0], lah[0], lbh[0], wp, W);
  rgb_to_lab(rv[0], gv[0], bv[0], lLv[0], lav[0], lbv[0], wp, W);
  rgb_to_lab(rh[1], gh[1], bh[1], lLh[1], lah[1], lbh[1], wp, W);
  rgb_to_lab(rv[1], gv[1], bv[1], lLv[1], lav[1], lbv[1], wp, W);

  // Rows<> starts at zero, as the upstream homogeneity maps do.

  float dLmaph[9];
  float dLmapv[9];
  float dCamaph[9];
  float dCamapv[9];
  float dCbmaph[9];
  float dCbmapv[9];

  for (int i = 1; i < H - 1; i++) {
    if (i % 64 == 0 && cancelled(double(i) / H)) {
      return RP_NO_ERROR;
    }
    int mod[3] = {(i - 1) % 3, i % 3, (i + 1) % 3};
    int ix = i % 3;
    int imx = (i - 1) % 3;
    int ipx = (i + 1) % 3;

    if (i < H - 2) {
      e.interpolate_row_g(gh[(i + 2) % 4], gv[(i + 2) % 4], i + 2);
      e.interpolate_row_rb(rh[(i + 1) % 3], bh[(i + 1) % 3], gh[i % 4],
                           gh[(i + 1) % 4], gh[(i + 2) % 4], i + 1);
      e.interpolate_row_rb(rv[(i + 1) % 3], bv[(i + 1) % 3], gv[i % 4],
                           gv[(i + 1) % 4], gv[(i + 2) % 4], i + 1);
    } else {
      e.interpolate_row_rb(rh[(i + 1) % 3], bh[(i + 1) % 3], gh[i % 4],
                           gh[(i + 1) % 4], nullptr, i + 1);
      e.interpolate_row_rb(rv[(i + 1) % 3], bv[(i + 1) % 3], gv[i % 4],
                           gv[(i + 1) % 4], nullptr, i + 1);
    }

    rgb_to_lab(rh[(i + 1) % 3], gh[(i + 1) % 4], bh[(i + 1) % 3],
               lLh[(i + 1) % 3], lah[(i + 1) % 3], lbh[(i + 1) % 3], wp, W);
    rgb_to_lab(rv[(i + 1) % 3], gv[(i + 1) % 4], bv[(i + 1) % 3],
               lLv[(i + 1) % 3], lav[(i + 1) % 3], lbv[(i + 1) % 3], wp, W);

    for (int j = 0; j < W; j++) {
      homh[ipx][j] = 0;
      homv[ipx][j] = 0;
    }

    for (int j = 1; j < W - 1; j++) {
      int dmi = 0;
      for (int x = -1; x <= 0; x++) {
        int idx = mod[x + 1];

        for (int y = -1; y <= 1; y++) {
          // compute distance in a, b, and L
          if (dmi < 4) {
            int sh = homh[idx][j + y];
            int sv = homv[idx][j + y];

            if (sh > sv) { // fixate horizontal pixel
              dLmaph[dmi] = dist(lLh[ix][j], lLh[idx][j + y]);
              dCamaph[dmi] = dist(lah[ix][j], lah[idx][j + y]);
              dCbmaph[dmi] = dist(lbh[ix][j], lbh[idx][j + y]);
              dLmapv[dmi] = dist(lLv[ix][j], lLh[idx][j + y]);
              dCamapv[dmi] = dist(lav[ix][j], lah[idx][j + y]);
              dCbmapv[dmi] = dist(lbv[ix][j], lbh[idx][j + y]);
            } else if (sh < sv) {
              dLmaph[dmi] = dist(lLh[ix][j], lLv[idx][j + y]);
              dCamaph[dmi] = dist(lah[ix][j], lav[idx][j + y]);
              dCbmaph[dmi] = dist(lbh[ix][j], lbv[idx][j + y]);
              dLmapv[dmi] = dist(lLv[ix][j], lLv[idx][j + y]);
              dCamapv[dmi] = dist(lav[ix][j], lav[idx][j + y]);
              dCbmapv[dmi] = dist(lbv[ix][j], lbv[idx][j + y]);
            } else {
              dLmaph[dmi] = dist(lLh[ix][j], lLh[idx][j + y]);
              dCamaph[dmi] = dist(lah[ix][j], lah[idx][j + y]);
              dCbmaph[dmi] = dist(lbh[ix][j], lbh[idx][j + y]);
              dLmapv[dmi] = dist(lLv[ix][j], lLv[idx][j + y]);
              dCamapv[dmi] = dist(lav[ix][j], lav[idx][j + y]);
              dCbmapv[dmi] = dist(lbv[ix][j], lbv[idx][j + y]);
            }
          } else {
            dLmaph[dmi] = dist(lLh[ix][j], lLh[idx][j + y]);
            dCamaph[dmi] = dist(lah[ix][j], lah[idx][j + y]);
            dCbmaph[dmi] = dist(lbh[ix][j], lbh[idx][j + y]);
            dLmapv[dmi] = dist(lLv[ix][j], lLv[idx][j + y]);
            dCamapv[dmi] = dist(lav[ix][j], lav[idx][j + y]);
            dCbmapv[dmi] = dist(lbv[ix][j], lbv[idx][j + y]);
          }

          dmi++;
        }
      }
      int idx = mod[2];

      for (int y = -1; y <= 1; y++) {
        // compute distance in a, b, and L
        dLmaph[dmi] = dist(lLh[ix][j], lLh[idx][j + y]);
        dCamaph[dmi] = dist(lah[ix][j], lah[idx][j + y]);
        dCbmaph[dmi] = dist(lbh[ix][j], lbh[idx][j + y]);
        dLmapv[dmi] = dist(lLv[ix][j], lLv[idx][j + y]);
        dCamapv[dmi] = dist(lav[ix][j], lav[idx][j + y]);
        dCbmapv[dmi] = dist(lbv[ix][j], lbv[idx][j + y]);
        dmi++;
      }

      // compute eL & eC
      float eL = std::min(std::max(dLmaph[3], dLmaph[5]),
                          std::max(dLmapv[1], dLmapv[7]));
      float eCa = std::min(std::max(dCamaph[3], dCamaph[5]),
                           std::max(dCamapv[1], dCamapv[7]));
      float eCb = std::min(std::max(dCbmaph[3], dCbmaph[5]),
                           std::max(dCbmapv[1], dCbmapv[7]));

      int wh = 0;
      for (int d = 0; d < 9; ++d) {
        wh += (dLmaph[d] <= eL) * (dCamaph[d] <= eCa) * (dCbmaph[d] <= eCb);
      }

      for (int r : {imx, ix, ipx})
        for (int k = -1; k <= 1; k++)
          homh[r][j + k] += wh;

      int wv = 0;
      for (int d = 0; d < 9; ++d) {
        wv += (dLmapv[d] <= eL) * (dCamapv[d] <= eCa) * (dCbmapv[d] <= eCb);
      }

      for (int r : {imx, ix, ipx})
        for (int k = -1; k <= 1; k++)
          homv[r][j + k] += wv;
    }

    // finalize image
    for (int j = 0; j < W; j++) {
      if (e.ISGREEN(i - 1, j)) {
        green[i - 1][j] = rawData[i - 1][j];
      } else {
        int hc = homh[imx][j];
        int vc = homv[imx][j];

        if (hc > vc) {
          green[i - 1][j] = std::max(0.f, gh[(i - 1) % 4][j]);
        } else if (hc < vc) {
          green[i - 1][j] = std::max(0.f, gv[(i - 1) % 4][j]);
        } else {
          green[i - 1][j] =
              std::max(0.f, (gh[(i - 1) % 4][j] + gv[(i - 1) % 4][j]) / 2);
        }
      }
    }
  }

  // finish H-2th and H-1th row, homogeneity value is still available
  for (int i = H - 1; i < H + 1; i++)
    for (int j = 0; j < W; j++) {
      int hc = homh[(i - 1) % 3][j];
      int vc = homv[(i - 1) % 3][j];

      if (hc > vc) {
        green[i - 1][j] = std::max(0.f, gh[(i - 1) % 4][j]);
      } else if (hc < vc) {
        green[i - 1][j] = std::max(0.f, gv[(i - 1) % 4][j]);
      } else {
        green[i - 1][j] =
            std::max(0.f, (gh[(i - 1) % 4][j] + gv[(i - 1) % 4][j]) / 2);
      }
    }

  // Interpolate R and B. Edge rows pass the one neighbor row twice; the
  // function reads only the existing row there.
  for (int i = 0; i < H; i++) {
    if (i % 64 == 0 && cancelled(double(i) / H)) {
      return RP_NO_ERROR;
    }
    const float *pg = i > 0 ? green[i - 1] : green[i + 1];
    const float *ng = i < H - 1 ? green[i + 1] : green[i - 1];
    e.interpolate_row_rb_mul_pp(red[i], blue[i], pg, green[i], ng, i);
  }
  return RP_NO_ERROR;
}
