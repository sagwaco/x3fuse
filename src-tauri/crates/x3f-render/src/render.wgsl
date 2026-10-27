// X3Fuse scene-linear editing. The film stages are a GPL-3.0-only port of
// spektrafilm-rs (turbasvin, v0.1.2 / 9dd59b0), which implements the
// spektrafilm model by Andrea Volpato. Data attribution and pinned hashes:
// assets/PROVENANCE.md; source attribution: NOTICE.
struct Pixels { v: array<vec4<f32>> }
struct Table { v: array<f32> }
struct Uniforms { v: array<vec4<f32>, 63> }
@group(0) @binding(0) var<storage, read> source: Pixels;
@group(0) @binding(1) var<storage, read> auxiliary: Pixels;
@group(0) @binding(2) var<storage, read_write> destination: Pixels;
@group(0) @binding(3) var<uniform> p: Uniforms;
@group(0) @binding(4) var<storage, read> spectral: Table;
@group(0) @binding(5) var<storage, read> tc_lut: Table;
@group(0) @binding(6) var<storage, read> curves: Pixels;
@group(0) @binding(7) var<storage, read> output_gamut: Table;
@group(1) @binding(0) var raw_source: texture_2d<f32>;
@group(1) @binding(1) var<storage, read_write> frame: array<u32>;
@group(1) @binding(2) var<storage, read> fill: array<vec2<f32>>;

// Offsets into `spectral`, mirroring film::offset.
const K: u32 = 256u;
const N_WL: u32 = 81u;
const SP_FILM_LOG_EXP: u32 = 0u;
const SP_FILM_CURVES: u32 = 256u;
const SP_FILM_CURVES_0: u32 = 1024u;
const SP_FILM_DYE: u32 = 1792u;
const SP_FILM_BASE: u32 = 2035u;
const SP_PRINT_ILLUM: u32 = 2116u;
const SP_PAPER_SENS: u32 = 2197u;
const SP_PAPER_LOG_EXP: u32 = 2440u;
const SP_PAPER_CURVES: u32 = 2696u;
const SP_SCAN_DYE: u32 = 3464u;
const SP_SCAN_BASE: u32 = 3707u;
const SP_SCAN_ILLUM_CMF: u32 = 3788u;
const LUT_SIZE: u32 = 192u;
const INV_LN10: f32 = 0.4342944819032518;

fn index(pos: vec2<u32>) -> u32 { return pos.y * u32(p.v[0].x) + pos.x; }
fn in_bounds(pos: vec2<u32>) -> bool { return all(pos < vec2<u32>(p.v[0].xy)); }
fn load_at(pos: vec2<i32>) -> vec3<f32> {
    let at = vec2<u32>(clamp(pos, vec2<i32>(0), vec2<i32>(p.v[0].xy)-1));
    return source.v[index(at)].rgb;
}
fn encode_srgb(c: vec3<f32>) -> vec3<f32> {
    return select(1.055*pow(max(c,vec3<f32>(0)),vec3<f32>(1.0/2.4))-0.055,12.92*c,c<=vec3<f32>(0.0031308));
}
fn decode_srgb(c: vec3<f32>) -> vec3<f32> {
    return select(pow(max((c+0.055)/1.055,vec3<f32>(0)),vec3<f32>(2.4)),c/12.92,c<=vec3<f32>(0.04045));
}
fn log10v(c: vec3<f32>) -> vec3<f32> { return log(max(c,vec3<f32>(0))+1e-10)*INV_LN10; }
fn matrix_at(slot: u32, c: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(dot(p.v[slot].xyz,c),dot(p.v[slot+1u].xyz,c),dot(p.v[slot+2u].xyz,c));
}

// ── Front pass: linear sRGB -> film raw exposure (hanatos2025) ─────────────
// Mitchell-Netravali B=C=1/3, the kernel spektrafilm samples its tc LUT with.
fn mitchell(t: f32) -> f32 {
    let a = abs(t); let b = 1.0/3.0;
    if a < 1.0 { return ((12.0-15.0*b)*a*a*a+(-18.0+18.0*b)*a*a+(6.0-2.0*b))/6.0; }
    if a < 2.0 { return ((-7.0*b)*a*a*a+(36.0*b)*a*a+(-60.0*b)*a+32.0*b)/6.0; }
    return 0.0;
}
fn reflect_index(i: i32) -> u32 {
    let n = i32(LUT_SIZE);
    var idx = abs(i) % (2*(n-1));
    if idx >= n { idx = 2*(n-1)-idx; }
    return u32(clamp(idx,0,n-1));
}
fn sample_tc(tc: vec2<f32>) -> vec3<f32> {
    let limit = f32(LUT_SIZE-1u);
    let at = clamp(tc*limit, vec2<f32>(0), vec2<f32>(limit));
    let base = min(vec2<i32>(floor(at)), vec2<i32>(i32(LUT_SIZE)-2));
    let f = at - vec2<f32>(base);
    var sum = vec3<f32>(0); var weight = 0.0;
    for (var j=0; j<4; j++) {
        let wy = mitchell(f.y-f32(j-1));
        let sy = reflect_index(base.y+j-1);
        for (var i=0; i<4; i++) {
            let w = mitchell(f.x-f32(i-1))*wy;
            let sx = reflect_index(base.x+i-1);
            let cell = (sx*LUT_SIZE+sy)*3u;
            weight += w;
            sum += w*vec3<f32>(tc_lut.v[cell],tc_lut.v[cell+1u],tc_lut.v[cell+2u]);
        }
    }
    return select(sum, sum/weight, weight != 0.0);
}

