import { String as Str } from "effect"

/**
 * The stack a property's run has: the runtime's default, or the small stack (config.ts SMALL_STACK) a package's
 * `smallStack` modules run on instead. A run's label is its property's identity, and `@small-stack` after it on the
 * small stack, so a token from a small-stack failure replays on a small-stack worker; a kept token names the property
 * and runs on its stack.
 */
export type Stack = "default" | "small"

const SMALL_SUFFIX = "@small-stack"

/** A run's label: its property's identity, marked when the run is on the small stack. */
export const labelOf = (id: string, stack: Stack): string => {
	switch (stack) {
		case "default":
			return id
		case "small":
			return `${id}${SMALL_SUFFIX}`
	}
}

/** The property identity and stack a run's label names. */
export const runOfLabel = (label: string): Readonly<{ id: string; stack: Stack }> =>
	Str.endsWith(SMALL_SUFFIX)(label)
		? { id: Str.slice(0, label.length - SMALL_SUFFIX.length)(label), stack: "small" }
		: { id: label, stack: "default" }
