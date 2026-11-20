#!/bin/sh
# toolchain-land (`pnpm land`): lands this clone's commits on its repository's trunk, one landing at a time across every
# clone of the machine, each gated once, on the commit that lands. Ported from metis's scripts/land.sh (3f46d57): a push
# gate that waited its turn and then found the trunk moved, rebased and queued again, ran O(N²) gates for N lanes; land
# runs N.
#
#   toolchain-land            waits for the push lock and, holding it, fetches the trunk, rebases this clone's trunk
#                             onto it and pushes, so the push gate (this clone's pre-push hook) runs once, on what
#                             lands, and the push is a fast-forward of a trunk no other landing can move meanwhile
#   toolchain-land pre-push   the push gate's check (toolchain-gate push, or a repository's own pre-push script), on
#                             git's pre-push lines on stdin: a push that updates the trunk is refused, before any gate
#                             runs, unless it is a landing's, holding the lock
#   hooks/pre-receive         this file as a local hub's pre-receive hook, which a landing installs there: the hub takes
#                             an update of the trunk only from a push holding the lock, whatever hooks its clone runs
#
# The binding is the repository's toolchain.config.ts `land` (src/land.ts reads it): `lock`, the file every clone takes
# the lock on, written from the home directory, and `branch`, the trunk. A hub holds the binding in its own git config
# (toolchain-land.lock, toolchain-land.branch), which each landing writes, since a hub has no working tree to read.
#
# The lock is flock(2)'s, taken by the toolchain's one holder of kernel locks (packages/testing/scripts/hold.pl) on a
# descriptor of the landing's first shell, which holds it and does nothing else: the landing itself runs as that
# shell's child with the descriptor closed, so no process it starts (a daemon a gate leaves behind) holds the lock past
# the landing, and the lock goes the moment the holding shell exits, however it exits. Older takers of a lock on the
# same file (grizzle's interim push.sh, flock(1)) take the same flock(2), so they and a landing keep each other out.
#
# A push proves it is a landing's (holds): the process it names as the holder, TOOLCHAIN_LAND_HOLDER, is an ancestor
# of the check, and the kernel lists an exclusive flock on the lock's file under a descriptor of that process
# (/proc/<pid>/fdinfo/<fd>'s `lock:` lines, which show the lock of the open file the descriptor is, whoever took it).
# Both must hold, so no environment alone lets a push through. A local push's receive-pack inherits the pusher's
# environment and is its descendant, so a hub's hook checks the same proof.
#
# It refuses a clone on another branch, one whose working tree or index holds changes to tracked files (a rebase needs
# them committed), one with no pre-push hook (its push would go out ungated), and a rebase that conflicts, which it
# aborts, leaving the clone as it was; then nothing was pushed. TOOLCHAIN_LAND_AFTER_REBASE, when set, is a command
# run after the rebase and before the push, inside the lock, such as a rename that must reach every commit the rebase
# brought in: whatever tracked change it leaves is folded into the clone's last commit, so the gate judges and the
# trunk takes the commit as the command left it.
set -eu

self=$(realpath -- "$0")

refuse() {
	printf 'toolchain-land: %s\n' "$1" >&2
	exit 1
}

# binding: reads the repository's toolchain.config.ts `land` into lock (an absolute path) and branch.
binding() {
	read_binding=$(cd "$(git rev-parse --show-toplevel)" && node "$(dirname -- "$self")/../src/land.ts") ||
		refuse "the repository's toolchain.config.ts binds no landing it could read"
	eval "$read_binding"
	lock="$HOME/${lock#"~/"}"
}

# holds <pid>: whether <pid> is an ancestor of this process whose descriptors hold the exclusive flock on $lock.
holds() {
	[ -n "$1" ] && [ -e "$lock" ] || return 1
	process=$$
	while [ "$process" != "$1" ] && [ "$process" -gt 1 ] 2>/dev/null; do
		process=$(sed 's/.*) //' "/proc/$process/stat" 2>/dev/null | cut -d' ' -f2)
	done
	[ "$process" = "$1" ] || return 1
	inode=$(stat -c %i -- "$lock")
	grep -Eqs "^lock:.*FLOCK +ADVISORY +WRITE +[0-9-]+ +[0-9a-f]+:[0-9a-f]+:$inode " "/proc/$1/fdinfo/"*
}

# updates <field> <ref>: whether a line on stdin names <ref> in its <field>th field, every line read either way.
updates() {
	named=no
	while read -r line; do
		[ "$(printf '%s\n' "$line" | cut -d' ' -f"$1")" != "$2" ] || named=yes
	done
	[ "$named" = yes ]
}

