#!/bin/sh
# toolchain-oxlint: oxlint with every argument it is given. Type-aware rules run in `tsrs --lint`, the `tsrs-lint` of
# the tsrs package each repository's root lists: oxlint takes `tsrs-lint` from node_modules/.bin ahead of tsgolint (oxlint
# 1.93.0, crates/oxc_linter/src/tsgolint.rs try_find_tsgolint_executable), so the lint reads the TypeScript the
# typecheck reads, tsrs 0.25.0's port of TypeScript 7.1.0-beta. tsgolint 7.0.2007 vendors typescript-go 7.0.2, whose
# checker took 1,451 s to lint edullm's qti-database, where tsrs takes 8 to 11 s and finds the same diagnostics.
set -eu
exec oxlint "$@"
