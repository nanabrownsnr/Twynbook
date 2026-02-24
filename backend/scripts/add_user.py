#!/usr/bin/env python3
"""One-off: add a user to users.json (same format as signup). Usage: python add_user.py"""
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

import bcrypt

DATA_DIR = Path(os.environ.get("DATA_DIR", str(Path(__file__).resolve().parent.parent.parent / "data")))
USERS_FILE = DATA_DIR / "users.json"


def main():
    email = "n.brown@4th-ir.com"
    password = "Laptop@123"
    name = "Nana Brown"

    users = json.load(open(USERS_FILE)) if USERS_FILE.exists() else []
    if any(u.get("email", "").lower() == email.lower() for u in users):
        print(f"User {email} already exists.")
        return

    user_id = uuid.uuid4().hex
    password_hash = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
    user = {
        "id": user_id,
        "email": email.lower(),
        "name": name,
        "password_hash": password_hash,
        "is_admin": True,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    users.append(user)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(USERS_FILE, "w") as f:
        json.dump(users, f, indent=2)
    print(f"Added user: {email} (id={user_id})")


if __name__ == "__main__":
    main()
