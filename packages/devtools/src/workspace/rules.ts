/**
 * The rules the workspace gate runs over the repository as a whole: the tsconfig gate's (the Effect diagnostics every
 * tsconfig sets, the shared base's roster, the one plugin block, the Effect-free packages' tsconfigs and manifests) and
 * the TypeScript-only extensions. The repository's exceptions name them as they name a linter's rules, and excuse the
 * files they list from them.
 */
export const WORKSPACE_RULES: ReadonlyArray<string> = [
	"rejected-diagnostics",
	"diagnostic-roster",
	"effect-plugin-block",
	"effect-free-packages",
	"ts-only-extensions"
]
