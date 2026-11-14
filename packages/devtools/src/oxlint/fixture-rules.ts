import { Array as Arr } from "effect"
import type plugin from "#oxlint-plugin.ts"
import type { FixtureRules } from "#oxlint/prove.ts"

/**
 * Every plugin rule the marked fixtures prove, with the options it runs under there. Paths point into the rule's own
 * fixture directory, so `<rule>/clean.tsx` is the file an exemption names, and `<rule>/grizzle/clean.tsx` the one of
 * the second set beneath it. no-comment is proven by its fixer cases (fixer-cases.ts) instead: a marker comment is a
 * comment it would strip.
 */
export const FIXTURE_RULES: FixtureRules<typeof plugin, "no-comment"> = {
	"bearer-owners": { owners: ["bearer-owners/clean.tsx"] },
	"brands-sole-mint": {
		mints: [
			{ doors: ["brands-sole-mint/clean.tsx"], brands: ["LabelStream", "RunStream"] },
			{ doors: ["brands-sole-mint/clean.tsx"], brands: ["TodoId", "TodoTitle"] },
			{ doors: ["brands-sole-mint/grizzle/clean.tsx"], brands: ["TableName", "ColumnName"] },
			{ doors: ["brands-sole-mint/grizzle/clean.tsx"], brands: ["SqlText"] }
		]
	},
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
	"no-collation": null,
	"no-default-parameter": null,
	"no-dynamic-imports": {
		allowed: [{ file: "no-dynamic-imports/clean.tsx", specifier: "#config/user.ts" }]
	},
	"no-inline-suppression": null,
	"no-new-error": null,
	"no-option-bridge": null,
	"no-optional-parameter": null,
	"no-overload": null,
	"no-pointless-type-alias": null,
	"no-raw-regexp": null,
	"no-raw-sql": { sources: ["no-raw-sql"], writers: [] },
	"no-send-beacon": null,
	"no-svg-paint": null,
	"no-svg-without-title": null,
	"no-switch-default-bailout": null,
	"no-try": null,
	"no-unoptimized-next-image": null,
	"no-useless-continue": null,
	"prefer-early-return": null,
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
	"test-no-prose-search": {
		fields: ["what"],
		textHelpers: ["containsText", "lacksText"],
		searchHelpers: ["containsText"]
	},
	"test-no-spelled-names": { markers: ["__pk", "__fk__"] }
}
