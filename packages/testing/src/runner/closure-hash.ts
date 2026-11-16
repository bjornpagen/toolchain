import { regex } from "arkregex"
import { Schema } from "effect"

/**
 * A module's closure hash (closure.ts): the hex SHA-256 of its closure, equal for two modules exactly when their
 * closures are equal. Its schema is how the hash crosses a process boundary: a worker reads the hash the parent
 * computed (runner/protocol.ts), decoded as 64 lowercase hex digits, so a worker never mints one from unchecked text.
 * This module loads no parser, so a worker reads hashes without loading the compiler that makes them.
 */
const ClosureHash = Schema.String.check(Schema.isPattern(regex("^[0-9a-f]{64}$"))).pipe(
	Schema.brand("ClosureHash")
)

export type ClosureHash = typeof ClosureHash.Type

/** The parent's answer to a worker that asked for a module's closure hash: the hash, or why it could not be made. */
export const ClosureAnswer = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("hashed"), hash: ClosureHash }),
	Schema.Struct({ kind: Schema.Literal("unhashed"), message: Schema.String })
])

export type ClosureAnswer = typeof ClosureAnswer.Type
