/**
 * Concurrency policy shared by main (pool sizing from os cores) and renderer
 * (showing the resolved auto value from navigator.hardwareConcurrency).
 */

/** Ceiling for the user-selectable concurrency setting. */
export const MAX_CONCURRENCY = 8

/**
 * Auto pool size: cores/2 clamped to 1..4. x3f_extract is CPU-bound and its
 * denoise pass is internally multithreaded, so per-process parallelism already
 * exists; /2 also discounts SMT-inflated core counts. The cap of 4 bounds peak
 * memory (each conversion holds full-resolution Foveon buffers).
 */
export function autoConcurrency(cores: number): number {
  return Math.min(4, Math.max(1, Math.floor(cores / 2)))
}
