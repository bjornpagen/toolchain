import { element, finite } from "#gen.ts"

/** The shapes a Vitest config's projects take (timeouts.test.ts): guided files or none, small-stack files or none. */
export const shapes = finite((source) => ({
	guided: source.draw(element([[], ["src/guided.test.ts"]] as const)),
	smallStack: source.draw(element([[], ["src/deep.test.ts"]] as const))
}))
