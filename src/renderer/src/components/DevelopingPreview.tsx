import { useEffect, useRef, useState } from 'react'
import type { X3FFileDTO } from '@shared/types'
import { displayPreviewUrl, isRenderedPreview } from '@shared/preview'
import { cachedSmallPreview, loadSmallPreview, lookupSmallPreview } from '../lib/previewImages'
import { cachedFitPreview } from '../lib/fitPreviews'
import { FilmstripImage } from './FilmstripImage'
import { OrientedImage } from './OrientedImage'
import { program, texture } from '../lib/webgl'

/** A fast preview replaces the empty canvas before the cloud appears. */
const APPEAR_DELAY = 150
/** Particle spacing in CSS pixels. Particles are about one pixel. */
const SPACING = 1.3
/** Large views space particles wider, so a frame never draws more. */
const MAX_PARTICLES = 600_000
/** CSS pixels between the moving cloud and the canvas edge. Particles near the edge move less. */
const PADDING = 30
/** Seconds to approach the cloud, to settle and to fade in. */
const RISE = 0.35
const SETTLE = 0.15
const FADE_IN = 0.25
/** Seconds to fade into the preview. */
const REVEAL = 0.8
/**
 * The canvas shows between a soft top edge and a soft bottom edge. Each edge
 * fades over 40% of the canvas height. Both edges only move down: as `--fill`
 * goes from 0 to 1, the canvas covers the preview from the top down. As
 * `--cover` goes from 1 to 0, the preview shows from the top down. The layers
 * intersect, so the edges can pass each other.
 */
const MASK =
  'linear-gradient(transparent calc(100% - 140% * var(--cover)), black calc(140% - 140% * var(--cover))), ' +
  'linear-gradient(black calc(140% * var(--fill) - 40%), transparent calc(140% * var(--fill)))'
/** Glow strength. */
const GLOW = 0.7

/**
 * Particles carry no vertex data: each derives its cell and random seeds from
 * its index, and samples its color from the thumbnail with linear filtering.
 */
const VERTEX = `#version 300 es
uniform sampler2D u_image;
uniform vec2 u_canvas;
uniform vec4 u_from; // the box of the moving cloud
uniform vec4 u_to; // the box of the settled image
uniform vec2 u_grid;
uniform float u_pixel; // device pixels per CSS pixel
uniform float u_time;
uniform float u_spread;
uniform float u_alpha;
out vec4 v_color;
out float v_radius; // in device pixels
vec4 seeds(uint i) {
  uvec4 h = uvec4(i) * uvec4(0x9E3779B1u, 0x85EBCA77u, 0xC2B2AE3Du, 0x27D4EB2Fu)
    + uvec4(0x165667B1u, 0xD3A2646Cu, 0xFD7046C5u, 0xB55A4F09u);
  h ^= h >> 15u;
  h *= 0x2C1B3C6Du;
  h ^= h >> 12u;
  h *= 0x297A2D39u;
  h ^= h >> 15u;
  return vec4(h >> 8u) / 16777216.0;
}
void main() {
  uint i = uint(gl_VertexID);
  uint columns = uint(u_grid.x);
  vec2 home = (vec2(float(i % columns), float(i / columns)) + 0.5) / u_grid;
  vec4 s = seeds(i);
  float t = u_time;
  // Particles land one after another as the cloud settles.
  float spread = smoothstep(0.3 * s.z, 0.3 * s.z + 0.7, u_spread);
  vec2 jitter = vec2(sin(t * (9.0 + 7.0 * s.x) + 6.2832 * s.y),
                     cos(t * (8.0 + 8.0 * s.z) + 6.2832 * s.w));
  vec2 swirl = vec2(sin(home.y * 7.0 + t * (1.5 + 1.0 * s.x) + 3.0 * s.w),
                    cos(home.x * 6.0 - t * (1.3 + 1.0 * s.z) + 3.0 * s.y));
  // Compressing flows push particles together into drifting clumps.
  vec2 squeeze = vec2(sin(home.x * 23.0 + 2.0 * sin(home.y * 9.0 + 0.4 * t) + 0.9 * t),
                      sin(home.y * 19.0 + 2.0 * sin(home.x * 8.0 - 0.5 * t) - 0.7 * t));
  vec2 offset = u_pixel * (4.0 * jitter + (16.0 + 24.0 * s.y) * swirl)
    + vec2(0.024, 0.028) * u_from.zw * squeeze;
  // Toward an edge, an offset shrinks smoothly below the room on that side,
  // so moving particles stay at least 3 CSS pixels inside the canvas.
  vec2 room = u_pixel * 27.0 + mix(home, 1.0 - home, step(0.0, offset)) * u_from.zw;
  offset = room * tanh(offset / room);
  // A landing particle moves on a line from its place in the cloud to its
  // place in the preview. Both are in the canvas, so the particle is too.
  vec2 cloud = u_from.xy + home * u_from.zw + offset;
  vec2 p = mix(u_to.xy + home * u_to.zw, cloud, spread);
  gl_Position = vec4(p / u_canvas * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
  // Landed particles grow to cover their cells, so the image shows no gaps.
  float cell = max(u_to.z / u_grid.x, u_to.w / u_grid.y);
  float size = mix(1.5 * cell, max(1.0, u_pixel * (0.9 + 0.4 * s.x)), spread);
  v_radius = 0.5 * size;
  // One more pixel holds the soft edge of the dot.
  gl_PointSize = size + 1.0;
  float twinkle = 0.85 + 0.15 * sin(t * (3.0 + 4.0 * s.w) + 6.2832 * s.x);
  // A slow field hides particles in drifting patches, so the density varies.
  float field = sin(home.x * 17.0 + home.y * 6.0 + 0.6 * t)
    * sin(home.y * 15.0 - home.x * 8.0 - 0.5 * t);
  float r = fract(13.0 * s.y);
  float shown = twinkle * smoothstep(r - 0.15, r + 0.15, 0.75 + 0.5 * field);
  // Particles fade in from the top down.
  float fade = smoothstep(0.0, 0.3, 1.3 * u_alpha - home.y);
  v_color = vec4(texture(u_image, home).rgb, fade * mix(1.0, shown, spread));
}`

