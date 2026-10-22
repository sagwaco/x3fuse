import { useContext, useEffect, useRef, useState } from 'react'
import { Pipette, RotateCcw } from 'lucide-react'
import {
  boundedWhiteBalanceGains,
  usesExtendedWhiteBalance,
  type EditRecipe,
  type Rgb,
  type WhiteBalanceValues
} from '@shared/editor'
import { useEditorStore } from '../stores/editorStore'
import { useQueueStore } from '../stores/queueStore'
import { DevelopingCloud } from '../lib/developingCloud'
import { ipc } from '../lib/ipc'
import { t } from '../lib/strings'
import { withShortcut } from '../lib/shortcut'
import { Adjustment, TEMPERATURE, TINT } from './EditorControls'
import { GainWhiteBalance } from './RawColorControls'
import { Button } from './ui/button'
import { Select } from './ui/select'
import { ToggleRow } from './ui/settingsLayout'

const PRESETS = [
  ['asShot', null],
  ['daylight', 5500],
  ['cloudy', 6500],
  ['shade', 7500],
  ['tungsten', 2850],
  ['flash', 6000]
] as const
const keyOf = (recipe: EditRecipe): string =>
  JSON.stringify([
    recipe.temperature,
    recipe.tint,
    recipe.rawColor?.gains,
    recipe.whiteBalanceGains,
    recipe.x3iSource
  ])
const sameGains = (a: Rgb, b: Rgb): boolean =>
  a.every((value, i) => Math.abs(value / a[1] - b[i] / b[1]) < 1e-6)