// ── Density curves: uniform log-exposure axis, endpoint clamped ────────────
fn develop_curve(axis: u32, table: u32, gamma_inv: f32, log_raw: vec3<f32>) -> vec3<f32> {
    let lo = spectral.v[axis]*gamma_inv;
    let hi = spectral.v[axis+K-1u]*gamma_inv;
    let t = clamp((log_raw-vec3<f32>(lo))/((hi-lo)/f32(K-1u)), vec3<f32>(0), vec3<f32>(f32(K-1u)));
    let cell = vec3<u32>(min(vec3<u32>(floor(t)), vec3<u32>(K-2u)));
    let f = t-vec3<f32>(cell);
    var out = vec3<f32>(0);
    for (var c=0u; c<3u; c++) {
        let a = spectral.v[table+cell[c]*3u+c];
        let b = spectral.v[table+(cell[c]+1u)*3u+c];
        out[c] = a+f[c]*(b-a);
    }
    return out;
}

// ── Grain: Poisson-binomial particle model (spektrafilm grain.wgsl) ────────
fn pcg(state: u32) -> u32 {
    let s = state*747796405u+2891336453u;
    let word = ((s >> ((s >> 28u)+4u)) ^ s)*277803737u;
    return (word >> 22u) ^ word;
}
fn splitmix32(x: u32) -> u32 {
    var z = (x ^ (x >> 16u))*0x85ebca6bu;
    z = (z ^ (z >> 13u))*0xc2b2ae35u;
    return z ^ (z >> 16u);
}
fn standard_normal(state: ptr<function,u32>) -> f32 {
    var s = pcg(*state); let u1 = f32(s)*(1.0/4294967296.0);
    s = pcg(s); let u2 = f32(s)*(1.0/4294967296.0);
    *state = s;
    return sqrt(-2.0*log(max(u1,1e-7)))*cos(6.28318530717958647*u2);
}
// X3Fuse extension: grain roughness. A smooth random field in [-1, 1] over
// cells of `size` native pixels, anchored like the grain RNG.
fn cell_noise(cell: vec2<u32>, seed: u32) -> f32 {
    return f32(splitmix32(splitmix32(cell.x+seed*0x9e3779b9u)^cell.y))*(2.0/4294967295.0)-1.0;
}
fn clump_field(native: vec2<f32>, size: f32, seed: u32) -> f32 {
    let q=native/size;let c=vec2<u32>(q);let f=fract(q);let s=f*f*(3.0-2.0*f);
    let top=mix(cell_noise(c,seed),cell_noise(c+vec2<u32>(1u,0u),seed),s.x);
    let bottom=mix(cell_noise(c+vec2<u32>(0u,1u),seed),cell_noise(c+vec2<u32>(1u,1u),seed),s.x);
    return mix(top,bottom,s.y);
}

