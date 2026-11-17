#!/bin/sh
# toolchain-test, the runner's command for a package that has @bjornpagen/testing in its node_modules: it runs
# src/runner/cli.ts with every argument it is given, from the package root the command was started in. Node strips no
# types from a file under node_modules, and the library ships TypeScript source, so Node first imports a load hook, from
# a data: URL, that strips the types of every TypeScript module under node_modules as Node would anywhere else; every
# worker the runner forks inherits the hook with the rest of this process's flags, the hardened ones among them.
set -eu
here=$(dirname -- "$(realpath -- "$0")")
strip='import { readFileSync } from "node:fs"; import { registerHooks, stripTypeScriptTypes } from "node:module"; registerHooks({ load: (url, context, nextLoad) => url.includes("/node_modules/") && url.endsWith(".ts") ? { format: "module", source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8")), shortCircuit: true } : nextLoad(url, context) });'
# The runner's hardened flags (src/runner/config.ts HARDENED_FLAGS, which launcher.test.ts holds this list to), given
# here so cli.ts never starts a second node to add them; and Node's compile cache (src/runner/compile-cache.ts), set
# before cli.ts loads so the runner's own modules are compiled once, unless this run reads V8's coverage.
hardened="--disable-proto=delete --disable-sigusr1 --throw-deprecation --pending-deprecation --force-context-aware --no-global-search-paths --unhandled-rejections=strict"
if [ -z "${NODE_V8_COVERAGE:-}" ]; then
	NODE_COMPILE_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/toolchain-test/compile"
	export NODE_COMPILE_CACHE
fi
# shellcheck disable=SC2086
exec node --disable-warning=ExperimentalWarning $hardened --import "data:text/javascript,$strip" "$here/../src/runner/cli.ts" "$@"
