#!/bin/sh
# toolchain-test, the runner's command for a package that has @bjornpagen/testing in its node_modules: it runs
# src/runner/cli-entry.ts, which runs src/runner/cli.ts, with every argument it is given, from the package root the
# command was started in. Node strips no types from a file under node_modules, and the library ships TypeScript
# source, so Node first imports a load hook, from a data: URL, that strips the types of every TypeScript module under
# node_modules as Node would anywhere else; every worker the runner forks inherits the hook with the rest of this
# process's flags, the hardened ones among them.
set -eu
here=$(dirname -- "$(realpath -- "$0")")
strip='import { readFileSync } from "node:fs"; import { registerHooks, stripTypeScriptTypes } from "node:module"; registerHooks({ load: (url, context, nextLoad) => url.includes("/node_modules/") && url.endsWith(".ts") ? { format: "module", source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8")), shortCircuit: true } : nextLoad(url, context) });'
# The runner's hardened flags (src/runner/config.ts HARDENED_FLAGS, which launcher.test.ts holds this list to), given
# here so cli.ts never starts a second node to add them. A compile cache the caller names (the account's, one
# directory every process of the machine shares) never reaches the runner or what it starts: cli-entry.ts enables
# the package root's own (src/runner/compile-cache.ts), and each worker gets its root's from the pool.
hardened="--disable-proto=delete --disable-sigusr1 --throw-deprecation --pending-deprecation --force-context-aware --no-global-search-paths --unhandled-rejections=strict"
unset NODE_COMPILE_CACHE
# shellcheck disable=SC2086
exec node --disable-warning=ExperimentalWarning $hardened --import "data:text/javascript,$strip" "$here/../src/runner/cli-entry.ts" "$@"