mode=${1:-land}
[ "$(basename -- "$0")" != pre-receive ] || mode=pre-receive
case $mode in
	land)
		binding
		[ "$(git symbolic-ref --short HEAD 2>/dev/null)" = "$branch" ] ||
			refuse "land from $branch: this clone is on another branch or detached"
		{ git diff --quiet && git diff --cached --quiet; } ||
			refuse "commit or set aside every change first: a rebase needs a clean working tree and index"
		[ -x "$(git rev-parse --git-path hooks/pre-push)" ] ||
			refuse "this clone has no pre-push hook, so its push would go out ungated: run node_modules/.bin/lefthook install"
		mkdir -p "$(dirname -- "$lock")"
		exec 9>>"$lock"
		printf 'toolchain-land: waiting for the push lock (%s)\n' "$lock" >&2
		perl "$(dirname -- "$self")/../../testing/scripts/hold.pl" wait exclusive 1 9
		landed=0
		TOOLCHAIN_LAND_HOLDER=$$ TOOLCHAIN_LAND_LOCK=$lock TOOLCHAIN_LAND_BRANCH=$branch \
			sh "$self" locked 9>&- || landed=$?
		exit "$landed"
		;;
	locked)
		[ "$PPID" = "${TOOLCHAIN_LAND_HOLDER:-}" ] || refuse "the push lock's holder is not this landing's parent"
		lock=$TOOLCHAIN_LAND_LOCK
		branch=$TOOLCHAIN_LAND_BRANCH
		# A local hub (an origin that is a repository's directory, not a URL) takes the trunk from a landing alone: its
		# binding and this file, as its pre-receive hook, are written before each push.
		origin=$(git remote get-url origin)
		if [ -d "$origin/hooks" ]; then
			git --git-dir="$origin" config toolchain-land.lock "$lock"
			git --git-dir="$origin" config toolchain-land.branch "$branch"
			cp -- "$self" "$origin/hooks/pre-receive.$$"
			chmod +x "$origin/hooks/pre-receive.$$"
			mv -- "$origin/hooks/pre-receive.$$" "$origin/hooks/pre-receive"
		fi
		git fetch -q origin "$branch"
		trunk=$(git rev-parse FETCH_HEAD)
		# A clone of this machine holds no git identity of its own: the rebase then commits as the author of the clone's
		# last commit, the one identity it holds.
		if ! git config user.email >/dev/null; then
			: "${GIT_COMMITTER_NAME:=$(git log -1 --format=%an)}" "${GIT_COMMITTER_EMAIL:=$(git log -1 --format=%ae)}"
			export GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL
		fi
		if ! git rebase -q "$trunk"; then
			git rebase --abort
			refuse "this clone's commits conflict with $branch ($trunk): rebase on it by hand, resolve, and land again"
		fi
		git submodule update --init --recursive -q
		if [ -n "${TOOLCHAIN_LAND_AFTER_REBASE:-}" ]; then
			sh -c "$TOOLCHAIN_LAND_AFTER_REBASE" || refuse "TOOLCHAIN_LAND_AFTER_REBASE failed: nothing was pushed"
			git diff --quiet || git commit -q --amend --no-edit -a
		fi
		[ "$(git rev-parse HEAD)" != "$trunk" ] || refuse "nothing to land: $branch is the remote's $branch"
		printf 'toolchain-land: pushing %s onto %s %s\n' "$(git rev-parse --short HEAD)" "$branch" "$(git rev-parse --short "$trunk")" >&2
		git push origin "HEAD:refs/heads/$branch"
		;;
	pre-push)
		# git's lines: <local ref> <local commit> <remote ref> <remote commit>. A run by hand (a terminal, or no lines) reads
		# no binding.
		sent=
		[ -t 0 ] || sent=$(cat)
		[ -n "$sent" ] || exit 0
		binding
		if printf '%s\n' "$sent" | updates 3 "refs/heads/$branch" && ! holds "${TOOLCHAIN_LAND_HOLDER:-}"; then
			refuse "land on $branch with pnpm land, which rebases onto the remote's $branch inside the push lock, then pushes"
		fi
		;;
	pre-receive)
		# git's lines: <old commit> <new commit> <ref>.
		lock=$(git config --get toolchain-land.lock) && branch=$(git config --get toolchain-land.branch) ||
			refuse "this hub holds no landing's binding (toolchain-land.lock, toolchain-land.branch)"
		if updates 3 "refs/heads/$branch" && ! holds "${TOOLCHAIN_LAND_HOLDER:-}"; then
			printf 'hub: %s moves only by pnpm land, which holds the push lock (%s) from its rebase through its push\n' "$branch" "$lock" >&2
			exit 1
		fi
		;;
	*)
		printf 'toolchain-land: usage: toolchain-land | toolchain-land pre-push\n' >&2
		exit 2
		;;
esac
