import { Fragment } from 'react'

// The notice is on the first kept statement, so the production bundle keeps it.
/*!
 * The displacement map and the filter are adapted from Liquid Glass
 * (https://github.com/nikdelvin/liquid-glass).
 *
 * MIT License
 *
 * Copyright (c) 2025 Nikita Stadnik
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
/**
 * The lens reaches this far past each side of the knob, so a negative strength
 * can bring in pixels from around the knob. It must be at least half of the
 * largest strength plus spread. Keep it equal to the .glass-lens inset in index.css.
 */
const PAD = 16

/**
 * An SVG image for feDisplacementMap. Red moves pixels on x, green on y. Near
 * the edges, a positive strength takes pixels from nearer the center, and a
 * negative strength takes them from farther out. Gray keeps its pixels.
 * WebKit ignores CSS blur() in an SVG image, so SVG blur filters do the blur.
 */
function displacementMap(width: number, height: number, radius: number, depth: number): string {
  const y = Math.ceil((radius / height) * 15)
  const x = Math.ceil((radius / width) * 15)
  const blur = (id: string, deviation: number): string =>
    `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${deviation}"/></filter>`
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width + 2 * PAD}" height="${height + 2 * PAD}"><defs>` +
    `<linearGradient id="y" x1="0" x2="0" y1="${y}%" y2="${100 - y}%"><stop stop-color="#0f0"/><stop offset="1" stop-color="#000"/></linearGradient>` +
    `<linearGradient id="x" x1="${x}%" x2="${100 - x}%" y1="0" y2="0"><stop stop-color="#f00"/><stop offset="1" stop-color="#000"/></linearGradient>` +
    `${blur('edge', 1)}${blur('depth', depth)}</defs>` +
    `<rect width="100%" height="100%" fill="#808080"/>` +
    `<g transform="translate(${PAD} ${PAD})" filter="url(#edge)"><rect width="${width}" height="${height}" fill="#000080"/>` +
    `<rect width="${width}" height="${height}" fill="url(#y)" style="mix-blend-mode:screen"/>` +
    `<rect width="${width}" height="${height}" fill="url(#x)" style="mix-blend-mode:screen"/>` +
    `<rect x="${depth}" y="${depth}" width="${width - 2 * depth}" height="${height - 2 * depth}" rx="${radius}" fill="#808080" filter="url(#depth)"/></g></svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

/**
 * Each knob's glass size (see index.css), and how strongly its lens refracts.
 * A negative strength makes the track look smaller in the lens, as in macOS.
 * The slider lens bends only on x. On y, its thin track gets stair steps.
 */
const LENSES = [
  { id: 'glass-switch', width: 28, height: 24, radius: 12, depth: 6, strength: -16, y: true },
  { id: 'glass-slider', width: 24, height: 18, radius: 9, depth: 5, strength: -50, y: false }
]

/** Red refracts most and blue least, which splits colors at the edges. */
const CHANNELS = [
  { result: 'r', spread: 0, matrix: '1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0' },
  { result: 'g', spread: 0, matrix: '0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0' },
  { result: 'b', spread: 0, matrix: '0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0' }
]

/**
 * Liquid glass filters that bend the edges of a lens, sized for the switch and
 * slider knobs. Render once per window. The knobs do not use them now (see
 * .glass-lens in index.css). Larger glass can use them with filter: url(#id).
 */
export function GlassFilters(): React.JSX.Element {
  return (
    <svg aria-hidden="true" width="0" height="0" className="absolute">
      {LENSES.map(({ id, width, height, radius, depth, strength, y }) => (
        // The region is the element box, and the map has no size, so it fits the
        // box as the knob grows. WebKit misplaces an feImage with a size.
        <filter key={id} id={id} x="0" y="0" width="1" height="1" colorInterpolationFilters="sRGB">
          <feImage
            href={displacementMap(width, height, radius, depth)}
            preserveAspectRatio="none"
            result="map"
          />
          {CHANNELS.map(({ result, spread, matrix }) => (
            <Fragment key={result}>
              <feDisplacementMap
                in="SourceGraphic"
                in2="map"
                scale={strength + spread}
                xChannelSelector="R"
                // Blue is 0.5 everywhere in the map, so it does not move pixels.
                yChannelSelector={y ? 'G' : 'B'}
              />
              <feColorMatrix type="matrix" values={matrix} result={result} />
            </Fragment>
          ))}
          <feBlend in="r" in2="g" mode="screen" />
          <feBlend in2="b" mode="screen" />
        </filter>
      ))}
    </svg>
  )
}
