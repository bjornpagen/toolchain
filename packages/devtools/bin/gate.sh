#!/bin/sh
# toolchain-gate: runs a check on exactly one snapshot of the repository, never on the working tree, so lanes that share
# one checkout never fail or pass each other's work in progress.
#
#   toolchain-gate commit           the commit gate (lefthook's pre-commit): on what the index holds, `pnpm types`,
#                                   oxfmt's check of the staged files and the AST-only oxlint (oxlint.ast.config.ts)
#                                   on the staged files it reads, side by side
#   toolchain-gate push             the push gate (lefthook's pre-push, with use_stdin): `pnpm check` on each commit the
#                                   push sends, read from git's pre-push lines on stdin (HEAD when there are none);
#                                   once a day `pnpm check:full` instead, where the repository has one; then, in each
#                                   package with a test.config.ts, `toolchain-test affected <what the remote held>`:
#                                   every property with no cached pass, and its kills, at full width
#   toolchain-gate run <index|commit> <command> [arguments]
#                                   any command on what the index holds, or on a commit
#
# A snapshot is a checkout under the cache of exactly the commit it checks (in index mode, a commit of what the index
# holds, on HEAD), with a git directory of its own that borrows the repository's objects (alternates), keeps its index
# in step with the files (read-tree --reset -u) and holds HEAD at that commit, so a check that reads git facts (HEAD,
# the file list, a submodule's pin) reads the commit's and needs no case for the snapshot. A run rewrites only the files
# that changed since the last, deletes the ones that went, and leaves what .gitignore names (node_modules, the
# typecheck's build info, the tools' caches) where it was, so installs and incremental checks stay warm. Each submodule
# is checked out the same way, with a git directory of its own borrowing the submodule's objects, at the commit the
# snapshot records, so the snapshot lists it as its gitlink, as the working tree does. The commit gate and the push gate keep separate snapshots, so a
# commit, which holds index.lock for its whole hook, never waits on a push's full gate; runs on one snapshot take turns.
#
# Cache layout: ${XDG_CACHE_HOME:-~/.cache}/toolchain-gate/<key>/, one directory per REPOSITORY, not per checkout. The key
# is the first 12 hex digits of the git hash of the repository's identity: its origin remote URL when it has one, else
# the absolute common git directory. Every clone of one repository (grizzle's lanes clone it under
# ~/.cache/grizzle-release/<LANE>/) therefore shares the one commit snapshot and the one push snapshot, taking turns
# under the lock, and the first run of the second clone is warm: the install and the typecheck's build info are there.
#
#   <key>/clones          the common git directories of the clones that have run here, one a line
#   <key>/commit, push    the snapshots' checkouts           <key>/commit.git, push.git   their git directories
#   <key>/commit.lock, push.lock   held (a pid file in a directory) while a run uses the snapshot
#   <key>/push.full       stamped when the daily check:full passed
#
# The snapshot's git directory borrows objects (alternates) from ONE repository, and a shared snapshot has several
# candidates. Each run rewrites the alternates to the objects of the clone whose commit it checks, under the lock and
# before read-tree: that clone is the only one certain to hold the commit (an index commit exists nowhere else), and a
# run holds the lock until it exits, so no other clone's rewrite can pull the objects away mid-run. Listing every
# clone's objects instead would let a deleted clone's missing directory and an unrelated clone's stale objects take
# part in every read.
#
# Garbage: a run that enters the cache deletes each other key directory whose repository is gone, meaning none of the
# clones listed in its `clones` file still exists with that key as its identity, and that holds no live lock. A
# directory with no `clones` file is the old per-path layout (a hash of the checkout's path), which a repository pinned
# to an older toolchain still runs in: it is left alone, since no run here can tell whether its checkout still uses it.
# Turbo's cache is the working tree's (.turbo/cache) unless TURBO_CACHE_DIR names one, so a task the working tree
# already ran on the same content is a hit in the snapshot, and the other way round.
set -eu

die() {
	printf 'toolchain-gate: %s\n' "$*" >&2
	exit 2
}

root=$(git rev-parse --show-toplevel)
git_dir=$(git rev-parse --absolute-git-dir)
common_dir=$(git rev-parse --path-format=absolute --git-common-dir)
cache_root="${XDG_CACHE_HOME:-$HOME/.cache}/toolchain-gate"
newline='
'

# key_of <common git dir>: the repository's cache key, from its origin remote URL when it has one, else from its path.
key_of() {
	identity=$(git --git-dir="$1" config --get remote.origin.url 2>/dev/null || true)
	printf '%s' "${identity:-$1}" | git hash-object --stdin | cut -c1-12
}

