import { Array as Arr } from "effect"
import type { RestrictedGlobal, RestrictedImports, RestrictedProperty } from "#preset.ts"

/**
 * What the library may not read: the environment, which is its caller's to hand it. The preset holds a repository's
 * library files to these lists beside its own (eslint/no-restricted-imports, eslint/no-restricted-properties and
 * eslint/no-restricted-globals, with node/no-process-env), and lifts them in the sanctioned readers. They read syntax
 * alone: a value of Node's process, os and v8 modules or of Effect's Config and ConfigProvider, by an import of it, a
 * property of the `process` global (`process.cwd()`, `process["env"]`, `const { env } = process`), `globalThis.process`,
 * or the `navigator` global.
 */

const MESSAGE =
	"The library reads no environment: what it needs is its caller's input. Take the value as an argument, or read it in one of the preset's sanctioned readers (environment.readers)."

/** The values of Node's process that are the environment: its variables, arguments, working directory, platform,
 * identity and resources. `process.pid`, `process.exitCode` and the streams are the process's own, never its
 * environment. */
const PROCESS_READS: ReadonlyArray<string> = [
	"env",
	"cwd",
	"chdir",
	"argv",
	"argv0",
	"execArgv",
	"execPath",
	"loadEnvFile",
	"platform",
	"arch",
	"version",
	"versions",
	"release",
	"config",
	"features",
	"title",
	"ppid",
	"getuid",
	"geteuid",
	"getgid",
	"getegid",
	"getgroups",
	"umask",
	"memoryUsage",
	"resourceUsage",
	"availableMemory",
	"constrainedMemory",
	"allowedNodeEnvironmentFlags",
	"permission"
]

/** The heap readings of Node's v8 module, which are the machine's. */
const V8_READS: ReadonlyArray<string> = [
	"getHeapStatistics",
	"getHeapSpaceStatistics",
	"getHeapCodeStatistics"
]

/** The imports the library may not make: the process module's environment and its default export, which is the
 * process itself; every value of the os module; v8's heap readings; and Effect's configuration modules. An `import type`
 * reads nothing, so each admits one. */
export const ENVIRONMENT_IMPORTS: RestrictedImports = {
	paths: [
		...Arr.flatMap(["node:process", "process"], (name) => [
			{ name, importNames: [...PROCESS_READS, "default"], allowTypeImports: true, message: MESSAGE }
		]),
		...Arr.map(["node:os", "os"], (name) => ({ name, allowTypeImports: true, message: MESSAGE })),
		...Arr.map(["node:v8", "v8"], (name) => ({
			name,
			importNames: V8_READS,
			allowTypeImports: true,
			message: MESSAGE
		})),
		{
			name: "effect",
			importNames: ["Config", "ConfigProvider"],
			allowTypeImports: true,
			message: MESSAGE
		},
		...Arr.map(["effect/Config", "effect/ConfigProvider"], (name) => ({
			name,
			allowTypeImports: true,
			message: MESSAGE
		}))
	],
	patterns: []
}

/** The properties the library may not read: the process global's environment, and the process reached through the
 * global object. */
export const ENVIRONMENT_PROPERTIES: ReadonlyArray<RestrictedProperty> = [
	...Arr.map(PROCESS_READS, (property) => ({ object: "process", property, message: MESSAGE })),
	{ object: "globalThis", property: "process", message: MESSAGE }
]

/** The globals the library may not read: the navigator, whose every value is the machine's. */
export const ENVIRONMENT_GLOBALS: ReadonlyArray<RestrictedGlobal> = [
	{ name: "navigator", message: MESSAGE }
]
