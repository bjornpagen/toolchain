import type { Plugin } from "#codemod/plugin.ts"
import { ambient, provisionsBy, unwrapsNothing } from "#codemod/plugins/shared.ts"

/** The toolchain (github.com/bjornpagen/toolchain): its packages' test modules and the platform's layers. */
export const toolchain: Plugin = {
	include: ["packages/**/*.test.ts"],
	provision: provisionsBy(ambient),
	stages: [],
	builders: [],
	unwrap: unwrapsNothing
}