const FRAGMENT = `#version 300 es
precision mediump float;
in vec4 v_color;
in float v_radius;
out vec4 color;
void main() {
  // The edge of the dot fades over one device pixel. Then the sum of its
  // pixels stays near its area at all subpixel positions, so a moving dot
  // does not flicker.
  float d = length(gl_PointCoord - 0.5) * (2.0 * v_radius + 1.0);
  float alpha = v_color.a * clamp(v_radius + 0.5 - d, 0.0, 1.0);
  color = vec4(v_color.rgb * alpha, alpha);
}`

/** One triangle that covers the canvas. */
const SCREEN = `#version 300 es
void main() {
  gl_Position = vec4(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0, 0.0, 1.0);
}`

/**
 * Blurs the particle frame into a glow buffer at a quarter of its size. Small
 * mipmap levels of the frame are blurred copies of it, so a few reads per
 * glow pixel are enough.
 */
const GLOW_PASS = `#version 300 es
precision highp float;
uniform sampler2D u_scene;
uniform float u_lod; // log2 of device pixels per CSS pixel
out vec4 color;
vec3 blurred(vec2 uv, float level) {
  vec2 d = 0.5 * exp2(level) / vec2(textureSize(u_scene, 0));
  return 0.25 * (textureLod(u_scene, uv - d, level).rgb + textureLod(u_scene, uv + d, level).rgb
    + textureLod(u_scene, uv + vec2(d.x, -d.y), level).rgb
    + textureLod(u_scene, uv + vec2(-d.x, d.y), level).rgb);
}
void main() {
  vec2 uv = gl_FragCoord.xy / vec2(textureSize(u_scene, 2));
  color = vec4(0.6 * blurred(uv, u_lod + 2.0) + 0.4 * blurred(uv, u_lod + 4.0), 1.0);
}`

/** Draws the particle frame and its glow to the canvas. */
const COMPOSITE = `#version 300 es
precision highp float;
uniform sampler2D u_scene;
uniform sampler2D u_glow;
uniform float u_strength;
out vec4 color;
void main() {
  vec4 base = texelFetch(u_scene, ivec2(gl_FragCoord.xy), 0);
  vec2 uv = gl_FragCoord.xy / vec2(textureSize(u_scene, 0));
  vec3 glow = u_strength * texture(u_glow, uv).rgb;
  // Screen blending, so bright areas glow without clipping to white.
  vec3 rgb = base.rgb + glow * (1.0 - base.rgb);
  float alpha = min(1.0, max(base.a, max(rgb.r, max(rgb.g, rgb.b))));
  color = vec4(min(rgb, vec3(alpha)), alpha);
}`

/** Particle columns and rows for a source shown `width` CSS pixels wide. */
function particleGrid(
  source: { width: number; height: number },
  width: number
): { columns: number; rows: number } {
  const wide = Math.max(160, width / SPACING)
  const scale = Math.min(
    1,
    Math.sqrt(MAX_PARTICLES / ((wide * wide * source.height) / source.width))
  )
  const columns = Math.max(1, Math.floor(wide * scale))
  return { columns, rows: Math.max(1, Math.floor((columns * source.height) / source.width)) }
}

