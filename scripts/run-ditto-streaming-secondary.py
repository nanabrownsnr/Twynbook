#!/usr/bin/env python3
"""
Start a second Ditto streaming container (same image/env/volume as an existing one),
with a new name, host port, and GPU pin — without removing the template container.

Default: name ditto-streaming-api-2, host port 8051, GPU 2, clone from ditto-streaming-api.

Usage:
  python3 scripts/run-ditto-streaming-secondary.py
  python3 scripts/run-ditto-streaming-secondary.py --name ditto-streaming-api-2 --port 8051 --gpu 2 \\
      --template ditto-streaming-api
"""
from __future__ import annotations

import argparse
import json
import shlex
import subprocess
import sys


def build_run_cmd(
    *,
    template: str,
    new_name: str,
    host_port: int,
    gpu: str,
) -> list[str]:
    raw = subprocess.check_output(["docker", "inspect", template], text=True)
    data = json.loads(raw)[0]
    cfg = data["Config"]
    host = data["HostConfig"]

    image = cfg.get("Image", "")
    if not image:
        raise SystemExit(f"inspect {template}: missing image")

    restart = (host.get("RestartPolicy") or {}).get("Name") or "unless-stopped"
    if restart == "no":
        restart = "unless-stopped"

    cmd: list[str] = [
        "docker",
        "run",
        "-d",
        "--name",
        new_name,
        "--restart",
        restart,
        "--runtime",
        host.get("Runtime") or "nvidia",
        "--gpus",
        f"device={gpu}",
        "-p",
        f"{host_port}:8050/tcp",
    ]

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
    return cmd


def main() -> int:
    p = argparse.ArgumentParser(description="Run a second Ditto container on another host port + GPU.")
    p.add_argument("--template", default="ditto-streaming-api", help="Existing container to clone settings from")
    p.add_argument("--name", default="ditto-streaming-api-2", help="New container name")
    p.add_argument("--port", type=int, default=8051, help="Host port mapped to container 8050")
    p.add_argument("--gpu", default="2", help="GPU index (NVIDIA_VISIBLE_DEVICES and --gpus device=)")
    args = p.parse_args()

    if subprocess.run(["docker", "inspect", args.template], capture_output=True).returncode != 0:
        print(f"Template container {args.template!r} not found.", file=sys.stderr)
        return 1

    subprocess.run(["docker", "rm", "-f", args.name], capture_output=True)

    try:
        cmd = build_run_cmd(
            template=args.template,
            new_name=args.name,
            host_port=args.port,
            gpu=str(args.gpu),
        )
    except SystemExit as e:
        print(e.args[0], file=sys.stderr)
        return 1

    print("Running:", shlex.join(cmd))
    return subprocess.run(cmd).returncode


if __name__ == "__main__":
    raise SystemExit(main())
