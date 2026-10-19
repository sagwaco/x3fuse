import { useEffect, useRef, useState } from 'react'
import { Layers } from 'lucide-react'
import type { X3FFileDTO } from '@shared/types'
import { displayPreviewUrl, isRenderedPreview } from '@shared/preview'
import { loadSmallPreview } from '../lib/previewImages'
import { cell, COUNT, fillOrder, hash, MIDDLE, SIZE } from '../lib/sfdCube'
import { program, texture } from '../lib/webgl'

/** CSS pixel size of the square canvas. It holds the orbits. */
const CANVAS = 44
/** CSS pixels between particles, and the particle radius. */
const SPACING = 2.9
const RADIUS = 0.5
/** A colored particle starts on this orbit radius, up to LIFT CSS pixels above or below its layer. */
const ORBIT = 17
const LIFT = 5
/** Seconds of a flight. */
const FLIGHT = 1.2
/**
 * During a merge, particles launch one at a time, fast enough to send the
 * waiting ones in LEAD seconds, about one merge step, but at MIN to MAX per
 * second. Thus they keep a steady stream.
 */
const LEAD = 2
const MIN = 4
const MAX = 120
/**
 * While the photo changes to the other RAW, particles launch fast enough to
 * send the waiting ones in SETTLE seconds, and fly for SWITCH seconds. The
 * stream slows as the cube fills, so the last particles wait for the photo.
 * When the photo shows, they launch at once, and all land in LAND seconds.
 */
const SETTLE = 0.4
const SWITCH = 0.6
const LAND = 0.25
/** Seconds for a landing flash to fade to a third. */
const FLASH = 0.12
/** Seconds of a drop, and its fall in CSS pixels per second squared. */
const DROP = 0.7
const GRAVITY = 90
/**
 * Gray particles fade in or out for FADE seconds. During a merge, they fade
 * out, so the particles appear as they land. When a drop ends, the gray ones
 * that are not wanted fade back in, each layer STAGGER seconds after the
 * layer above it.
 */
const FADE = 0.25
const STAGGER = 0.08
/** The wireframe around the cube, half a spacing out: dots per edge, and their size and alpha. */
const WIRE = 48
const WIRE_SIZE = 0.4
const WIRE_ALPHA = 0.3
/** Radians per second of the spin. */
const SPIN = (2 * Math.PI) / 16
/**
 * The isometric tilt. A still cube shows 15 degrees off the isometric angle:
 * there, particle columns line up and the cube looks like a flat hexagon.
 */
const TILT = Math.atan(Math.SQRT1_2)
const REST = Math.PI / 6
/** Floats per particle: x, y, size, red, green, blue, alpha, glow. */
const STRIDE = 8

const easeOut = (t: number): number => 1 - (1 - t) ** 3
const easeInOut = (t: number): number => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2)

/** Positions are CSS pixels from the canvas center, with y down. */
const PARTICLE = `#version 300 es
layout(location = 0) in vec2 a_position;
layout(location = 1) in float a_size;
layout(location = 2) in vec4 a_color;
layout(location = 3) in float a_glow;
uniform float u_half; // half the canvas size in CSS pixels
uniform float u_pixel; // device pixels per CSS pixel
out vec4 v_color;
out float v_glow;
out float v_radius; // in device pixels
void main() {
  gl_Position = vec4(a_position / u_half * vec2(1.0, -1.0), 0.0, 1.0);
  v_radius = 0.5 * a_size * u_pixel;
  // One more pixel holds the soft edge of the dot.
  gl_PointSize = 2.0 * v_radius + 1.0;
  v_color = a_color;
  v_glow = a_glow;
}`

/** Draws a soft dot, and its light into a glow buffer. A gray dot hides the glow behind it. */
const DOT = `#version 300 es
precision mediump float;
in vec4 v_color;
in float v_glow;
in float v_radius;
layout(location = 0) out vec4 color;
layout(location = 1) out vec4 glow;
void main() {
  float d = length(gl_PointCoord - 0.5) * (2.0 * v_radius + 1.0);
  float alpha = v_color.a * clamp(v_radius + 0.5 - d, 0.0, 1.0);
  color = vec4(v_color.rgb * alpha, alpha);
  glow = vec4(min(v_color.rgb * v_glow, vec3(1.0)) * alpha, alpha);
}`

