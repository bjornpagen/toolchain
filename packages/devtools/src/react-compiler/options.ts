/**
 * The React Compiler's options, stated once: a Next app's next.config.ts builds with them. At `all_errors` every
 * function the compiler cannot compile fails the build, never a function left silently unmemoized; the preset's web part
 * runs oxlint's React Compiler rules (react/todo, react/unsupported-syntax, react/syntax, react/invariant and the
 * correctness category's), so `pnpm check` refuses those functions first, without a build or a TypeScript program.
 */
export const REACT_COMPILER_OPTIONS = {
	panicThreshold: "all_errors"
} as const
