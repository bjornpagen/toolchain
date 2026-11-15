#!/bin/sh
# toolchain-typecheck: a package's typecheck, tsrs, Effect-patched by @effect/tsgo, over the tsconfig.json of the
# directory it runs in. The shared base makes it incremental: a re-check reads the package's build info and checks
# only what changed. Every argument passes through, so the full gate's typecheck:full passes --incremental false.
# TOOLCHAIN_TS_CHECKERS, when set, is tsrs's checker count (--checkers), so a machine that many runs share caps each
# one; unset, tsrs picks its own, as it did before. It goes after the caller's arguments: build mode's -b must be the
# first argument (TS5023 otherwise), and --checkers is valid after it as after -p.
set -eu
case ${TOOLCHAIN_TS_CHECKERS:-} in
	"") ;;
	*[!0-9]* | 0*)
		printf 'toolchain-typecheck: TOOLCHAIN_TS_CHECKERS must be a whole number above zero, not "%s"\n' "$TOOLCHAIN_TS_CHECKERS" >&2
		exit 2
		;;
	*) set -- "$@" --checkers "$TOOLCHAIN_TS_CHECKERS" ;;
esac
exec effect-tsgo tsrs "$@"
