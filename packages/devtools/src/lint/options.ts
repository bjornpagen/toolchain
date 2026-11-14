import { Schema } from "effect"

/** Repository-relative paths: one ending in "/" names a directory and every file beneath it, any other one file. */
const Paths = Schema.Array(Schema.String)

const PackageDirectories = Schema.Array(Schema.String)

/** The repository's exceptions: files where a rule does not run, by its id. Exceptions live in the repository's
 * toolchain.config.ts, never inline. */
export const Exceptions = Schema.Array(Schema.Struct({ rule: Schema.String, files: Paths }))

export type Exceptions = typeof Exceptions.Type

/** The workspace packages that use no Effect, by repository-relative directory without a trailing "/": each runs
 * the Effect-free lint rules, its tsconfig extends the dev tools' Effect-free base, and it depends on no `effect`. */
export const EffectFree = PackageDirectories

/** The grizzle pack's options: its rules take their names in the repository's oxlint.config.ts, so it states none
 * here. */
export const GrizzleOptions = Schema.Struct({})

export type GrizzleOptions = typeof GrizzleOptions.Type

/** The exceptions the fixtures run under, relative to the fixtures root. */
export const FIXTURE_EXCEPTIONS: Exceptions = []

/** The grizzle pack's options for its fixtures. */
export const GRIZZLE_FIXTURE_OPTIONS: GrizzleOptions = {}
