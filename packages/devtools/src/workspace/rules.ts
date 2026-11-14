import { Schema } from "effect"

/**
 * The rules the workspace gate runs over the repository as a whole: the tsconfig gate's (the Effect diagnostics every
 * tsconfig sets, the shared base's roster, the one plugin block, the Effect-free packages' tsconfigs and manifests) and
 * the TypeScript-only extensions. They are the only rules toolchain.config.ts's exceptions name: a lint rule's exception
 * is an override block in oxlint.config.ts, a style rule's is the web pack app's, and a test file that runs no search is
 * exempt in its Vitest config's `examples`.
 */
const WORKSPACE_RULES = [
	"rejected-diagnostics",
	"diagnostic-roster",
	"effect-plugin-block",
	"effect-free-packages",
	"ts-only-extensions"
] as const

/** Repository-relative paths: one ending in "/" names a directory and every file beneath it, any other one file. */
const Paths = Schema.Array(Schema.String)

/** The repository's exceptions: files a workspace gate rule does not hold, by its id. Exceptions live in the
 * repository's toolchain.config.ts, never inline, and naming a rule the gate does not run is refused, by type and when
 * the toolchain is read. */
export const Exceptions = Schema.Array(
	Schema.Struct({ rule: Schema.Literals(WORKSPACE_RULES), files: Paths })
)

export type Exceptions = typeof Exceptions.Type

/** The workspace packages that use no Effect, by repository-relative directory without a trailing "/": each runs
 * the Effect-free lint rules, its tsconfig extends the dev tools' Effect-free base, and it depends on no `effect`. */
export const EffectFree = Schema.Array(Schema.String)
