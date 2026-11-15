#!/bin/sh
# toolchain-oxlint: oxlint with every argument it is given. Type-aware rules run in tsgolint, a Go program oxlint
# starts, which uses the logical CPUs the process may use (its affinity mask and, on Linux, its cgroup CPU quota:
# https://pkg.go.dev/runtime, verified 2026-11-15).
set -eu
exec oxlint "$@"
