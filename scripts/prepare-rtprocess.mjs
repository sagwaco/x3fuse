import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { downloadVerified } from './download-verified.mjs'

// librtprocess master after 0.12.0, with the MSVC fixes of June 2023. There
// is no release archive of this commit. GitHub generates the archive, and it
// changed its bytes once in 2023; a new change fails the checksum safely.
export const commit = '9a858270acb2096e2e403d932760ee688fcac425'
const sha256 = 'a85bac0d67fc08ceaf61a7deeedff5ffaf8edabcebeb9a59924df378efc800f6'
export const kernels = ['ahd', 'amaze', 'bayerfast', 'border', 'dcb', 'hphd', 'igv', 'lmmse', 'vng4']

const cancel = 'if (setProgCancel(progress)) goto x3f_cancel;'
const label = 'x3f_cancel:;\n'

// Upstream kernels ignore the return value of setProgCancel. These exact
// replacements make each kernel stop at its progress points. A cancelled
// kernel jumps to its own cleanup code, so it frees all of its buffers.
// `count` is the number of matches that the pinned source must contain.
export const patches = [
  ['ahd.cc', '                        setProgCancel(progress);\n', `                        ${cancel}\n`, 1],
  ['ahd.cc', '    delete [] buffer;\n}\n', `${label}    delete [] buffer;\n}\n`, 1],
  // AMaZE: also before each tile, not only at every 32nd tile.
  [
    'amaze.cc',
    '                    memset(&nyquist[3 * tsh], 0,',
    `                    ${cancel}\n                    memset(&nyquist[3 * tsh], 0,`,
    1
  ],
  ['amaze.cc', '                            setProgCancel(progress);\n', `                            ${cancel}\n`, 1],
  ['amaze.cc', '        // clean up\n', `${label}        // clean up\n`, 1],
  // A last tile column that overlaps the image by 16 pixels or less (for
  // example width 127) has no pixels, but the odd-width tail still wrote
  // one pixel after the row end. RawTherapee 5.13 has the same code.
  [
    'amaze.cc',
    'if(cc1 & 1) { // width of tile is odd',
    'if((cc1 & 1) && indx < rr * ts + cc1 - 16) { // width of tile is odd',
    4
  ],
  ['bayerfast.cc', '                            setProgCancel(progress);\n', `                            ${cancel}\n`, 1],
  ['bayerfast.cc', '        free(buffer);\n    } // End', `${label}        free(buffer);\n    } // End`, 1],
  [
    'dcb.cc',
    '            memset(tile, 0, CACHESIZE * CACHESIZE * sizeof * tile);\n',
    '            if (setProgCancel(currentProgress)) goto x3f_cancel;\n            memset(tile, 0, CACHESIZE * CACHESIZE * sizeof * tile);\n',
    1
  ],
  ['dcb.cc', '    if (buffer0) {\n        free(buffer0);', `${label}    if (buffer0) {\n        free(buffer0);`, 1],
  // HPHD: the serial passes run in strips of 256 columns or rows, as the
  // OpenMP passes run in blocks. Columns and rows are independent.
  [
    'hphd.cc',
    '    rc = hphd_vertical(rawData, hpmap, 0, W, H);\n',
    '    for (int k = 0; k < W && !rc; k += 256) {\n        if (setProgCancel(0.0)) return rc;\n        rc = hphd_vertical(rawData, hpmap, k, std::min(k + 256, W), H);\n    }\n',
    1
  ],
  [
    'hphd.cc',
    '        rc = hphd_horizontal(rawData, hpmap, 0, H, W);\n',
    '        for (int k = 0; k < H && !rc; k += 256) {\n            if (setProgCancel(0.35)) return rc;\n            rc = hphd_horizontal(rawData, hpmap, k, std::min(k + 256, H), W);\n        }\n',
    1
  ],
  ['hphd.cc', '            setProgCancel(0.43);\n', '            if (setProgCancel(0.43)) return rc;\n', 1],
  ...['0.13', '0.26', '0.39', '0.52', '0.65', '0.78', '0.91'].map((p) => [
    'igv.cc',
    `setProgCancel(${p});\n`,
    `if (setProgCancel(${p})) goto x3f_cancel;\n`,
    p === '0.52' ? 1 : 2
  ]),
  [
    'igv.cc',
    '    rc = bayerborder_demosaic(winw, winh, 8,',
    `${label}    rc = bayerborder_demosaic(winw, winh, 8,`,
    2
  ],
  ...['0.1', '0.2', '0.3', '0.4', '0.5', '0.6', '0.7', '0.8'].map((p) => [
    'lmmse.cc',
    `setProgCancel(${p});\n`,
    `if (setProgCancel(${p})) goto x3f_cancel;\n`,
    1
  ]),
  ['lmmse.cc', '    setProgCancel(1.0);\n\n    if (buffer) {', `${label}    setProgCancel(1.0);\n\n    if (buffer) {`, 1],
  [
    'lmmse.cc',
    '        setProgCancel((double)b / PassCount);\n',
    '        if (setProgCancel((double)b / PassCount)) return;\n',
    1
  ],
  ['vng4.cc', '        setProgCancel(progress);\n\n#ifdef _OPENMP', `        ${cancel}\n\n#ifdef _OPENMP`, 1],
  ['vng4.cc', '                        setProgCancel(progress);\n', `                        ${cancel}\n`, 1],
  ['vng4.cc', '        free(code[0][0]);\n', `${label}        free(code[0][0]);\n`, 1]
]

