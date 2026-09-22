#!/usr/bin/env bash
# One-command publish: create the GitHub repo (if absent) and push this branch.
#
# Credentials are read from a FILE, never from argv and never from the shell
# history, and the token is passed to git through a temporary credential helper
# so it is not written into .git/config or any log. The file is not deleted
# automatically — remove it yourself once you are done.
#
# Usage:
#   read -rsp "PAT: " T && printf '%s' "$T" > ~/.gh-pat && chmod 600 ~/.gh-pat && unset T
#   bash scripts/publish.sh
#
# Requires the token to have the `repo` scope (to create a repository) or, if you
# create the repo in the browser first, plain push access is enough.
set -uo pipefail

OWNER="${GH_OWNER:-lsl1931}"
REPO="${GH_REPO:-dsh-resource-bar}"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
PAT_FILE="${GH_PAT_FILE:-$HOME/.gh-pat}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

die() { echo "error: $*" >&2; exit 1; }

[[ -f "$PAT_FILE" ]] || die "no token file at $PAT_FILE (see the usage comment in this script)"
PAT="$(tr -d '\r\n' < "$PAT_FILE")"
[[ -n "$PAT" ]] || die "the token file is empty"

# A token with comments/whitespace would otherwise leak into the header.
[[ "$PAT" =~ ^[A-Za-z0-9_-]+$ ]] || die "the token file does not look like a bare token"

cd "$REPO_DIR" || die "cannot cd to $REPO_DIR"

echo "=== 1. does $OWNER/$REPO exist? ==="
STATUS="$(printf 'header = "Authorization: Bearer %s"\n' "$PAT" | \
  curl -sS -o /dev/null -w '%{http_code}' -K - "https://api.github.com/repos/$OWNER/$REPO" || echo 000)"
case "$STATUS" in
  200) echo "  exists";;
  404)
    echo "  not found; creating a public repository"
    CREATE="$(printf 'header = "Authorization: Bearer %s"\n' "$PAT" | \
      curl -sS -X POST -K - -H 'Content-Type: application/json' \
      -d "{\"name\":\"$REPO\",\"private\":false,\"description\":\"DSH web plugin: a CPU/memory usage pill in the sidebar with click-to-expand detail.\"}" \
      "https://api.github.com/user/repos")"
    echo "$CREATE" | grep -q '"full_name"' || { echo "$CREATE" | head -20; die "repository creation failed"; }
    echo "  created $OWNER/$REPO";;
  401) die "the token was rejected (401): check it is valid and not expired";;
  403) die "forbidden (403): the token likely lacks the 'repo' scope";;
  *)   die "unexpected status $STATUS from the GitHub API";;
esac

echo "=== 2. push $BRANCH ==="
# The helper reads the token from the FILE at call time rather than having it
# expanded into the command string: expanding it would put the secret into the
# helper process's argv, where any local `ps` could see it. Nothing is persisted
# under .git/ either (credential.helper= clears any inherited helper first).
git -c credential.helper= \
    -c "credential.helper=!f() { echo username=x-access-token; echo \"password=\$(cat '$PAT_FILE')\"; }; f" \
    push "https://github.com/$OWNER/$REPO.git" "$BRANCH:$BRANCH" || die "push failed"

echo "=== 3. verify the remote ref ==="
git ls-remote "https://github.com/$OWNER/$REPO.git" "refs/heads/$BRANCH" | sed 's/^/  /'

echo
echo "done: https://github.com/$OWNER/$REPO"
echo "remember to delete $PAT_FILE"
