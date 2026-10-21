#!/usr/bin/env bash
# Loads the Worker's four secrets from 1Password into Cloudflare.
# Prints names and lengths only, never values. Rerun after changing a value in 1Password.
# Usage: OP_VAULT=<vault name> scripts/set-secrets.sh
set -uo pipefail
cd "$(dirname "$0")/.."
vault=${OP_VAULT:?set OP_VAULT to the 1Password vault that holds the marketing-mcp items}

put() {
  local name=$1 v=$2
  [ -n "$v" ] || { echo "$name: empty in 1Password, skipped"; return 1; }
  printf %s "$v" | npx wrangler secret put "$name" >/dev/null 2>&1 && echo "$name set (length ${#v})" || echo "$name: wrangler secret put failed"
}

v=$(op read -n "op://$vault/marketing-mcp-confirm-hmac-key/password") && put CONFIRM_HMAC_KEY "$v" || echo "CONFIRM_HMAC_KEY: 1Password read failed"
v=$(op document get marketing-mcp-sa-key --vault "$vault") && put GOOGLE_SA_JSON "$v" || echo "GOOGLE_SA_JSON: 1Password read failed"
v=$(op read -n "op://$vault/marketing-mcp-google-oauth/username") && put GOOGLE_OAUTH_CLIENT_ID "$v" || echo "GOOGLE_OAUTH_CLIENT_ID: 1Password read failed"
v=$(op read -n "op://$vault/marketing-mcp-google-oauth/credential") && put GOOGLE_OAUTH_CLIENT_SECRET "$v" || echo "GOOGLE_OAUTH_CLIENT_SECRET: 1Password read failed"
unset v