cache="$cache_root/$(key_of "$common_dir")"

# The limits the gate reads, GATE_LOCK_POLL_SECONDS and GATE_FULL_CHECK_DAYS: the toolchain's packages/limits/limits.env,
# which packages/limits generates from its Limits and `pnpm check` holds to them. It sits beside the dev tools, found from
# this script's own path through any link to it (node_modules/.bin/toolchain-gate).
script=$0
while [ -L "$script" ]; do
	target=$(readlink -- "$script")
	case $target in
		/*) script=$target ;;
		*) script=$(dirname -- "$script")/$target ;;
	esac
done
limits_env=$(dirname -- "$script")/../../limits/limits.env
[ -f "$limits_env" ] || die "$limits_env is missing: the toolchain's limits package generates it (pnpm limits:data)"
# shellcheck source=../../limits/limits.env
. "$limits_env"

# fill <git dir> <commit> <directory> <snapshot git dir> <checkout>: <directory> is a checkout of <commit>, whose git
# directory, <snapshot git dir>, borrows <git dir>'s objects and holds HEAD at <commit>; each submodule is filled the
# same way at the commit <commit> records, from the submodule's repository in <checkout>, the working tree that holds
# the submodules.
fill() (
	mkdir -p "$3" "$(dirname -- "$4")"
	# An older gate kept a fresh, empty repository in the snapshot itself.
	if [ -d "$3/.git" ]; then
		rm -rf "$3/.git"
	fi
	if [ ! -f "$4/HEAD" ] || [ ! -f "$3/.git" ]; then
		rm -f "$3/.git"
		git init --quiet --separate-git-dir="$4" "$3"
	fi
	GIT_DIR=$1 git rev-parse --git-path objects >"$4/objects/info/alternates"
	GIT_DIR=$4 git --work-tree="$3" read-tree --reset -u "$2^{tree}"
	# read-tree removes only the files its index held: a file no index knows (one an older gate's snapshot kept, or one a
	# check wrote and .gitignore does not name) would stay, and a check listing untracked files would read it. clean
	# without -x removes those and keeps what .gitignore names (node_modules, build info, the tools' caches); a submodule's
	# own git directory keeps clean out of it, and its own fill cleans it.
	GIT_DIR=$4 git --work-tree="$3" clean -fdq
	GIT_DIR=$4 git update-ref --no-deref HEAD "$2"
	GIT_DIR=$4 git ls-tree -r "$2^{tree}" | while IFS='	' read -r entry path; do
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
		fill "$module" "$commit" "$3/$path" "$4/modules/$(printf '%s' "$path" | git hash-object --stdin)" "$5/$path"
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
		sleep "$GATE_LOCK_POLL_SECONDS"
	done
	printf '%s\n' "$$" >"$held/pid"
	trap 'rm -rf "$held"' EXIT
	trap 'exit 130' INT TERM
}

# held <key directory>: succeeds when a live run holds one of the directory's locks.
held() {
	for lockdir in "$1"/*.lock; do
		pid=$(cat "$lockdir/pid" 2>/dev/null || true)
		[ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && return 0
	done
	return 1
}

# collect: registers this clone under its key, then deletes every other key directory of this layout whose repository is
# gone and that holds no live lock. The key directory appears whole (renamed from a hidden one) so a concurrent collect never reads a
# new directory as an old-layout one; hidden names are skipped.
collect() {
	mkdir -p "$cache_root"
	if [ ! -d "$cache" ]; then
		fresh=$(mktemp -d "$cache_root/.new.XXXXXX")
		printf '%s\n' "$common_dir" >"$fresh/clones"
		mv "$fresh" "$cache" 2>/dev/null || true
		rm -rf "$fresh"
	fi
	grep -qxF -- "$common_dir" "$cache/clones" 2>/dev/null || printf '%s\n' "$common_dir" >>"$cache/clones"
	for dir in "$cache_root"/*; do
		[ -d "$dir" ] && [ "$dir" != "$cache" ] || continue
		# An older toolchain's gate keeps its snapshots here keyed by its checkout's path, with no clones file: that
		# repository may be mid-run in it (edullm and grizzle move their pin only with a certified grizzle).
		[ -f "$dir/clones" ] || continue
		alive=
		clones=$(cat "$dir/clones" 2>/dev/null || true)
		while IFS= read -r clone; do
			if [ -d "$clone" ] && [ "$(key_of "$clone")" = "$(basename -- "$dir")" ]; then
				alive=1
				break
			fi
		done <<EOF
$clones
EOF
		[ -z "$alive" ] || continue
		held "$dir" || rm -rf "$dir"
	done
}

# indexed: a commit of what the index holds, on HEAD, for the commit snapshot's HEAD. It is never referenced, so git's
# gc prunes it.
indexed() {
	tree=$(git write-tree)
	parent=$(git rev-parse --quiet --verify HEAD) || parent=
	printf 'toolchain-gate: what the index holds\n' |
		GIT_AUTHOR_NAME=toolchain-gate GIT_AUTHOR_EMAIL=toolchain-gate@localhost \
			GIT_COMMITTER_NAME=toolchain-gate GIT_COMMITTER_EMAIL=toolchain-gate@localhost \
			git commit-tree "$tree" ${parent:+-p "$parent"}
}

# enter <snapshot> <commit>: the snapshot is a checkout of <commit>, its dependencies are installed, and the shell is in
# it.
enter() {
	unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
	collect
	lock "$cache/$1"
	fill "$git_dir" "$2" "$cache/$1" "$cache/$1.git" "$root"
	export TURBO_CACHE_DIR="${TURBO_CACHE_DIR:-$root/.turbo/cache}"
	cd "$cache/$1"
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
		enter commit "$(indexed)"
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
		# Each line names a ref the push updates, the commit it sends and the commit the remote held; a commit of zeros
		# sends nothing to check (a deletion). What the remote held is what `toolchain-test affected` counts changes
		# against: the empty tree when the ref is new or the remote's commit is not here. With no lines at all (run by
		# hand), the push is HEAD's, against its upstream.
		empty=$(git hash-object -t tree /dev/null)
		pushed=
		lines=0
		if [ ! -t 0 ]; then
			while read -r _ local_commit _ remote_commit; do
				lines=$((lines + 1))
				case $local_commit in
					*[!0]*) ;;
					*) continue ;;
				esac
				base=$empty
				case $remote_commit in
					*[!0]*) git cat-file -e "$remote_commit^{commit}" 2>/dev/null && base=$remote_commit ;;
				esac
				pushed="$pushed $local_commit:$base"
			done
		fi
		[ "$lines" -gt 0 ] ||
			pushed="$(git rev-parse HEAD):$(git rev-parse --verify --quiet '@{upstream}' || printf '%s' "$empty")"
		origin=$(git --git-dir="$common_dir" config --get remote.origin.url || true)
		for pair in $pushed; do
			commit=${pair%%:*}
			base=${pair#*:}
			(
				enter push "$commit"
				# The push snapshot keeps the incremental typecheck's build info between runs, so `pnpm check` re-checks
				# what changed. A repository whose check:full runs the same gate from scratch (no build info, every task
				# forced) has it run once every GATE_FULL_CHECK_DAYS (a day, Bjorn, 2026-11-15), so a stale result from build
				# info lives that long at most; the stamp is written only when it passes.
				check=check
				if grep -q '"check:full"' package.json &&
					[ -z "$(find "$cache/push.full" -mtime "-$GATE_FULL_CHECK_DAYS" 2>/dev/null)" ]; then
					check=check:full
				fi
				printf 'toolchain-gate: pnpm %s on %s\n' "$check" "$commit" >&2
				pnpm "$check"
				[ "$check" = check ] || touch "$cache/push.full"
				# The snapshot carries the repository's origin, so toolchain-test names the repository as every clone does
				# and reads the verdicts their runs cached (${XDG_CACHE_HOME:-~/.cache}/toolchain-test/<key>/verdicts).
				[ -z "$origin" ] || git config remote.origin.url "$origin"
				# Each package with a runner config runs the properties whose verdict key holds no cached pass, and the
				# kills of each that passes (packages/testing/src/runner/affected.ts). A submodule's packages are its own
				# repository's to gate: git lists its gitlink, not its files.
				configs=$(git ls-files | grep -E '(^|/)test\.config\.ts$' || true)
				set -f
				IFS=$newline
				for config in $configs; do
					unset IFS
					directory=$(dirname -- "$config")
					printf 'toolchain-gate: toolchain-test affected %s in %s\n' "$base" "$directory" >&2
					(cd "$directory" && pnpm exec toolchain-test affected "$base")
				done
				unset IFS
				set +f
			)
		done
		;;
	run)
		[ "$#" -ge 2 ] || die "usage: toolchain-gate run <index|commit> <command> [arguments]"
		target=$1
		shift
		case $target in
			index) enter commit "$(indexed)" ;;
			*) enter push "$(git rev-parse --verify "$target^{commit}")" ;;
		esac
		"$@"
		;;
	*)
		die "usage: toolchain-gate commit | push | run <index|commit> <command> [arguments]"
		;;
esac
