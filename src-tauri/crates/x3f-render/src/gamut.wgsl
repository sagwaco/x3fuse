// Spektrafilm 28bf883 default OkLCh compression (GPL-3.0-only).
// The host binds output_gamut as a read-only Table of f32 values.
// Each profile block has 18 matrix scalars, then Cmax[64][720].
const OUTPUT_GAMUT_PROFILE_STRIDE: u32 = 46098u;

fn output_gamut_matrix(at: u32, rgb: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(
        dot(vec3<f32>(output_gamut.v[at], output_gamut.v[at+1u], output_gamut.v[at+2u]), rgb),
        dot(vec3<f32>(output_gamut.v[at+3u], output_gamut.v[at+4u], output_gamut.v[at+5u]), rgb),
        dot(vec3<f32>(output_gamut.v[at+6u], output_gamut.v[at+7u], output_gamut.v[at+8u]), rgb)
    );
}

fn gamut_xyz_to_oklab(xyz: vec3<f32>) -> vec3<f32> {
    let lms = vec3<f32>(
        dot(vec3<f32>(0.8189330101, 0.3618667424, -0.1288597137), xyz),
        dot(vec3<f32>(0.0329845436, 0.9293118715, 0.0361456387), xyz),
        dot(vec3<f32>(0.0482003018, 0.2643662691, 0.6338517070), xyz)
    );
    let root = sign(lms) * pow(abs(lms), vec3<f32>(1.0/3.0));
    return vec3<f32>(
        dot(vec3<f32>(0.2104542553, 0.7936177850, -0.0040720468), root),
        dot(vec3<f32>(1.9779984951, -2.4285922050, 0.4505937099), root),
        dot(vec3<f32>(0.0259040371, 0.7827717662, -0.8086757660), root)
    );
}

fn gamut_oklab_to_xyz(lab: vec3<f32>) -> vec3<f32> {
    let root = vec3<f32>(
        dot(vec3<f32>(0.9999999984505197, 0.3963377921737678, 0.21580375806075877), lab),
        dot(vec3<f32>(1.0000000088817607, -0.10556134232365633, -0.0638541747717059), lab),
        dot(vec3<f32>(1.0000000546724108, -0.08948418209496574, -1.2914855378640917), lab)
    );
    let lms = root * root * root;
    return vec3<f32>(
        dot(vec3<f32>(1.2270138511035211, -0.5577999806518222, 0.2812561489664678), lms),
        dot(vec3<f32>(-0.0405801784232806, 1.11225686961683, -0.07167667866560119), lms),
        dot(vec3<f32>(-0.0763812845057069, -0.4214819784180126, 1.5861632204407947), lms)
    );
}

fn output_gamut_knee(d: f32) -> f32 {
    if d <= 0.95 { return d; }
    let x = (d-0.95)/0.05;
    return 0.95 + 0.05*x/pow(1.0+pow(x,1.6),1.0/1.6);
}

fn output_gamut_cmax(base: u32, lightness: f32, hue: f32) -> f32 {
    let li = (clamp(lightness,0.02,1.0)-0.02)/0.98*63.0;
    let l0 = min(u32(floor(li)),62u);
    let lf = li-f32(l0);
    let hi = (hue+3.141592653589793)/(6.283185307179586/720.0);
    let h0 = u32((i32(floor(hi))%720+720)%720);
    let h1 = (h0+1u)%720u;
    let hf = hi-floor(hi);
    let row0 = base+18u+l0*720u;
    let row1 = row0+720u;
    return output_gamut.v[row0+h0]*(1.0-lf)*(1.0-hf)
        + output_gamut.v[row0+h1]*(1.0-lf)*hf
        + output_gamut.v[row1+h0]*lf*(1.0-hf)
        + output_gamut.v[row1+h1]*lf*hf;
}

// profile: 0=sRGB, 1=Adobe RGB, 2=ProPhoto RGB. Call before output encoding.
fn compress_output_gamut(rgb: vec3<f32>, profile: u32) -> vec3<f32> {
    let base = profile*OUTPUT_GAMUT_PROFILE_STRIDE;
    let lab = gamut_xyz_to_oklab(output_gamut_matrix(base,rgb));
    let lightness = output_gamut_knee(lab.x);
    let chroma = length(lab.yz);
    var hue = 0.0;
    if chroma > 0.0 { hue = atan2(lab.z,lab.y); }
    let cmax = max(output_gamut_cmax(base,lightness,hue),1e-9);
    let new_chroma = output_gamut_knee(chroma/cmax)*cmax;
    let xyz = gamut_oklab_to_xyz(vec3<f32>(lightness,new_chroma*cos(hue),new_chroma*sin(hue)));
    return output_gamut_matrix(base+9u,xyz);
}
