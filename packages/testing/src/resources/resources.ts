/**
 * Per-case resources, isolated by construction: no case ever shares a mutable database or directory with another. What
 * is shared is immutable; what a case gets is its own.
 */
export { Scratch, type ScratchDir } from "#resources/scratch.ts"
