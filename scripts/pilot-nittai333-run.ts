import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { createGovernancePool, GovernanceDB } from '../src/governance-v2/database.js';
import { DirectoryPayloadStore } from '../src/governance-v2/storage.js';
import { EventRunner } from '../src/governance-v2/runner.js';
const root='/Users/xuhuan/workspace_new/document/333回增量治理准备';
const ssh='/Users/xuhuan/.codex/skills/server-resource-bridge/scripts/ssh-incubator';
const env=JSON.parse(execFileSync(ssh,['--',`sudo docker inspect --format '{{json .Config.Env}}' tasuki-keifu-governance-worker`],{encoding:'utf8'})).reduce((a:Record<string,string>,line:string)=>{const i=line.indexOf('=');a[line.slice(0,i)]=line.slice(i+1);return a},{});
function url(s:string){const u=new URL(s);u.hostname='127.0.0.1';u.port='15433';return u.toString()}
if(!env.GOVERNANCE_DATABASE_URL||!env.GOVERNANCE_READ_DATABASE_URL)throw Error('Runtime and readonly roles required');
const pool=createGovernancePool(url(env.GOVERNANCE_DATABASE_URL),'nittai333-pilot');
const readPool=createGovernancePool(url(env.GOVERNANCE_READ_DATABASE_URL),'nittai333-pilot-reader');
const db=new GovernanceDB(pool,readPool);const saver=new PostgresSaver(pool,undefined,{schema:'governance_checkpoint'});
const store=new DirectoryPayloadStore(`${root}/payloads`);
const mode=process.argv[2];if(mode!=='dry_run'&&mode!=='apply')throw Error('explicit dry_run or apply required');
try{
 const edition=(await readPool.query('SELECT id FROM public."CompetitionEdition" WHERE slug=\'nittaidai-long-distance-meet-333\'')).rows[0];if(!edition)throw Error('Missing shell');
 const input=JSON.parse(await readFile(`${root}/first-group-input.json`,'utf8'));
 if(input.raceSlug!=='nittaidai-long-distance-meet-333-men-5000-heat-1')throw Error('Unexpected group');
 // Mirror immutable raw objects into the server worker volume before queuing the task.
 const ref=await store.put(input);if(!/^[a-f0-9]{64}\.json\.gz$/.test(ref.ref))throw Error('Invalid ref');
 const remote=`/tmp/nittai333-${ref.ref}`;
 execFileSync(ssh,['--',`umask 077; cat > ${remote} && sudo docker cp ${remote} tasuki-keifu-governance-worker:/var/lib/tasuki-governance/payloads/${ref.ref} && rm ${remote}`],{input:await readFile(`${root}/payloads/${ref.ref}`)});
 const manifest={version:'event-governance/1',requestKey:`nittai333-men5000-heat1-${mode}-v1`,eventEditionId:edition.id,mode,batches:[input]};
 await writeFile(`${root}/manifest-${mode}.json`,JSON.stringify(manifest,null,2)+'\n');
 const id=await db.submit(manifest,store);await writeFile(`${root}/task-${mode}.txt`,id+'\n');console.log('Task',id,'mode',mode);
 const runner=new EventRunner(db,store,saver,{writeEnabled:mode==='apply',research:{apiKey:env.OPENAI_API_KEY,baseUrl:env.OPENAI_BASE_URL,model:env.GOVERNANCE_RESEARCH_MODEL,timeoutMs:25000,maxRequests:3}});
 const report=await runner.run(id);
 const task=(await pool.query('SELECT id,status,mode,summary,"errorMessage" FROM governance."EventImportTask" WHERE id=$1',[id])).rows[0];
 const batches=await db.batches(id);const batchIds=batches.map(b=>b.id);
 const findings=(await pool.query('SELECT * FROM governance."GovernanceFinding" WHERE "batchId"=ANY($1::uuid[])',[batchIds])).rows;
 const changes=(await pool.query('SELECT * FROM governance."GovernanceChange" WHERE "batchId"=ANY($1::uuid[])',[batchIds])).rows;
 const executions=(await pool.query('SELECT e.* FROM governance."AgentExecution" e JOIN governance."BatchAttempt" a ON a.id=e."batchAttemptId" WHERE a."batchId"=ANY($1::uuid[])',[batchIds])).rows;
 const attempts=(await pool.query('SELECT * FROM governance."BatchAttempt" WHERE "batchId"=ANY($1::uuid[])',[batchIds])).rows;
 const output={report,task,batches,attempts,executions,findings,changes};await writeFile(`${root}/result-${mode}.json`,JSON.stringify(output,null,2)+'\n');
 console.log(JSON.stringify({task,findings:findings.map(f=>({code:f.findingCode,reason:f.reason})),changes:changes.reduce((a,v)=>(a[v.operation??'other']=(a[v.operation??'other']??0)+1,a),{})},null,2));
 if(task.status==='failed')process.exitCode=1;
}finally{await pool.end();await readPool.end()}
