#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SERVER_DIR="${ROOT_DIR}/server"
DIST_DIR="${SERVER_DIR}/builds"
VERSION_FILE="${SERVER_DIR}/main.go"

DARWIN_ARM64="${DIST_DIR}/familycall-server-darwin-arm64"
DARWIN_AMD64="${DIST_DIR}/familycall-server-darwin-amd64"
LINUX_AMD64="${DIST_DIR}/familycall-server-linux-amd64"
LINUX_ARM64="${DIST_DIR}/familycall-server-linux-arm64"
WINDOWS_AMD64="${DIST_DIR}/familycall-server-windows-amd64.exe"

NOTES=""
DRY_RUN=0
GH_REPO="ZonD80/familycall"

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: ./release.sh [-n|--notes TEXT] [--dry-run] [NOTES]

Run tests, build familycall-server for every release target, then create a
GitHub release.

Tag format: {version} from AppVersion in server/main.go (no "v" prefix)

Options:
  -n, --notes TEXT   Release notes (prompted if omitted)
      --dry-run      Run every check, test and build, but don't create the release
  -h, --help         Show this help
EOF
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "'$1' is required"
}

app_version() {
  local version
  [[ -f "$VERSION_FILE" ]] || die "version file not found: $VERSION_FILE"
  version="$(grep -E '^const AppVersion = "' "$VERSION_FILE" \
    | head -n1 \
    | sed -E 's/^const AppVersion = "([^"]+)".*/\1/')"
  [[ -n "$version" ]] || die "AppVersion not found in $VERSION_FILE"
  echo "$version"
}

require_artifact() {
  local path="$1"
  [[ -f "$path" && -s "$path" ]] || die "missing or empty artifact: $path"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -h|--help)
        usage
        exit 0
        ;;
      -n|--notes)
        [[ $# -ge 2 ]] || die "--notes requires a value"
        NOTES="$2"
        shift 2
        ;;
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      --)
        shift
        break
        ;;
      -*)
        die "unknown option: $1"
        ;;
      *)
        if [[ -n "$NOTES" ]]; then
          die "unexpected argument: $1"
        fi
        NOTES="$1"
        shift
        ;;
    esac
  done

  if [[ $# -gt 0 ]]; then
    if [[ -n "$NOTES" ]]; then
      die "unexpected argument: $1"
    fi
    NOTES="$*"
  fi
}

prompt_notes() {
  if [[ -n "$NOTES" || "$DRY_RUN" -eq 1 ]]; then
    return 0
  fi
  if [[ ! -t 0 ]]; then
    die "release notes required (pass -n/--notes or a positional argument)"
  fi
  echo "Enter release notes (end with Ctrl-D):"
  NOTES="$(cat)"
  [[ -n "${NOTES//[[:space:]]/}" ]] || die "release notes cannot be empty"
}

require_release_commit() {
  local origin head upstream
  origin="$(git -C "$ROOT_DIR" remote get-url origin 2>/dev/null || true)"
  [[ "$origin" == *ZonD80/familycall* ]] \
    || die "origin must be the ZonD80/familycall repository"
  [[ -z "$(git -C "$ROOT_DIR" status --porcelain)" ]] \
    || die "working tree is not clean"
  git -C "$ROOT_DIR" fetch origin
  head="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  upstream="$(git -C "$ROOT_DIR" rev-parse '@{u}' 2>/dev/null || true)"
  [[ -n "$upstream" ]] || die "branch has no upstream; push it before releasing"
  [[ "$head" == "$upstream" ]] || die "push this commit before releasing (or pull if behind)"
}

require_new_tag() {
  local tag="$1"
  if git -C "$ROOT_DIR" rev-parse -q --verify "refs/tags/${tag}" >/dev/null \
    || git -C "$ROOT_DIR" ls-remote --exit-code --tags origin "refs/tags/${tag}" >/dev/null 2>&1; then
    die "tag already exists: $tag (bump AppVersion in server/main.go)"
  fi
}

run_tests() {
  echo "==> Running tests"
  (cd "$SERVER_DIR" && go vet ./... && go test ./...)
  node --test "${ROOT_DIR}/tests/web/"*.test.js
  echo
}

build_server() {
  echo "==> Building server binaries"
  # Never upload binaries left over from an earlier build
  rm -f "$DARWIN_ARM64" "$DARWIN_AMD64" "$LINUX_AMD64" "$LINUX_ARM64" "$WINDOWS_AMD64"
  "${SERVER_DIR}/build-all.sh"
  require_artifact "$DARWIN_ARM64"
  require_artifact "$DARWIN_AMD64"
  require_artifact "$LINUX_AMD64"
  require_artifact "$LINUX_ARM64"
  require_artifact "$WINDOWS_AMD64"
  echo "OK: $DARWIN_ARM64"
  echo "OK: $DARWIN_AMD64"
  echo "OK: $LINUX_AMD64"
  echo "OK: $LINUX_ARM64"
  echo "OK: $WINDOWS_AMD64"
  echo
}

create_github_release() {
  local tag="$1"
  local target
  target="$(git -C "$ROOT_DIR" rev-parse HEAD)"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "==> Dry run: would create GitHub release ${tag} at ${target}"
    return 0
  fi

  echo "==> Creating GitHub release: ${tag}"
  gh auth status >/dev/null 2>&1 || die "gh is not authenticated (run: gh auth login)"

  if gh release view "$tag" --repo "$GH_REPO" >/dev/null 2>&1; then
    die "release already exists for tag: $tag"
  fi

  gh release create "$tag" \
    --repo "$GH_REPO" \
    --target "$target" \
    --title "$tag" \
    --notes "$NOTES" \
    "$DARWIN_ARM64" \
    "$DARWIN_AMD64" \
    "$LINUX_AMD64" \
    "$LINUX_ARM64" \
    "$WINDOWS_AMD64"

  echo
  echo "Release created:"
  gh release view "$tag" --repo "$GH_REPO" --json url -q .url
}

main() {
  parse_args "$@"
  prompt_notes

  require_cmd go
  require_cmd node
  require_cmd git
  require_cmd gh

  local ver tag
  ver="$(app_version)"
  [[ "$ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version must be major.minor.patch, got: $ver"
  tag="${ver}"

  echo "Release tag: ${tag}"
  [[ "$DRY_RUN" -eq 1 ]] && echo "(dry run - nothing will be published)"
  echo

  if [[ "$DRY_RUN" -eq 1 ]]; then
    # Allow trying the script on uncommitted changes
    require_new_tag "$tag"
  else
    require_release_commit
    require_new_tag "$tag"
  fi

  run_tests
  build_server

  create_github_release "$tag"
}

main "$@"
