import { Array as Arr, Option, Schema } from "effect"
import { type AnyNode, configured, isFileAt } from "#oxlint/rule.ts"
import { calleeNameOf } from "#oxlint/syntax.ts"

/** The files that may hold a single-permit lock, each with why its work must take turns. */
const Options = Schema.Struct({
	owners: Schema.Array(Schema.Struct({ file: Schema.String, reason: Schema.NonEmptyString }))
})

/** The constructors of a semaphore, which take its permits first. */
export const SEMAPHORES: ReadonlyArray<string> = [
	"Semaphore.make",
	"Semaphore.makeUnsafe",
	"Effect.makeSemaphore",
	"Effect.makeSemaphoreUnsafe"
]

/** The call that runs an effect under a number of a semaphore's permits, as a method or as Semaphore's function. */
export const WITH_PERMITS = "withPermits"

/** One permit: the lock that lets one effect run at a time. */
const isOne = (node: AnyNode | undefined): boolean => node?.type === "Literal" && node.value === 1

/** The arguments of a call that state its permits: a constructor's first, a method's first, Semaphore's function's any. */
const permitsOf = (call: AnyNode): ReadonlyArray<AnyNode> => {
	if (call.type !== "CallExpression") {
		return []
	}
	const name = calleeNameOf(call.callee)
	if (Option.exists(name, (called) => Arr.contains(SEMAPHORES, called))) {
		return Arr.take(call.arguments, 1)
	}
	if (Option.contains(name, `Semaphore.${WITH_PERMITS}`)) {
		return call.arguments
	}
	const { callee } = call
	return callee.type === "MemberExpression" &&
		!callee.computed &&
		callee.property.type === "Identifier" &&
		callee.property.name === WITH_PERMITS
		? Arr.take(call.arguments, 1)
		: []
}

/**
 * A single-permit lock in test scope outside its owners: a semaphore made with one permit (`Semaphore.make(1)`,
 * `Effect.makeSemaphore(1)`) or an effect run under one permit (`lock.withPermits(1)`, `Semaphore.withPermits(lock,
 * 1)`). A lock of one in a test serializes what the runner runs in parallel, a shared resource that each case should
 * own; where the work under test must take turns (one session's wire), the file is an owner, with its reason.
 */
export const singlePermitOwners = configured(Options, (context, options) => {
	if (Arr.some(options.owners, (owner) => isFileAt(context.filename, owner.file))) {
		return {}
	}
	return {
		CallExpression: (node) => {
			if (Arr.some(permitsOf(node), isOne)) {
				context.report({
					node,
					message:
						"A single-permit lock in a test serializes cases the runner runs in parallel: give each case its own resource through a need. Where the work under test must take turns, name the file in single-permit-owners with its reason."
				})
			}
		}
	}
})
