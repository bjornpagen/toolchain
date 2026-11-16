import type { Plugin } from "#codemod/plugin.ts"
import { ambient, provisionsBy, unwrapsNothing } from "#codemod/plugins/shared.ts"

/**
 * superstarter (github.com/superbuilders/superstarter): its packages' test trees. The in-memory telemetry layers are
 * built for each case; the application's shared database (ApplicationPostgresLive) is lane SS-1's template, so its
 * files are left with their reason.
 */
export const superstarter: Plugin = {
	include: ["packages/**/*.test.ts"],
	provision: provisionsBy([
		...ambient,
		["TestTelemetry", { kind: "layer", text: "TestTelemetry" }],
		["ActionTelemetry", { kind: "layer", text: "ActionTelemetry" }]
	]),
	stages: [],
	builders: [],
	unwrap: unwrapsNothing
}