@compute @workgroup_size(16,8)
fn expose(@builtin(global_invocation_id) id:vec3<u32>) {
    let pos=id.xy;if !in_bounds(pos) {return;}let i=index(pos);
    let xyz=matrix_at(18u,source.v[i].rgb*p.v[16].x);
    let b=xyz.x+xyz.y+xyz.z;
    if b<=1e-10 { destination.v[i]=vec4<f32>(0,0,0,1); return; }
    let chroma=xyz.xy/b;
    let tc=vec2<f32>(clamp((1.0-chroma.x)*(1.0-chroma.x),0.0,1.0),
                     clamp(chroma.y/max(1.0-chroma.x,1e-10),0.0,1.0));
    destination.v[i]=vec4<f32>(sample_tc(tc)*b,1);
}
// Halation scatter mix at spektrafilm's default scatter_amount of 1.0, with the
// recipe's per-channel scatter strength as the tail weight.
@compute @workgroup_size(16,8)
fn scatter_mix(@builtin(global_invocation_id) id:vec3<u32>) {
    let pos=id.xy;if !in_bounds(pos) {return;}let i=index(pos);let w=p.v[37].xyz;
    destination.v[i]=vec4<f32>((1.0-w)*source.v[i].rgb+w*auxiliary.v[i].rgb,source.v[i].w);
}
@compute @workgroup_size(16,8)
fn combine(@builtin(global_invocation_id) id:vec3<u32>) {
    let pos=id.xy;if !in_bounds(pos) {return;}let i=index(pos);
    destination.v[i]=vec4<f32>(p.v[21].x*source.v[i].rgb+p.v[21].y*auxiliary.v[i].rgb,source.v[i].w);
}
// Multi-bounce halation add and renormalize. `halation_midtones` gates the
// added light by the blurred signal level, keeping halation in the highlights.
@compute @workgroup_size(16,8)
fn halation_finish(@builtin(global_invocation_id) id:vec3<u32>) {
    let pos=id.xy;if !in_bounds(pos) {return;}let i=index(pos);
    let base=source.v[i].rgb;let bounced=auxiliary.v[i].rgb;
    let level=max(0.0,dot(bounced,vec3<f32>(1.0/3.0)));
    let gate=mix(1.0,level/(level+0.18),p.v[38].w);
    destination.v[i]=vec4<f32>((base+p.v[38].xyz*gate*bounced)*p.v[39].xyz,source.v[i].w);
}
@compute @workgroup_size(16,8)
fn develop(@builtin(global_invocation_id) id:vec3<u32>) {
    let pos=id.xy;if !in_bounds(pos) {return;}let i=index(pos);
    destination.v[i]=vec4<f32>(develop_curve(SP_FILM_LOG_EXP,SP_FILM_CURVES,p.v[16].y,log10v(source.v[i].rgb)),1);
}
@compute @workgroup_size(16,8)
fn dir_matmul(@builtin(global_invocation_id) id:vec3<u32>) {
    let pos=id.xy;if !in_bounds(pos) {return;}let i=index(pos);
    var silver=source.v[i].rgb;
    if p.v[32].w>0.5 {
        silver=p.v[32].xyz-silver;
    } else {
        silver=silver*1.5*p.v[32].xyz/max(p.v[32].xyz+silver,vec3<f32>(1e-20));
    }
    destination.v[i]=vec4<f32>(p.v[29].xyz*silver.x+p.v[30].xyz*silver.y+p.v[31].xyz*silver.z,1);
}
@compute @workgroup_size(16,8)
fn dir_develop(@builtin(global_invocation_id) id:vec3<u32>) {
    let pos=id.xy;if !in_bounds(pos) {return;}let i=index(pos);
    var inhibitor=auxiliary.v[i].rgb;
    if p.v[32].w>0.5 {
        inhibitor=inhibitor*3.0*p.v[51].xyz/max(2.0*p.v[51].xyz+inhibitor,vec3<f32>(1e-20));
    }
    let corrected=log10v(source.v[i].rgb)-inhibitor;
    destination.v[i]=vec4<f32>(develop_curve(SP_FILM_LOG_EXP,SP_FILM_CURVES_0,p.v[16].y,corrected),1);
}
@compute @workgroup_size(16,8)
fn print_spectral(@builtin(global_invocation_id) id:vec3<u32>) {
    let pos=id.xy;if !in_bounds(pos) {return;}let i=index(pos);
    let cmy=source.v[i].rgb;var raw=vec3<f32>(0);
    for (var wl=0u; wl<N_WL; wl++) {
        let dye=wl*3u;
        let d=cmy.x*spectral.v[SP_FILM_DYE+dye]+cmy.y*spectral.v[SP_FILM_DYE+dye+1u]
             +cmy.z*spectral.v[SP_FILM_DYE+dye+2u]+spectral.v[SP_FILM_BASE+wl];
        let light=pow(10.0,-d)*spectral.v[SP_PRINT_ILLUM+wl];
        raw+=light*vec3<f32>(spectral.v[SP_PAPER_SENS+dye],spectral.v[SP_PAPER_SENS+dye+1u],spectral.v[SP_PAPER_SENS+dye+2u]);
    }
    destination.v[i]=vec4<f32>(log10v(raw*p.v[17].x),1);
}
@compute @workgroup_size(16,8)
fn print_develop(@builtin(global_invocation_id) id:vec3<u32>) {
    let pos=id.xy;if !in_bounds(pos) {return;}let i=index(pos);
    destination.v[i]=vec4<f32>(develop_curve(SP_PAPER_LOG_EXP,SP_PAPER_CURVES,p.v[16].z,source.v[i].rgb),1);
}
@compute @workgroup_size(16,8)
fn scan(@builtin(global_invocation_id) id:vec3<u32>) {
    let pos=id.xy;if !in_bounds(pos) {return;}let i=index(pos);
    // Warmth changes the developed silver amount before optical scanning.
    let silver=p.v[37].w>0.5;
    let cmy=source.v[i].rgb*p.v[62].y;var xyz=vec3<f32>(0);
    for (var wl=0u; wl<N_WL; wl++) {
        let dye=wl*3u;
        let d=cmy.x*spectral.v[SP_SCAN_DYE+dye]+cmy.y*spectral.v[SP_SCAN_DYE+dye+1u]
             +cmy.z*spectral.v[SP_SCAN_DYE+dye+2u]+spectral.v[SP_SCAN_BASE+wl];
        xyz+=pow(10.0,-d)*vec3<f32>(spectral.v[SP_SCAN_ILLUM_CMF+dye],spectral.v[SP_SCAN_ILLUM_CMF+dye+1u],spectral.v[SP_SCAN_ILLUM_CMF+dye+2u]);
    }
    xyz/=p.v[17].y;
    // Scanner white and black correction (spektrafilm scan_spectral): remap
    // luminance so paper white and the deepest black reach the scanner's
    // levels, keeping chromaticity.
    if p.v[28].w>0.5 {xyz*=clamp(p.v[26].w*xyz.y+p.v[27].w,0.0,1.0)/(xyz.y+1e-10);}
    destination.v[i]=vec4<f32>(matrix_at(26u,xyz),select(1.0,max(0.0,dot(cmy,vec3<f32>(1.0/3.0))),silver));
}
@compute @workgroup_size(16,8)
fn sample(@builtin(global_invocation_id) id:vec3<u32>) {
    let pos=id.xy;if !in_bounds(pos) { return; }
    let global=vec3<f32>(vec2<f32>(pos)+p.v[0].zw+0.5,1.0);
    let bounds=vec2<i32>(textureDimensions(raw_source))-1;
    let h=vec3<f32>(dot(p.v[24].xyz,global),dot(p.v[25].xyz,global),dot(p.v[40].xyz,global));
    let at=clamp(h.xy/h.z,vec2<f32>(0),vec2<f32>(bounds));
    let lo=vec2<i32>(floor(at));let hi=min(lo+1,bounds);let f=at-vec2<f32>(lo);
    let t0=textureLoad(raw_source,lo,0).rgb;let t1=textureLoad(raw_source,vec2<i32>(hi.x,lo.y),0).rgb;
    let t2=textureLoad(raw_source,vec2<i32>(lo.x,hi.y),0).rgb;let t3=textureLoad(raw_source,hi,0).rgb;
    let top=t0*(1.0-f.x)+t1*f.x;let bottom=t2*(1.0-f.x)+t3*f.x;
    var gain=1.0;
    if p.v[49].x!=0.0 {
        let x0=fill_x(t0,lo)*(1.0-f.x)+fill_x(t1,vec2<i32>(hi.x,lo.y))*f.x;
        let x1=fill_x(t2,vec2<i32>(lo.x,hi.y))*(1.0-f.x)+fill_x(t3,hi)*f.x;
        gain=fill_gain(x0*(1.0-f.y)+x1*f.y);
    }
    destination.v[index(pos)]=vec4<f32>(top*(1.0-f.y)+bottom*f.y,gain);
}
// SIGMA Photo Pro's X3 Fill Light (fill.rs). Each texel has a Retinex map
// value x: its target minus its own log luminance. Like SPP, `sample`
// interpolates x, not the luminance, and `adjust` or `finish` applies the gain.
fn fill_field(at:vec2<f32>)->vec2<f32> {
    let size=vec2<i32>(p.v[50].xy);
    let g=clamp((at-p.v[50].w)/p.v[50].z,vec2<f32>(0),vec2<f32>(size-1));
    let lo=vec2<i32>(floor(g));let hi=min(lo+1,size-1);let f=g-vec2<f32>(lo);
    let cell=fill[1+lo.y*size.x+lo.x]*(1.0-f.x)+fill[1+lo.y*size.x+hi.x]*f.x;
    let below=fill[1+hi.y*size.x+lo.x]*(1.0-f.x)+fill[1+hi.y*size.x+hi.x]*f.x;
    return mix(cell,below,f.y);
}
fn fill_x(rgb:vec3<f32>,texel:vec2<i32>)->f32 {
    let field=fill_field(vec2<f32>(texel));
    // Sigma's luminance in 12-bit counts, without exposure, as fill::log_luma.
    let l=log(clamp(dot(p.v[48].xyz,rgb)+p.v[48].w,0.0,32767.0)+30.0);
    return field.y*(l-field.x)-(l-fill[0].x);
}
fn fill_gain(x:f32)->f32 {
    // tanh is 1 to float precision past 10; larger arguments can overflow.
    return exp(p.v[49].x*tanh(clamp(x*p.v[49].y,-10.0,10.0)));
}
@compute @workgroup_size(16,8)
fn adjust(@builtin(global_invocation_id) id:vec3<u32>) {
    let pos=id.xy;if !in_bounds(pos) { return; }let i=index(pos);let c=source.v[i].rgb;
    // Fill Light gain from `sample`. Sigma's native Color Mode takes it on its
    // counts in `finish`, as SIGMA Photo Pro does.
    let native=p.v[41].y>0.5;let gain=source.v[i].w;
    var rgb=vec3<f32>(dot(p.v[5].xyz,c),dot(p.v[6].xyz,c),dot(p.v[7].xyz,c))*exp2(p.v[2].x)*select(gain,1.0,native);
    if p.v[41].x>0.5 { rgb=camera_look(rgb); }
    if p.v[1].w>0.5 {
        // Mix source colors before the sensor or film removes their hue.
        let positive=max(rgb,vec3<f32>(0));
        let peak=max(1e-10,max(positive.x,max(positive.y,positive.z)));
        let hsv=rgb_to_hsv(encode_srgb(positive/peak));var tone=0.0;var total=0.0;
        for(var band=0u;band<8u;band++) {
            let distance=abs(hsv.x-p.v[8u+band].w);
            let weight=max(0.0,1.0-min(distance,1.0-distance)/0.125);
            tone+=p.v[60u+band/4u][band%4u]*weight;total+=weight;
        }
        rgb*=exp2(tone/max(total,1.0)*hsv.y);
    }
    // Calibrated inverse camera matrix recovers the B/M/T layer mixture. Keep
    // signed samples and highlight headroom until the ordinary output transform.
    // B&W film takes the colour image; its spectral sensitivity makes it gray.
    if p.v[1].w>0.5 && p.v[37].w<0.5 { rgb=vec3<f32>(dot(p.v[4].yzw,rgb)); }
    // The masks see Fill Light on every path, as SPP's tone curve does.
    let y=max(0.0,dot(rgb*select(1.0,gain,native),vec3<f32>(0.2126,0.7152,0.0722)));
    let shadow=1.0-smoothstep(0.01,0.4,y);let high=smoothstep(0.18,1.0,y);
    rgb*=exp2(p.v[2].w*shadow*2.0+p.v[2].z*high*2.0);
    // Film receives the selected camera look, including its native tone curve.
    if native && p.v[1].z>0.5 { rgb=native_look(rgb,gain); }
    destination.v[i]=vec4<f32>(rgb,select(1.0,gain,native));
}
// One axis of a separable Gaussian: p.v[21].xyz holds a sigma per channel,
// p.v[21].w the tap radius and p.v[22].x the axis.
@compute @workgroup_size(16,8)
fn blur(@builtin(global_invocation_id) id:vec3<u32>) {
    let pos=id.xy;if !in_bounds(pos) {return;}
    let radius=i32(p.v[21].w);let sigma=max(p.v[21].xyz,vec3<f32>(0.01));let axis=select(vec2<i32>(1,0),vec2<i32>(0,1),p.v[22].x>0.5);
    let falloff=-0.5/(sigma*sigma);
    var sum=vec3<f32>(0);var weight=vec3<f32>(0);
    for(var k=-radius;k<=radius;k++) {let w=exp(f32(k*k)*falloff);sum+=w*load_at(vec2<i32>(pos)+axis*k);weight+=w;}
    destination.v[index(pos)]=vec4<f32>(sum/weight,source.v[index(pos)].w);
}
// Sharpen, texture and clarity work on log ratios of the scene-linear image,
// so they act the same at every exposure and keep highlight headroom. The
// floor keeps deep shadow noise from dominating the ratio.
const DETAIL_FLOOR: f32 = 0.005;
const DETAIL_LUMA: vec3<f32> = vec3<f32>(0.2126,0.7152,0.0722);
// The band between two blurs: per-channel log ratios in rgb, the luminance
// log ratio in w.
@compute @workgroup_size(16,8)
fn detail_band(@builtin(global_invocation_id) id:vec3<u32>) {
    let pos=id.xy;if !in_bounds(pos) {return;}let i=index(pos);
    let fine=max(source.v[i].rgb,vec3<f32>(0));let coarse=max(auxiliary.v[i].rgb,vec3<f32>(0));
    destination.v[i]=vec4<f32>(log(fine+DETAIL_FLOOR)-log(coarse+DETAIL_FLOOR),
        log(dot(fine,DETAIL_LUMA)+DETAIL_FLOOR)-log(dot(coarse,DETAIL_LUMA)+DETAIL_FLOOR));
}
// Scales the band of `auxiliary` in `source`. p.v[21]: x gain (negative
// values smooth), y chroma mix (0 is luminance only), z soft limit of the
// band, which bounds halos at strong edges, and w midtone weighting.
@compute @workgroup_size(16,8)
fn detail_apply(@builtin(global_invocation_id) id:vec3<u32>) {
    let pos=id.xy;if !in_bounds(pos) {return;}let i=index(pos);
    let c=source.v[i];let q=p.v[21];
    let band=mix(vec3<f32>(auxiliary.v[i].w),auxiliary.v[i].rgb,q.y);
    // tanh is 1 to float precision past 10; larger arguments can overflow.
    var d=q.z*tanh(clamp(band/q.z,vec3<f32>(-10.0),vec3<f32>(10.0)));
    if q.w>0.5 {
        // ponytail: fixed 0.18 mid-gray with a 3-stop bell; use the metered gray
        // if clarity reaches too far into shadows on dark camera looks.
        let stops=log2((max(dot(c.rgb,DETAIL_LUMA),0.0)+1e-6)/0.18);
        d*=exp(-stops*stops/18.0);
    }
    destination.v[i]=vec4<f32>(c.rgb*exp(q.x*d),source.v[i].w);
}
fn rgb_to_hsv(c:vec3<f32>)->vec3<f32> {
    let mx=max(c.x,max(c.y,c.z));let mn=min(c.x,min(c.y,c.z));let d=mx-mn;
    var h=0.0;if d>1e-7 {if mx==c.x {h=(c.y-c.z)/d;}else if mx==c.y {h=2.0+(c.z-c.x)/d;}else {h=4.0+(c.x-c.y)/d;}h=fract(h/6.0+1.0);}
    return vec3<f32>(h,select(0.0,d/max(mx,1e-7),mx>1e-7),mx);
}
fn hsv_to_rgb(c:vec3<f32>)->vec3<f32> {
    let q=clamp(abs(fract(c.xxx+vec3<f32>(0,2.0/3.0,1.0/3.0))*6.0-3.0)-1.0,vec3<f32>(0),vec3<f32>(1));return c.z*mix(vec3<f32>(1),q,c.y);
}
fn camera_tone(x:f32)->f32 {
    if x<0.0 { return curves.v[1024].x+x*255.0*(curves.v[1025].x-curves.v[1024].x); }
    if x>1.0 { return curves.v[1279].x+(x-1.0)*255.0*(curves.v[1279].x-curves.v[1278].x); }
    let at=x*255.0;let lo=u32(at);
    return mix(curves.v[1024u+lo].x,curves.v[1024u+min(lo+1u,255u)].x,fract(at));
}
fn camera_look(rgb:vec3<f32>)->vec3<f32> {
    // Match the core DNG hue map in linear ProPhoto RGB, with signed headroom.
    let prophoto=matrix_at(42u,rgb);let positive=max(prophoto,vec3<f32>(0));
    var hsv=rgb_to_hsv(positive);let at=hsv.x*21.0;let lo=u32(at)%21u;
    let correction=mix(curves.v[1280u+lo].xy,curves.v[1280u+(lo+1u)%21u].xy,fract(at));
    hsv.x=fract(hsv.x+correction.x/360.0+1.0);hsv.y=clamp(hsv.y*correction.y,0.0,1.0);
    var corrected=rgb;
    if any(correction!=vec2<f32>(0,1)) { corrected+=matrix_at(45u,hsv_to_rgb(hsv)-positive); }
    // Use the renderer's display encoding for the core's measured tone curve.
    let encoded=encode_srgb(corrected);
    return decode_srgb(vec3<f32>(camera_tone(encoded.x),camera_tone(encoded.y),camera_tone(encoded.z)));
}
// Sigma's native tone curve, from counts to linear output: flat past
// saturation like the camera, mirrored below zero to keep extended colour.
const NATIVE_TONE: u32 = 1301u;
const NATIVE_ROWS: u32 = 4096u;
fn native_tone(count:f32)->f32 {
    let at=min(abs(count)*p.v[41].z,f32(NATIVE_ROWS-1u));let lo=u32(at);
    return sign(count)*mix(curves.v[NATIVE_TONE+lo].x,curves.v[NATIVE_TONE+min(lo+1u,NATIVE_ROWS-1u)].x,fract(at));
}
// Merrill ColorDQ (Sigma ApplyMatrixAndColorDQ): two signed table lookups
// that core small chroma differences, on native counts rounded half up.
const COLOR_DQ: u32 = NATIVE_TONE+NATIVE_ROWS;
fn color_dq(q:vec3<f32>)->vec3<f32> {
    let mask=u32(p.v[41].w);let i=vec3<i32>(floor(q+0.5));var residual=vec3<i32>(0);
    for (var c=0u;c<3u;c++) {residual[c]=i[c]-i32(curves.v[COLOR_DQ+(bitcast<u32>(i[c])&mask)][c]);}
    let mean=(residual.x+2*residual.y+residual.z)>>2u;var out=q;
    for (var c=0u;c<3u;c++) {out[c]=q[c]-curves.v[COLOR_DQ+(bitcast<u32>(residual[c]-mean)&mask)][c];}
    return out;
}
fn native_look(rgb:vec3<f32>,gain:f32)->vec3<f32> {
    var counts=matrix_at(42u,rgb)+vec3<f32>(p.v[42].w,p.v[43].w,p.v[44].w);
    if p.v[41].w>0.5 {counts=color_dq(counts);}
    counts*=gain;
    return matrix_at(45u,vec3<f32>(native_tone(counts.x),native_tone(counts.y),native_tone(counts.z)));
}
fn sample_curve(x:f32,ch:u32)->f32 {
    if x<0.0 {return curves.v[0][ch]+x*1023.0*(curves.v[1][ch]-curves.v[0][ch]);}
    if x>1.0 {return curves.v[1023][ch]+(x-1.0)*1023.0*(curves.v[1023][ch]-curves.v[1022][ch]);}
    let at=x*1023.0;let lo=u32(at);return mix(curves.v[lo][ch],curves.v[min(lo+1u,1023u)][ch],fract(at));
}
@compute @workgroup_size(16,8)
fn finish(@builtin(global_invocation_id) id:vec3<u32>) {
    let pos=id.xy;if !in_bounds(pos) {return;}let i=index(pos);var rgb=source.v[i].rgb;
    if p.v[41].y>0.5 && p.v[1].z<0.5 {
        rgb=native_look(rgb,source.v[i].w);
    } else if p.v[1].z<0.5 && p.v[62].z<0.5 {
        // Other cameras, unless the base curve is linear. A Naka-Rushton S-curve per channel, fitted to
        // Sigma's in-camera JPEGs (sd Quattro, dp0 Quattro, SD1 Merrill). It
        // puts middle gray at 0.40, adds a toe and rolls highlights off toward
        // white. It runs on linear Rec.2020 primaries, where Adobe RGB and
        // most ProPhoto colours are not negative, so a wide-gamut export keeps
        // them. Colours outside Rec.2020 use the mirrored curve.
        let wide=mat3x3<f32>(vec3<f32>(0.6274040,0.0690970,0.0163916),vec3<f32>(0.3292820,0.9195400,0.0880132),vec3<f32>(0.0433136,0.0113612,0.8955950))*rgb;
        let x=pow(abs(wide),vec3<f32>(1.63));
        rgb=mat3x3<f32>(vec3<f32>(1.6604910,-0.1245505,-0.0181508),vec3<f32>(-0.5876411,1.1328999,-0.1005789),vec3<f32>(-0.0728499,-0.0083494,1.1187297))*(sign(wide)*x/(x+0.093));
    }
    var percept=encode_srgb(rgb);
    let contrast=exp2(p.v[2].y);percept=(percept-0.5)*contrast+0.5;
    let y=dot(percept,vec3<f32>(0.2126,0.7152,0.0722));let sat=rgb_to_hsv(max(percept,vec3<f32>(0))).y;
    percept=mix(vec3<f32>(y),percept,max(0.0,1.0+p.v[3].z+p.v[3].w*(1.0-sat)));
    var hsv=rgb_to_hsv(max(percept,vec3<f32>(0)));var delta=vec3<f32>(0);var total=0.0;
    for(var band=0u;band<8u;band++) {let center=p.v[8u+band].w;let dist=min(abs(hsv.x-center),1.0-abs(hsv.x-center));let w=max(0.0,1.0-dist/0.125);delta+=p.v[8u+band].xyz*w;total+=w;}
    delta/=max(total,1.0);hsv.x=fract(hsv.x+delta.x/12.0+1.0);hsv.y=clamp(hsv.y*(1.0+delta.y),0.0,1.0);hsv.z*=exp2(delta.z);
    if total>0.0 && any(abs(delta)>vec3<f32>(0)) {percept=hsv_to_rgb(hsv);}
    // Color wheels. Two ramps at the zone borders split the luma into shadow,
    // midtone and highlight weights that sum to one; zero width is a hard
    // split. Each zone scales the pixel by its gain and adds its tint, in
    // proportion to its weight.
    if p.v[59].w>0.5 {
        let luma=vec2<f32>(dot(percept,vec3<f32>(0.2126,0.7152,0.0722)));
        let border=p.v[59].xy;let ramp=p.v[59].z;
        var s=step(border,luma);
        if ramp>0.0 {s=smoothstep(border-ramp,border+ramp,luma);}
        let w=vec3<f32>(1.0-s.x,s.x-s.y,s.y);
        let gain=exp2(dot(w,vec3<f32>(p.v[56].w,p.v[57].w,p.v[58].w)));
        percept=percept*gain+mat3x3<f32>(p.v[56].xyz,p.v[57].xyz,p.v[58].xyz)*w;
    }
    // Extrapolate endpoint slopes so identity curves retain extended channels;
    // conversion to the selected output gamut happens before the final clamp.
    percept=vec3<f32>(sample_curve(sample_curve(percept.x,3u),0u),sample_curve(sample_curve(percept.y,3u),1u),sample_curve(sample_curve(percept.z,3u),2u));
    destination.v[i]=vec4<f32>(decode_srgb(percept),source.v[i].w);
}
fn output_primaries(c:vec3<f32>)->vec3<f32> {
    if p.v[1].y>1.5 {
        // Linear sRGB D65 -> Bradford D50 -> ProPhoto RGB.
        if p.v[1].z>0.5 { return mat3x3<f32>(vec3<f32>(0.5288241003643182,0.09752941484853804,0.01635990179731055),vec3<f32>(0.3340609866357058,0.8790074094009789,0.10661249325366998),vec3<f32>(0.1373616909346029,0.023398117522046773,0.877248518530815))*c; }
        return mat3x3<f32>(vec3<f32>(0.529345,0.098374,0.016883),vec3<f32>(0.330072,0.873461,0.117673),vec3<f32>(0.140583,0.028165,0.865444))*c;
    }
    if p.v[1].y>0.5 {
        if p.v[1].z>0.5 { return mat3x3<f32>(vec3<f32>(0.7151773009999999,-8.124599999998504e-05,-2.7899000000002072e-05),vec3<f32>(0.2848856159999999,1.0000474719999999,0.041163335999999995),vec3<f32>(4.74079999999303e-05,-5.999999983976074e-09,0.9587994129999999))*c; }
        return mat3x3<f32>(vec3<f32>(0.715162,0,0),vec3<f32>(0.284838,1,0.041170),vec3<f32>(0,0,0.958830))*c;
    }
    return c;
}
@compute @workgroup_size(16,8)
fn output(@builtin(global_invocation_id) id:vec3<u32>) {
    let pos=id.xy;if !in_bounds(pos) {return;}let i=index(pos);var c=source.v[i].rgb;
    // Whites and blacks move the white and black points, as levels do, after
    // every other control so none can undo the ceiling or the floor. A raised
    // floor or lowered ceiling also catches what contrast clipped. Only
    // luminance is clamped, which keeps wide-gamut colours.
    let y=dot(c,vec3<f32>(0.2126,0.7152,0.0722));var clamped=y;
    if p.v[3].y>0.0 {clamped=max(clamped,0.0);}
    if p.v[3].x<0.0 {clamped=min(clamped,1.0);}
    let lo_in=-0.15*min(p.v[3].y,0.0);let lo_out=0.15*max(p.v[3].y,0.0);
    let hi_in=1.0-0.25*max(p.v[3].x,0.0);let hi_out=1.0+0.25*min(p.v[3].x,0.0);
    c=decode_srgb(lo_out+(encode_srgb(c+(clamped-y))-lo_in)*((hi_out-lo_out)/(hi_in-lo_in)));
    // Film dyes, colored grain and channel curves can add tint. Neutralize after
    // them; a neutral ray is identical in every supported output RGB space.
    let monochrome=p.v[1].w>0.5;
    if monochrome { c=vec3<f32>(dot(c,vec3<f32>(0.2126,0.7152,0.0722))); }
    if !monochrome { c=output_primaries(c); }
    if p.v[1].z>0.5 { c=compress_output_gamut(c,u32(p.v[1].y)); }
    // Keep B&W neutral after the native-white output compression.
    if monochrome {
        c=vec3<f32>(dot(c,vec3<f32>(0.2126,0.7152,0.0722)));
        if p.v[62].x!=0.0 {
            // shortcut: RGB absorption approximates silver toning; replace it when measured toned-silver spectra are available.
            let density=select(-log(clamp(c.x,1e-4,1.0))*INV_LN10,source.v[i].w,p.v[37].w>0.5);
            var tint=exp2(p.v[62].x*density*vec3<f32>(0.3,0.04,-0.4));
            tint/=dot(tint,vec3<f32>(0.2126,0.7152,0.0722));
            c*=output_primaries(tint)/output_primaries(vec3<f32>(1));
        }
    }
    if p.v[1].y>1.5 {
        c=max(c,vec3<f32>(0));c=select(pow(c,vec3<f32>(1.0/1.8)),c*16.0,c<vec3<f32>(1.0/512.0));
    } else if p.v[1].y>0.5 {
        c=pow(max(c,vec3<f32>(0)),vec3<f32>(256.0/563.0));
    } else { c=encode_srgb(c); }
    destination.v[i]=vec4<f32>(clamp(c,vec3<f32>(0),vec3<f32>(1)),1);
}
// Write the tile interior into the RGBA8 frame (p.v[21] = margin, frame width,
// tile x, tile y). Quantize to 16 bits and then to 8 bits as the CPU does for
// export, so both paths give the same 8-bit values. Alpha 0 flags a
// non-finite pixel; the reader rejects the frame.
@compute @workgroup_size(16,8)
fn pack(@builtin(global_invocation_id) id:vec3<u32>) {
    let margin=u32(p.v[21].x);let size=vec2<u32>(p.v[0].xy)-2u*margin;
    let pos=id.xy;if any(pos>=size) {return;}
    let c=source.v[index(pos+margin)].rgb;
    let finite=all((bitcast<vec3<u32>>(c)&vec3<u32>(0x7f800000u))!=vec3<u32>(0x7f800000u));
    let wide=vec3<u32>(floor(clamp(c,vec3<f32>(0),vec3<f32>(1))*65535.0+0.5));
    let v=(wide+128u)/257u;
    frame[(u32(p.v[21].w)+pos.y)*u32(p.v[21].y)+u32(p.v[21].z)+pos.x]=v.r|(v.g<<8u)|(v.b<<16u)|(select(0u,255u,finite)<<24u);
}
