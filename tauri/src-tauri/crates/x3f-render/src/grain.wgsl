// Stock-calibrated sublayer grain from spektrafilm experimental 28bf883.
// Slots52..55 contain the table layout, stock parameters and pixel area.
fn grain_uniform(state: ptr<function,u32>) -> f32 {
    *state=pcg(*state);
    return clamp(f32(*state)*(1.0/4294967296.0),1e-7,1.0-1e-7);
}
fn grain_poisson(rate:f32,state:ptr<function,u32>) -> f32 {
    if rate>=30.0 { return max(0.0,round(rate+sqrt(rate)*standard_normal(state))); }
    let limit=exp(-rate);var product=1.0;var count=0u;
    loop {
        product*=grain_uniform(state);
        if product<=limit || count>=255u { break; }
        count++;
    }
    return f32(count);
}
fn grain_binomial(n:f32,probability:f32,state:ptr<function,u32>) -> f32 {
    let mean=n*probability;let variance=mean*(1.0-probability);
    if variance>10.0 { return clamp(round(mean+sqrt(variance)*standard_normal(state)),0.0,n); }
    // Invert the smaller tail so high development probabilities do not underflow.
    let prob=min(probability,1.0-probability);
    let log_probability=select(log(1.0-prob),-prob*(1.0+prob*(0.5+prob/3.0)),prob<0.01);
    var term=exp(n*log_probability);var cumulative=term;var count=0.0;
    let sample=grain_uniform(state);
    loop {
        if sample<=cumulative || count>=n || count>=255.0 { break; }
        term*=((n-count)/(count+1.0))*(prob/(1.0-prob));
        count+=1.0;cumulative+=term;
        if count>n*prob && term<1e-8 { break; }
    }
    return select(count,n-count,probability>0.5);
}
fn grain_native(pos:vec2<u32>) -> vec2<f32> {
    let global=vec3<f32>(vec2<f32>(pos)+p.v[0].zw+0.5,1.0);
    return clamp(vec2<f32>(dot(p.v[22].xyz,global),dot(p.v[23].xyz,global)),
                 vec2<f32>(0.0),vec2<f32>(p.v[22].w,p.v[23].w)-1.0);
}
fn grain_coord(native:vec2<f32>) -> u32 {
    let cell=vec2<u32>(native);
    return cell.y*u32(p.v[22].w)+cell.x;
}
fn grain_layer_density(density:f32,channel:u32,layer:u32) -> f32 {
    let layers=u32(p.v[52].y);let count=u32(p.v[52].z);
    let total=u32(p.v[52].x)+layers*9u;
    let sub=total+count*3u;
    let sign=select(1.0,-1.0,p.v[32].w>0.5);
    let requested=density*sign;
    var lo=0u;var hi=count-1u;
    loop {
        if hi-lo<=1u { break; }
        let mid=(lo+hi)/2u;
        if spectral.v[total+mid*3u+channel]*sign<requested { lo=mid; } else { hi=mid; }
    }
    let x0=spectral.v[total+lo*3u+channel]*sign;
    let x1=spectral.v[total+hi*3u+channel]*sign;
    let fraction=clamp((requested-x0)/max(x1-x0,1e-12),0.0,1.0);
    let y0=spectral.v[sub+(lo*layers+layer)*3u+channel];
    let y1=spectral.v[sub+(hi*layers+layer)*3u+channel];
    return mix(y0,y1,fraction);
}
@compute @workgroup_size(16,8)
fn grain_layer(@builtin(global_invocation_id) id:vec3<u32>) {
    let pos=id.xy;if !in_bounds(pos) {return;}let i=index(pos);
    let native=grain_native(pos);let coord=grain_coord(native);
    let layer=u32(p.v[52].w);let offset=u32(p.v[52].x)+layer*9u;
    let seed=bitcast<u32>(p.v[34].w);let silver=p.v[37].w>0.5;
    let roughness=p.v[35].w;
    let clump=select(1.0,exp2(3.0*roughness*clump_field(native,p.v[36].w,seed^0x5bd1e995u)),roughness>0.0);
    var result=vec3<f32>(0);
    for (var c=0u;c<3u;c++) {
        let floor=spectral.v[offset+c];let maximum=spectral.v[offset+3u+c];
        let particles=max(1e-8,p.v[55].x*spectral.v[offset+6u+c]*clump);
        let density=grain_layer_density(source.v[i][c],c,layer)+floor;
        let probability=clamp(density/max(maximum,1e-8),1e-6,1.0-1e-6);
        let saturation=1.0-probability*p.v[53][c]*(1.0-1e-6);
        var rng=splitmix32(select(c,0u,silver)+layer*10u+seed)^splitmix32(coord);
        let seeds=grain_poisson(particles/saturation,&rng);
        result[c]=grain_binomial(seeds,probability,&rng)*(maximum/particles)*saturation;
    }
    destination.v[i]=vec4<f32>(result,1);
}
@compute @workgroup_size(16,8)
fn grain_micro_field(@builtin(global_invocation_id) id:vec3<u32>) {
    let pos=id.xy;if !in_bounds(pos) {return;}let i=index(pos);
    let coord=grain_coord(grain_native(pos));let seed=bitcast<u32>(p.v[34].w);
    let variance=log(1.0+p.v[53].w*p.v[53].w);var result=vec3<f32>(1);
    for (var c=0u;c<3u;c++) {
        var rng=splitmix32(select(c,0u,p.v[37].w>0.5)+seed+0x68bc21ebu)^splitmix32(coord);
        result[c]=exp(sqrt(variance)*standard_normal(&rng)-0.5*variance);
    }
    destination.v[i]=vec4<f32>(result,1);
}
@compute @workgroup_size(16,8)
fn grain_multiply(@builtin(global_invocation_id) id:vec3<u32>) {
    let pos=id.xy;if !in_bounds(pos) {return;}let i=index(pos);
    destination.v[i]=vec4<f32>(source.v[i].rgb*auxiliary.v[i].rgb,1);
}
@compute @workgroup_size(16,8)
fn grain_usm(@builtin(global_invocation_id) id:vec3<u32>) {
    let pos=id.xy;if !in_bounds(pos) {return;}let i=index(pos);
    let density=max(source.v[i].rgb,vec3<f32>(0));
    let blurred=max(auxiliary.v[i].rgb,vec3<f32>(1e-6));
    destination.v[i]=vec4<f32>(density*pow(max(density,vec3<f32>(1e-6))/blurred,vec3<f32>(p.v[54].w)),1);
}
// Local mass transport replaces the image-dependent scalar used upstream.
// S * G(D / G(S)) preserves density and gives the same result in every tile.
@compute @workgroup_size(16,8)
fn grain_ratio(@builtin(global_invocation_id) id:vec3<u32>) {
    let pos=id.xy;if !in_bounds(pos) {return;}let i=index(pos);
    destination.v[i]=vec4<f32>(max(source.v[i].rgb,vec3<f32>(0))/max(auxiliary.v[i].rgb,vec3<f32>(1e-6)),1);
}
@compute @workgroup_size(16,8)
fn grain_finish(@builtin(global_invocation_id) id:vec3<u32>) {
    let pos=id.xy;if !in_bounds(pos) {return;}let i=index(pos);
    let original=auxiliary.v[i].rgb;
    var noise=source.v[i].rgb-p.v[54].xyz-original;
    noise=mix(vec3<f32>(dot(noise,vec3<f32>(1.0/3.0))),noise,p.v[17].w)*p.v[17].z;
    destination.v[i]=vec4<f32>(original+noise,1);
}
