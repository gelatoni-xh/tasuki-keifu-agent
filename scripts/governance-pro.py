#!/usr/bin/env python3
"""Run the local governance CLI with the explicit CC Switch pro credential.

Credentials remain in the existing store and the child process environment.
This launcher never reads the currently selected Codex model or writes secrets.
"""
import json
import os
from pathlib import Path
import re
import sqlite3
import sys


def main():
    database = Path.home() / ".cc-switch/cc-switch.db"
    with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
        rows = connection.execute(
            "SELECT settings_config FROM providers WHERE app_type=? AND name=?",
            ("codex", "gpt pro"),
        ).fetchall()
    if len(rows) != 1:
        raise ValueError("Expected exactly one Codex gpt pro profile")
    profile = json.loads(rows[0][0])
    credential = profile.get("auth", {}).get("OPENAI_API_KEY")
    config = profile.get("config", "")
    base = re.search(r'^\s*base_url\s*=\s*"([^"]+)"', config, re.M)
    wire = re.search(r'^\s*wire_api\s*=\s*"([^"]+)"', config, re.M)
    if not credential or not base or not wire or wire[1] != "responses":
        raise ValueError("Pro profile requires a credential and Responses endpoint")
    if base[1].rstrip("/") != "https://xcode.best/v1":
        raise ValueError("Pro endpoint changed; inspect the provider before running")
    model = "gpt-6.1-sol"
    args = sys.argv[1:]
    if args == ["--check"]:
        print(json.dumps({
            "group": "gpt pro", "model": model,
            "endpoint": base[1].rstrip("/") + "/responses",
            "credentialConfigured": True,
            "scope": "local launcher only; no API call or database connection",
        }, ensure_ascii=False, indent=2))
        return
    if not args:
        raise ValueError("Use --check or pass governance CLI arguments")
    root = Path(__file__).resolve().parents[1]
    runtime = os.environ.copy()
    runtime.update({
        "OPENAI_API_KEY": credential,
        "OPENAI_BASE_URL": base[1].rstrip("/"),
        "GOVERNANCE_RESEARCH_MODEL": model,
    })
    os.chdir(root)
    os.execvpe("node", ["node", "--import", "tsx", "src/governance-v2/cli.ts", *args], runtime)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Never include profile contents or credentials in diagnostic output.
        sys.exit("Cannot load governance pro profile; check the local provider configuration.")