/** The box of an image with `aspect` contained in a `width` by `height` area. */
function contain(aspect: number, width: number, height: number, inset = 0): number[] {
  const w = Math.min(width - 2 * inset, (height - 2 * inset) * aspect)
  const h = w / aspect
  return [(width - w) / 2, (height - h) / 2, w, h]
}

/** Draws a frame. Returns false when the canvas cannot hold the frame. */
type Draw = (uniforms: {
  size: number[]
  time: number
  spread: number
  alpha: number
  from: number[]
  to: number[]
  pixel: number
}) => boolean

/**
 * Draws the particles into a frame texture (unit 1), blurs its mipmaps into
 * a glow texture (unit 2), then draws both to the canvas. Unit 0 holds the
 * thumbnail.
 */
function particleRenderer(
  gl: WebGL2RenderingContext,
  source: TexImageSource,
  columns: number,
  rows: number
): Draw | undefined {
  const particles = program(gl, VERTEX, FRAGMENT)
  const blur = program(gl, SCREEN, GLOW_PASS)
  const composite = program(gl, SCREEN, COMPOSITE)
  const image = texture(gl, 0, gl.LINEAR)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
  const scene = texture(gl, 1, gl.LINEAR_MIPMAP_LINEAR)
  const glow = texture(gl, 2, gl.LINEAR)
  const sceneBuffer = gl.createFramebuffer()
  const glowBuffer = gl.createFramebuffer()
  if (!particles || !blur || !composite || !image || !scene || !glow) return
  if (!sceneBuffer || !glowBuffer) return
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  const uniform = (program: WebGLProgram, names: string[]): Array<WebGLUniformLocation | null> =>
    names.map((name) => gl.getUniformLocation(program, name))
  const [canvas, from, to, grid, pixel, time, spread, alpha] = uniform(particles, [
    'u_canvas',
    'u_from',
    'u_to',
    'u_grid',
    'u_pixel',
    'u_time',
    'u_spread',
    'u_alpha'
  ])
  const [blurScene, lod] = uniform(blur, ['u_scene', 'u_lod'])
  const [compositeScene, compositeGlow, strength] = uniform(composite, [
    'u_scene',
    'u_glow',
    'u_strength'
  ])
  gl.useProgram(blur)
  gl.uniform1i(blurScene, 1)
  gl.useProgram(composite)
  gl.uniform1i(compositeScene, 1)
  gl.uniform1i(compositeGlow, 2)
  gl.uniform1f(strength, GLOW)
  gl.useProgram(particles)
  gl.uniform2f(grid, columns, rows)
  /** Gives `target` a `width` by `height` texture on texture unit `unit`. */
  const allocate = (
    unit: number,
    target: WebGLFramebuffer,
    attachment: WebGLTexture,
    width: number,
    height: number
  ): boolean => {
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, target)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, attachment, 0)
    // A failed allocation can keep the old texture, so check for errors too.
    return (
      gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE &&
      gl.getError() === gl.NO_ERROR
    )
  }
  let size = ''
  return (values) => {
    const [width, height] = values.size
    // The glow has the size of mipmap level 2 of the frame.
    const [glowWidth, glowHeight] = [Math.max(1, width >> 2), Math.max(1, height >> 2)]
    // A hidden canvas has nothing to draw.
    if (!width || !height) return true
    const resized = size !== `${width}x${height}`
    if (resized) {
      if (!allocate(1, sceneBuffer, scene, width, height)) return false
      if (!allocate(2, glowBuffer, glow, glowWidth, glowHeight)) return false
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneBuffer)
    gl.viewport(0, 0, width, height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(particles)
    gl.uniform2f(canvas, width, height)
    gl.uniform4fv(from, values.from)
    gl.uniform4fv(to, values.to)
    gl.uniform1f(pixel, values.pixel)
    gl.uniform1f(time, values.time)
    gl.uniform1f(spread, values.spread)
    gl.uniform1f(alpha, values.alpha)
    gl.enable(gl.BLEND)
    gl.drawArrays(gl.POINTS, 0, columns * rows)
    gl.disable(gl.BLEND)
    gl.activeTexture(gl.TEXTURE1)
    gl.generateMipmap(gl.TEXTURE_2D)
    // The first mipmaps at a new size allocate the mipmap levels. Reading
    // errors waits for the GPU, so do it only then.
    if (resized) {
      if (gl.getError() !== gl.NO_ERROR) return false
      size = `${width}x${height}`
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, glowBuffer)
    gl.viewport(0, 0, glowWidth, glowHeight)
    gl.useProgram(blur)
    gl.uniform1f(lod, Math.log2(values.pixel))
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, width, height)
    gl.useProgram(composite)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    return true
  }
}

