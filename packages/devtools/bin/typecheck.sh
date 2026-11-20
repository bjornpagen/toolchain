#!/bin/sh
# toolchain-typecheck: a package's typecheck, tsrs, Effect-patched by @effect/tsgo, over the tsconfig.json of the
# directory it runs in. The shared base makes it incremental: a re-check reads the package's build info and checks
# only what changed. Every argument passes through, so the typecheck from scratch is this same script with
# --incremental false (`turbo run typecheck -- --incremental false`), and a package states its typecheck once.
set -eu
# Half the machine's CPUs, one at least (Bjorn, 2026-11-20: "they must cut their cpu usage in half"): the native
# checker's threads follow GOMAXPROCS, and the machine is shared by many agents' checks at once, as testing's
# workers.ts testWorkers halves a run's workers.
half=$(( $(nproc) / 2 ))
[ "$half" -ge 1 ] || half=1
GOMAXPROCS=$half exec effect-tsgo tsrs "$@"