export function WhiteBalanceControls({
  recipe,
  picking,
  setPicking
}: {
  recipe: EditRecipe
  picking: boolean
  setPicking: (value: boolean) => void
}): React.JSX.Element {
  const session = useEditorStore((state) => state.session)
  const sessionId = session?.sessionId
  const preview = useEditorStore((state) => state.preview)
  const change = useEditorStore((state) => state.change)
  const storeCommit = useEditorStore((state) => state.commit)
  const inactive = useEditorStore(
    (state) => state.before || state.loading || state.closing || !state.preview
  )
  const busy = useQueueStore((state) => state.isProcessing || state.isPreparing)
  const cloud = useContext(DevelopingCloud)
  const disabled = inactive || busy || cloud
  const asShot = preview?.asShotGains
  const direct = recipe.rawColor?.gains ?? recipe.whiteBalanceGains
  const key = keyOf(recipe)
  const [extended, setExtended] = useState(() => usesExtendedWhiteBalance(recipe))
  const [converted, setConverted] = useState<{ key: string; values: WhiteBalanceValues }>()
  const [draft, setDraft] = useState<{ key: string; temperature: number; tint: number }>()
  const [notice, setNotice] = useState<string>()
  const serial = useRef(0)
  const pending = useRef<{ commit: boolean }>()
  const metadata = preview?.whiteBalance
  const metadataMatches =
    metadata &&
    (direct
      ? sameGains(metadata.gains, direct)
      : recipe.temperature !== null
        ? metadata.temperature === recipe.temperature && metadata.tint === recipe.tint
        : recipe.tint === 0 && asShot && sameGains(metadata.gains, asShot))
  const balance = converted?.key === key ? converted.values : metadataMatches ? metadata : undefined
  const needsConversion = extended ? !direct : !!direct
  const gains = direct ?? (balance && boundedWhiteBalanceGains(balance.gains))
  const physical = draft?.key === key ? draft : direct ? balance : undefined
  const physicalTemperature =
    physical?.temperature ??
    recipe.temperature ??
    (cloud ? 6500 : (preview?.asShotTemperature ?? 6500))
  const physicalTint = physical?.tint ?? recipe.tint
  const temperature = Math.max(2000, Math.min(12000, physicalTemperature))
  const tint = Math.max(-100, Math.min(100, physicalTint))
  const preset = direct
    ? asShot && sameGains(direct, asShot)
      ? 'asShot'
      : (PRESETS.find(
          ([, kelvin]) =>
            kelvin !== null &&
            balance &&
            Math.abs(balance.temperature - kelvin) <= 1 &&
            Math.abs(balance.tint) <= 1
        )?.[0] ?? 'custom')
    : (PRESETS.find(([, kelvin]) => recipe.temperature === kelvin && recipe.tint === 0)?.[0] ??
      'custom')

  useEffect(() => {
    useEditorStore.setState({ whiteBalanceExtended: extended })
  }, [extended])
  useEffect(
    () => () => {
      if (pending.current?.commit && useEditorStore.getState().session?.sessionId === sessionId)
        storeCommit()
      // shortcut: leaving cancels a pending fit; retain it when navigation must wait for that fit.
      serial.current++
      pending.current = undefined
    },
    [sessionId, storeCommit]
  )
  useEffect(() => {
    if (extended && !direct && balance && !boundedWhiteBalanceGains(balance.gains)) {
      setExtended(false)
      setNotice(t('editor.extendedRangeUnavailable'))
      return
    }
    if (!needsConversion || balance || !session || !preview || disabled) return
    let cancelled = false
    void ipc
      .invoke('editor:whiteBalance', { sessionId: session.sessionId, recipe })
      .then((values) => {
        if (cancelled) return
        if (extended && !boundedWhiteBalanceGains(values.gains)) {
          setExtended(false)
          setNotice(t('editor.extendedRangeUnavailable'))
        } else setConverted({ key, values })
      })
      .catch((error: unknown) => {
        if (!cancelled && !/calibration is not ready/i.test(String(error))) setNotice(String(error))
      })
    return () => {
      cancelled = true
    }
  }, [key, needsConversion, balance, session, preview, disabled, extended, recipe, direct])

  const commit = (): void => {
    if (pending.current) pending.current.commit = true
    else storeCommit()
  }
  const setGains = (next: Rgb, save: boolean): void => {
    serial.current++
    pending.current = undefined
    setDraft(undefined)
    setNotice(undefined)
    change(
      recipe.rawColor
        ? { rawColor: { ...recipe.rawColor, gains: next } }
        : { whiteBalanceGains: next },
      save
    )
  }
  const setPhysical = (nextTemperature: number | null, nextTint: number, save = true): void => {
    setNotice(undefined)
    if (!recipe.rawColor) {
      change({ temperature: nextTemperature, tint: nextTint, whiteBalanceGains: null }, save)
      return
    }
    if (nextTemperature === null && nextTint === 0 && asShot) {
      serial.current++
      setGains([...asShot], save)
      return
    }
    if (!session) return
    const source = useEditorStore.getState().documents[session.path]?.recipe
    if (!source?.rawColor || useEditorStore.getState().session?.sessionId !== session.sessionId)
      return
    const requestKey = keyOf(source)
    const request = ++serial.current
    const gesture = { commit: save }
    pending.current = gesture
    setDraft({
      key: requestKey,
      temperature: nextTemperature ?? preview?.asShotTemperature ?? 6500,
      tint: nextTint
    })
    void ipc
      .invoke('editor:whiteBalance', {
        sessionId: session.sessionId,
        recipe: {
          ...source,
          rawColor: null,
          whiteBalanceGains: null,
          temperature: nextTemperature,
          tint: nextTint
        }
      })
      .then((values) => {
        const state = useEditorStore.getState()
        const current = state.documents[session.path]?.recipe
        if (
          request !== serial.current ||
          state.session?.sessionId !== session.sessionId ||
          !current?.rawColor ||
          keyOf(current) !== requestKey ||
          state.closing ||
          state.loading ||
          state.before
        )
          return
        const next = boundedWhiteBalanceGains(values.gains)
        if (!next) {
          setDraft(undefined)
          setNotice(t('editor.extendedRangeUnavailable'))
          return
        }
        const rawColor = { ...current.rawColor, gains: next }
        setConverted({ key: keyOf({ ...current, rawColor }), values: { ...values, gains: next } })
        change({ rawColor }, gesture.commit)
      })
      .catch((error: unknown) => {
        if (request === serial.current) {
          setDraft(undefined)
          if (!/calibration is not ready/i.test(String(error)) || gesture.commit)
            setNotice(
              /calibration is not ready/i.test(String(error))
                ? t('editor.whiteBalanceLoading')
                : String(error)
            )
        }
      })
      .finally(() => {
        if (pending.current === gesture) {
          pending.current = undefined
          setDraft(undefined)
          if (gesture.commit && useEditorStore.getState().session?.sessionId === session.sessionId)
            storeCommit()
        }
      })
  }
  const reset = (): void => {
    serial.current++
    pending.current = undefined
    setDraft(undefined)
    if (recipe.rawColor && asShot) setGains([...asShot], true)
    else if (!recipe.rawColor) setPhysical(null, 0)
  }
  const asShotPhysicalTint =
    recipe.temperature === null && recipe.tint === 0 && !direct
      ? (preview?.asShotTint ?? 0)
      : physicalTint

  return (
    <>
      <div className="flex items-center gap-1.5">
        <Select
          aria-label={t('editor.whiteBalancePreset')}
          className="flex-1"
          value={preset}
          disabled={disabled || (!!recipe.rawColor && !asShot)}
          options={[
            ...PRESETS.map(([value]) => ({ value, label: t(`editor.${value}`) })),
            ...(preset === 'custom'
              ? [{ value: 'custom', label: t('editor.customWhiteBalance'), disabled: true }]
              : [])
          ]}
          onValueChange={(value) => {
            const selected = PRESETS.find(([name]) => name === value)
            if (selected) setPhysical(selected[1], 0)
          }}
        />
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          aria-label={t('editor.picker')}
          title={withShortcut(t('editor.picker'), 'whiteBalancePicker')}
          aria-keyshortcuts="W"
          aria-pressed={picking}
          disabled={disabled}
          onClick={() => setPicking(!picking)}
        >
          <Pipette aria-hidden="true" className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          aria-label={t('editor.resetWhiteBalance')}
          title={t('editor.resetWhiteBalance')}
          disabled={disabled || preset === 'asShot'}
          onClick={reset}
        >
          <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
        </Button>
      </div>
      {picking && (
        <p role="status" className="control-label text-tone-100">
          {t('editor.pickNeutral')}
        </p>
      )}
      {extended ? (
        <GainWhiteBalance
          gains={gains ?? asShot ?? [1, 1, 1]}
          asShot={asShot ?? [1, 1, 1]}
          disabled={disabled || !gains || !asShot}
          change={setGains}
          commit={commit}
        />
      ) : (
        <>
          <Adjustment
            label={t('editor.temperature')}
            value={temperature}
            min={2000}
            max={12000}
            step={50}
            track={TEMPERATURE}
            disabled={disabled || (!!direct && !physical)}
            change={(value, save) => setPhysical(value, asShotPhysicalTint, save)}
            reset={() =>
              recipe.rawColor
                ? setPhysical(preview?.asShotTemperature ?? 6500, physicalTint)
                : change({ temperature: null, whiteBalanceGains: null })
            }
            commit={commit}
          />
          <Adjustment
            label={t('editor.tint')}
            value={tint}
            track={TINT}
            disabled={disabled || (!!direct && !physical)}
            change={(value, save) =>
              setPhysical(
                recipe.rawColor || direct ? physicalTemperature : recipe.temperature,
                value,
                save
              )
            }
            reset={() =>
              setPhysical(recipe.rawColor || direct ? physicalTemperature : recipe.temperature, 0)
            }
            commit={commit}
          />
        </>
      )}
      <ToggleRow
        label={t('editor.extendedRange')}
        help={t('editor.extendedRangeHelp')}
        checked={extended}
        disabled={disabled}
        onChange={(value) => {
          commit()
          setExtended(value)
          setNotice(undefined)
        }}
      />
      {notice && (
        <p role="status" className="text-xs text-danger">
          {notice}
        </p>
      )}
    </>
  )
}
