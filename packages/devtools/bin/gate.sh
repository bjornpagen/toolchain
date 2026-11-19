#!/bin/sh
# toolchain-gate: runs a check on exactly one snapshot of the repository, never on the working tree, so lanes that share
# one checkout never fail or pass each other's work in progress.
#
#   toolchain-gate commit           the commit gate (lefthook's pre-commit): on what the index holds, `pnpm types`,
#                                   oxfmt's check of the staged files and the AST-only oxlint (oxlint.ast.config.ts)
#                                   on the staged files it reads, side by side
#   toolchain-gate push             the push gate (lefthook's pre-push, with use_stdin): `pnpm check` on the tip of each
#                                   ref the push updates, read from git's pre-push lines on stdin (HEAD when there are
#                                   none): a push lands its commits together, so the tip is the commit that matters;
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
# snapshot records, so the snapshot lists it as its gitlink, as the working tree does. The commit gate and the push gate
# keep separate snapshots, so a commit, which holds index.lock for its whole hook, never shares one with a push's gate.
#
# No run waits for another. A mode has as many snapshots as runs of it were ever at once: a run claims the first one no
# live run holds, and when every one is held it makes the next at once, filled and installed from pnpm's store, so a
# long command in one snapshot (a property suite run by hand, the push's affected properties) keeps no other lane's
# commit or push waiting. A snapshot stays warm for whichever run claims it next: its install stays, and fill rewrites
# only what changed.
#
# Cache layout: ${XDG_CACHE_HOME:-~/.cache}/toolchain-snapshots/<key>/, one directory per REPOSITORY, not per checkout.
# The key is the first 12 hex digits of the git hash of the repository's identity: its origin remote URL when it has
# one, written with no trailing / or .git (https://github.com/o/r.git and https://github.com/o/r are one repository),
# else the absolute common git directory. Every clone of one repository (grizzle's lanes clone it under
# ~/.cache/grizzle-release/<LANE>/) therefore shares the snapshots, and the first run of the second clone is warm: the
# install is there.
#
#   <key>/clones                 the common git directories of the clones that have run here, one a line
#   <key>/commit.<n>, push.<n>   the snapshots' checkouts, n from 0     <key>/<mode>.<n>.git   their git directories
#   <key>/<mode>.<n>.lock        locked, exclusive, by the run that uses that snapshot
#   <key>/push.full              stamped when the daily check:full passed
#   <key>/push.passed/<tree>     stamped when every check of the push gate passed on that tree
#   .<key>.lock                  beside the key directory, locked, shared, by every run of the repository
#
# Every hold is a kernel lock on an open file (flock(2)), taken on the shell's own descriptor by the toolchain's one
# holder of kernel locks (packages/testing/scripts/hold.pl, which takes the cluster maker's locks too): a run's shell
# and every process it starts keep the file open, and the kernel lets the lock go when the last of them exits, however
# it exits. The gates since 434ec12 hold the same locks with flock(1), which takes flock(2)'s, so a run of this gate and
# one of theirs in one cache keep each other's. No pid names a holder, so no live run
# is ever taken for a dead one, and no run reads a snapshot another run is filling. A run holds its repository's key
# from before its first look at the cache until it and everything it started have exited, and a snapshot from its
# claim until then too, so whatever holds a snapshot holds its key.
#
# The cache is this gate's alone. Every gate before it kept its snapshots in ${XDG_CACHE_HOME:-~/.cache}/toolchain-gate/
# and deleted a key directory there by rules that see no flock(1) hold: one judged by a pid file inside each lock, and
# by a key that kept a URL's .git, so the directory of a repository cloned with .git (effect-openapi-cli-generator's
# 930250a4b854) read as gone and was deleted under its live run, four of its pushes in a row. No older gate looks here.
#
# A snapshot's git directory borrows objects (alternates) from ONE repository, and a snapshot serves several clones.
# Each run rewrites the alternates to the objects of the clone whose commit it checks, while it holds the snapshot and
# before read-tree: that clone is the only one certain to hold the commit (an index commit exists nowhere else), and a
# run holds its snapshot until it exits, so no other clone's rewrite can pull the objects away mid-run. Listing every
# clone's objects instead would let a deleted clone's missing directory and an unrelated clone's stale objects take
# part in every read.
#
# Garbage: once a run holds its key, it deletes each other key directory whose repository is gone and that no run
# holds. The `clones` registry says only whether the repository is gone: none of the clones it lists still exists with
# that key as its identity. Whether a run is in the directory is the lock's to say: the collect takes the key's lock
# alone (exclusive, without waiting) and renames the directory away under it, then removes it, so a run either holds
# the key before the rename, and the directory stays, or makes a new one after it. That rename is the one way anything
# under the cache is deleted but a snapshot's own reset, which its claim's lock guards; what a collect killed between
# the two left behind (a .gone.* directory) is removed by the next.
#
# Turbo's cache is the working tree's (.turbo/cache) unless TURBO_CACHE_DIR names one, so a task the working tree
# already ran on the same content is a hit in the snapshot, and the other way round.
set -eu

