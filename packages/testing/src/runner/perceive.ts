import type { Session } from "node:inspector/promises"
import { Array as Arr, Context, Effect, Scope, String as Str } from "effect"
import type { Sense, Trace } from "#runner/protocol.ts"
import { classOf, coverageSession, type ScriptCoverage } from "#sense.ts"

/**
 * What a process perceives of a case beyond its notes, as its order's sense asks: nothing, or V8's block coverage of
 * the files the sense names, as a trace keyed by script URL and range (protocol.ts Trace), so traces from every
 * process merge in the parent.
 */
export class Perception extends Context.Service<
	Perception,
	Readonly<{
		perceive: <A, E, R>(
			sense: Sense,
			effect: Effect.Effect<A, E, R>
		) => Effect.Effect<readonly [A, Trace], E, R>
	}>
>()("@bjornpagen/testing/runner/perceive/Perception") {}

/**
 * The trace of the coverage V8 took, of the scripts whose URL (without its query) ends with one of `files`: each range
 * with the class of its count, the larger class where two copies of one file report one range.
 */
const traceOf = (scripts: ReadonlyArray<ScriptCoverage>, files: ReadonlyArray<string>): Trace => {
	const classes = new Map<string, number>()
	for (const script of scripts) {
		const url = Arr.headNonEmpty(Str.split(script.url, "?"))
		if (!Arr.some(files, (file) => Str.endsWith(file)(url))) {
			continue
		}
		for (const covered of script.functions) {
			for (const range of covered.ranges) {
				const key = `${url}:${range.startOffset}:${range.endOffset}`
				classes.set(key, Math.max(classes.get(key) ?? 0, classOf(range.count)))
			}
		}
	}
	return Arr.fromIterable(classes.entries())
}

/** Coverage V8 took through a session: every script's, its counts reset by the taking. */
const taken = (session: Session): Effect.Effect<ReadonlyArray<ScriptCoverage>> =>
	Effect.promise((): Promise<ReadonlyArray<ScriptCoverage>> =>
		session.post("Profiler.takePreciseCoverage").then((took) => took.result)
	)

/**
 * This process's perception: a `notes` case runs as it is, with an empty trace; a `blocks` case reads V8's precise
 * coverage before and after it, through the process's coverage session (sense.ts startProcessCoverage, which a worker
 * starts before it loads any test module when its run guides a search by blocks) or, opened the first time a case
 * asks and kept for the process's scope, one of its own. Taking the counts resets them, and a process runs one case
 * at a time, so each trace is its case's alone.
 */
export const perceptionOf: Effect.Effect<
	Context.Service.Shape<typeof Perception>,
	never,
	Scope.Scope
> = Effect.gen(function* () {
	const scope = yield* Scope.Scope
	const session = yield* Effect.cached(Scope.provide(scope)(coverageSession))
	return {
		perceive: <A, E, R>(sense: Sense, effect: Effect.Effect<A, E, R>) => {
			switch (sense.kind) {
				case "notes":
					return Effect.map(effect, (value) => [value, []] as const)
				case "blocks":
					return Effect.gen(function* () {
						const opened = yield* session
						yield* taken(opened)
						const value = yield* effect
						const after = yield* taken(opened)
						return [value, traceOf(after, sense.files)] as const
					})
			}
		}
	}
})
