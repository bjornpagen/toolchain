import { Array as Arr, Effect } from "effect"
import { assert } from "#assert.ts"
/**
 * The library's Vitest config (vitest/config.ts defineTestConfig) sets no timeout: whatever a package states of its
 * tests, every test and every hook, in every project the config builds, runs under testTimeout and hookTimeout 0,
 * Vitest's none, so no verdict waits on the wall clock: a search ends by its case count under each case's hang guard
 * (vitest/run.ts runOfTest gives it no deadline), and a hang is the gate's progress watch to stop. qti-pie's
 * testTimeout: 60_000 turned crust red ("DeadlineReached ... before any case failed", at 10,485 of 40,960 cases) when
 * the machine slowed. Exhausted over the shapes a config's projects take: guided files or none, small-stack files or
 * none.
 *
 * Oracle: the specification, defineTestConfig's JSDoc: no test and no hook has a timeout.
 */
import { property } from "#property.ts"
import { defineTestConfig } from "#vitest/config.ts"
import { shapes } from "#vitest/timeouts.fixtures.ts"

export const noTestOrHookHasATimeout = property.exhaust(shapes, {
	box: "a config with or without guided files and with or without small-stack files",
	needs: {},
	situations: [],
	check: () => (shape) =>
		Effect.sync(() => {
			const config = defineTestConfig({
				include: ["src/**/*.test.ts"],
				guided: shape.guided,
				setup: [],
				conditions: [],
				smallStack: shape.smallStack,
				examples: { kind: "allowed" }
			})
			const projects = config.test?.projects ?? []
			assert.deepEqual(
				{
					test: config.test?.testTimeout,
					hook: config.test?.hookTimeout,
					inherited: Arr.every(
						projects,
						(project) =>
							typeof project === "object" &&
							"extends" in project &&
							project.extends === true &&
							!("testTimeout" in (project.test ?? {})) &&
							!("hookTimeout" in (project.test ?? {}))
					)
				},
				{ test: 0, hook: 0, inherited: true }
			)
		}),
	oracle: {
		kind: "specification",
		name: "defineTestConfig's stated contract: no test and no hook has a timeout"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/vitest/config.ts",
			original: "\t\t\ttestTimeout: 0,\n",
			replacement: "\t\t\ttestTimeout: 60_000,\n",
			why: "Every test fails when the wall clock passes a minute, as qti-pie's crust did at 10,485 of 40,960 cases on a slow machine; the property fails."
		},
		{
			file: "packages/testing/src/vitest/config.ts",
			original: "\t\t\thookTimeout: 0\n",
			replacement: "\t\t\thookTimeout: 10_000\n",
			why: "Every hook fails when the wall clock passes ten seconds, a database's setup among them on a loaded machine; the property fails."
		}
	]
})
