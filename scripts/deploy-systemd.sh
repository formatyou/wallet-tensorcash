#!/usr/bin/env bash
set -euo pipefail

# Activate an already assembled release; configuration and Core data stay outside it.
wallet_requested=${1:?Usage: deploy-systemd.sh /opt/tensorcash-wallet/releases/RELEASE_ID}
if [[ $EUID -ne 0 ]]; then printf '%s\n' 'Run as root to switch the system service release.' >&2; exit 1; fi
wallet_release=$(realpath -e -- "$wallet_requested")
case "$wallet_release" in
  /opt/tensorcash-wallet/releases/*) ;;
  *) printf '%s\n' 'Release must be a physical directory under /opt/tensorcash-wallet/releases.' >&2; exit 1 ;;
esac
test -d "$wallet_release"
test -f "$wallet_release/dist/build.json"
test -f "$wallet_release/scripts/verify-build.mjs"
test -d "$wallet_release/node_modules/tsx"
# NODE must name the Node.js 24+ executable if it is not on PATH.
wallet_node=${NODE:-node}
"$wallet_node" "$wallet_release/scripts/verify-build.mjs" "$wallet_release"
systemctl cat tensorcash-wallet.service >/dev/null
test -f /etc/tensorcash-wallet.env
wallet_previous=
if test -L /opt/tensorcash-wallet/current; then
  wallet_previous=$(realpath -e /opt/tensorcash-wallet/current)
elif test -e /opt/tensorcash-wallet/current; then
  printf '%s\n' 'Existing current path must be a symlink.' >&2
  exit 1
fi
wallet_next="/opt/tensorcash-wallet/current.next.$$"
ln -s -- "$wallet_release" "$wallet_next"
mv -Tf -- "$wallet_next" /opt/tensorcash-wallet/current
wallet_rollback() {
  if [[ -n $wallet_previous ]]; then
    ln -s -- "$wallet_previous" "$wallet_next"
    mv -Tf -- "$wallet_next" /opt/tensorcash-wallet/current
    systemctl restart tensorcash-wallet.service || true
    printf '%s\n' 'Activation failed; previous release restored.' >&2
  else
    printf '%s\n' 'Activation failed; there was no previous release.' >&2
  fi
}
trap wallet_rollback ERR
systemctl restart tensorcash-wallet.service
"$wallet_node" "$wallet_release/scripts/check-activation.mjs" "$wallet_release"
systemctl is-active --quiet tensorcash-wallet.service
trap - ERR
printf 'Activated verified wallet release %s\n' "$wallet_release"
