#!/usr/bin/env python3
"""Explicitly provision the selected pro model to the existing server env file.

Secrets travel only through SSH stdin, never argv, logs, or repository files.
This command does not start a worker or submit governance tasks.
"""
import json
from pathlib import Path
import re
import shlex
import sqlite3
import subprocess
import sys

REMOTE = r'''
import datetime,json,os,pathlib,re,shutil,sys,tempfile
try:
    values=json.load(sys.stdin)
    expected={'OPENAI_API_KEY','OPENAI_BASE_URL','GOVERNANCE_RESEARCH_MODEL','GOVERNANCE_RESEARCH_TIMEOUT_MS'}
    assert set(values)==expected
    assert values['OPENAI_BASE_URL']=='https://xcode.best/v1'
    assert values['GOVERNANCE_RESEARCH_MODEL']=='gpt-6.1-sol'
    assert all(isinstance(v,str) and not any(c in v for c in "'\n\r\x00") for v in values.values())
    target=pathlib.Path('/opt/apps/tasuki-keifu-agent/.env.governance')
    assert target.is_file() and not target.is_symlink()
    old=target.read_text()
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup=target.with_name('.env.governance.before-llm-'+stamp)
    fd=os.open(backup,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    with os.fdopen(fd,'w') as f: f.write(old)
    lines=[]
    for line in old.splitlines():
        match=re.match(r'^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=',line)
        if match and match[1] in values: continue
        lines.append(line)
    lines.extend(k+"='"+v+"'" for k,v in values.items())
    fd,name=tempfile.mkstemp(prefix='.env.governance-',dir=target.parent)
    with os.fdopen(fd,'w') as f:
        f.write('\n'.join(lines)+'\n');f.flush();os.fsync(f.fileno())
    os.chmod(name,0o600)
    stat=target.stat();os.chown(name,stat.st_uid,stat.st_gid)
    os.replace(name,target)
    print(json.dumps({'configured':True,'model':values['GOVERNANCE_RESEARCH_MODEL'],
        'endpoint':values['OPENAI_BASE_URL']+'/responses','group':'gpt pro',
        'timeoutMs':int(values['GOVERNANCE_RESEARCH_TIMEOUT_MS']),
        'envFile':str(target),'protectedBackup':str(backup),'workerStarted':False}))
except Exception:
    sys.exit('Failed to configure governance LLM; credential details omitted')
'''


def main():
    if sys.argv[1:] != ["--apply"]:
        sys.exit("Usage: python3 scripts/configure-governance-model.py --apply")
    with sqlite3.connect(f"file:{Path.home()}/.cc-switch/cc-switch.db?mode=ro", uri=True) as db:
        rows = db.execute("SELECT settings_config FROM providers WHERE app_type=? AND name=?", ("codex", "gpt pro")).fetchall()
    if len(rows) != 1:
        raise ValueError("Expected one pro profile")
    profile = json.loads(rows[0][0])
    base = re.search(r'^\s*base_url\s*=\s*"([^"]+)"', profile.get("config", ""), re.M)
    if not base or base[1].rstrip("/") != "https://xcode.best/v1":
        raise ValueError("Unexpected pro endpoint")
    values = {
        "OPENAI_API_KEY": profile["auth"]["OPENAI_API_KEY"],
        "OPENAI_BASE_URL": base[1].rstrip("/"),
        "GOVERNANCE_RESEARCH_MODEL": "gpt-6.1-sol",
        "GOVERNANCE_RESEARCH_TIMEOUT_MS": "120000",
    }
    ssh = Path.home() / ".codex/skills/server-resource-bridge/scripts/ssh-incubator"
    result = subprocess.run([str(ssh), "--", "sudo python3 -c " + shlex.quote(REMOTE)],
                            input=json.dumps(values), text=True, capture_output=True, timeout=60)
    if result.returncode:
        sys.exit("Remote model configuration failed; details omitted")
    print(result.stdout.strip())


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.exit("Cannot provision pro configuration; secret details omitted")
