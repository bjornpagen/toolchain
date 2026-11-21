import { Array as Arr } from "effect"
import type plugin from "#oxlint-plugin.ts"
import type { FixtureRules } from "#oxlint/prove.ts"

/**
 * Every plugin rule the marked fixtures prove, with the options it runs under there. Paths point into the rule's own
 * fixture directory, so `<rule>/clean.tsx` is the file an exemption names, and `<rule>/grizzle/clean.tsx` the one of
 * the second set beneath it. no-comment is proven by its fixer cases (fixer-cases.ts) instead: a marker comment is a
 * comment it would strip. no-plant and single-permit-owners are proven by their searches (their rules' *.test.ts), a
 * marker comment being no-plant's own subject.
 */
export const FIXTURE_RULES: FixtureRules<
	typeof plugin,
	"no-comment" | "no-plant" | "single-permit-owners"
> = {
	"bearer-owners": { owners: ["bearer-owners/clean.tsx"] },
	"brands-sole-mint": {
		mints: [
			{ doors: ["brands-sole-mint/clean.tsx"], brands: ["LabelStream", "RunStream"] },
			{ doors: ["brands-sole-mint/clean.tsx"], brands: ["TodoId", "TodoTitle"] },
			{ doors: ["brands-sole-mint/grizzle/clean.tsx"], brands: ["TableName", "ColumnName"] },
			{ doors: ["brands-sole-mint/grizzle/clean.tsx"], brands: ["SqlText"] }
		]
	},
	"effect-free-imports": null,
	"import-doors": {
		doors: [
			{
				module: "pg",
				guards: { kind: "module" },
				doors: ["import-doors/clean.tsx"],
				message: "Reach Postgres through the database package."
			},
			{
				module: "@superstarter/todo-protocol/action",
				guards: { kind: "exports", names: ["makeActionClient"] },
				doors: ["import-doors/clean.tsx"],
				message: "Call a server action through the app's one action client."
			},
			{
				module: "node:assert",
				guards: { kind: "module" },
				doors: ["import-doors/grizzle/clean.tsx"],
				message: "Import assertions from the assertion door."
			},
			{
				module: "node:util",
				guards: { kind: "exports", names: ["isDeepStrictEqual"] },
				doors: ["import-doors/grizzle/clean.tsx"],
				message: "Use the assertion door's typed deepEqual."
			}
		]
	},
	markup: {
		measuredStyles: Arr.map(["markup/clean.tsx", "markup/violating.tsx"], (path) => ({
			path,
			properties: {
				width: [
					{ kind: "expression", text: "box.width" },
					{ kind: "expression", text: "share" }
				],
				transform: [{ kind: "export", module: "#fixture/motion.ts", name: "coverMotion" }]
			}
		})),
		styleBridges: Arr.map(["markup/clean.tsx", "markup/violating.tsx"], (path) => ({
			path,
			function: "mergeSurfaceProps",
			base: "baseProps",
			overlay: "props"
		})),
		htmlTemplates: ["markup/clean.tsx"],
		stylesheetConstructors: ["markup/clean.tsx"]
	},
	"no-bare-materialized-view-joins": {
		modules: [{ specifiers: ["#fixture/views.ts"], views: ["ledgerTotals"] }]
	},
	"no-case-list": {
		searches: [
			{ module: "#fixture/testing.ts", name: "exhaust", space: { field: "generator" } },
			{ module: "#fixture/testing.ts", name: "explore", space: { field: "draw" } }
		],
		generators: [
			{ module: "#fixture/testing.ts", names: ["element"], draws: "list" },
			{ module: "#fixture/testing.ts", names: ["constant"], draws: "value" },
			{
				module: "#fixture/testing.ts",
				names: ["map", "span", "drawn", "sketched"],
				draws: "each"
			},
			{ module: "#fixture/testing.ts", names: ["oneOf", "weighted"], draws: "union" }
		],
		mints: [],
		cases: ["no-case-list/violating.tsx", "no-case-list/clean.tsx"],
		dictionaries: []
	},
	"no-collation": null,
	"no-default-parameter": null,
	"no-drizzle-write-without-where": { receivers: ["db"] },
	"no-dynamic-imports": {
		allowed: [{ file: "no-dynamic-imports/clean.tsx", specifier: "#config/user.ts" }]
	},
	"no-implicit-select-all": null,
	"no-inline-suppression": null,
	"no-module-state": null,
	"no-new-error": null,
	"no-null-undefined-union": null,
	"no-option-bridge": null,
	"no-optional-parameter": null,
	"no-overload": null,
	"no-pointless-type-alias": null,
	"no-raw-regexp": null,
	"no-raw-sql": { sources: ["no-raw-sql"], writers: ["no-raw-sql/writer/clean.tsx"] },
	"no-send-beacon": null,
	"no-spread-argument": { tuples: [{ module: "#fixture/list.ts", names: ["argumentsOf"] }] },
	"no-svg-paint": null,
	"no-svg-without-title": null,
	"no-switch-default-bailout": null,
	"no-try": null,
	"no-unoptimized-next-image": null,
	"no-useless-continue": null,
	"prefer-early-return": null,
	"sha256-digests": null,
	"side-effect-free": {
		modules: [
			{
				file: "side-effect-free/clean.tsx",
				specifiers: ["#fixture/proven.ts"],
				functions: [
					{ name: "brand", returns: "functions", invokes: [] },
					{ name: "twice", returns: "values", invokes: [] },
					{ name: "derive", returns: "values", invokes: [{ parameter: 0, property: "compute" }] }
				],
				constants: ["limit"]
			}
		]
	},
	"sql-aliased-table-reference": null,
	"sql-distinct-window": null,
	"sql-dynamic-schema": {
		tableFactories: [{ owner: "sql-dynamic-schema/clean.tsx", declaration: "stageOf" }]
	},
	"sql-executor-contract": null,
	"sql-json-owner": { owners: ["sql-json-owner/clean.tsx"] },
	"sql-leaf-owners-only": { owners: ["sql-leaf-owners-only/clean.tsx"] },
	"sql-number-decoder": null,
	"sql-query-deadline": {
		files: ["sql-query-deadline/"],
		properties: ["statement_timeout", "queryTimeoutMs"],
		refusals: ["budget-exhausted"],
		admitted: [
			{
				owner: "sql-query-deadline/clean.tsx",
				property: "statement_timeout",
				construction: "Pool",
				guard: { subject: "username", principals: "PRINCIPALS", principal: "reader" },
				value: { specifier: "#fixture/limits.ts", constant: "READER_TIMEOUT_MILLISECONDS" }
			}
		]
	},
	"sql-raw-execution": {
		statementOwners: ["sql-raw-execution/clean.tsx"],
		copyStreamOwners: ["sql-raw-execution/clean.tsx"],
		nativeClientOwners: ["sql-raw-execution/clean.tsx"],
		declaredExecutions: [
			{
				owner: "sql-raw-execution/clean.tsx",
				executor: "createStaging",
				statement: "stagingDefinition"
			}
		]
	},
	"sql-raw-statement": {
		recursiveEnvelopeOwners: ["sql-raw-statement/clean.tsx"],
		projectionEnvelopeOwners: ["sql-raw-statement/clean.tsx"],
		declaredStatements: [
			{
				owner: "sql-raw-statement/clean.tsx",
				declaration: "truncation",
				grammar: "truncate ? cascade"
			}
		]
	},
	"test-no-prose-search": {
		fields: ["what"],
		textHelpers: ["containsText", "lacksText"],
		searchHelpers: ["containsText"]
	},
	"test-no-spelled-names": { markers: ["__pk", "__fk__"] }
}
