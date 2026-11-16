#!/bin/sh
# toolchain-test, the runner's command for a package that has @bjornpagen/testing in its node_modules: it runs
# src/runner/cli.ts with every argument it is given, from the package root the command was started in. Node strips no
# types from a file under node_modules, and the library ships TypeScript source, so Node first imports a load hook, from
# a data: URL, that strips the types of every TypeScript module under node_modules as Node would anywhere else; every
# worker the runner forks inherits the hook with the rest of this process's flags.
set -eu
here=$(dirname -- "$(realpath -- "$0")")
strip='import { readFileSync } from "node:fs"; import { registerHooks, stripTypeScriptTypes } from "node:module"; registerHooks({ load: (url, context, nextLoad) => url.includes("/node_modules/") && url.endsWith(".ts") ? { format: "module", source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8")), shortCircuit: true } : nextLoad(url, context) });'
exec node --disable-warning=ExperimentalWarning --import "data:text/javascript,$strip" "$here/../src/runner/cli.ts" "$@"
