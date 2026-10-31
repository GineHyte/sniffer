# Shared helpers for scripts/setup.sh and scripts/demo-setup.sh. Source it; don't run it.

if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; N=$'\e[0m'; else B= G= Y= R= N=; fi
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
die()  { printf '  %s✗%s %s\n' "$R" "$N" "$*" >&2; exit 1; }
step() { printf '\n%s%s%s\n' "$B" "$*" "$N"; }

# Read KEY's value from an env file (empty if missing).
env_get() { local line; line=$(grep -E "^$2=" "$1" 2>/dev/null | tail -n1) || true; line=${line#*=}; line=${line#\"}; printf '%s' "${line%\"}"; }
# Set KEY=value in an env file without sed (values may contain any character).
env_set() {
  local file=$1 key=$2 value=$3 tmp found=0 line
  tmp=$(mktemp "$file.XXXXXX")
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ $line == "$key="* ]]; then printf '%s=%s\n' "$key" "$value"; found=1; else printf '%s\n' "$line"; fi
  done < "$file" > "$tmp"
  [ "$found" = 1 ] || printf '%s=%s\n' "$key" "$value" >> "$tmp"
  chmod --reference="$file" "$tmp" 2>/dev/null || chmod 600 "$tmp"
  mv "$tmp" "$file"
}

# Puts Node 24+ first on PATH, installing it with nvm if needed.
# Sets NODE_PATH_HINT when the default `node` is older than 24.
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
ensure_node24() {
  [ "$(node_major)" -ge 24 ] && return 0
  local nvm_node
  nvm_node=$(ls -d "$HOME"/.nvm/versions/node/v2[4-9]*/bin 2>/dev/null | sort -V | tail -n1 || true)
  if [ -z "$nvm_node" ] && [ -s "$HOME/.nvm/nvm.sh" ]; then
    warn "Node $(node_major) found; installing Node 24 with nvm"
    # shellcheck disable=SC1091
    ( set +eu; . "$HOME/.nvm/nvm.sh"; nvm install 24 >/dev/null ) || die "nvm install 24 failed"
    nvm_node=$(ls -d "$HOME"/.nvm/versions/node/v24*/bin | sort -V | tail -n1)
  fi
  [ -n "$nvm_node" ] || die "Node 24+ is required (found $(node_major)). Install it, e.g. with nvm: nvm install 24"
  export PATH="$nvm_node:$PATH"
  NODE_PATH_HINT=$nvm_node
}

node_path_hint() {
  [ -n "${NODE_PATH_HINT:-}" ] || return 0
  echo "  Note: your default 'node' is older than 24. Add Node 24 to your PATH, e.g. in fish:"
  echo "        fish_add_path -U $NODE_PATH_HINT"
}
