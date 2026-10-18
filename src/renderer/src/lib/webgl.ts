/** Small WebGL 2 helpers for the canvas effects. */

/** Compiles and links a program. Returns undefined when that fails. */
export function program(
  gl: WebGL2RenderingContext,
  vertex: string,
  fragment: string
): WebGLProgram | undefined {
  const program = gl.createProgram()
  if (!program) return
  for (const [type, code] of [
    [gl.VERTEX_SHADER, vertex],
    [gl.FRAGMENT_SHADER, fragment]
  ] as const) {
    const shader = gl.createShader(type)
    if (!shader) return
    gl.shaderSource(shader, code)
    gl.compileShader(shader)
    gl.attachShader(program, shader)
  }
  gl.linkProgram(program)
  return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : undefined
}

/** Binds a new texture to texture unit `unit`. */
export function texture(
  gl: WebGL2RenderingContext,
  unit: number,
  min: number
): WebGLTexture | null {
  const texture = gl.createTexture()
  gl.activeTexture(gl.TEXTURE0 + unit)
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return texture
}
