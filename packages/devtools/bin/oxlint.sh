#!/bin/sh
# toolchain-oxlint: oxlint with every argument it is given. Type-aware rules run in tsgolint, a Go program oxlint
# starts, which takes a core per thread unless GOMAXPROCS says otherwise; TOOLCHAIN_TSGOLINT_PROCS, when set, is that
# GOMAXPROCS, so a machine that many runs share caps each one. Unset, tsgolint takes what it took before.
set -eu
case ${TOOLCHAIN_TSGOLINT_PROCS:-} in
	"") ;;
	*[!0-9]* | 0*)
		printf 'toolchain-oxlint: TOOLCHAIN_TSGOLINT_PROCS must be a whole number above zero, not "%s"\n' "$TOOLCHAIN_TSGOLINT_PROCS" >&2
		exit 2
		;;
	*) export GOMAXPROCS="$TOOLCHAIN_TSGOLINT_PROCS" ;;
esac
exec oxlint "$@"