/** One triangle that covers the canvas. */
const SCREEN = `#version 300 es
void main() {
  gl_Position = vec4(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0, 0.0, 1.0);
}`

/**
 * Adds a bloom from blurred mipmap levels of the glow buffer, and splits red
 * and blue away from the center for a chromatic aberration.
 */
const COMPOSITE = `#version 300 es
precision highp float;
uniform sampler2D u_scene;
uniform sampler2D u_glow;
out vec4 color;
vec3 level(vec2 uv, float lod) {
  vec2 d = 0.5 * exp2(lod) / vec2(textureSize(u_glow, 0));
  return 0.25 * (textureLod(u_glow, uv - d, lod).rgb + textureLod(u_glow, uv + d, lod).rgb
    + textureLod(u_glow, uv + vec2(d.x, -d.y), lod).rgb
    + textureLod(u_glow, uv + vec2(-d.x, d.y), lod).rgb);
}
vec3 bloom(vec2 uv) {
  return 0.6 * level(uv, 1.0) + 0.45 * level(uv, 2.0) + 0.3 * level(uv, 3.0);
}
void main() {
  vec2 uv = gl_FragCoord.xy / vec2(textureSize(u_scene, 0));
  // Dots split less than their bloom, so small gray dots stay gray.
  vec2 shift = 0.012 * (uv - 0.5);
  vec2 spread = 0.035 * (uv - 0.5);
  vec4 green = texture(u_scene, uv);
  // Red and blue split inside each dot only. Outside it, a split would darken
  // a light background into colored rims.
  float red = min(texture(u_scene, uv + shift).r, green.a);
  float blue = min(texture(u_scene, uv - shift).b, green.a);
  vec3 base = vec3(red, green.g, blue);
  vec3 light = vec3(bloom(uv + spread).r, bloom(uv).g, bloom(uv - spread).b);
  // Screen blending, so bright areas glow without clipping to white.
  vec3 rgb = base + light * (1.0 - base);
  float alpha = min(1.0, max(green.a, max(rgb.r, max(rgb.g, rgb.b))));
  color = vec4(min(rgb, vec3(alpha)), alpha);
}`

/** Draws `count` particles from `data`. Returns false when the canvas cannot hold the frame. */
type Draw = (data: Float32Array, count: number, pixel: number) => boolean

/**
 * Draws the particles into a scene texture (unit 0) and a glow texture
 * (unit 1), then both to the canvas with the bloom and aberration.
 */
function cubeRenderer(gl: WebGL2RenderingContext): Draw | undefined {
  const particles = program(gl, PARTICLE, DOT)
  const composite = program(gl, SCREEN, COMPOSITE)
  const scene = texture(gl, 0, gl.LINEAR)
  const glow = texture(gl, 1, gl.LINEAR_MIPMAP_LINEAR)
  const target = gl.createFramebuffer()
  const buffer = gl.createBuffer()
  if (!particles || !composite || !scene || !glow || !target || !buffer) return
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  for (const [location, size, offset] of [
    [0, 2, 0],
    [1, 1, 2],
    [2, 4, 3],
    [3, 1, 7]
  ]) {
    gl.enableVertexAttribArray(location)
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, STRIDE * 4, offset * 4)
  }
  gl.useProgram(composite)
  gl.uniform1i(gl.getUniformLocation(composite, 'u_scene'), 0)
  gl.uniform1i(gl.getUniformLocation(composite, 'u_glow'), 1)
  gl.useProgram(particles)
  const pixelSize = gl.getUniformLocation(particles, 'u_pixel')
  gl.uniform1f(gl.getUniformLocation(particles, 'u_half'), CANVAS / 2)
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  let size = 0
  return (data, count, pixel) => {
    const width = gl.drawingBufferWidth
    gl.bindFramebuffer(gl.FRAMEBUFFER, target)
    if (size !== width) {
      for (const [unit, attachment] of [
        [0, scene],
        [1, glow]
      ] as const) {
        gl.activeTexture(gl.TEXTURE0 + unit)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, width, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
        gl.framebufferTexture2D(
          gl.FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0 + unit,
          gl.TEXTURE_2D,
          attachment,
          0
        )
      }
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1])
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return false
      size = width
    }
    gl.viewport(0, 0, width, width)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(particles)
    gl.uniform1f(pixelSize, pixel)
    gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, count * STRIDE), gl.DYNAMIC_DRAW)
    gl.enable(gl.BLEND)
    gl.drawArrays(gl.POINTS, 0, count)
    gl.disable(gl.BLEND)
    gl.activeTexture(gl.TEXTURE1)
    gl.generateMipmap(gl.TEXTURE_2D)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.useProgram(composite)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    return true
  }
}

