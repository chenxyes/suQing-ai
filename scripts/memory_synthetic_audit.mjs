#!/usr/bin/env node
/** Read-only legacy suspicion audit. Reviewed quarantine is possible only in a new copy. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {openOfflineSqliteSnapshot,protectDatabasePaths as protectSnapshotPaths} from '../src/offline_sqlite_snapshot.mjs';

const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const contentHash=value=>digest(String(value));
const isHash=value=>typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
function fail(code){const error=new Error(code);error.auditCode=code;throw error;}
function protectDatabasePaths(target,database){
  try{protectSnapshotPaths(database,target);}catch{fail('database_or_sidecar_output_forbidden');}
}
function sameIdentity(a,b){return a && b && a.database_sha256===b.database_sha256 && a.wal_sha256===b.wal_sha256;}
function tableExists(db,name){return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);}
function sourceRevision(db,cid,uid){
  if(!tableExists(db,'memory_recall_barriers'))return 0;
  return db.prepare('SELECT revision FROM memory_recall_barriers WHERE companion_id=? AND user_id=?').get(cid,String(uid))?.revision ?? 0;
}
function inspect(db,sourceIdentity){
  const memories=db.prepare('SELECT * FROM companion_memories ORDER BY id').all();
  const owners=new Map(db.prepare('SELECT id,user_id FROM companions').all().map(row=>[row.id,String(row.user_id)]));
  const topics=new Map();
  if(tableExists(db,'companion_conversation_turns')){
    const columns=new Set(db.pragma('table_info(companion_conversation_turns)').map(row=>row.name));
    if(columns.has('synthetic') && columns.has('topic')){
      const verifiedImport=columns.has('import_unverified')?' AND COALESCE(import_unverified,0)=0':'';
      for(const row of db.prepare('SELECT companion_id,topic FROM companion_conversation_turns WHERE synthetic=1 AND topic IS NOT NULL'+verifiedImport).all()){
        if(!topics.has(row.companion_id))topics.set(row.companion_id,new Set());
        topics.get(row.companion_id).add(row.topic);
      }
    }
  }
  const rows=memories.filter(row=>(row.memory_origin || 'unknown')==='unknown').map(row=>{
    const match=String(row.content || '').match(/^([\s\S]+)（([0-9]+) 天前发生）$/u);
    const ownerMatches=owners.get(row.companion_id)===String(row.user_id);
    const suspected=!!(match && ownerMatches && topics.get(row.companion_id)?.has(match[1]));
    return {memory_id:row.id,companion_id:row.companion_id,user_id:row.user_id,
      memory_origin:'unknown',content_sha256:contentHash(row.content),
      recall_revision:sourceRevision(db,row.companion_id,row.user_id),current_owner_matches:ownerMatches,
      restricted:(row.memory_status ?? 'active')!=='active'||!!row.do_not_mention||!!row.recall_blocked,
      suspected,reasons:suspected?['legacy_day_suffix_and_scoped_synthetic_topic']:[]};
  });
  return {version:1,mode:'read-only',source_identity:sourceIdentity,total:memories.length,unknown:rows.length,
    suspected:rows.filter(row=>row.suspected).length,
    synthetic:memories.filter(row=>row.memory_origin==='synthetic').length,
    // A match is only a review lead. Even matching rows remain unchanged by this audit.
    classification:'suspicions_only_no_automatic_reclassification',rows};
}
function reviewedGroups(manifest,report){
  if(!manifest || manifest.version!==1 || !isHash(manifest.source_identity?.database_sha256)
    || !(manifest.source_identity?.wal_sha256===null || isHash(manifest.source_identity?.wal_sha256))
    || !sameIdentity(manifest.source_identity,report.source_identity))fail('stale_source_identity');
  if(!Array.isArray(manifest.entries)||!manifest.entries.length||manifest.entries.length>10000)fail('invalid_manifest_entries');
  const byId=new Map(report.rows.map(row=>[row.memory_id,row]));const seen=new Set(),groups=new Map();
  for(const entry of manifest.entries){
    if(!entry || !Number.isSafeInteger(entry.memory_id)||entry.memory_id<=0||seen.has(entry.memory_id)
      || !Number.isSafeInteger(entry.companion_id)||entry.companion_id<=0
      || !((Number.isSafeInteger(entry.user_id)&&entry.user_id>0)||(typeof entry.user_id==='string'&&entry.user_id.length>0))
      || !Number.isSafeInteger(entry.expected_recall_revision)||entry.expected_recall_revision<0
      || !isHash(entry.content_sha256)||entry.action!=='quarantine_synthetic')fail('invalid_manifest_entry');
    seen.add(entry.memory_id);
    const row=byId.get(entry.memory_id);
    if(!row || !row.current_owner_matches || row.companion_id!==entry.companion_id || String(row.user_id)!==String(entry.user_id)
      || row.content_sha256!==entry.content_sha256 || row.recall_revision!==entry.expected_recall_revision)fail('stale_or_wrong_scope_entry');
    const key=JSON.stringify([entry.companion_id,String(entry.user_id)]);
    if(!groups.has(key))groups.set(key,{companionId:entry.companion_id,userId:entry.user_id,entries:[]});
    groups.get(key).entries.push({id:entry.memory_id,contentHash:entry.content_sha256});
  }
  return [...groups.values()];
}

export async function auditSyntheticMemories({dbPath,manifestPath=null,outputDb=null}={}){
  if(!dbPath || !fs.existsSync(dbPath)||!fs.statSync(dbPath).isFile())fail('existing_source_database_required');
  if(!!manifestPath!==!!outputDb)fail('manifest_and_new_output_required_together');
  const input=fs.realpathSync(dbPath);
  if(outputDb){
    protectDatabasePaths(outputDb,input);
    protectDatabasePaths(outputDb,process.env.DB_PATH || path.resolve('data/bot.db'));
  }
  // Shared snapshot reader never opens SQLite at the source path.
  const snapshot=openOfflineSqliteSnapshot(input);
  const source=snapshot.db,initialIdentity=snapshot.sourceIdentity;
  try{
    const report=source.transaction(()=>inspect(source,initialIdentity))();
    snapshot.assertSourceUnchanged();
    if(!manifestPath)return report;
    let manifest,manifestBytes;
    try{manifestBytes=fs.readFileSync(manifestPath);manifest=JSON.parse(manifestBytes.toString('utf8'));}catch{fail('invalid_manifest_json');}
    const groups=reviewedGroups(manifest,report);
    const destination=path.resolve(outputDb);
    // Exclusive reservation also rejects source aliases, symlinks and any existing output.
    let fd;
    try{fd=fs.openSync(destination,'wx',0o600);}catch{fail('output_must_be_new_file');}
    fs.closeSync(fd);
    await source.backup(destination);
    snapshot.assertSourceUnchanged();
    process.env.DB_PATH=destination;process.env.LOG_DIR=path.join(path.dirname(destination),'synthetic-audit-logs');
    const m=await import('../src/db.mjs');const copied=m.getDb();
    if(path.resolve(copied.name)!==destination)fail('app_database_already_initialized_elsewhere');
    try{
      if(typeof m.quarantineSyntheticMemories!=='function')fail('quarantine_api_unavailable');
      copied.transaction(()=>{
        for(const group of groups){
          // Source revision was checked above. Schema migrations in this fresh copy may
          // conservatively seed additional barriers for pre-existing restricted rows.
          const revision=m.getMemoryRecallBarrier(group.companionId,group.userId).revision;
          const count=m.quarantineSyntheticMemories(group.companionId,group.userId,group.entries,{expectedRecallRevision:revision});
          if(count!==group.entries.length)fail('quarantine_rejected');
        }
      })();
      const integrity=copied.pragma('integrity_check',{simple:true});
      if(integrity!=='ok')fail('copy_integrity_failed');
      return {...report,mode:'reviewed-copy',applied:manifest.entries.map(entry=>({memory_id:entry.memory_id,
        companion_id:entry.companion_id,user_id:entry.user_id,action:entry.action})),
        manifest_sha256:digest(manifestBytes),integrity};
    }finally{copied.close();}
  }finally{snapshot.close();}
}

if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const args={};
    for(let i=2;i<process.argv.length;i+=2){
      const key=process.argv[i];if(!['--db','--manifest','--output-db','--report'].includes(key)||!process.argv[i+1]||args[key])fail('invalid_arguments');
      args[key]=process.argv[i+1];
    }
    if(args['--report'] && args['--db'] && fs.existsSync(args['--db'])){
      protectDatabasePaths(args['--report'],fs.realpathSync(args['--db']));
      protectDatabasePaths(args['--report'],process.env.DB_PATH || path.resolve('data/bot.db'));
      if(args['--output-db'])protectDatabasePaths(args['--report'],args['--output-db']);
    }
    const report=await auditSyntheticMemories({dbPath:args['--db'],manifestPath:args['--manifest'],outputDb:args['--output-db']});
    if(args['--report'])fs.writeFileSync(args['--report'],JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
    console.log(JSON.stringify({mode:report.mode,total:report.total,unknown:report.unknown,suspected:report.suspected,
      applied:report.applied?.length || 0,integrity:report.integrity || null}));
  }catch(error){console.error(`memory synthetic audit: ${error.auditCode || 'operation_failed'}`);process.exitCode=1;}
}
