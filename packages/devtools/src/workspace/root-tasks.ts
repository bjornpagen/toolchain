import { Array as Arr, Effect, Option, Record, Result, Schema, String as Str } from "effect"
import { DevtoolFailure } from "#shared/devtool.ts"
import type { Finding } from "#shared/finding.ts"

/**
 * The root's tasks: turbo runs the root package's script for a task only when turbo.json registers the task as
 * `//#<name>`. The generic task of that name, which every workspace package runs, never reaches the root, and turbo
 * says nothing of the script it passed over. So a root script named as a generic task that turbo.json does not
 * register is a check every `turbo run <name>` skips, and the root's own files, its configuration among them, go
 * unchecked: superstarter's root typecheck and oxlint ran in no `pnpm types` or `pnpm check` until its c8b40d1, and a
 * type error in a root config file passed the gate. The gate refuses such a script. A root script that runs turbo
 * itself is the entry point of its task, never a task turbo runs, and is left alone.
 */

/** turbo's configuration, at the repository root. */
export const TURBO_CONFIG = "turbo.json"

/** The root package's manifest. */
export const ROOT_MANIFEST = "package.json"

/** The prefix of a root task's name in turbo.json's tasks: `//#typecheck` is the root's typecheck. */
export const ROOT_TASK = "//#"

/** The command a script that runs turbo names, as a word of its own or a path's last segment. */
export const TURBO = "turbo"

/** The characters a shell or a manifest separates a command's words by. */
const SEPARATORS: ReadonlyArray<string> = [" ", "\t", "\n", ";", "&", "|", "(", ")", '"', "'", "`"]

/** What the gate reads of the root manifest: its scripts. */
const Manifest = Schema.fromJsonString(
	Schema.Struct({ scripts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)) })
)

/** What the gate reads of turbo.json: the names of its tasks. */
const Turbo = Schema.fromJsonString(
	Schema.Struct({ tasks: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)) })
)

/** A command's words, split where a shell would split them. */
const wordsOf = (command: string): ReadonlyArray<string> =>
	Arr.filter(
		Str.split(" ")(
			Arr.join(
				Arr.map(Str.split("")(command), (character) =>
					Arr.contains(SEPARATORS, character) ? " " : character
				),
				""
			)
		),
		Str.isNonEmpty
	)

/** Whether a script runs turbo: a word of it is `turbo`, or a path ending in `/turbo`. */
const runsTurbo = (command: string): boolean =>
	Arr.some(wordsOf(command), (word) => word === TURBO || Str.endsWith(`/${TURBO}`)(word))

/** The 1-based line of turbo.json that first holds a task's key, else the first, as the gate's other lines fall back. */
const keyLine = (text: string, name: string): number =>
	Option.match(Arr.findFirstIndex(Str.split("\n")(text), Str.includes(`"${name}":`)), {
		onNone: () => 1,
		onSome: (at) => at + 1
	})

/**
 * The root scripts turbo would pass over: each one named as a task of turbo.json, which every package runs (a
 * package's own task, `@scope/a#<name>`, is named by no script of the root), registered as no root task, and running
 * no turbo of its own, reported at the task's key. The texts are the root manifest's and turbo.json's; a text that is
 * not the JSON the gate reads fails the gate.
 */
export const rootTaskFindings = (
	input: Readonly<{ root: string; manifest: string; turbo: string }>
): Effect.Effect<ReadonlyArray<Finding>, DevtoolFailure> =>
	Effect.gen(function* () {
		const manifest = yield* Schema.decodeEffect(Manifest)(input.manifest).pipe(
			Effect.mapError((cause) =>
				DevtoolFailure.make({ detail: `${ROOT_MANIFEST} is not a manifest the gate reads`, cause })
			)
		)
		const turbo = yield* Schema.decodeEffect(Turbo)(input.turbo).pipe(
			Effect.mapError((cause) =>
				DevtoolFailure.make({
					detail: `${TURBO_CONFIG} is not a turbo configuration the gate reads`,
					cause
				})
			)
		)
		const tasks = Record.keys(turbo.tasks ?? {})
		return Arr.filterMap(
			Record.toEntries(manifest.scripts ?? {}),
			([name, command]): Result.Result<Finding, void> =>
				Arr.contains(tasks, name) &&
				!Arr.contains(tasks, `${ROOT_TASK}${name}`) &&
				!runsTurbo(command)
					? Result.succeed({
							file: `${input.root}/${TURBO_CONFIG}`,
							line: keyLine(input.turbo, name),
							column: 1,
							rule: "root-tasks",
							message: `The root's ${name} script runs only as the task ${ROOT_TASK}${name}: the generic ${name} task never reaches the root, so every turbo run of ${name} passes over the root's own files.`,
							suggestion: `Register "${ROOT_TASK}${name}" in ${TURBO_CONFIG}'s tasks.`
						})
					: Result.failVoid
		)
	})