/** Moves `value` toward `target` with time constant `rise` up or `fall` down. */
const approach = (value: number, target: number, dt: number, rise: number, fall: number): number =>
  target + (value - target) * Math.exp(-dt / (target > value ? rise : fall))

/** The embedded JPEG of a photo, without its saved edit. */
const embedded = (file: X3FFileDTO): X3FFileDTO => ({
  ...file,
  edit: undefined,
  displayPreviewUrl: undefined
})

/**
 * The placeholder while a RAW develops. A decoded high-resolution preview of
 * the current edit shows at once. Otherwise a glowing particle cloud,
 * colored by the cached edited thumbnail or the embedded JPEG, appears.
 * The cache can derive the thumbnail from a stored full edited preview.
 * Edited cache lookups do not render pixels.
 * When the preview is ready, the cloud fades into it, and the component
 * calls `onDone`. Reduced motion, a missing WebGL 2
 * and a lost context show the still thumbnail.
 *
 * `matching` permits a finished cached preview only when it shows the current
 * edit. The cloud can use a saved thumbnail as an approximate color source.
 * Remount for a new photo or crop view, not when the session loads.
 *
 * With `from`, the URL of the preview on screen, the cloud starts as that
 * preview over it and then rises. Reduced motion then shows no placeholder.
 */
