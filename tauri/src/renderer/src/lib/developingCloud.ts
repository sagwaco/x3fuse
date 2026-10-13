import { createContext } from 'react'

/**
 * True while the developing cloud is on screen. Work that the reveal does not
 * need waits until the cloud leaves, so the cloud does not skip frames.
 */
export const DevelopingCloud = createContext(false)
