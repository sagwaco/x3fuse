"""Generate deterministic reference patches from spektrafilm experimental."""

import json
from dataclasses import replace
import os
from pathlib import Path
import subprocess
import sys
import tempfile


root = Path(sys.argv[1]).resolve()
revision = subprocess.check_output(
    ["git", "rev-parse", "HEAD"], cwd=root, text=True
).strip()
assert revision.startswith("28bf883"), "Use the pinned experimental checkout"
os.environ.setdefault("NUMBA_CACHE_DIR", str(Path(tempfile.gettempdir()) / "x3fuse-spektrafilm-numba"))
os.environ.setdefault("MPLCONFIGDIR", str(Path(tempfile.gettempdir()) / "x3fuse-spektrafilm-mpl"))
sys.dont_write_bytecode = True
sys.path.insert(0, str(root / "src"))

import numpy as np
from spektrafilm import digest_params, init_params, Simulator


patches = np.array([
    [0, 0, 0], [0.01, 0.01, 0.01], [0.184, 0.184, 0.184],
    [0.45, 0.28, 0.21], [0.1, 0.4, 0.05], [0.04, 0.1, 0.8],
    [1, 0, 0], [0, 1, 0], [0, 0, 1], [2, 2, 2],
    [-0.1, 0.4, 0.2], [4, 4, 4],
], dtype=float)
pairs = [
    ("kodak_portra_400", "kodak_portra_endura", False),
    ("kodak_vision3_50d", "kodak_2383", False),
    ("kodak_vision3_200t", "kodak_2383", False),
    ("fujifilm_pro_400h", "fujifilm_crystal_archive_typeii", False),
    ("kodak_kodachrome_64", "kodak_portra_endura", True),
    ("kodak_ektachrome_100", "kodak_portra_endura", True),
    ("kodak_doublex", "kodak_2302", False),
    ("kodak_trix", "kodak_2302", True),
]
cases = []
for film, paper, direct in pairs:
    for amount, gamma_film, gamma_paper, output, tune_m, tune_y in (
        [(a, 1.0, 1.0, "sRGB", 0.0, 0.0) for a in (0.0, 0.25, 1.0)]
        + [(0.25, g, 1.0, "sRGB", 0.0, 0.0) for g in (0.5, 2.0)]
        + [(1.0, 2.0, 1.0, "sRGB", 0.0, 0.0)]
        + ([] if direct else [(0.25, 1.0, g, "sRGB", 0.0, 0.0) for g in (0.5, 2.0)])
        + [(0.25, 1.0, 1.0, space, 0.0, 0.0) for space in ("Adobe RGB (1998)", "ProPhoto RGB")]
        + ([(0.25, 1.0, 1.0, "sRGB", 0.5, -0.25)] if film == "kodak_portra_400" else [])
    ):
        params = init_params(film, paper)
        params.camera.auto_exposure = False
        params.enlarger.print_exposure_compensation = False
        # X3Fuse trims span 20 Kodak CC units per unit of the control.
        params.enlarger.m_filter_shift = tune_m * 20.0
        params.enlarger.y_filter_shift = tune_y * 20.0
        params.io.input_color_space = "sRGB"
        params.io.input_cctf_decoding = False
        params.io.output_color_space = output
        params.io.output_cctf_encoding = False
        params.workflow.route = "input > film > scan" if direct else "input > film > print > scan"
        params.debug.deactivate_spatial_effects = True
        params.debug.deactivate_stochastic_effects = True
        params.film_render.glare.active = False
        params.film_render.dir_couplers.amount = amount
        params.film_render.chemistry = replace(params.film_render.chemistry, gamma_factor=gamma_film)
        params.print_render.chemistry = replace(params.print_render.chemistry, gamma_factor=gamma_paper)
        params.scanner.white_correction = False
        params.scanner.black_correction = False
        result = Simulator(digest_params(params)).process(patches[None, :, :])[0]
        assert result.shape == patches.shape and np.isfinite(result).all()
        cases.append({
            "film": film, "paper": paper, "direct": direct,
            "couplers": amount, "gamma_film": gamma_film, "gamma_paper": gamma_paper,
            "output_space": output, "tune_m": tune_m, "tune_y": tune_y,
            "linear_rgb": result.tolist(),
        })
        print(f"Generated {film} / {paper}, couplers={amount}, gamma={gamma_film}/{gamma_paper}, trim={tune_m}/{tune_y}, {output}", flush=True)

destination = Path(__file__).with_name("experimental_patches.json")
destination.write_text(json.dumps({
    "source": "spektrafilm by Andrea Volpato, experimental",
    "revision": revision,
    "input_linear_srgb": patches.tolist(),
    "cases": cases,
}, indent=2, allow_nan=False) + "\n")
print(destination)
