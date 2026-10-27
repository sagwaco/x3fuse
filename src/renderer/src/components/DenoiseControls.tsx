import { defaultDenoiseOptions, type DenoiseOptions } from '@shared/denoise'
import { RotateCcw } from 'lucide-react'
import { t } from '../lib/strings'
import { Button } from './ui/button'
import { Select } from './ui/select'
import { Slider } from './ui/slider'
import { FIELD_LABEL, Row, ToggleRow } from './ui/settingsLayout'
import { AdvancedDetails } from './ui/advancedDetails'

/** The same sensor controls are used for conversion and editor preparation. */
export function DenoiseControls({
  value,
  change,
  commit,
  storageId
}: {
  value: DenoiseOptions
  change: (options: DenoiseOptions, commit?: boolean) => void
  commit?: () => void
  /**
   * For the editor sidebar. Keeps the open state of Advanced, and keeps its header at the
   * top while it scrolls, as a section does. Without it, Advanced starts closed.
   */
  storageId?: string
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
      <AdvancedDetails
        id={storageId}
        name={t('denoise.advanced')}
        action={
          <Button
            variant="ghost"
            size="icon"
            // The negative margins keep the summary height and line up the icon with the
            // controls below.
            className="-my-1 -mr-1 h-5 w-5"
            aria-label={t('denoise.reset')}
            title={t('denoise.reset')}
            onClick={() => change({ ...defaultDenoiseOptions(), algorithm: value.algorithm })}
          >
            <RotateCcw className="h-3 w-3" aria-hidden="true" />
          </Button>
        }
      >
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
          {/* The label of a Row, so that it looks the same in the editor and in export. */}
          <span className={FIELD_LABEL}>
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
      </AdvancedDetails>
    </div>
  )
}
