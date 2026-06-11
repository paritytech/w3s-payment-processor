#!/usr/bin/env bash
#
# deploy.sh - Build and deploy the W3sPay Payment Processor SPA as a .dot product.
#
# Usage:
#   ./deploy.sh [name-or-domain]
#
# Domain resolution (highest priority first):
#   1. VITE_DOTNS_PRODUCT_DOMAIN env var — preferred; shared with src/config.ts
#      so a single value drives BOTH the deploy target AND the v2 host product
#      account resolved at runtime.
#   2. DOTNS_PRODUCT_DOMAIN env var      — legacy alias for CI configs that
#      have not yet migrated to the VITE_-prefixed name.
#   3. $1 positional arg                 — local override, e.g. `./deploy.sh staging.dot`.
# The resolved value MUST end in `.dot`. If both env and arg are set they MUST
# match, or the script aborts (silent overrides have caused staging/prod swaps).
# When none of the above are set, the script aborts — there is NO default
# domain. A hardcoded fallback would publish the SPA to the wrong chain
# identity on the first deploy of a staging/fork/merchant-pilot instance.
#
# Required env:
#   - MNEMONIC or DOTNS_MNEMONIC
#
# Optional env:
#   - VITE_DOTNS_PRODUCT_DOMAIN  Target `.dot` name. REQUIRED — no default.
#   - DOTNS_PRODUCT_DOMAIN      Legacy alias; read only if VITE_DOTNS_PRODUCT_DOMAIN
#                               is unset.
#   - DOTNS_GATEWAY_BASE        Final gateway host suffix (default: dot.li).
#   - BULLETIN_ENV              bulletin-deploy --env id (default: paseo-next-v2).
#                               Coinage + Paseo People Next live in v2; do not
#                               change unless both the host network AND the
#                               coinage runtime are present in the chosen env.
#   - VITE_NETWORK              App chain key. Defaults to BULLETIN_ENV and
#                               MUST match it.
#   - BULLETIN_DEPLOY_PUBLISH   Set to `true` to pass --publish to bulletin-deploy,
#                               listing the .dot in the on-chain Publisher registry
#                               (paseo-next-v2 only). Default: false (upload only).
#
set -euo pipefail

