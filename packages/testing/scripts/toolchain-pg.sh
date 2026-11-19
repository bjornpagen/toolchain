#!/bin/sh
# toolchain-pg, the local cluster's command for a package that has @bjornpagen/testing in its node_modules: it runs
# src/pg/cli.ts with every argument it is given, over the cluster the pg.config.ts of the directory it was started in
# states. Node strips no types from a file under node_modules, and the library ships TypeScript source, so Node first
# imports a load hook, from a data: URL, that strips the types of every TypeScript module under node_modules as Node
# would anywhere else (as toolchain-test does).
set -eu
here=$(dirname -- "$(realpath -- "$0")")
strip='import { readFileSync } from "node:fs"; import { registerHooks, stripTypeScriptTypes } from "node:module"; registerHooks({ load: (url, context, nextLoad) => url.includes("/node_modules/") && url.endsWith(".ts") ? { format: "module", source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8")), shortCircuit: true } : nextLoad(url, context) });'
exec node --disable-warning=ExperimentalWarning --import "data:text/javascript,$strip" "$here/../src/pg/cli.ts" "$@"
