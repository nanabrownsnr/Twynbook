#!/usr/bin/env python3
"""
Recreate ditto-streaming-api from the existing container, pinning one GPU index.

Preserves ports, volumes, env (with NVIDIA_VISIBLE_DEVICES overridden), network.

Usage:
  python3 scripts/recreate-ditto-streaming-gpu.py 2
"""
from __future__ import annotations

import json
import shlex
import subprocess
import sys


def main() -> int:
    if len(sys.argv) != 2 or not sys.argv[1].isdigit():
        print("Usage: recreate-ditto-streaming-gpu.py <gpu_index>", file=sys.stderr)
        return 2
    gpu = sys.argv[1]
    name = "ditto-streaming-api"
    raw = subprocess.check_output(["docker", "inspect", name], text=True)
    data = json.loads(raw)[0]
    cfg = data["Config"]
    host = data["HostConfig"]

    image = cfg.get("Image", "")
    if not image:
        print("inspect: missing image", file=sys.stderr)
        return 1

    restart = (host.get("RestartPolicy") or {}).get("Name") or "unless-stopped"
    if restart == "no":
        restart = "unless-stopped"

    cmd: list[str] = [
        "docker",
        "run",
        "-d",
        "--name",
        name,
        "--restart",
        restart,
        "--runtime",
        host.get("Runtime") or "nvidia",
        "--gpus",
        f"device={gpu}",
    ]

    nets = data.get("NetworkSettings", {}).get("Networks") or {}
    if "streaming_default" in nets:
        cmd += ["--network", "streaming_default", "--network-alias", "ditto-service"]

    for container_port, bindings in (host.get("PortBindings") or {}).items():
        cport, proto = (container_port.split("/") + ["tcp"])[:2]
        for b in bindings or []:
            hport = b.get("HostPort") or cport
            cmd += ["-p", f"{hport}:{cport}/{proto}"]

    for m in host.get("Binds") or []:
        cmd += ["-v", m]

    for e in cfg.get("Env") or []:
        if e.startswith("NVIDIA_VISIBLE_DEVICES="):
            cmd += ["-e", f"NVIDIA_VISIBLE_DEVICES={gpu}"]
        else:
            cmd += ["-e", e]

    if cfg.get("WorkingDir"):
        cmd += ["-w", cfg["WorkingDir"]]
    if cfg.get("User"):
        cmd += ["-u", cfg["User"]]

    ep = cfg.get("Entrypoint")
    if isinstance(ep, list) and ep:
        cmd += ["--entrypoint", ep[0]]
    elif isinstance(ep, str) and ep:
        cmd += ["--entrypoint", ep]

    cmd.append(image)
    cmd.extend(cfg.get("Cmd") or [])

    rm = subprocess.run(["docker", "rm", "-f", name], capture_output=True, text=True)
    if rm.returncode != 0 and rm.stderr:
        print(rm.stderr, file=sys.stderr)
    if subprocess.run(["docker", "inspect", name], capture_output=True).returncode == 0:
        print(
            "Old container still exists after docker rm -f. "
            "Restart the Docker daemon (or host), then re-run this script, "
            "or apply docker-compose.ditto-streaming.gpu2.override.yml from the streaming stack directory.",
            file=sys.stderr,
        )
        return 1

    print("Running:", shlex.join(cmd))
    return subprocess.run(cmd).returncode


if __name__ == "__main__":
    raise SystemExit(main())
