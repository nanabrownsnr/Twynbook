#!/usr/bin/env python3
"""
Remove or fix TwynBook personas that reference a Ditto image_id whose preview
no longer exists (404). Uses same DATA_DIR and DITTO_API_URL as main.py.

Usage (from repo root or backend/):
  python backend/scripts/cleanup_personas.py [--dry-run] [--clear]
  Set DITTO_API_URL if Ditto is not at http://localhost:8080.

  --dry-run   Only print what would be removed/cleared.
  --clear     Clear image_id/preview_url for broken personas (keep persona).
              Default: remove broken personas from the list entirely.
"""
import argparse
import json
import os
import sys
from pathlib import Path

# Repo layout: backend/scripts/cleanup_personas.py, data/personas.json at repo root
BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = BACKEND_DIR.parent
sys.path.insert(0, str(BACKEND_DIR))

DATA_DIR = Path(os.environ.get("DATA_DIR", str(REPO_ROOT / "data")))
PERSONAS_FILE = DATA_DIR / "personas.json"
DITTO_API_URL = (os.environ.get("DITTO_API_URL", "http://localhost:8080")).rstrip("/")


def load_personas() -> list[dict]:
    if not PERSONAS_FILE.exists():
        return []
    with open(PERSONAS_FILE, "r") as f:
        return json.load(f)


def save_personas(personas: list[dict]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(PERSONAS_FILE, "w") as f:
        json.dump(personas, f, indent=2)


def ditto_preview_exists(image_id: str) -> bool:
    import httpx
    url = f"{DITTO_API_URL}/personas/{image_id}/preview"
    try:
        with httpx.Client(timeout=10.0) as client:
            r = client.head(url)  # or get; head is cheaper
            return r.status_code == 200
    except Exception:
        return False


def main():
    parser = argparse.ArgumentParser(
        description="Clean TwynBook personas whose Ditto preview is missing (404)"
    )
    parser.add_argument("--dry-run", action="store_true", help="Only print, do not change file")
    parser.add_argument(
        "--clear",
        action="store_true",
        help="Clear image_id/preview_url for broken personas instead of removing them",
    )
    args = parser.parse_args()

    personas = load_personas()
    if not personas:
        print("No personas in store.")
        return

    broken = []
    for p in personas:
        image_id = p.get("image_id")
        if not image_id:
            continue
        if not ditto_preview_exists(image_id):
            broken.append(p)

    if not broken:
        print("No personas with missing Ditto preview.")
        return

    print(f"Found {len(broken)} persona(s) with missing Ditto preview:")
    for p in broken:
        print(f"  id={p.get('id')}  name={p.get('name')!r}  image_id={p.get('image_id')}")

    if args.dry_run:
        if args.clear:
            print("(Dry run: would clear image_id/preview_url for these personas)")
        else:
            print("(Dry run: would remove these personas from the list)")
        return

    if args.clear:
        for p in personas:
            if p in broken:
                p["image_id"] = None
                p["preview_url"] = None
        save_personas(personas)
        print("Cleared image_id and preview_url for the listed personas.")
    else:
        keep = [p for p in personas if p not in broken]
        save_personas(keep)
        print(f"Removed {len(broken)} persona(s) from the list.")


if __name__ == "__main__":
    main()
