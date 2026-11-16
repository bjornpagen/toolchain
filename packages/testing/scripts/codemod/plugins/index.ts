import type { Plugin } from "#codemod/plugin.ts"
import { den } from "#codemod/plugins/den.ts"
import { edullm } from "#codemod/plugins/edullm.ts"
import { grizzle } from "#codemod/plugins/grizzle.ts"
import { superstarter } from "#codemod/plugins/superstarter.ts"
import { toolchain } from "#codemod/plugins/toolchain.ts"

/** Every repository's plugin, by the name the codemod's --plugin flag takes. */
export const PLUGINS = {
	den,
	edullm,
	grizzle,
	superstarter,
	toolchain
} as const satisfies Readonly<Record<string, Plugin>>

export type PluginName = keyof typeof PLUGINS
