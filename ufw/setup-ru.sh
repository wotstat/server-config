#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <OTHER_RU_IP>" >&2
  exit 2
fi

# Validate before changing any firewall rule. Python is also used by configure-ru.py.
ru_peer_ip=$(python3 - "$1" <<'PY'
import ipaddress
import sys

try:
    peer = ipaddress.ip_address(sys.argv[1])
    if peer.is_unspecified or peer.is_multicast or "%" in str(peer):
        raise ValueError()
except ValueError:
    sys.exit("OTHER_RU_IP must be a unicast IPv4 or IPv6 address without a scope ID")
print(peer)
PY
)

# Allow the existing SSH port before enabling the firewall. No reset: preserve other rules.
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow in proto tcp from "$ru_peer_ip" to any port 18443 comment 'RU peer HTTPS relay'
ufw allow in proto tcp from "$ru_peer_ip" to any port 18080 comment 'RU peer HTTP relay'

ufw default deny incoming
ufw default allow outgoing
ufw default deny routed
ufw logging low
ufw app default skip
ufw enable
ufw status verbose
