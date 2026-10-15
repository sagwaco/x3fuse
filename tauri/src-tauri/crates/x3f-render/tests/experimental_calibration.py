"""Generate CPU reference values from spektrafilm experimental 28bf883."""
from dataclasses import replace
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

root = Path(sys.argv[1]).resolve()
destination = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).with_name("experimental_calibration.json")
revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
assert revision.startswith("28bf883"), "Use the pinned experimental checkout"
os.environ.setdefault("NUMBA_CACHE_DIR", str(Path(tempfile.gettempdir()) / "x3fuse-spektrafilm-numba"))
os.environ.setdefault("MPLCONFIGDIR", str(Path(tempfile.gettempdir()) / "x3fuse-spektrafilm-mpl"))
sys.dont_write_bytecode = True
sys.path.insert(0, str(root / "src"))

import numpy as np
from spektrafilm import digest_params, init_params, load_profile
from spektrafilm.model.couplers import (
    compute_density_curves_before_dir_couplers, compute_dir_couplers_matrix,
    langmuir_donor_params, receiver_langmuir_params,
)
from spektrafilm.model.density_curves import refresh_density_curves_from_model, select_development_time
from spektrafilm.model.illuminants import standard_illuminant
from spektrafilm.runtime.pipeline import SimulationPipeline
from spektrafilm.utils.morph_curves import FilmChemistryParams, apply_print_curves_morph_with_layers


def pipeline(stock, gamma=1.0):
    params = init_params(stock, "kodak_portra_endura")
    params.camera.auto_exposure = False
    params.enlarger.print_exposure_compensation = False
    params.io.input_color_space = "sRGB"
    params.io.input_cctf_decoding = False
    params.film_render.chemistry = replace(params.film_render.chemistry, gamma_factor=gamma)
    return SimulationPipeline(digest_params(params))


runtime = pipeline("kodak_portra_400")
sensitivity = np.nan_to_num(10 ** runtime.film.data.log_sensitivity)
tc_lut = runtime._lut_service.get_filming_tc_lut(
    runtime.settings.rgb_to_raw_method, sensitivity, runtime.film.info.reference_illuminant)
assert runtime.settings.rgb_to_raw_method == "hanatos2025" and tc_lut.shape == (192, 192, 3)
neutral = [runtime.enlarger.c_filter_neutral, runtime.enlarger.m_filter_neutral, runtime.enlarger.y_filter_neutral]
illuminant = runtime._enlarger_service.enlarger_filtered_illuminant(standard_illuminant(runtime.enlarger.illuminant))
paper_sensitivity = np.nan_to_num(10 ** runtime.print.data.log_sensitivity)
calibration = {
    "film": "kodak_portra_400", "paper": "kodak_portra_endura",
    "lut_nodes": [{"i": i, "j": j, "rgb": tc_lut[i, j].tolist()}
                  for i, j in [(0, 0), (37, 91), (95, 95), (191, 191), (10, 180)]],
    "neutral_filters": neutral,
    "illuminant_samples": [{"index": i, "value": float(illuminant[i])} for i in [0, 20, 40, 60, 80]],
    "print_exposure_factor": np.asarray(runtime._printing_stage._compute_exposure_factor_midgray(paper_sensitivity, illuminant)).item(),
}
chemistry = []
for stock in ["kodak_portra_400", "kodak_ektachrome_100", "kodak_portra_endura", "kodak_doublex", "kodak_trix", "kodak_2302"]:
    profile = load_profile(stock)
    refresh_density_curves_from_model(profile.data, profile.info.type)
    select_development_time(profile.data, None)
    for gamma in [0.5, 1.0, 2.0]:
        total, layers = apply_print_curves_morph_with_layers(
            profile.data.log_exposure, profile.data.density_curves_model,
            FilmChemistryParams(gamma_factor=gamma), profile_type=profile.info.type)
        chemistry.append({"stock": stock, "gamma": gamma, "index": 128,
                          "total": total[128].tolist(), "layer": layers[128, 1].tolist()})

inverse = []
for stock, amount, index, channel in [("fujifilm_pro_400h", 1.0, 79, 1), ("kodak_kodachrome_64", 1.0, 79, 0)]:
    runtime = pipeline(stock, gamma=2.0)
    film, couplers = runtime.film, runtime.film_render.dir_couplers
    matrix = compute_dir_couplers_matrix(couplers)
    curves = film.data.density_curves - np.nanmin(film.data.density_curves, axis=0)
    knee, reference = langmuir_donor_params(curves, couplers.langmuir_donor_k_rgb, n_ch=3)
    receiver_knee, receiver_reference = receiver_langmuir_params(reference, matrix, couplers.langmuir_receiver_k_rgb, 3)
    positive = film.info.type == "positive"
    result = compute_density_curves_before_dir_couplers(
        curves, film.data.log_exposure, matrix * amount,
        langmuir_k=None if positive else knee, langmuir_d_ref=reference,
        receiver_kr=receiver_knee if positive else None,
        receiver_c_ref=receiver_reference if positive else None, positive=positive)
    inverse.append({"stock": stock, "gamma": 2.0, "amount": amount, "index": index,
                    "channel": channel, "density": float(result[index, channel])})

destination.write_text(json.dumps({"source": "spektrafilm by Andrea Volpato, experimental", "revision": revision,
                                   "calibration": calibration, "chemistry": chemistry, "folded_inverse": inverse},
                                  indent=2, allow_nan=False) + "\n")
print(destination)
