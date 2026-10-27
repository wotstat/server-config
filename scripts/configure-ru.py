#!/usr/bin/env python3
"""Render the shared RU nginx transport using only main and peer IP addresses."""

import argparse
import ipaddress
import os
from pathlib import Path
from string import Template
import tempfile


SOURCE = Path(__file__).resolve().parents[1] / "etc/nginx-ru"
TEMPLATES = (
    "conf.d/main-upstreams.conf",
    "stream-conf.d/main-relay.conf",
)


def address(value):
    try:
        ip = ipaddress.ip_address(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("expected an IPv4 or IPv6 address") from error
    if ip.is_unspecified or ip.is_multicast or "%" in str(ip):
        raise argparse.ArgumentTypeError("expected a unicast IP without a scope ID")
    return ip


def endpoint(ip, port):
    host = f"[{ip}]" if ip.version == 6 else str(ip)
    return f"{host}:{port}"


def render(main, peer):
    if main == peer:
        raise ValueError("main and peer must have different IP addresses")
    values = {
        "MAIN_HTTPS": endpoint(main, 443),
        "MAIN_HTTP": endpoint(main, 80),
        "PEER_HTTPS": endpoint(peer, 18443),
        "PEER_HTTP": endpoint(peer, 18080),
        "PEER_IP": str(peer),
    }
    return {
        path: Template((SOURCE / (path + ".template")).read_text()).substitute(values)
        for path in TEMPLATES
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--main-ip", required=True, type=address)
    parser.add_argument("--peer-ip", required=True, type=address)
    parser.add_argument("--output-dir", type=Path, default=Path("/etc/nginx"))
    args = parser.parse_args()
    try:
        configs = render(args.main_ip, args.peer_ip)
    except ValueError as error:
        parser.error(str(error))

    # Complete rendering/validation before touching the destination. Nginx keeps
    # its old in-memory configuration until the operator runs nginx -t + reload.
    for relative, content in configs.items():
        target = args.output_dir / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", dir=target.parent, delete=False) as output:
                temporary = Path(output.name)
                output.write(content)
            temporary.chmod(0o644)
            os.replace(temporary, target)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        print(target)
    print("Rendered. Install the shared snippets/sites, enable stream {}, then run nginx -t before reloading.")


if __name__ == "__main__":
    main()
