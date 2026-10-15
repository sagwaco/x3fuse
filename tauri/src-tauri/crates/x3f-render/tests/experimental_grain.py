"""Measure grain calibration and local density normalization from spektrafilm experimental."""

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
from scipy.ndimage import gaussian_filter
from spektrafilm import digest_params,init_params
from spektrafilm.runtime.pipeline import SimulationPipeline
from spektrafilm.model.grain import _layer_grain_params,apply_grain
import json
out=[]
for name in ['kodak_portra_400','kodak_vision3_500t','kodak_ektachrome_100','kodak_doublex','kodak_trix','kodak_verita_200d']:
 p=SimulationPipeline(digest_params(init_params(name,'kodak_portra_endura')))
 dc=p.film.data.density_curves; dl=p.film.data.density_curves_layers; g=p.film_render.grain
 dm,dmn,dmx,npp=_layer_grain_params(np.max(dl,axis=0),g.density_min,g.rms_granularity,g.particle_scale_sublayers,g.uniformity,dc.shape[-1],5,density_curves_layers=dl)
 out.append(dict(stock=name,npp=npp.tolist(),density_max=dmx.tolist(),density_min=dmn.tolist(),rms=g.rms_granularity))

 for size in [1,4]:
  for label,net in [('flat',np.ones((512,512,dc.shape[-1]))),('edge',np.broadcast_to(np.where(np.arange(512)<256,.1,2)[None,:,None],(512,512,dc.shape[-1])).copy())]:
   g.mult_usm_amount=0;g.blur=.89*size;g.blur_dye_clouds_um=2
   grain=apply_grain(net,5/size,g,dc-np.min(dc,axis=0),dl,p.film.info.type)+dm
   blur=gaussian_filter(grain,(.7*size,.7*size,0),truncate=3)
   sharp=np.maximum(grain,1e-6)**2.5/np.maximum(blur,1e-6)**1.5
   reference=sharp*(grain.sum((0,1))/sharp.sum((0,1)))
   local=sharp*gaussian_filter(grain/np.maximum(gaussian_filter(sharp,(.7*size,.7*size,0),truncate=3),1e-6),(.7*size,.7*size,0),truncate=3)
   print('USM',name,size,label,'raw_mass_bias',((sharp.mean((0,1))/grain.mean((0,1)))-1).tolist(),'local_rmse',np.sqrt(np.mean((local-reference)**2,axis=(0,1))).tolist(),'ref_std',reference.std((0,1)).tolist(),flush=True)
print(json.dumps(out,indent=2))
