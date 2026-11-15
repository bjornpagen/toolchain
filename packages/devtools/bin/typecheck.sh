#!/bin/sh
# toolchain-typecheck: a package's typecheck, tsrs, Effect-patched by @effect/tsgo, over the tsconfig.json of the
# directory it runs in. The shared base makes it incremental: a re-check reads the package's build info and checks
# only what changed. Every argument passes through, so the full gate's typecheck:full passes --incremental false.
set -eu
exec effect-tsgo tsrs "$@"