// The GPLv3 notice of modification at the top of each patched file.
const changes = {
  'ahd.cc': 'stops on cancel',
  'amaze.cc': 'stops on cancel; odd-width tail stays in the row',
  'bayerfast.cc': 'stops on cancel',
  'dcb.cc': 'stops on cancel',
  'hphd.cc': 'stops on cancel; serial passes in strips',
  'igv.cc': 'stops on cancel',
  'lmmse.cc': 'stops on cancel',
  'vng4.cc': 'stops on cancel'
}

function patchAll(sources) {
  for (const [file, from, to, count] of patches) {
    const found = sources[file].split(from).length - 1
    if (found !== count) {
      throw new Error(`librtprocess patch for ${file} matched ${found} times, expected ${count}`)
    }
    sources[file] = sources[file].replaceAll(from, to)
  }
  for (const [file, change] of Object.entries(changes)) {
    sources[file] =
      `// Modified for X3Fuse by scripts/prepare-rtprocess.mjs, 2026-10-26: ${change}.\n` +
      sources[file]
  }
}

/** Prepare the librtprocess subset that x3f-dng compiles. */
export async function prepareRtprocess(root) {
  const destination = join(root, 'src-tauri/crates/x3f-dng/rtprocess')
  const revision = createHash('sha256').update(JSON.stringify(patches)).digest('hex')
  const marker = `${commit}:${sha256}:${revision}`
  if (
    (await readFile(join(destination, '.version'), 'utf8').catch(() => '')) === marker &&
    existsSync(join(destination, 'include/librtprocess.h'))
  )
    return

  const cache = join(root, '.cache')
  await mkdir(cache, { recursive: true })
  const archivePath = join(cache, `librtprocess-${commit}.tar.gz`)
  await downloadVerified(
    `https://github.com/CarVac/librtprocess/archive/${commit}.tar.gz`,
    archivePath,
    sha256
  )
  const temporary = await mkdtemp(join(cache, 'rtprocess-'))
  try {
    const tar =
      process.platform === 'win32'
        ? join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'tar.exe')
        : 'tar'
    execFileSync(tar, ['-xf', archivePath, '-C', temporary], { stdio: 'inherit' })
    const source = join(temporary, `librtprocess-${commit}`)
    const prepared = join(temporary, 'prepared')
    await mkdir(join(prepared, 'demosaic'), { recursive: true })
    await cp(join(source, 'src/include'), join(prepared, 'include'), { recursive: true })
    for (const name of ['LICENSE.txt', 'README.md']) {
      await cp(join(source, name), join(prepared, name))
    }
    const sources = {}
    for (const name of kernels) {
      sources[`${name}.cc`] = await readFile(join(source, 'src/demosaic', `${name}.cc`), 'utf8')
    }
    patchAll(sources)
    for (const [name, text] of Object.entries(sources)) {
      await writeFile(join(prepared, 'demosaic', name), text)
    }
    await writeFile(join(prepared, '.version'), marker)
    await mkdir(join(destination, '..'), { recursive: true })
    await rm(destination, { recursive: true, force: true })
    await rename(prepared, destination)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
