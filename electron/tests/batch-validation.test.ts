import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { validateBatch } from '../src/main/services/batchValidation'
import { outputFilePath } from '../src/main/services/queueHelpers'
import { outputFileName } from '../src/renderer/src/lib/outputName'
import { batchSettings, DEFAULT_SETTINGS, type OutputFormat } from '@shared/types'

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'x3f-batch-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})
const settings = () => ({ ...batchSettings(DEFAULT_SETTINGS), outputDirectory: directory })
const file = { id: 'a', path: '/source/image.X3F', fileName: 'image.X3F' }

describe('batch preflight', () => {
  it.each<[OutputFormat, string]>([
    ['dng', 'image.dng'],
    ['tiff', 'image.X3F.tif'],
    ['embeddedJpg', 'image.X3F.jpg']
  ])(
    'checks %s paths consistently with preview names and includes only conflicts',
    async (outputFormat, name) => {
      const options = { ...settings(), outputFormat }
      expect(outputFileName(file, options)).toBe(name)
      expect(outputFilePath(options, file.path)).toBe(join(directory, name))
      await writeFile(join(directory, name), 'existing output')
      expect(await validateBatch([file, { id: 'b', path: '/source/other.X3F' }], options)).toEqual([
        { id: 'a', outputPath: join(directory, name) }
      ])
    }
  )

  it('confirms duplicate targets and existing intermediate DNG files', async () => {
    expect(
      await validateBatch([file, { id: 'b', path: '/other/image.X3F' }], settings())
    ).toHaveLength(2)
    await writeFile(join(directory, 'image.X3F.dng'), 'old intermediate')
    expect(await validateBatch([file], settings())).toEqual([
      { id: 'a', outputPath: join(directory, 'image.dng') }
    ])
  })

  it('rejects unavailable destinations and malformed options before conversion', async () => {
    await expect(
      validateBatch([file], { ...settings(), outputDirectory: join(directory, 'missing') })
    ).rejects.toThrow()
    await writeFile(join(directory, 'not-a-directory'), 'file')
    await expect(
      validateBatch([file], { ...settings(), outputDirectory: join(directory, 'not-a-directory') })
    ).rejects.toThrow('Not a directory')
    await expect(validateBatch([file], { ...settings(), denoiseIntensity: NaN })).rejects.toThrow(
      'Invalid conversion setting'
    )
    await expect(validateBatch([file], { ...settings(), concurrency: 99 })).rejects.toThrow(
      'Invalid conversion setting'
    )
    await expect(validateBatch([{ id: 'a', path: 'relative.X3F' }], settings())).rejects.toThrow(
      'Invalid conversion file'
    )
    await expect(validateBatch([file, file], settings())).rejects.toThrow('Invalid conversion file')
  })

  it('resolves alongside-source destinations separately', async () => {
    const alongside = { ...file, path: join(directory, 'image.X3F') }
    await writeFile(join(directory, 'image.dng'), 'existing')
    expect(await validateBatch([alongside], { ...settings(), outputDirectory: null })).toEqual([
      { id: 'a', outputPath: join(directory, 'image.dng') }
    ])
  })
})