# Load Vite-style .env so `./deploy.sh` works the same way as `vite dev`/
# `vite build`: variables declared in .env (and .env.local, which overrides)
# are exported into the shell so a deploy resolves VITE_DOTNS_PRODUCT_DOMAIN
# the same way the SPA does at build time. Two distinct precedence rules:
#   .env       — only set vars that are NOT already in the parent shell, so
#                an explicit `VITE_DOTNS_PRODUCT_DOMAIN=foo ./deploy.sh`
#                (CI / one-off) wins over the shared repo default.
#   .env.local — always overwrites; gitignored per-developer override that
#                wins over .env (matches Vite's own precedence).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
_load_env() {
  local file="$1" force="$2"
  [[ -f "$file" ]] || return 0
  while IFS='=' read -r key val; do
    # skip blank lines and comments
    key="${key#"${key%%[![:space:]]*}"}"   # ltrim
    key="${key%"${key##*[![:space:]]}"}"   # rtrim
    [[ -z "$key" || "$key" == \#* ]] && continue
    # ignore non-identifier keys (must start with letter/underscore)
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    # strip trailing CR (Windows-edited files) + outer whitespace + outer quotes
    val="${val%$'\r'}"
    val="${val#"${val%%[![:space:]]*}"}"
    val="${val%"${val##*[![:space:]]}"}"
    val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
    if [[ "$force" == "1" || -z "${!key:-}" ]]; then
      export "$key=$val"
    fi
  done < <(grep -v '^[[:space:]]*#' "$file" | grep -v '^[[:space:]]*$' || true)
}
_load_env "$SCRIPT_DIR/.env" 0
_load_env "$SCRIPT_DIR/.env.local" 1
BUILD_DIR="$SCRIPT_DIR/dist"
GATEWAY_BASE="${DOTNS_GATEWAY_BASE:-dot.li}"
BULLETIN_ENV="${BULLETIN_ENV:-paseo-next-v2}"
BULLETIN_DEPLOY_PUBLISH="${BULLETIN_DEPLOY_PUBLISH:-false}"
MIN_BULLETIN_DEPLOY_VERSION="0.10.0"
_arg_domain="${1:-}"
# Prefer VITE_-prefixed name (shared with src/config.ts); fall back to legacy.
# This is the SINGLE source of truth: the resolved value is exported as
# VITE_DOTNS_PRODUCT_DOMAIN, passed positionally to `bulletin-deploy` as the
# target domain, AND baked into the SPA at build time via Vite.
_domain_env="${VITE_DOTNS_PRODUCT_DOMAIN:-${DOTNS_PRODUCT_DOMAIN:-}}"
if [[ -n "$_arg_domain" && -n "$_domain_env" && "$_arg_domain" != "$_domain_env" ]]; then
  echo "Error: VITE_DOTNS_PRODUCT_DOMAIN=\"$_domain_env\" and arg \"$_arg_domain\" disagree. Unset one."
  exit 1
fi
VITE_DOTNS_PRODUCT_DOMAIN="${_domain_env:-${_arg_domain:-}}"
if [[ -z "$VITE_DOTNS_PRODUCT_DOMAIN" ]]; then
  echo "Error: VITE_DOTNS_PRODUCT_DOMAIN (or legacy DOTNS_PRODUCT_DOMAIN) is not set, and no positional arg was given."
  echo "Set the target .dot name in your env, in .env, or pass it as \$1, e.g. ./deploy.sh myproduct.dot"
  exit 1
fi
if [[ "$VITE_DOTNS_PRODUCT_DOMAIN" != *.dot ]]; then
  VITE_DOTNS_PRODUCT_DOMAIN="${VITE_DOTNS_PRODUCT_DOMAIN}.dot"
fi
# Legacy alias kept exported for downstream tooling that reads the un-prefixed name.
export DOTNS_PRODUCT_DOMAIN="$VITE_DOTNS_PRODUCT_DOMAIN"
export VITE_DOTNS_PRODUCT_DOMAIN

version_gte() {
  local current="$1"
  local minimum="$2"
  local current_major current_minor current_patch
  local minimum_major minimum_minor minimum_patch

  IFS=. read -r current_major current_minor current_patch <<<"$current"
  IFS=. read -r minimum_major minimum_minor minimum_patch <<<"$minimum"

  [[ "$current_major" =~ ^[0-9]+$ ]] || return 1
  [[ "$current_minor" =~ ^[0-9]+$ ]] || return 1
  [[ "$current_patch" =~ ^[0-9]+$ ]] || return 1

  if (( current_major != minimum_major )); then
    (( current_major > minimum_major ))
    return
  fi
  if (( current_minor != minimum_minor )); then
    (( current_minor > minimum_minor ))
    return
  fi
  (( current_patch >= minimum_patch ))
}

if ! command -v bulletin-deploy >/dev/null 2>&1; then
  echo "Error: bulletin-deploy is required for current DotNS deployments."
  echo ""
  echo "Install it first:"
  echo "  npm install -g bulletin-deploy@latest"
  exit 1
fi

BULLETIN_DEPLOY_VERSION="$(bulletin-deploy --version | sed -E 's/.*v?([0-9]+[.][0-9]+[.][0-9]+).*/\1/')"
if ! version_gte "$BULLETIN_DEPLOY_VERSION" "$MIN_BULLETIN_DEPLOY_VERSION"; then
  echo "Error: bulletin-deploy ${MIN_BULLETIN_DEPLOY_VERSION} or newer is required for Paseo deployments."
  echo "Found: ${BULLETIN_DEPLOY_VERSION:-unknown}"
  echo ""
  echo "Update it first:"
  echo "  npm install -g bulletin-deploy@latest"
  exit 1
fi

# Resolve the deploying mnemonic. Sources in priority order:
#   1. Shell env vars (MNEMONIC or DOTNS_MNEMONIC) — highest priority
#   2. .env files in Vite precedence order:
#        .env.production.local -> .env.production -> .env.local -> .env
# Store the mnemonic in .env.local (gitignored), never in .env.

_read_envfile_key() {
  local file="$1" key="$2" line value
  line="$( (grep -E "^${key}=" "$file" || true) | tail -n 1)"
  [[ -n "$line" ]] || return 1
  value="${line#"${key}="}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  if [[ "$value" == \"*\" ]]; then value="${value#\"}"; value="${value%\"}"; fi
  if [[ "$value" == \'*\' ]]; then value="${value#\'}"; value="${value%\'}"; fi
  value="$(printf '%s' "$value" | tr -s '[:space:]' ' ' | sed -E 's/^ //; s/ $//')"
  [[ -n "$value" ]] && printf '%s' "$value" || return 1
}

_dotns_norm="$(printf '%s' "${DOTNS_MNEMONIC:-}" | tr -s '[:space:]' ' ' | sed -E 's/^ //; s/ $//')"
_mnem_norm="$(printf '%s' "${MNEMONIC:-}" | tr -s '[:space:]' ' ' | sed -E 's/^ //; s/ $//')"

if [[ -n "$_dotns_norm" && -n "$_mnem_norm" && "$_dotns_norm" != "$_mnem_norm" ]]; then
  echo "Error: DOTNS_MNEMONIC and MNEMONIC are both set but differ. Unset one."
  exit 1
fi

RAW_MNEMONIC="${_dotns_norm:-$_mnem_norm}"

if [[ -z "$RAW_MNEMONIC" ]]; then
  for _envfile in .env.production.local .env.production .env.local .env; do
    [[ -f "$SCRIPT_DIR/$_envfile" ]] || continue
    _f_dotns="$(_read_envfile_key "$SCRIPT_DIR/$_envfile" DOTNS_MNEMONIC || true)"
    _f_mnem="$(_read_envfile_key "$SCRIPT_DIR/$_envfile" MNEMONIC || true)"
    if [[ -n "$_f_dotns" && -n "$_f_mnem" && "$_f_dotns" != "$_f_mnem" ]]; then
      echo "Error: $_envfile sets both DOTNS_MNEMONIC and MNEMONIC to different values."
      exit 1
    fi
    RAW_MNEMONIC="${_f_dotns:-$_f_mnem}"
    if [[ -n "$RAW_MNEMONIC" ]]; then
      echo "==> Using mnemonic from ${_envfile}."
      break
    fi
  done
fi

if [[ -z "$RAW_MNEMONIC" ]]; then
  echo "Error: no mnemonic found. Provide one via:"
  echo "  export MNEMONIC=\"your twelve word mnemonic phrase here\""
  echo "  or add MNEMONIC=... to .env.local (gitignored)."
  exit 1
fi

WORD_COUNT="$(printf '%s' "$RAW_MNEMONIC" | awk '{print NF}')"
if [[ "$WORD_COUNT" != "12" && "$WORD_COUNT" != "24" ]]; then
  echo "Error: mnemonic has $WORD_COUNT words; expected 12 or 24."
  exit 1
fi

export MNEMONIC="$RAW_MNEMONIC"
export DOTNS_MNEMONIC="$RAW_MNEMONIC"

# Resolve VITE_W3SPAY_REGISTRY_ADDRESS so it's logged + baked deterministically.
# Empty here is allowed (src/config.ts carries the network default); the
# `validate-config` preflight surfaces it as a warning. When set, sanity-check
# the H160 shape so a malformed value never silently ships.
VITE_W3SPAY_REGISTRY_ADDRESS="${VITE_W3SPAY_REGISTRY_ADDRESS:-}"
if [[ -n "$VITE_W3SPAY_REGISTRY_ADDRESS" ]]; then
  if [[ ! "$VITE_W3SPAY_REGISTRY_ADDRESS" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
    echo "Error: VITE_W3SPAY_REGISTRY_ADDRESS=\"$VITE_W3SPAY_REGISTRY_ADDRESS\" is not a 0x-prefixed 20-byte H160." >&2
    exit 1
  fi
  export VITE_W3SPAY_REGISTRY_ADDRESS
fi
export VITE_NETWORK="${VITE_NETWORK:-$BULLETIN_ENV}"

case "$VITE_NETWORK" in
  paseo|paseo-next-v2|previewnet) ;;
  *)
    echo "Error: VITE_NETWORK=\"$VITE_NETWORK\" is not supported."
    echo "Expected one of: paseo, paseo-next-v2, previewnet."
    exit 1
    ;;
esac
if [[ "$VITE_NETWORK" != "$BULLETIN_ENV" ]]; then
  echo "Error: VITE_NETWORK=\"$VITE_NETWORK\" must match BULLETIN_ENV=\"$BULLETIN_ENV\"."
  exit 1
fi

# Echo every VITE_* var the build will see — these get baked into the SPA.
# `npm run build` inherits the script's environment and Vite picks up
# `process.env.VITE_*` ahead of any matching `.env`/`.env.local` entry, so
# what you see here is what ships.
echo "==> VITE_* env baked into this build:"
_logged=0
while IFS= read -r _name; do
  [[ -n "$_name" ]] || continue
  _logged=1
  printf '    %s=%s\n' "$_name" "${!_name}"
done < <(compgen -v | grep -E '^VITE_' | sort)
if [[ "$_logged" == "0" ]]; then
  echo "    (none — every VITE_* var resolves to its src/config.ts default)"
fi

# Static config preflight. Validates ONLY the build-time chain/token/host env
# wiring in src/config.ts — NOT merchant PEMs. The per-merchant credential
# bundle is never bundled into the SPA: it is fetched + AES-GCM-decrypted at
# unlock time. Per-merchant configs are published from the w3spay-admin app
# (encrypted, on Bulletin, CID recorded on the registry) — nothing to provision here.
CONFIG_FILE="$SCRIPT_DIR/src/config.ts"
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Error: $CONFIG_FILE is required (the static chain/token/host config)."
  exit 1
fi
echo "==> Validating static config (chain/token/host env; NOT merchant PEMs)..."
if ! npm --prefix "$SCRIPT_DIR" run validate-config; then
  echo "Error: static config failed validation (see the message above)."
  exit 1
fi
echo "==> Using network: ${VITE_NETWORK}"
echo "==> Building W3sPay Payment Processor SPA..."
npm --prefix "$SCRIPT_DIR" run build

echo "==> Copying dot.li manifest (rewriting id=${VITE_DOTNS_PRODUCT_DOMAIN})..."
_id="${VITE_DOTNS_PRODUCT_DOMAIN%.dot}"
sed -E "s|^id = \".*\"$|id = \"${_id}.dot\"|" "$SCRIPT_DIR/bundle/manifest.toml" > "$BUILD_DIR/manifest.toml"

if [[ ! -f "$BUILD_DIR/manifest.toml" ]]; then
  echo "Error: manifest.toml was not copied into the build output."
  exit 1
fi
echo ""
echo "==> Publish to Browse: ${BULLETIN_DEPLOY_PUBLISH}"
if [[ "$BULLETIN_DEPLOY_PUBLISH" == "true" ]]; then
  bulletin-deploy --publish --env "$BULLETIN_ENV" --mnemonic "$RAW_MNEMONIC" "$BUILD_DIR" "$VITE_DOTNS_PRODUCT_DOMAIN"
else
  bulletin-deploy --env "$BULLETIN_ENV" --mnemonic "$RAW_MNEMONIC" "$BUILD_DIR" "$VITE_DOTNS_PRODUCT_DOMAIN"
fi
NAME="${VITE_DOTNS_PRODUCT_DOMAIN%.dot}"
echo ""
echo "==> Done! Live at:"
echo "    https://${NAME}.${GATEWAY_BASE}"