/** A CSS color token such as `--tone-500` as red, green and blue from 0 to 1. */
const token = (name: string): number[] =>
  getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim()
    .split(/\s+/)
    .map((value) => Number(value) / 255)

/**
 * A spinning isometric cube of particles, one layer per X3I frame. Gray
 * particles show the unfused RAW. As `fill` goes from 0 to 1, particles in the
 * colors of the photo preview fly in one at a time on orbits, from the middle
 * layer out, two layers at a time, and flash as they replace the gray ones. A
 * full cube shows the SFD RAW. When the fill goes down, colored particles drop
 * and fade out. Then gray particles fade in, from the top layer down. While
 * `fusing`, the gray particles fade out, so each particle appears as it lands.
 * While `switching`, the photo changes to the other RAW, and the cube
 * completes when the photo shows. A dotted wireframe outlines the cube.
 * Particles flicker, with a bloom and a chromatic aberration. It draws frames
 * only while it is in view. Reduced motion shows a still cube. Without WebGL
 * 2, it shows a layers icon.
 */
export function SfdCube({
  fill,
  fusing,
  switching = false,
  file
}: {
  fill: number
  fusing: boolean
  switching?: boolean
  file?: X3FFileDTO
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const target = useRef({ fill, fusing, switching })
  target.current = { fill, fusing, switching }
  const colors = useRef<Float32Array>()
  const wake = useRef<() => void>()
  // StrictMode sets the effect up again at once, so a release of the context waits a task.
  const gpu = useRef<{ gl: WebGL2RenderingContext; draw: Draw; release?: number }>()
  const [failed, setFailed] = useState(false)
  const url = file && displayPreviewUrl(file)
  const orientation = file && !isRenderedPreview(file) ? (file.orientation ?? 1) : 1
  const aspectRatio = file && !isRenderedPreview(file) ? file.aspectRatio : undefined

  // Each layer takes its colors from a band of rows of the preview, top to bottom.
  useEffect(() => {
    if (!url) return
    const controller = new AbortController()
    loadSmallPreview(url, orientation, aspectRatio, controller.signal).then(
      (source) => {
        const sample = document.createElement('canvas')
        sample.width = SIZE * SIZE
        sample.height = SIZE
        const context = sample.getContext('2d', { willReadFrequently: true })
        if (!context || controller.signal.aborted) return
        context.imageSmoothingQuality = 'high'
        context.drawImage(source, 0, 0, sample.width, sample.height)
        const { data } = context.getImageData(0, 0, sample.width, sample.height)
        const values = new Float32Array(3 * COUNT)
        for (let index = 0; index < COUNT; index++) {
          const [x, z, layer] = cell(index)
          const offset = 4 * (layer * SIZE * SIZE + x * SIZE + z)
          for (let channel = 0; channel < 3; channel++)
            values[3 * index + channel] = data[offset + channel] / 255
        }
        colors.current = values
        wake.current?.()
      },
      () => undefined
    )
    return () => controller.abort()
  }, [url, orientation, aspectRatio])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    if (gpu.current) window.clearTimeout(gpu.current.release)
    else {
      const gl = canvas.getContext('webgl2', { antialias: false, depth: false })
      const draw = gl ? cubeRenderer(gl) : undefined
      if (!gl || !draw) {
        gl?.getExtension('WEBGL_lose_context')?.loseContext()
        setFailed(true)
        return
      }
      gpu.current = { gl, draw }
    }
    const { gl, draw } = gpu.current
    const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    let still = !!motion?.matches
    let visible = true
    const sequence = fillOrder()
    // Cube positions in CSS pixels, with y up, polar coordinates in their
    // layers, the seconds from a drop to the gray fade-in, and random values
    // for the flight, the drop and the flicker.
    const home = Array.from({ length: COUNT }, (_, index) => {
      const [x, z, layer] = cell(index).map((value) => (value - MIDDLE) * SPACING)
      const radius = Math.hypot(x, z)
      return {
        x,
        y: -layer,
        z,
        radius,
        wait: DROP + STAGGER * cell(index)[2],
        phase: radius ? Math.atan2(z, x) : 2 * Math.PI * hash(index),
        lift: LIFT * (2 * hash(index + 3000) - 1),
        fall: GRAVITY * (0.7 + 0.6 * hash(index + 2000)),
        turn: Math.PI * (0.9 + 0.8 * hash(index + 4000)),
        rate: 3 + 6 * hash(index + 5000)
      }
    })
    // Dots along the 12 edges of the wireframe, as x, y and z.
    const edge = (MIDDLE + 0.5) * SPACING
    const wire = Array.from({ length: 12 * WIRE }, (_, i) => {
      const line = Math.floor(i / WIRE)
      const point = [line & 1 ? edge : -edge, line & 2 ? edge : -edge]
      point.splice(Math.floor(line / 4), 0, edge * ((2 * ((i % WIRE) + 0.5)) / WIRE - 1))
      return point
    })
    // The first `launched` particles of the sequence are colored.
    const wanted = (): number => Math.floor(target.current.fill * COUNT + 1e-6)
    let launched = wanted()
    let credit = 0
    // Seconds since each launch, or -1 for a gray particle.
    const clock = new Float64Array(COUNT).fill(-1)
    for (let k = 0; k < launched; k++) clock[sequence[k]] = FLIGHT
    const flashed = new Float64Array(COUNT).fill(-Infinity)
    // Where and when each colored particle started to drop, fixed in the view.
    const dropped = new Float64Array(COUNT).fill(-Infinity)
    const from = new Float32Array(3 * COUNT)
    const turned = new Float64Array(COUNT)
    // The alpha of each gray particle, and the time from which it waits to fade back in.
    const veil = new Float32Array(COUNT).fill(1)
    const reveal = new Float64Array(COUNT).fill(-Infinity)
    let merging = target.current.fusing
    const spot = [0, 0, 0]
    let gray = token('--tone-500')
    const neutral = [0.75, 0.75, 0.75]
    let angle = REST
    let time = 0
    let last = 0
    let frame = 0
    // Gray, colored and dropping particles and the wireframe, sorted from back
    // to front into `data`. A particle can have all three, when it launches
    // during its drop.
    const capacity = 3 * COUNT + wire.length
    const items = new Float32Array(capacity * STRIDE)
    const depth = new Float32Array(capacity)
    const order = new Uint16Array(capacity)
    const data = new Float32Array(capacity * STRIDE)
    const tint = [0, 0, 0]

    /** Puts a colored particle `amount` of its flight to its place into `spot`. */
    const place = (index: number, amount: number): void => {
      const { x, y, z, radius, phase, lift, turn } = home[index]
      // The particle circles the cube on an orbit, then dives to its place.
      const close = easeInOut(amount)
      const r = ORBIT + (radius - ORBIT) * close
      const around = phase - turn * (1 - easeOut(amount))
      spot[0] = amount >= 1 ? x : r * Math.cos(around)
      spot[1] = amount >= 1 ? y : y + lift * (1 - close)
      spot[2] = amount >= 1 ? z : r * Math.sin(around)
    }
    /** Puts the preview color of a particle into `tint`, toward white by `flash`. */
    const color = (index: number, bright: number, flash: number): void => {
      for (let channel = 0; channel < 3; channel++) {
        const value = (colors.current?.[3 * index + channel] ?? neutral[channel]) * bright
        tint[channel] = value + (1 - value) * 0.8 * flash
      }
    }

    const render = (): boolean => {
      const pixel = window.devicePixelRatio || 1
      if (canvas.width !== Math.round(CANVAS * pixel)) {
        canvas.width = Math.round(CANVAS * pixel)
        canvas.height = canvas.width
      }
      const [cos, sin] = [Math.cos(angle), Math.sin(angle)]
      const [up, down] = [Math.cos(TILT), Math.sin(TILT)]
      let count = 0
      const add = (
        x: number,
        y: number,
        z: number,
        size: number,
        alpha: number,
        glow: number
      ): void => {
        const front = x * sin + z * cos
        const near = (y * down + front * up + ORBIT) / (2 * ORBIT)
        const item = count * STRIDE
        items[item] = x * cos - z * sin
        items[item + 1] = front * down - y * up
        // Far particles are smaller and dimmer.
        items[item + 2] = size * (0.7 + 0.6 * near)
        items.set(tint, item + 3)
        items[item + 6] = alpha * (0.6 + 0.4 * near)
        items[item + 7] = glow
        depth[count] = near
        order[count] = count
        count++
      }
      for (let index = 0; index < COUNT; index++) {
        const { x, y, z, rate, fall } = home[index]
        const amount = clock[index] < 0 ? 0 : Math.min(1, clock[index] / FLIGHT)
        // Each particle flickers with its own smooth random brightness.
        const beat = time * rate + 17 * hash(index + 6000)
        const tick = Math.floor(beat)
        const blend = (beat - tick) ** 2 * (3 - 2 * (beat - tick))
        const noise =
          hash(index * 1013 + tick) * (1 - blend) + hash(index * 1013 + tick + 1) * blend
        const bright = still ? 1 : 0.7 + 0.6 * noise
        if (amount < 1 && veil[index] > 0) {
          for (let channel = 0; channel < 3; channel++) tint[channel] = gray[channel] * bright
          add(x, y, z, 2 * RADIUS, veil[index], 0)
        }
        if (amount > 0) {
          const flash = Math.exp(-(time - flashed[index]) / FLASH)
          color(index, bright, flash)
          place(index, amount)
          add(
            spot[0],
            spot[1],
            spot[2],
            2 * RADIUS * (1 + 1.5 * flash),
            Math.min(1, 4 * amount),
            0.35 + 2.5 * flash
          )
        }
        // A dropped particle falls straight down and fades.
        const since = time - dropped[index]
        if (since < DROP) {
          // Turn it back by the spin since the drop, so it falls in place.
          const back = turned[index] - angle
          const [dx, dy, dz] = [from[3 * index], from[3 * index + 1], from[3 * index + 2]]
          color(index, bright, 0)
          add(
            dx * Math.cos(back) - dz * Math.sin(back),
            dy - 0.5 * fall * since ** 2,
            dx * Math.sin(back) + dz * Math.cos(back),
            2 * RADIUS,
            (1 - since / DROP) ** 2,
            0.35
          )
        }
      }
      for (let channel = 0; channel < 3; channel++) tint[channel] = gray[channel]
      for (const [x, y, z] of wire) add(x, y, z, WIRE_SIZE, WIRE_ALPHA, 0)
      order.subarray(0, count).sort((a, b) => depth[a] - depth[b])
      for (let i = 0; i < count; i++)
        data.set(items.subarray(order[i] * STRIDE, (order[i] + 1) * STRIDE), i * STRIDE)
      return draw(data, count, pixel)
    }

    const step = (now: number): void => {
      frame = 0
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0
      last = now
      time += dt
      const goal = wanted()
      if (still) {
        launched = goal
        clock.fill(-1)
        dropped.fill(-Infinity)
        flashed.fill(-Infinity)
        veil.fill(1)
        reveal.fill(-Infinity)
        for (let k = 0; k < launched; k++) clock[sequence[k]] = FLIGHT
      } else {
        const { fusing, switching } = target.current
        const pace = fusing ? 1 : FLIGHT / (switching ? SWITCH : LAND)
        // A merge that stops before the cube is full brings back its gray particles.
        if (merging && !fusing) reveal.fill(time)
        merging = fusing
        for (let k = 0; k < launched; k++) {
          const index = sequence[k]
          const before = clock[index]
          clock[index] += dt * pace
          // A particle flashes as it replaces a gray one.
          if (before < FLIGHT && clock[index] >= FLIGHT) flashed[index] = time
        }
        // Colored particles that are no longer wanted drop from where they are.
        for (; launched > goal; launched--) {
          const index = sequence[launched - 1]
          place(index, Math.min(1, clock[index] / FLIGHT))
          from.set(spot, 3 * index)
          turned[index] = angle
          dropped[index] = time
          reveal[index] = time
          veil[index] = 0
          clock[index] = -1
        }
        if (fusing || switching) {
          // Wanted particles launch one at a time, each at its own moment in the frame.
          const waiting = goal - launched
          const rate = fusing ? Math.max(MIN, Math.min(MAX, waiting / LEAD)) : waiting / SETTLE
          credit = waiting > 0 ? credit + rate * dt : 0
          for (; credit >= 1 && launched < goal; launched++) {
            credit -= 1
            clock[sequence[launched]] = (credit / rate) * pace
          }
        } else {
          // The photo shows its RAW, so the wanted particles launch at once.
          credit = 0
          for (; launched < goal; launched++) clock[sequence[launched]] = 0
        }
        for (let k = 0; k < COUNT; k++) {
          const index = sequence[k]
          if (fusing) veil[index] = Math.max(0, veil[index] - dt / FADE)
          else if (k >= goal && time >= reveal[index] + home[index].wait)
            veil[index] = Math.min(1, veil[index] + dt / FADE)
        }
      }
      if (!still) angle += SPIN * dt
      if (!render()) return setFailed(true)
      if (!still && visible) frame = requestAnimationFrame(step)
      else last = 0
    }
    wake.current = () => {
      if (!frame && visible) frame = requestAnimationFrame(step)
    }
    wake.current()
    const lost = (): void => setFailed(true)
    canvas.addEventListener('webglcontextlost', lost)
    const theme = new MutationObserver(() => {
      gray = token('--tone-500')
      wake.current?.()
    })
    theme.observe(document.documentElement, { attributeFilter: ['data-theme'] })
    const reduce = (): void => {
      still = !!motion?.matches
      wake.current?.()
    }
    motion?.addEventListener('change', reduce)
    // A cube that is scrolled away or in a closed section draws nothing.
    const view =
      typeof IntersectionObserver === 'undefined'
        ? undefined
        : new IntersectionObserver(([entry]) => {
            visible = entry.isIntersecting
            if (visible) wake.current?.()
          })
    view?.observe(canvas)
    return () => {
      cancelAnimationFrame(frame)
      theme.disconnect()
      view?.disconnect()
      motion?.removeEventListener('change', reduce)
      canvas.removeEventListener('webglcontextlost', lost)
      wake.current = undefined
      const current = gpu.current
      if (current)
        current.release = window.setTimeout(() => {
          gl.getExtension('WEBGL_lose_context')?.loseContext()
          gpu.current = undefined
        })
    }
  }, [])

  useEffect(() => wake.current?.(), [fill, fusing, switching])

  if (failed) return <Layers aria-hidden="true" className="m-3.5 h-4 w-4 text-tone-400" />
  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="block"
      style={{ width: CANVAS, height: CANVAS }}
    />
  )
}
