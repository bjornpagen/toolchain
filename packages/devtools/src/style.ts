#!/usr/bin/env -S node

import { Array as Arr, Console, Effect, Option, Record } from "effect"
import { proveFixtures } from "#oxlint/prove.ts"
import { invocationOf } from "#shared/arguments.ts"
import { repositoryToolchain } from "#shared/config.ts"
import { DevtoolFailure } from "#shared/devtool.ts"
import { renderFindings, statusOf } from "#shared/finding.ts"
import { renderFixtureMismatches } from "#shared/fixtures.ts"
import { covers, Repository, relativeTo } from "#shared/repository.ts"
import { runDevtool } from "#shared/run.ts"
import {
	CLASS_FIXTURES,
	CLASS_FIXTURE_RULES,
	CLASS_FIXTURES_CONFIG
} from "#style/class-fixtures.ts"
import { TAILWIND_PLUGIN } from "#style/classes.ts"
import { appFindings, FIXTURES_ROOT, fixtureRuns } from "#style/engine.ts"
import type { WebOptions } from "#style/options.ts"

/**
 * The style linter: the stylesheet contract over the Tailwind app whose package runs it (a workspace package holding
 * components.json). The stylesheets hold the theme and nothing else, each the one home of its tokens, and the app holds
 * no standalone HTML. It reads its files as text: no TypeScript program and no design system. The app's classes, markup
 * and SVG paint are oxlint's, which the preset runs on the app's files with the same options. Each app's names, and the
 * repository's own style rules it runs, come from the web pack of the repository's toolchain.config.ts, under the app's
 * package root; a repository without a Tailwind app has nothing to check. Explicit paths narrow the files.
 * `--fixtures` proves the rules instead: the shared rules' fixtures where the dev tools are the repository's own
 * package (not under vendor/), the class rules' among them, and the fixtures of every own style rule set the web pack
 * lists.
 */

/** The web pack's options, when the repository's toolchain has one. */
const webOptions = Effect.map(repositoryToolchain, (toolchain) =>
	Option.map(
		Arr.findFirst(toolchain.packs, (pack) => pack.pack === "web"),
		(pack): WebOptions => pack.options
	)
)

/** The class rules over their fixtures, through oxlint and the plugin's own configuration, as the preset runs them. */
const classFixtures = proveFixtures({
	plugin: { meta: { name: TAILWIND_PLUGIN }, rules: {} },
	config: CLASS_FIXTURES_CONFIG,
	fixtures: CLASS_FIXTURES,
	rules: CLASS_FIXTURE_RULES,
	tester: []
})

const checkFixtures = Effect.gen(function* () {
	const { root } = yield* Repository
	const web = yield* webOptions
	const own = Option.match(web, {
		onNone: () => [],
		onSome: (options) => Arr.dedupe(Arr.flatMap(Record.values(options.apps), (app) => app.own))
	})
	const shared = !covers({ selected: `${root}/vendor`, file: FIXTURES_ROOT })
	const runs = yield* fixtureRuns({ shared, own })
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
	const classes = shared ? yield* classFixtures : 0
	return Math.max(classes, statusOf(Arr.flatMap(runs, (run) => run.mismatches)))
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
	const found = yield* webOptions
	const web = yield* Effect.fromOption(found).pipe(
		Effect.mapError(() =>
			DevtoolFailure.make({
				detail: `toolchain.config.ts has no web pack, so the Tailwind app ${name} has no style options`
			})
		)
	)
	if (web.root !== root) {
		return yield* DevtoolFailure.make({
			detail: `toolchain.config.ts's web pack names ${web.root} as the repository's root, and the repository is ${root}: write import.meta.dirname of a module at the root`
		})
	}
	const options = yield* Effect.fromOption(Record.get(web.apps, name)).pipe(
		Effect.mapError(() =>
			DevtoolFailure.make({
				detail: `toolchain.config.ts's web pack holds no style options for the Tailwind app ${name}`
			})
		)
	)
	const findings = yield* appFindings({ app, name, root, invocation, options })
	yield* Console.log(renderFindings({ tool: "style", root, findings }))
	return statusOf(findings)
})

runDevtool(main)
