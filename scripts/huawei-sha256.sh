#!/usr/bin/env bash
# Print the SHA-256 fingerprint Huawei AppGallery Connect needs.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
ks="$root/frontend/android/app/gemak-debug.keystore"
if [[ ! -f "$ks" ]]; then
  echo "No keystore at $ks" >&2
  echo "Create it (same as CI) or pass a path:" >&2
  echo "  $0 /path/to/your.keystore [alias] [storepass]" >&2
  exit 1
fi
keystore="${1:-$ks}"
alias="${2:-gemak}"
pass="${3:-gemakdebug}"
keytool -list -v -keystore "$keystore" -alias "$alias" -storepass "$pass" \
  | grep -i "SHA256:"
