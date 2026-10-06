#!/usr/bin/env bash
# Cut a release: bump package.json, commit, tag, push.
# The release workflow (`.github/workflows/release.yml`) does the rest:
# verify on 3 OSes → npm publish (after approval) → GitHub release.
#
# usage: scripts/release.sh 0.2.0
set -euo pipefail

ver="${1:-}"
[[ "$ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || {
  echo "usage: scripts/release.sh <version>   e.g. scripts/release.sh 0.2.0" >&2
  exit 1
}

branch="$(git rev-parse --abbrev-ref HEAD)"
[[ "$branch" == "main" ]] || { echo "run this on main (now on $branch)" >&2; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo "working tree is dirty — commit or stash first" >&2; exit 1; }
if git rev-parse -q --verify "refs/tags/v$ver" >/dev/null; then
  echo "tag v$ver already exists — bump the version or delete the tag first" >&2
  exit 1
fi

bun -e "const f='package.json'; const j=JSON.parse(await Bun.file(f).text()); j.version='$ver'; await Bun.write(f, JSON.stringify(j, null, 2) + '\n')"

git add package.json
git commit -m "chore: release v$ver"
git tag "v$ver"
git push origin main "v$ver"

echo "pushed v$ver — follow the run: https://github.com/FinleyLaempe/opencode-ufr/actions"
