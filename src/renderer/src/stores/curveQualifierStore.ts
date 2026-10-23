import { create } from 'zustand'

type RGB = [number, number, number]

/** The tone curve Qualifier. While armed, the photo shows where its pixels fall on the curve. */
export const useCurveQualifier = create<{
  armed: boolean
  /** The preview color under the pointer, 0 to 1, or null off the photo. */
  hover: RGB | null
  /** A clicked preview color. The curve adds a point for it and then clears it. */
  pick: RGB | null
  arm: (armed: boolean) => void
}>((set) => ({
  armed: false,
  hover: null,
  pick: null,
  arm: (armed) => set({ armed, hover: null, pick: null })
}))
