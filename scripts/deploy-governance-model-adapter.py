#!/usr/bin/env python3
"""Deploy only research.ts over the existing image; never a dirty whole checkout.

Requires an already configured .env.governance and an empty governance task queue.
Keeps a Compose backup and immutable pre-change image for rollback. No model calls.
"""
import hashlib
from pathlib import Path
import shlex
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
source = (root / 'src/governance-v2/research.ts').read_bytes()
digest = hashlib.sha256(source).hexdigest()
folder = '/opt/apps/tasuki-keifu-agent/model-adapter-' + digest[:12]
image = 'tasuki-keifu-agent:llm-pro-' + digest[:12]
ssh = str(Path.home() / '.codex/skills/server-resource-bridge/scripts/ssh-incubator')
if sys.argv[1:] != ['--apply']:
    sys.exit('Usage: python3 scripts/deploy-governance-model-adapter.py --apply')
subprocess.run([ssh, '--', f'mkdir -p {shlex.quote(folder)} && cat > {shlex.quote(folder + "/research.ts")}'], input=source, check=True)
remote = r'''
set -eu
cd /opt/apps/tasuki-keifu-agent
printf '%s  %s\n' __HASH__ __FOLDER__/research.ts | sha256sum -c -
base=$(sudo docker inspect tasuki-keifu-governance-worker --format '{{.Image}}')
if ! sudo docker image inspect tasuki-keifu-agent:before-llm-__SHORT__ >/dev/null 2>&1; then
  sudo docker tag "$base" tasuki-keifu-agent:before-llm-__SHORT__
fi
# Refuse to enable a worker if it could consume any existing experiment.
sudo docker run --rm -i --network tasuki-keifu_default --env-file .env.governance --entrypoint node "$base" --input-type=module <<'JS'
import pg from 'pg';
const db=new pg.Client({connectionString:process.env.GOVERNANCE_DATABASE_URL});
await db.connect();
try {
 const {rows}=await db.query('SELECT count(*) AS n FROM governance."EventImportTask"');
 if(Number(rows[0].n)!==0) throw new Error('Refusing deployment with existing tasks');
 console.log('Queue empty; safe to enable idle worker');
}finally{await db.end();}
JS
printf 'FROM %s\nCOPY research.ts /app/src/governance-v2/research.ts\n' tasuki-keifu-agent:before-llm-__SHORT__ > __FOLDER__/Dockerfile
sudo docker build -t __IMAGE__ __FOLDER__
sudo python3 - <<'PYREMOTE'
from pathlib import Path
import datetime,re,shutil
p=Path('docker-compose.prod.yml')
s=p.read_text()
a=s.index('  governance-worker:')
b=s.index('  governance-mail:',a)
section=s[a:b]
section,n=re.subn(r'(?m)^    image: .+$','    image: __IMAGE__',section)
assert n==1
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
shutil.copy2(p,str(p)+'.before-llm-'+stamp)
p.write_text(s[:a]+section+s[b:])
PYREMOTE
sudo docker compose -f docker-compose.prod.yml --env-file .env.governance up -d --no-deps governance-worker
sudo docker exec tasuki-keifu-governance-worker sha256sum /app/src/governance-v2/research.ts
'''
for key,value in {'__HASH__':digest,'__SHORT__':digest[:12],'__FOLDER__':folder,'__IMAGE__':image}.items():
    remote = remote.replace(key,value)
subprocess.run([ssh,'--','sh -c '+shlex.quote(remote)],check=True)
print('Deployed worker adapter image: '+image)