die() {
	printf 'toolchain-gate: %s\n' "$*" >&2
	exit 2
}

holder="$(dirname -- "$(realpath -- "$0")")/../../testing/scripts/hold.pl"
root=$(git rev-parse --show-toplevel)
git_dir=$(git rev-parse --absolute-git-dir)
common_dir=$(git rev-parse --path-format=absolute --git-common-dir)
cache_root="${XDG_CACHE_HOME:-$HOME/.cache}/toolchain-snapshots"
newline='
'

# key_of <common git dir>: the repository's cache key, from its origin remote URL when it has one, written with no
# trailing / or .git, else from its path.
key_of() {
	identity=$(git --git-dir="$1" config --get remote.origin.url 2>/dev/null || true)
	identity=${identity%/}
	identity=${identity%.git}
	printf '%s' "${identity:-$1}" | git hash-object --stdin | cut -c1-12
}

key=$(key_of "$common_dir")
cache="$cache_root/$key"

# How long the push gate's last passing check:full counts, before the next push runs check:full again (gate.sh).
#
# @limitKind provisional
# @owner the dev tools' gate (packages/devtools/bin/gate.sh, the push)
# @unit days
# @scope the age of the push snapshot's last passing check:full, in a repository that has one
# @guards without a period a stale result of the incremental typecheck's build info (TypeScript #64386 and #64591)
#   could pass every push for ever; with none at all every push runs the gate from scratch
# @measure over a few weeks of pushes, record each check:full that failed where the incremental check before it
#   passed, and how long the build info had then been kept; choose the period below the shortest such age
# @origin Bjorn's decision of 2026-11-15, "once a day", written with db83729, with no evidence
# @recorded 2026-11-16
readonly GATE_FULL_CHECK_DAYS=1

