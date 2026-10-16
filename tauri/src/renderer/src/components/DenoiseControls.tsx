import { defaultDenoiseOptions, type DenoiseOptions } from '@shared/denoise'
import { t } from '../lib/strings'
import { Select } from './ui/select'
import { Slider } from './ui/slider'
import { Row, ToggleRow } from './ui/settingsLayout'

/** The same sensor controls are used for conversion and editor preparation. */
export function DenoiseControls({
  value,
  change,
  commit
}: {
  value: DenoiseOptions
  change: (options: DenoiseOptions, commit?: boolean) => void
  commit?: () => void
}): React.JSX.Element {
  const update = (patch: Partial<DenoiseOptions>, committed = true): void =>
    change({ ...value, ...patch }, committed)
  const window = (
    key: keyof DenoiseOptions['nlm'],
    max: number,
    disabled: boolean
  ): React.JSX.Element => (
    <Row label={t(`denoise.${key}`)}>
      <Select
        aria-label={t(`denoise.${key}`)}
        value={String(value.nlm[key])}
        disabled={disabled}
        options={Array.from({ length: (max + 1) / 2 }, (_, i) => ({
          value: String(i * 2 + 1),
          label: String(i * 2 + 1)
        }))}
        onValueChange={(size) => update({ nlm: { ...value.nlm, [key]: Number(size) } })}
      />
    </Row>
  )
  return (
    <div className="space-y-3">
      <Row label={t('denoise.algorithm')}>
        <Select
          aria-label={t('denoise.algorithm')}
          value={value.algorithm}
          options={[
            { value: 'nlm', label: 'NLM' },
            { value: 'bm3d', label: 'BM3D' }
          ]}
          onValueChange={(algorithm) => update({ algorithm })}
        />
      </Row>
      {value.algorithm === 'bm3d' && (
        <p className="text-xs text-tone-500">{t('denoise.bm3dHelp')}</p>
      )}
      <details className="space-y-3 text-xs text-tone-300">
        <summary className="control-label cursor-pointer select-none font-bold text-tone-400">
          {t('denoise.advanced')}
        </summary>
        <ToggleRow
          label={t('denoise.luminance')}
          checked={value.luminance}
          onChange={(luminance) => update({ luminance })}
        />
        <ToggleRow
          label={t('denoise.chroma')}
          checked={value.chroma}
          onChange={(chroma) => update({ chroma })}
        />
        <p className="text-tone-500">{t('denoise.channelsHelp')}</p>
        <div className="space-y-2">
          <span className="control-label">
            {t('denoise.strength')} ({value.strength.toFixed(1)}×)
          </span>
          <Slider
            aria-label={t('denoise.strength')}
            value={value.strength}
            min={0.1}
            max={3}
            step={0.1}
            onValueChange={(strength) => update({ strength }, false)}
            onValueCommit={() => commit?.()}
          />
        </div>
        {value.algorithm === 'nlm' && (
          <>
            {window('lumaPatch', 9, !value.luminance)}
            {window('lumaSearch', 31, !value.luminance)}
            {window('chromaPatch', 9, !value.chroma)}
            {window('chromaSearch', 31, !value.chroma)}
            <p className="text-tone-500">{t('denoise.windowsHelp')}</p>
          </>
        )}
        <button
          type="button"
          className="control-label text-tone-500 hover:text-tone-100"
          onClick={() => change({ ...defaultDenoiseOptions(), algorithm: value.algorithm })}
        >
          {t('denoise.reset')}
        </button>
      </details>
    </div>
  )
}
