#!/bin/sh
# toolchain-gate: runs a check on exactly one snapshot of the repository, never on the working tree, so lanes that share
# one checkout never fail or pass each other's work in progress.
#
#   toolchain-gate commit           the commit gate (lefthook's pre-commit): on what the index holds, `pnpm types`,
#                                   oxfmt's check of the staged files and the AST-only oxlint (oxlint.ast.config.ts)
#                                   on the staged files it reads, side by side
#   toolchain-gate push             the push gate (lefthook's pre-push, with use_stdin): `pnpm check` on each commit the
#                                   push sends, read from git's pre-push lines on stdin (HEAD when there are none)
#   toolchain-gate run <index|commit> <command> [arguments]
#                                   any command on what the index holds, or on a commit
#
# A snapshot is a directory under the cache that git keeps in step with an index of its own (read-tree --reset -u): a
# run rewrites only the files that changed since the last, deletes the ones that went, and leaves what .gitignore names
# (node_modules, the typecheck's build info, the tools' caches) where it was, so installs and incremental checks stay
# warm. git leaves a submodule's gitlink an empty directory: each is filled the same way from the submodule's own
# repository, at the commit the snapshot records. The commit gate and the push gate keep separate snapshots, so a
# commit, which holds index.lock for its whole hook, never waits on a push's full gate; runs on one snapshot take turns.
# Turbo's cache is the working tree's (.turbo/cache) unless TURBO_CACHE_DIR names one, so a task the working tree
# already ran on the same content is a hit in the snapshot, and the other way round.
set -eu

die() {
	printf 'toolchain-gate: %s\n' "$*" >&2
	exit 2
}

root=$(git rev-parse --show-toplevel)
git_dir=$(git rev-parse --absolute-git-dir)
cache="${XDG_CACHE_HOME:-$HOME/.cache}/toolchain-gate/$(printf '%s' "$root" | git hash-object --stdin | cut -c1-12)"
newline='
'

# fill <git dir> <tree> <directory> <state> <checkout>: <directory> holds exactly <tree>, each submodule at the commit
# <tree> records, read from the submodule's repository in <checkout>, the working tree that holds the submodules.
fill() (
	mkdir -p "$3" "$(dirname -- "$4")"
	GIT_DIR=$1 GIT_INDEX_FILE=$4 git --work-tree="$3" read-tree --reset -u "$2"
	GIT_DIR=$1 git ls-tree -r "$2" | while IFS='	' read -r entry path; do
		case $entry in
			*" commit "*) ;;
			*) continue ;;
		esac
		commit=${entry##* }
		# A submodule the working tree never checked out (a nested one, often) stays an empty directory, as it is there.
		checkout=$(cd "$5/$path" 2>/dev/null && pwd -P) || continue
		top=$(git -C "$checkout" rev-parse --show-toplevel 2>/dev/null) || continue
		[ "$(cd "$top" && pwd -P)" = "$checkout" ] || continue
		module=$(git -C "$checkout" rev-parse --absolute-git-dir)
		GIT_DIR=$module git cat-file -e "$commit^{commit}" 2>/dev/null ||
			die "$path's repository lacks $commit, which the snapshot records: fetch it there"
		fill "$module" "$commit^{tree}" "$3/$path" "$4.modules/$(printf '%s' "$path" | git hash-object --stdin)" "$5/$path"
	done
)

# lock <snapshot>: waits until no other run holds the snapshot, then holds it until this run exits.
lock() {
	held="$1.lock"
	mkdir -p "$(dirname -- "$held")"
	waited=0
	until mkdir "$held" 2>/dev/null; do
		holder=$(cat "$held/pid" 2>/dev/null || true)
		if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
			rm -rf "$held"
			continue
		fi
		[ "$waited" = 0 ] && printf 'toolchain-gate: waiting for the run that holds %s\n' "$held" >&2
		waited=1
		sleep 1
	done
	printf '%s\n' "$$" >"$held/pid"
	trap 'rm -rf "$held"' EXIT
	trap 'exit 130' INT TERM
}

# enter <snapshot> <tree>: the snapshot holds <tree> and its dependencies are installed, and the shell is in it.
enter() {
	lock "$cache/$1"
	fill "$git_dir" "$2" "$cache/$1" "$cache/$1.index" "$root"
	export TURBO_CACHE_DIR="${TURBO_CACHE_DIR:-$root/.turbo/cache}"
	cd "$cache/$1"
	unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
	[ -d .git ] || git init --quiet
	pnpm install --frozen-lockfile --offline --reporter=silent
}

# started <name> <command> [arguments]: runs the command in the background, its output kept for report.
started() {
	name=$1
	shift
	"$@" >"$logs/$name" 2>&1 &
	printf '%s\n' "$!" >"$logs/$name.pid"
}

# report <name>: waits for a started command and prints its output; failed collects the names of those that failed.
report() {
	[ -f "$logs/$1.pid" ] || return 0
	if wait "$(cat "$logs/$1.pid")"; then
		printf '%s: passed\n' "$1"
	else
		printf '%s: failed\n' "$1"
		failed="$failed $1"
	fi
	cat "$logs/$1"
}

mode=${1:-}
[ "$#" -gt 0 ] && shift
case $mode in
	commit)
		# The staged files, submodules aside (a gitlink is no file to format or lint), one a line.
		staged=$(git diff --cached --name-only --diff-filter=ACMR --ignore-submodules=all)
		lintable=$(printf '%s\n' "$staged" | grep -E '\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$' || true)
		enter commit "$(git write-tree)"
		[ -f oxlint.ast.config.ts ] || die "the repository has no oxlint.ast.config.ts, the commit gate's AST-only oxlint"
		logs=$(mktemp -d)
		failed=
		started types pnpm types
		set -f
		IFS=$newline
		# shellcheck disable=SC2086
		[ -z "$staged" ] || started format pnpm exec oxfmt --check --no-error-on-unmatched-pattern $staged
		# shellcheck disable=SC2086
		[ -z "$lintable" ] || started lint pnpm exec oxlint -c oxlint.ast.config.ts --no-error-on-unmatched-pattern $lintable
		unset IFS
		set +f
		report types
		report format
		report lint
		rm -rf "$logs"
		[ -z "$failed" ] || die "failed:$failed"
		;;
	push)
		# Each line names a ref the push updates and the commit it sends; a commit of zeros deletes the ref, which sends
		# nothing to check. With no lines at all (run by hand), the push is HEAD's.
		pushed=
		lines=0
		if [ ! -t 0 ]; then
			while read -r _ local_commit _ _; do
				lines=$((lines + 1))
				case $local_commit in
					*[!0]*) pushed="$pushed $local_commit" ;;
				esac
			done
		fi
		[ "$lines" -gt 0 ] || pushed=$(git rev-parse HEAD)
		for commit in $pushed; do
			printf 'toolchain-gate: pnpm check on %s\n' "$commit" >&2
			(
				enter push "$commit^{tree}"
				pnpm check
			)
		done
		;;
	run)
		[ "$#" -ge 2 ] || die "usage: toolchain-gate run <index|commit> <command> [arguments]"
		target=$1
		shift
		case $target in
			index) enter commit "$(git write-tree)" ;;
			*) enter push "$(git rev-parse --verify "$target^{tree}")" ;;
		esac
		"$@"
		;;
	*)
		die "usage: toolchain-gate commit | push | run <index|commit> <command> [arguments]"
		;;
esac