# fill <git dir> <commit> <directory> <snapshot git dir> <checkout>: <directory> is a checkout of <commit>, whose git
# directory, <snapshot git dir>, borrows <git dir>'s objects and holds HEAD at <commit>; each submodule is filled the
# same way at the commit <commit> records, from the submodule's repository in <checkout>, the working tree that holds
# the submodules.
fill() (
	mkdir -p "$3" "$(dirname -- "$4")"
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

# hold <claim>...: takes the holder's claims (hold.pl's CLAIMs) on this shell's descriptors, which keep them until it
# and everything it starts have exited; fails when a `try` claim's lock is taken, and dies on any other failure.
hold() {
	perl "$holder" "$@" && return 0 || exited=$?
	[ "$exited" -eq 1 ] || die "the holder failed (exit $exited) on: $*"
	return 1
}

# claim <mode>: holds the first snapshot of <mode> no live run holds, until this run and everything it starts have
# exited, and names it $snapshot; when every one is held, the next number is a new snapshot, which fill makes. Each
# look opens the snapshot's lock on descriptor 9, letting go of the one before, which this run could not take.
claim() {
	n=0
	until exec 9>>"$cache/$1.$n.lock" && hold try exclusive 1 9; do
		n=$((n + 1))
	done
	snapshot="$cache/$1.$n"
}

# collect: registers this clone under its key, then deletes every other key directory whose repository is gone and
# that no run holds, by renaming it to a hidden one under its lock (hidden names are no key's) and removing that after,
# with any a collect left behind when it was killed. It runs once this run holds its key, so its own directory, made
# here on its repository's first run, is never one another collect can take.
collect() {
	mkdir -p "$cache"
	grep -qxF -- "$common_dir" "$cache/clones" 2>/dev/null || printf '%s\n' "$common_dir" >>"$cache/clones"
	for dir in "$cache_root"/*; do
		[ -d "$dir" ] && [ "$dir" != "$cache" ] || continue
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
		exec 7>>"$cache_root/.$(basename -- "$dir").lock"
		if hold try exclusive 1 7; then
			mv "$dir" "$(mktemp -d "$cache_root/.gone.XXXXXX")/"
		fi
		exec 7>&-
	done
	rm -rf "$cache_root"/.gone.*
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

# enter <mode> <commit>: a snapshot of the mode is this run's, a checkout of <commit> with its dependencies installed,
# and the shell is in it. The install reads pnpm's store and metadata cache and fetches only what they lack
# (--prefer-offline): under pnpm's supply-chain policy a changed lockfile has every package's metadata checked again,
# and --offline failed (ERR_PNPM_NO_OFFLINE_META) whenever the metadata cache lacked one of them.
enter() {
	unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
	claim "$1"
	fill "$git_dir" "$2" "$snapshot" "$snapshot.git" "$root"
	export TURBO_CACHE_DIR="${TURBO_CACHE_DIR:-$root/.turbo/cache}"
	cd "$snapshot"
	pnpm install --frozen-lockfile --prefer-offline --reporter=silent
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

# The run holds its repository's key, shared, on descriptor 8, from here until it and everything it starts have exited:
# from before its first look at the cache (the push's stamps, a claim), so no collect deletes the directory under any
# part of it. It waits only while a collect renames a gone repository's directory away, and then makes a new one.
mkdir -p "$cache_root"
exec 8>>"$cache_root/.$key.lock"
hold wait shared 1 8
collect
printf 'toolchain-gate: holds %s\n' "$cache" >&2

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
		# Its arguments are git's pre-push arguments, which lefthook passes on: the remote's name (its URL when the push
		# names none) and its URL; by hand, none. Anything else is refused, since this mode checks what the push sends,
		# whatever it is given: a lane that ran the pre-push script as `run index …` was checking HEAD, not the index.
		if [ "$#" -ne 0 ] && { [ "$#" -ne 2 ] || { [ "$1" != "$2" ] && ! git remote get-url -- "$1" >/dev/null 2>&1; }; }; then
			die "push takes git's pre-push arguments (a remote and its URL) or none; to check the index or a commit, run toolchain-gate run <index|commit> <command>"
		fi
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
			# A tree this gate passed before passes again: the gate's verdict is a function of the commit's tree, so a push
			# that sends a tree already gated (a ref race that threw the push away, a re-push) claims no snapshot and runs
			# nothing. The stamp is written only when every check of the tree passed.
			tree=$(git rev-parse "$commit^{tree}")
			if [ -f "$cache/push.passed/$tree" ]; then
				printf 'toolchain-gate: the tree of %s (%s) passed this gate before\n' "$commit" "$tree" >&2
				continue
			fi
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
				mkdir -p "$cache/push.passed"
				touch "$cache/push.passed/$tree"
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
