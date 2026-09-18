import { memo, useRef } from 'react'
import { ArrowRight } from 'lucide-react'
import type { ConversionSettings, X3FFileDTO } from '@shared/types'
import { useSettingsStore } from '../stores/settingsStore'
import { useVirtualGrid } from '../hooks/useVirtualGrid'
import { outputFileName } from '../lib/outputName'
import { Thumbnail } from './Thumbnail'
import { StatusIcon } from './StatusIcon'

const PADDING = 16
const GAP = 16
const MIN_CELL = 160
const THUMB_H = 120
const LABEL_H = 46
const ROW_HEIGHT = THUMB_H + LABEL_H + GAP

/**
 * Read-only virtualized gallery of the files about to be converted, shown on the
 * Export screen. Mirrors FileGrid's virtualization (so big batches don't fetch
 * every preview at once) but carries no selection/drag/context-menu behavior;
 * each cell also shows the resolved output filename for the current settings.
 */
export function ExportPreviewGrid({ files }: { files: X3FFileDTO[] }): React.JSX.Element {
  // Read settings so each cell's output name (extension) updates live when the
  // user changes the format in the sidebar.
  const settings = useSettingsStore((s) => s.settings)

  const parentRef = useRef<HTMLDivElement>(null)
  const { columns, virtualizer } = useVirtualGrid(parentRef, files.length, {
    padding: PADDING,
    gap: GAP,
    minCell: MIN_CELL,
    rowHeight: ROW_HEIGHT
  })

  return (
    <div ref={parentRef} className="min-h-0 flex-1 overflow-auto">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const start = vi.index * columns
          const rowFiles = files.slice(start, start + columns)
          return (
            <div
              key={vi.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: vi.size,
                transform: `translateY(${vi.start}px)`,
                paddingLeft: PADDING,
                paddingRight: PADDING,
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                columnGap: GAP
              }}
              className="grid"
            >
              {rowFiles.map((file) => (
                <ExportCell key={file.id} file={file} settings={settings} />
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Memoized so the grid only re-renders cells whose file or settings changed.
const ExportCell = memo(function ExportCell({
  file,
  settings
}: {
  file: X3FFileDTO
  settings: ConversionSettings
}): React.JSX.Element {
  const outputName = outputFileName(file, settings)
  return (
    <div className="flex flex-col" style={{ height: THUMB_H + LABEL_H }} title={file.fileName}>
      <div className="relative rounded-md border border-white/10" style={{ height: THUMB_H }}>
        <Thumbnail file={file} className="h-full w-full rounded-md" />
        <div className="absolute right-1 top-1 rounded bg-black/55 p-0.5">
          <StatusIcon file={file} />
        </div>
      </div>
      <div className="flex flex-col items-center px-1 pt-1">
        <span className="max-w-full truncate text-xs text-neutral-400" title={file.fileName}>
          {file.fileName}
        </span>
        <span
          className="flex max-w-full items-center gap-1 text-xs text-neutral-200"
          title={outputName}
        >
          <ArrowRight className="h-3 w-3 shrink-0 text-neutral-500" />
          <span className="truncate">{outputName}</span>
        </span>
      </div>
    </div>
  )
})
