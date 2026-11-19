/**
 * The cluster a process reaches (make.ts reachedPort): its spec's when TOOLCHAIN_PG_CLUSTER is unset; the port it names
 * when it names one in canonical decimal, a private cluster of the same spec; and none when it holds anything else,
 * each misspelling refused rather than read as some port or as the spec's. Oracle: the specification.
 */
import { ConfigProvider, Effect, Exit } from "effect"
import { assert } from "#assert.ts"
import testingCluster from "#pg.config.ts"
import { reachedPort } from "#pg/make.ts"
import { misspellings, names } from "#pg/reached.fixtures.ts"
import { property } from "#property.ts"

export const reachedPorts = property.explore(names, {
	needs: {},
	situations: ["the spec's cluster, unset", "a port named", ...misspellings],
	check: (_resources, c) => (name) =>
		Effect.gen(function* () {
			const environment = ConfigProvider.fromEnvRecord(
				name.kind === "unset"
					? {}
					: { TOOLCHAIN_PG_CLUSTER: name.kind === "port" ? `${name.port}` : name.text },
				{ preserveEmptyStrings: true }
			)
			const reached = yield* Effect.exit(
				Effect.provideService(
					reachedPort(testingCluster),
					ConfigProvider.ConfigProvider,
					environment
				)
			)
			switch (name.kind) {
				case "unset":
					assert.deepEqual(
						Exit.map(reached, (port): number => port),
						Exit.succeed(testingCluster.port),
						"unset, the spec's cluster"
					)
					c.note("the spec's cluster, unset")
					return
				case "port":
					assert.deepEqual(
						Exit.map(reached, (port): number => port),
						Exit.succeed(name.port),
						"a canonical port names its cluster"
					)
					c.note("a port named")
					return
				case "misspelled":
					assert.ok(Exit.isFailure(reached), `${name.misspelling} is refused`)
					c.note(name.misspelling)
					return
			}
		}),
	oracle: {
		kind: "specification",
		name: "unset reaches the spec's cluster, a canonical port its own, and every misspelling none"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/pg/make.ts",
			original: "String(port) === text && port > 0",
			replacement: "port > 0",
			why: "A port spelled otherwise (a leading zero, a sign) is read as the port, so two names reach one cluster; the property fails."
		}
	]
})
