#!/usr/bin/env -S node

import { Array as Arr, Console, Effect, Option, Record } from "effect"
import { invocationOf } from "#shared/arguments.ts"
import { repositoryToolchain } from "#shared/config.ts"
import { DevtoolFailure } from "#shared/devtool.ts"
import { renderFindings, statusOf } from "#shared/finding.ts"
import { renderFixtureMismatches } from "#shared/fixtures.ts"
import { covers, Repository, relativeTo } from "#shared/repository.ts"
import { runDevtool } from "#shared/run.ts"
import { appFindings, FIXTURES_ROOT, fixtureRuns } from "#style/engine.ts"
import type { WebOptions } from "#style/options.ts"

/**
 * The style linter: design-token and presentation enforcement over the Tailwind app whose package runs it (a
 * workspace package holding components.json), read with the app's own checker, against the full Tailwind v4 design
 * system the stylesheet components.json names defines. Every class must be readable and compile; colors are theme
 * tokens; an arbitrary value is a theme token's var() or nothing; one class list never sets a property twice;
 * presentation is fixed JSX; and the stylesheets hold the theme and nothing else, each the one home of its tokens.
 * Each app's names, and the repository's own style rules it runs, come from the web pack of the repository's
 * toolchain.config.ts, under the app's package root; a repository without a Tailwind app has nothing to check.
 * Explicit paths narrow the files (a file the tsconfig excludes is added). `--fixtures` proves the rules instead: the
 * shared rules' fixtures where the dev tools are the repository's own package (not under vendor/), and the fixtures
 * of every own style rule set the web pack lists.
 */

/** The web pack's options, when the repository's toolchain has one. */
const webOptions = Effect.map(repositoryToolchain, (toolchain) =>
	Option.map(
		Arr.findFirst(toolchain.packs, (pack) => pack.pack === "web"),
		(pack): WebOptions => pack.options
	)
)

const checkFixtures = Effect.gen(function* () {
	const { root } = yield* Repository
	const web = yield* webOptions
	const own = Option.match(web, {
		onNone: () => [],
		onSome: (options) => Arr.dedupe(Arr.flatMap(Record.values(options.apps), (app) => app.own))
	})
	const runs = yield* fixtureRuns({
		shared: !covers({ selected: `${root}/vendor`, file: FIXTURES_ROOT }),
		own
	})
	if (!Arr.isReadonlyArrayNonEmpty(runs)) {
		yield* Console.log(
			"style fixtures: nothing to prove here: the shared rules are proven where the dev tools are developed, and the web pack lists no own style rules"
		)
		return 0
	}
	yield* Console.log(
		Arr.join(
			Arr.map(runs, (run) =>
				renderFixtureMismatches({
					tool: run.name,
					root,
					rules: run.rules,
					mismatches: run.mismatches
				})
			),
			"\n"
		)
	)
	return statusOf(Arr.flatMap(runs, (run) => run.mismatches))
})

const main = Effect.gen(function* () {
	const invocation = yield* invocationOf(["--fixtures"])
	if (invocation.flags.has("--fixtures")) {
		return yield* checkFixtures
	}
	const { root, apps } = yield* Repository
	if (!Arr.isReadonlyArrayNonEmpty(apps)) {
		yield* Console.log(
			"style: the repository has no Tailwind app (no workspace package holds components.json)"
		)
		return 0
	}
	const packageRoot = yield* Effect.sync(() => process.cwd())
	const app = yield* Effect.fromOption(
		Arr.findFirst(apps, (candidate) => candidate.root === packageRoot)
	).pipe(
		Effect.mapError(() =>
			DevtoolFailure.make({
				detail: `style runs in a Tailwind app's package, and ${packageRoot} holds no components.json`
			})
		)
	)
	const name = relativeTo(root)(app.root)
	const web = yield* webOptions
	const options = yield* Effect.fromOption(
		Option.flatMap(web, (found) => Record.get(found.apps, name))
	).pipe(
		Effect.mapError(() =>
			DevtoolFailure.make({
				detail: Option.isNone(web)
					? `toolchain.config.ts has no web pack, so the Tailwind app ${name} has no style options`
					: `toolchain.config.ts's web pack holds no style options for the Tailwind app ${name}`
			})
		)
	)
	const findings = yield* appFindings({ app, name, invocation, options })
	yield* Console.log(renderFindings({ tool: "style", root, findings }))
	return statusOf(findings)
})

runDevtool(main)