export function DevelopingPreview({
  file,
  matching,
  developing,
  ready,
  onDone,
  from
}: {
  file: X3FFileDTO
  matching: boolean
  developing: boolean
  ready: boolean
  onDone: () => void
  from?: string
}): React.JSX.Element | null {
  // Decide once per photo, so the placeholder does not change while it shows.
  const [morph] = useState(!!from)
  const [cachedImage] = useState(
    () => !morph && matching && !!cachedFitPreview(displayPreviewUrl(file, 'full'))
  )
  const image = cachedImage && matching
  const [candidate] = useState(() => (from ? { ...embedded(file), displayPreviewUrl: from } : file))
  const [thumbnail, setThumbnail] = useState(() =>
    morph || !isRenderedPreview(candidate) || cachedSmallPreview(displayPreviewUrl(candidate))
      ? candidate
      : undefined
  )
  const [still, setStill] = useState(
    () =>
      typeof WebGL2RenderingContext === 'undefined' ||
      !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  )
  const [source, setSource] = useState<HTMLCanvasElement>()
  // A morph shows the preview below until its first frame draws the same picture.
  const [covered] = useState(!ready && !morph)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const state = useRef({ developing, ready, onDone })
  state.current = { developing, ready, onDone }
  const wake = useRef<() => void>()
  const cloud = !image && !still
  useEffect(() => {
    if (image) return
    const controller = new AbortController()
    const { signal } = controller
    async function load(): Promise<void> {
      let selected = candidate
      let cached: HTMLCanvasElement | undefined
      if (!morph && isRenderedPreview(candidate)) {
        const url = displayPreviewUrl(candidate)
        if (url) cached = await lookupSmallPreview(url, 1, undefined, signal)
        if (!cached) selected = embedded(candidate)
      }
      if (signal.aborted) return
      setThumbnail(selected)
      if (!cloud) return
      const source =
        cached ??
        (await loadSmallPreview(
          displayPreviewUrl(selected),
          isRenderedPreview(selected) ? 1 : (selected.orientation ?? 1),
          isRenderedPreview(selected) ? undefined : selected.aspectRatio,
          signal,
          'selected'
        ))
      if (!signal.aborted) setSource(source)
    }
    void load().catch(() => {
      if (!signal.aborted) setStill(true)
    })
    return () => controller.abort()
  }, [cloud, image, candidate, morph])

  // Without a cloud, the preview replaces the placeholder at once.
  useEffect(() => {
    if (ready && (!cloud || !source)) state.current.onDone()
  }, [ready, cloud, source])

  useEffect(() => {
    if (!cloud || !source) return
    const canvas = canvasRef.current!
    const gl = canvas.getContext('webgl2', { antialias: false, depth: false })
    const width = Math.min(
      canvas.clientWidth - 2 * PADDING,
      ((canvas.clientHeight - 2 * PADDING) * source.width) / source.height
    )
    const { columns, rows } = particleGrid(source, width > 0 ? width : source.width)
    const draw = gl ? particleRenderer(gl, source, columns, rows) : undefined
    if (!draw) {
      gl?.getExtension('WEBGL_lose_context')?.loseContext()
      setStill(true)
      return
    }
    // A lost context draws nothing, so show the still thumbnail.
    const lost = (): void => setStill(true)
    canvas.addEventListener('webglcontextlost', lost)
    const start = performance.now()
    let last = start
    let spread = morph ? 0 : 1
    let alpha = morph ? 1 : 0
    // The edges of the canvas mask. Its background hides the preview below it.
    let cover = Number(canvas.style.getPropertyValue('--cover'))
    let fill = Number(canvas.style.getPropertyValue('--fill'))
    // A Web Animation of the cover runs the fade into the preview.
    let fade: Animation | undefined
    let frame = 0
    const step = (now: number): void => {
      frame = 0
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const { developing, ready, onDone } = state.current
      if (ready && !fade) {
        // A cloud that did not show yet leaves at once.
        if (alpha === 0) return onDone()
        const current = canvas.animate([{ '--cover': cover }, { '--cover': 0 }], {
          duration: REVEAL * 1000,
          easing: 'ease-in-out',
          fill: 'forwards'
        })
        // Finish events come before animation frames. A preview that went away
        // in the last frame of the fade needs the cloud again, so only the
        // current fade of a ready preview ends the cloud.
        current.onfinish = () => {
          if (fade !== current || !state.current.ready) return
          cancelAnimationFrame(frame)
          frame = 0
          state.current.onDone()
        }
        fade = current
      } else if (!ready && fade) {
        // Continue from the cover that shows now.
        cover = Number(getComputedStyle(canvas).getPropertyValue('--cover'))
        fade.cancel()
        fade = undefined
      }
      if (!fade) {
        const shown = morph || !developing || now - start > APPEAR_DELAY
        spread = approach(spread, developing ? 1 : 0, dt, RISE, SETTLE)
        alpha = approach(alpha, shown ? 1 : 0, dt, FADE_IN, FADE_IN)
        cover = approach(cover, 1, dt, FADE_IN, FADE_IN)
        fill = approach(fill, 1, dt, FADE_IN, FADE_IN)
        canvas.style.setProperty('--cover', String(cover))
        canvas.style.setProperty('--fill', String(fill))
      }
      // A mask adds a compositing pass, so a full cover has no mask.
      canvas.style.maskImage = fade || cover < 0.999 || fill < 0.999 ? MASK : ''
      const pixel = window.devicePixelRatio || 1
      const width = Math.round(canvas.clientWidth * pixel)
      const height = Math.round(canvas.clientHeight * pixel)
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }
      // The moving cloud keeps clear of the edges.
      const drawn = draw({
        size: [width, height],
        time: (now - start) / 1000,
        spread,
        alpha,
        from: contain(source.width / source.height, width, height, PADDING * pixel),
        to: contain(source.width / source.height, width, height),
        pixel
      })
      if (!drawn) return setStill(true)
      // Settled particles need no frames until the editor develops again.
      const settled = spread < 0.001 && alpha > 0.999 && cover > 0.999 && fill > 0.999
      if (!developing && !ready && settled) return
      frame = requestAnimationFrame(step)
    }
    wake.current = () => {
      if (frame) return
      last = performance.now()
      frame = requestAnimationFrame(step)
    }
    wake.current()
    return () => {
      cancelAnimationFrame(frame)
      fade?.cancel()
      fade = undefined
      wake.current = undefined
      canvas.removeEventListener('webglcontextlost', lost)
      gl?.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }, [cloud, source, morph])

  useEffect(() => wake.current?.(), [developing, ready])

  if (ready && !cloud) return null
  if (image)
    return (
      <div className="pointer-events-none absolute inset-0">
        <FilmstripImage
          file={file}
          containerClassName="h-full w-full"
          className="h-full w-full object-contain"
        />
      </div>
    )
  if (still)
    return morph || !thumbnail ? null : (
      <OrientedImage
        file={thumbnail}
        loading="eager"
        progressive={false}
        containerClassName="h-full w-full"
        className="h-auto w-auto object-contain"
      />
    )
  // The background of the preview stage in FileFilmstrip hides the preview
  // below the cloud until the cloud fades into it. A cloud that mounts over a
  // ready preview does not hide it.
  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={file.fileName}
      data-developing-preview=""
      className="pointer-events-none absolute inset-0 h-full w-full bg-tone-950"
      style={
        {
          '--cover': 1,
          '--fill': covered ? 1 : 0,
          maskImage: MASK,
          maskComposite: 'intersect'
        } as React.CSSProperties
      }
    />
  )
}
