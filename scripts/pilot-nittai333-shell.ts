import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import { createGovernancePool } from '../src/governance-v2/database.js';
const dir='/Users/xuhuan/workspace_new/document/333回增量治理准备';
const env=dotenv.parse(await readFile('../tasuki-keifu/.env','utf8'));
const url=new URL(env.DATABASE_URL); if(url.hostname!=='127.0.0.1'||url.port!=='15432'||url.pathname!=='/tasuki_keifu')throw Error('Unexpected target');url.port='15433';
const p=createGovernancePool(url.toString(),'nittai333-shell');const c=await p.connect();
const configs=JSON.parse(await readFile(`${dir}/shell-config.json`,'utf8'));
// This pilot is explicitly male-only, including the separately scoped NCG races.
// Reject excluded rows rather than silently recreating deleted women race shells.
for (const config of configs) {
 if (!config.races?.length || config.races.some((r: {slug: string; name: string}) =>
  !r.slug.includes('-men-') || !r.name.includes('男子') || r.name.includes('女子'))) {
  await c.release(); await p.end();
  throw Error('333回导入范围仅限男子；拒绝女子或性别不明确的分组壳');
 }
}
const apply=process.argv.includes('--apply');const plan:any[]=[];
try {
 await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock(hashtext('nittai333-shell'))");
 for(const config of configs){
  let competition=(await c.query('SELECT * FROM public."Competition" WHERE slug=$1',[config.competition.slug])).rows[0];
  if(!competition){const id=randomUUID();plan.push({entity:'Competition',action:'create',id,...config.competition});if(apply)competition=(await c.query('INSERT INTO public."Competition" (id,slug,"nameJa",type,"updatedAt") VALUES($1,$2,$3,$4,now()) RETURNING *',[id,config.competition.slug,config.competition.nameJa,config.competition.type])).rows[0];else competition={id};}else plan.push({entity:'Competition',action:'reuse',id:competition.id,slug:competition.slug});
  for(const s of config.sources){
   const old=(await c.query('SELECT * FROM public."Source" WHERE id=$1',[s.id])).rows[0];
   if(old){if(old.url!==s.url)throw Error('Source URL mismatch');continue}
   if(!plan.some(v=>v.entity==='Source'&&v.id===s.id)){plan.push({entity:'Source',action:'create',...s});if(apply)await c.query('INSERT INTO public."Source" (id,name,url,type,reliability,"updatedAt") VALUES($1,$2,$3,$4,$5,now())',[s.id,s.name,s.url,s.type,s.reliability]);}
  }
  for(const e of config.editions){
   let ed=(await c.query('SELECT * FROM public."CompetitionEdition" WHERE slug=$1',[e.slug])).rows[0];
   if(ed){if(ed.competitionId!==competition.id||ed.editionNumber!==e.editionNumber)throw Error('Edition mismatch');plan.push({entity:'CompetitionEdition',action:'reuse',id:ed.id,slug:e.slug});}
   else{const id=randomUUID();plan.push({entity:'CompetitionEdition',action:'create',id,...e});ed={id};if(apply)await c.query('INSERT INTO public."CompetitionEdition" (id,"competitionId",slug,"editionNumber",year,"officialName","shortName","startsOn","endsOn","sourceId","updatedAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())',[id,competition.id,e.slug,e.editionNumber,e.year,e.officialName,e.shortName,e.startsOn,e.endsOn,e.sourceId]);}
   for(const r of config.races){
    const old=(await c.query('SELECT * FROM public."Race" WHERE slug=$1',[r.slug])).rows[0];
    if(old){if(old.competitionEditionId!==ed.id||old.discipline!==r.discipline||old.heat!==r.heat)throw Error('Race mismatch');plan.push({entity:'Race',action:'reuse',id:old.id,slug:r.slug});continue;}
    const id=randomUUID();plan.push({entity:'Race',action:'create',id,...r});if(apply)await c.query('INSERT INTO public."Race" (id,"competitionEditionId",slug,name,discipline,round,heat,"distanceMeters","startsAt","sourceId",notes,"updatedAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())',[id,ed.id,r.slug,r.name,r.discipline,r.round,r.heat,r.distanceMeters,r.startsAt,r.sourceId,r.notes]);
   }
  }
 }
 if(apply){for(const v of plan.filter(v=>v.action==='create'))await c.query('INSERT INTO public."AuditLog" (id,"entityType","entityId",action,"newValue","reasonType","reasonNote","actorType") VALUES($1,$2,$3,\'create\',$4,\'import\',\'333回官方赛事壳准备；不含人物及成绩\',\'import_script\')',[randomUUID(),v.entity,v.id,JSON.stringify(v)]);await c.query('COMMIT');}else await c.query('ROLLBACK');
 await writeFile(`${dir}/shell-${apply?'applied':'preview'}.json`,JSON.stringify({target:{host:url.hostname,port:url.port,database:url.pathname},at:new Date().toISOString(),apply,plan},null,2));
 console.log({apply,counts:plan.reduce((a,v)=>(a[`${v.entity}:${v.action}`]=(a[`${v.entity}:${v.action}`]??0)+1,a),{} as Record<string,number>)});
} catch(e){await c.query('ROLLBACK');throw e}finally{c.release();await p.end()}
