// X3Fuse scene-linear editing. The film stages are a GPL-3.0-only port of
// spektrafilm-rs (turbasvin, v0.1.2 / 9dd59b0), which implements the
// spektrafilm model by Andrea Volpato. Data attribution and pinned hashes:
// assets/PROVENANCE.md; source attribution: NOTICE.
struct Pixels { v: array<vec4<f32>> }
struct Table { v: array<f32> }
struct Uniforms { v: array<vec4<f32>, 40> }
@group(0) @binding(0) var<storage, read> source: Pixels;
@group(0) @binding(1) var<storage, read> auxiliary: Pixels;
@group(0) @binding(2) var<storage, read_write> destination: Pixels;
@group(0) @binding(3) var<uniform> p: Uniforms;
@group(0) @binding(4) var<storage, read> spectral: Table;
@group(0) @binding(5) var<storage, read> tc_lut: Table;
@group(0) @binding(6) var<storage, read> curves: Pixels;
@group(1) @binding(0) var raw_source: texture_2d<f32>;

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
// Halation scatter mix at spektrafilm's default scatter_amount of 1.0.
@compute @workgroup_size(16,8)
fn scatter_mix(@builtin(global_invocation_id) id:vec3<u32>) {
    let pos=id.xy;if !in_bounds(pos) {return;}let i=index(pos);let w=p.v[37].xyz;
    destination.v[i]=vec4<f32>((1.0-w)*source.v[i].rgb+w*auxiliary.v[i].rgb,1);
}
@compute @workgroup_size(16,8)
fn combine(@builtin(global_invocation_id) id:vec3<u32>) {
    let pos=id.xy;if !in_bounds(pos) {return;}let i=index(pos);
    destination.v[i]=vec4<f32>(p.v[21].x*source.v[i].rgb+p.v[21].y*auxiliary.v[i].rgb,1);
}
// Multi-bounce halation add and renormalize. `halation_midtones` gates the
// added light by the blurred signal level, keeping halation in the highlights.
@compute @workgroup_size(16,8)
fn halation_finish(@builtin(global_invocation_id) id:vec3<u32>) {
    let pos=id.xy;if !in_bounds(pos) {return;}let i=index(pos);
    let base=source.v[i].rgb;let bounced=auxiliary.v[i].rgb;
    let level=max(0.0,dot(bounced,vec3<f32>(1.0/3.0)));
    let gate=mix(1.0,level/(level+0.18),p.v[38].w);
    destination.v[i]=vec4<f32>((base+p.v[38].xyz*gate*bounced)*p.v[39].xyz,1);
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
    if p.v[32].w>0.5 { silver=p.v[32].xyz-silver; }
    destination.v[i]=vec4<f32>(p.v[29].xyz*silver.x+p.v[30].xyz*silver.y+p.v[31].xyz*silver.z,1);
}
@compute @workgroup_size(16,8)
fn dir_develop(@builtin(global_invocation_id) id:vec3<u32>) {
    let pos=id.xy;if !in_bounds(pos) {return;}let i=index(pos);
    let corrected=log10v(source.v[i].rgb)-auxiliary.v[i].rgb;
    destination.v[i]=vec4<f32>(develop_curve(SP_FILM_LOG_EXP,SP_FILM_CURVES_0,p.v[16].y,corrected),1);
}
@compute @workgroup_size(16,8)
fn grain(@builtin(global_invocation_id) id:vec3<u32>) {
    let pos=id.xy;if !in_bounds(pos) {return;}let i=index(pos);
    let density=source.v[i].rgb;
    // Anchor the RNG to native image coordinates so tiles, regions and whole
    // previews of the same output size draw identical noise.
    let global=vec3<f32>(vec2<f32>(pos)+p.v[0].zw+0.5,1.0);
    let native=clamp(vec2<f32>(dot(p.v[22].xyz,global),dot(p.v[23].xyz,global)),
                     vec2<f32>(0.0),vec2<f32>(p.v[22].w,p.v[23].w)-1.0);
    let cell=vec2<u32>(native);
    let coord=cell.y*u32(p.v[22].w)+cell.x;
    let layers=u32(p.v[33].w);
    let seed=bitcast<u32>(p.v[34].w);
    var developed_density=vec3<f32>(0);
    for (var c=0u; c<3u; c++) {
        let dmin=p.v[33][c];let dmax=p.v[34][c];let npp=p.v[35][c];
        let od=dmax/npp;
        let ratio=clamp((density[c]+dmin)/dmax,1e-6,1.0-1e-6);
        let saturation=1.0-ratio*p.v[36][c]*(1.0-1e-6);
        let lambda=npp/saturation;
        var total=0.0;
        for (var layer=0u; layer<layers; layer++) {
            var rng=splitmix32(c+layer*10u+seed)^splitmix32(coord);
            let seeds=max(0.0,round(lambda+sqrt(lambda)*standard_normal(&rng)));
            let mean=seeds*ratio;let variance=mean*(1.0-ratio);
            var grains=mean;
            if variance>0.0 { grains=clamp(round(mean+sqrt(variance)*standard_normal(&rng)),0.0,seeds); }
            total+=grains*od*saturation;
        }
        developed_density[c]=total/f32(layers)-dmin;
    }
    var noise=developed_density-density;
    // X3Fuse extension: desaturate the grain toward its achromatic mean.
    noise=mix(vec3<f32>(dot(noise,vec3<f32>(1.0/3.0))),noise,p.v[17].w)*p.v[17].z;
    destination.v[i]=vec4<f32>(density+noise,1);
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
    let cmy=source.v[i].rgb;var xyz=vec3<f32>(0);
    for (var wl=0u; wl<N_WL; wl++) {
        let dye=wl*3u;
        let d=cmy.x*spectral.v[SP_SCAN_DYE+dye]+cmy.y*spectral.v[SP_SCAN_DYE+dye+1u]
             +cmy.z*spectral.v[SP_SCAN_DYE+dye+2u]+spectral.v[SP_SCAN_BASE+wl];
        xyz+=pow(10.0,-d)*vec3<f32>(spectral.v[SP_SCAN_ILLUM_CMF+dye],spectral.v[SP_SCAN_ILLUM_CMF+dye+1u],spectral.v[SP_SCAN_ILLUM_CMF+dye+2u]);
    }
    destination.v[i]=vec4<f32>(matrix_at(26u,xyz/p.v[17].y),1);
}
@compute @workgroup_size(16,8)
fn sample(@builtin(global_invocation_id) id:vec3<u32>) {
    let pos=id.xy;if !in_bounds(pos) { return; }
    let global=vec3<f32>(vec2<f32>(pos)+p.v[0].zw+0.5,1.0);
    let bounds=vec2<i32>(textureDimensions(raw_source))-1;
    let at=clamp(vec2<f32>(dot(p.v[24].xyz,global),dot(p.v[25].xyz,global)),vec2<f32>(0),vec2<f32>(bounds));
    let lo=vec2<i32>(floor(at));let hi=min(lo+1,bounds);let f=at-vec2<f32>(lo);
    let top=textureLoad(raw_source,lo,0).rgb*(1.0-f.x)+textureLoad(raw_source,vec2<i32>(hi.x,lo.y),0).rgb*f.x;
    let bottom=textureLoad(raw_source,vec2<i32>(lo.x,hi.y),0).rgb*(1.0-f.x)+textureLoad(raw_source,hi,0).rgb*f.x;
    destination.v[index(pos)]=vec4<f32>(top*(1.0-f.y)+bottom*f.y,1);
}
@compute @workgroup_size(16,8)
fn adjust(@builtin(global_invocation_id) id:vec3<u32>) {
    let pos=id.xy;if !in_bounds(pos) { return; }let i=index(pos);let c=source.v[i].rgb;
    var rgb=vec3<f32>(dot(p.v[5].xyz,c),dot(p.v[6].xyz,c),dot(p.v[7].xyz,c))*exp2(p.v[2].x);
    // Calibrated inverse camera matrix recovers the B/M/T layer mixture. Keep
    // signed samples and highlight headroom until the ordinary output transform.
    if p.v[1].w>0.5 { rgb=vec3<f32>(dot(p.v[4].yzw,rgb)); }
    let y=max(0.0,dot(rgb,vec3<f32>(0.2126,0.7152,0.0722)));
    let shadow=1.0-smoothstep(0.01,0.4,y);let high=smoothstep(0.18,1.0,y);
    let stops=p.v[2].w*shadow*2.0+p.v[2].z*high*2.0+p.v[3].x*smoothstep(0.5,2.0,y)+p.v[3].y*(1.0-smoothstep(0.0,0.08,y));
    rgb*=exp2(stops);
    destination.v[i]=vec4<f32>(rgb,1);
}
@compute @workgroup_size(16,8)
fn blur(@builtin(global_invocation_id) id:vec3<u32>) {
    let pos=id.xy;if !in_bounds(pos) {return;}
    let radius=i32(p.v[21].z);let sigma=max(p.v[21].x,0.01);let axis=select(vec2<i32>(1,0),vec2<i32>(0,1),p.v[21].y>0.5);
    var sum=vec3<f32>(0);var weight=0.0;
    for(var k=-radius;k<=radius;k++) {let w=exp(-0.5*f32(k*k)/(sigma*sigma));sum+=w*load_at(vec2<i32>(pos)+axis*k);weight+=w;}
    destination.v[index(pos)]=vec4<f32>(sum/weight,1);
}
fn rgb_to_hsv(c:vec3<f32>)->vec3<f32> {
    let mx=max(c.x,max(c.y,c.z));let mn=min(c.x,min(c.y,c.z));let d=mx-mn;
    var h=0.0;if d>1e-7 {if mx==c.x {h=(c.y-c.z)/d;}else if mx==c.y {h=2.0+(c.z-c.x)/d;}else {h=4.0+(c.x-c.y)/d;}h=fract(h/6.0+1.0);}
    return vec3<f32>(h,select(0.0,d/max(mx,1e-7),mx>1e-7),mx);
}
fn hsv_to_rgb(c:vec3<f32>)->vec3<f32> {
    let q=clamp(abs(fract(c.xxx+vec3<f32>(0,2.0/3.0,1.0/3.0))*6.0-3.0)-1.0,vec3<f32>(0),vec3<f32>(1));return c.z*mix(vec3<f32>(1),q,c.y);
}
fn sample_curve(x:f32,ch:u32)->f32 {
    if x<0.0 {return curves.v[0][ch]+x*1023.0*(curves.v[1][ch]-curves.v[0][ch]);}
    if x>1.0 {return curves.v[1023][ch]+(x-1.0)*1023.0*(curves.v[1023][ch]-curves.v[1022][ch]);}
    let at=x*1023.0;let lo=u32(at);return mix(curves.v[lo][ch],curves.v[min(lo+1u,1023u)][ch],fract(at));
}
@compute @workgroup_size(16,8)
fn finish(@builtin(global_invocation_id) id:vec3<u32>) {
    let pos=id.xy;if !in_bounds(pos) {return;}let i=index(pos);var rgb=source.v[i].rgb;
    if p.v[1].z<0.5 {
        // Exposure-preserving shoulder: identity through middle gray, smooth to white.
        let y=max(dot(rgb,vec3<f32>(0.2126,0.7152,0.0722)),0.0);
        let mapped=select(y,0.18+0.82*(1.0-exp(-(y-0.18)/0.82)),y>0.18);
        rgb*=select(1.0,mapped/max(y,1e-8),y>1e-8);
    }
    var percept=encode_srgb(rgb);
    let contrast=exp2(p.v[2].y);percept=(percept-0.5)*contrast+0.5;
    let y=dot(percept,vec3<f32>(0.2126,0.7152,0.0722));let sat=rgb_to_hsv(max(percept,vec3<f32>(0))).y;
    percept=mix(vec3<f32>(y),percept,max(0.0,1.0+p.v[3].z+p.v[3].w*(1.0-sat)));
    var hsv=rgb_to_hsv(max(percept,vec3<f32>(0)));var delta=vec3<f32>(0);var total=0.0;
    for(var band=0u;band<8u;band++) {let center=p.v[8u+band].w;let dist=min(abs(hsv.x-center),1.0-abs(hsv.x-center));let w=max(0.0,1.0-dist/0.125);delta+=p.v[8u+band].xyz*w;total+=w;}
    delta/=max(total,1.0);hsv.x=fract(hsv.x+delta.x/12.0+1.0);hsv.y=clamp(hsv.y*(1.0+delta.y),0.0,1.0);hsv.z*=exp2(delta.z);
    if total>0.0 && any(abs(delta)>vec3<f32>(0)) {percept=hsv_to_rgb(hsv);}
    // Extrapolate endpoint slopes so identity curves retain extended channels;
    // conversion to the selected output gamut happens before the final clamp.
    percept=vec3<f32>(sample_curve(sample_curve(percept.x,3u),0u),sample_curve(sample_curve(percept.y,3u),1u),sample_curve(sample_curve(percept.z,3u),2u));
    destination.v[i]=vec4<f32>(decode_srgb(percept),1);
}
@compute @workgroup_size(16,8)
fn output(@builtin(global_invocation_id) id:vec3<u32>) {
    let pos=id.xy;if !in_bounds(pos) {return;}let i=index(pos);var c=source.v[i].rgb;
    if p.v[4].x>0.0 {let y=dot(c,vec3<f32>(0.2126,0.7152,0.0722));let by=dot(auxiliary.v[i].rgb,vec3<f32>(0.2126,0.7152,0.0722));c+=vec3<f32>((y-by)*p.v[4].x*2.0);}
    // Film dyes, colored grain and channel curves can add tint. Neutralize after
    // them; a neutral ray is identical in every supported output RGB space.
    let monochrome=p.v[1].w>0.5;
    if monochrome { c=vec3<f32>(dot(c,vec3<f32>(0.2126,0.7152,0.0722))); }
    if p.v[1].y>1.5 {
        // Linear sRGB D65 -> Bradford D50 -> ProPhoto RGB.
        if !monochrome { c=mat3x3<f32>(vec3<f32>(0.529345,0.098374,0.016883),vec3<f32>(0.330072,0.873461,0.117673),vec3<f32>(0.140583,0.028165,0.865444))*c; }
        c=max(c,vec3<f32>(0));c=select(pow(c,vec3<f32>(1.0/1.8)),c*16.0,c<vec3<f32>(1.0/512.0));
    } else if p.v[1].y>0.5 {
        if !monochrome { c=mat3x3<f32>(vec3<f32>(0.715162,0,0),vec3<f32>(0.284838,1,0.041170),vec3<f32>(0,0,0.958830))*c; }
        c=pow(max(c,vec3<f32>(0)),vec3<f32>(256.0/563.0));
    } else { c=encode_srgb(c); }
    destination.v[i]=vec4<f32>(clamp(c,vec3<f32>(0),vec3<f32>(1)),1);
}
