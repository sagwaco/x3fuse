import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type { MenuCommand } from '@shared/ipc'
import { registerCommands } from '../lib/commands'
import { labelOf } from '../lib/menuActions'
import { acceleratorsOf, formatAccelerator } from '../lib/shortcut'
import { t } from '../lib/strings'
import { Button } from './ui/button'

/** The commands with keys, by menu, in menu order. */
const SHORTCUT_GROUPS: [string, MenuCommand[]][] = [
  [
    'menu.file.title',
    [
      'addFiles',
      'addFolder',
      'editPhoto',
      'exportSelected',
      'exportPrevious',
      'stop',
      'showInFinder',
      'clearQueue'
    ]
  ],
  [
    'menu.edit.title',
    ['undoEdit', 'redoEdit', 'copyEdits', 'pasteEdits', 'resetEdits', 'selectAll', 'deselectAll']
  ],
  [
    'menu.view.title',
    [
      'viewGrid',
      'viewFilmstrip',
      'viewSurvey',
      'toggleFilterBar',
      'togglePanel',
      'zoomIn',
      'zoomOut',
      'zoomFit',
      'zoomActual',
      'compare'
    ]
  ],
  [
    'menu.photo.title',
    [
      'previousPhoto',
      'nextPhoto',
      'pick',
      'reject',
      'unflag',
      'rate0',
      'rate1',
      'rate2',
      'rate3',
      'rate4',
      'rate5',
      'ratingUp',
      'ratingDown',
      'rotateLeft',
      'rotateRight',
      'crop',
      'whiteBalancePicker'
    ]
  ],
  ['menu.help.title', ['shortcuts', 'showLogs']]
]

/** Keys that a focused list or preview uses. They are not commands. */
const FOCUS_KEYS: [string, string[]][] = [
  ['shortcuts.move', ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']],
  ['shortcuts.advance', ['Shift']],
  ['menu.file.remove_from_queue', ['Backspace']],
  ['shortcuts.zoomPreview', ['Equal', 'Minus']],
  ['shortcuts.peek', ['Space']],
  ['shortcuts.escape', ['Escape']]
]

/** The menu bar text. Without their submenu, the rating items need more words. */
function label(name: MenuCommand): string {
  const rating = /^rate([0-5])$/.exec(name)
  if (!rating) return labelOf(name)
  const stars = Number(rating[1])
  return stars ? t('cull.rating', { stars }) : t('cull.no_rating')
}

/** Lists the keys of `shortcuts.json` by menu (Help > Keyboard Shortcuts, ⌘/). */
export function ShortcutSheet(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  // The sheet has no trigger button. Focus goes back to the element that had it.
  const opener = useRef<Element | null>(null)
  useEffect(
    () =>
      registerCommands({
        shortcuts: () => {
          opener.current = document.activeElement
          setOpen(true)
          return true
        }
      }),
    []
  )
  const sections = [
    ...SHORTCUT_GROUPS.map(([title, names]) => ({
      title,
      rows: names.map((name) => ({ name, label: label(name), keys: acceleratorsOf(name) }))
    })),
    {
      title: 'shortcuts.focus',
      rows: FOCUS_KEYS.map(([key, keys]) => ({ name: undefined, label: t(key), keys }))
    }
  ]
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[1px]" />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            if (opener.current instanceof HTMLElement) opener.current.focus()
          }}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[680px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl border border-ink/10 bg-tone-900 p-5 shadow-2xl focus:outline-none"
        >
          <Dialog.Title className="text-base font-semibold text-tone-50">
            {labelOf('shortcuts')}
          </Dialog.Title>
          <div className="min-h-0 gap-8 overflow-y-auto sm:columns-2">
            {sections.map(({ title, rows }) => (
              <section key={title} className="mb-5 break-inside-avoid">
                <h3 className="mb-2 text-xs font-medium text-tone-400">{t(title)}</h3>
                <dl className="flex flex-col gap-1.5 text-sm">
                  {rows.map((row) => (
                    <div
                      key={row.label}
                      data-command={row.name}
                      className="flex items-baseline justify-between gap-3"
                    >
                      <dt className="text-tone-200">{row.label}</dt>
                      <dd className="flex shrink-0 gap-1">
                        {row.keys.map((key) => (
                          <kbd
                            key={key}
                            className="rounded bg-ink/10 px-1.5 py-0.5 font-sans text-xs text-tone-100"
                          >
                            {formatAccelerator(key)}
                          </kbd>
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
          <div className="flex justify-end">
            <Dialog.Close asChild>
              <Button variant="prominent" size="md">
                {t('button.done')}
              </Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
