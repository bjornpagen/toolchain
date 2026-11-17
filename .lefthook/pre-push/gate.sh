# The push gate (toolchain-gate push, packages/devtools/bin/gate.sh) on the tip of each ref the push updates, which git
# names on the hook's stdin (lefthook.yml's use_stdin): a push lands its commits together, so the tip is the commit that
# matters. It is a script job because lefthook runs a script job whatever files the push changes, while it skips a
# pre-push run job whenever `git diff HEAD @{push}` names no file, as a push of a submodule's gitlink alone, of
# deletions alone or of an empty commit does, so each of those went out ungated.
exec sh packages/devtools/bin/gate.sh push
