#!/usr/bin/env node
/** Read-only audit by default. Applying a reviewed manifest creates a NEW database copy. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import {pathToFileURL} from 'node:url';
import {validateMemoryEvidence} from '../src/memory_provenance.mjs';
import {filterForStorage} from '../src/privacy_filter.mjs';
export const contentHash = text=>crypto.createHash('sha256').update(Buffer.isBuffer(text)?text:String(text)).digest('hex');
export async function auditMemoryProvenance({dbPath,manifestPath=null,outputDb=null}) {
  if (!dbPath || !fs.existsSync(dbPath)) throw new Error('Existing --db is required');
  if (!!manifestPath !== !!outputDb) throw new Error('--manifest requires --output-db for a new copy');
  const source=new Database(path.resolve(dbPath),{readonly:true,fileMustExist:true});
  let result;
  try {
    let resultUnknown=0,resultRestricted=0;
    const rows=source.prepare('SELECT * FROM companion_memories ORDER BY id').all();
    result={mode:manifestPath?'reviewed-copy':'read-only',total:rows.length,unknown:0,restricted:0,rows:rows.map(row=>{
      const subject=row.memory_subject || 'unknown'; const restricted=(row.memory_status??'active')!=='active'||!!row.do_not_mention||!!row.recall_blocked;
      if(subject==='unknown')resultUnknown++; if(restricted)resultRestricted++;
      return {memory_id:row.id,companion_id:row.companion_id,subject,restricted,content_sha256:contentHash(row.content),has_evidence:!!row.memory_evidence};
    })};
    result.unknown=resultUnknown;result.restricted=resultRestricted;
    if (!manifestPath) return result;
    const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
    if(!Array.isArray(manifest) || !manifest.length || manifest.length>10000)throw new Error('Manifest must be a non-empty bounded array');
    // Reserve with exclusive create; never overwrite the input or another copy.
    const destination=path.resolve(outputDb);
    const fd=fs.openSync(destination,'wx',0o600);fs.closeSync(fd);
    await source.backup(destination);
    process.env.DB_PATH=destination;
    process.env.LOG_DIR=path.join(path.dirname(destination),'memory-audit-logs');
    const m=await import('../src/db.mjs'); const db=m.getDb();
    try {
      if(path.resolve(db.name)!==destination)throw new Error('DB module already initialized for a different path');
      const seen=new Set();
      const decisions=manifest.map(entry=>{
        if(!Number.isSafeInteger(entry.memory_id)||seen.has(entry.memory_id))throw new Error('Invalid or duplicate memory ID');
        seen.add(entry.memory_id);
        const row=db.prepare('SELECT * FROM companion_memories WHERE id=?').get(entry.memory_id);
        if(!row || contentHash(row.content)!==entry.content_sha256)throw new Error(`Content changed or missing: ${entry.memory_id}`);
        if((row.memory_status??'active')!=='active'||row.do_not_mention||row.recall_blocked)throw new Error(`Restricted record cannot be promoted: ${entry.memory_id}`);
        if(entry.action==='quarantine')return {row,action:'quarantine'};
        if(entry.action!=='attribute')throw new Error('Action must be quarantine or attribute');
        if(!m.getRecallableMemories(row.companion_id,row.user_id).some(r=>r.id===row.id))throw new Error(`Ineligible provenance: ${row.id}`);
        const ids=Array.isArray(entry.evidence)?entry.evidence.map(e=>e.turn_id):[];
        const turns=m.getMemoryEvidenceTurns(row.companion_id,row.user_id,ids);
        const checked=validateMemoryEvidence({subject:entry.subject,evidence:entry.evidence,turns});
        if(!checked || checked.evidence.some(e=>{const pf=filterForStorage(e.quote);return !pf.store||pf.text!==e.quote;}))throw new Error(`Unusable evidence: ${entry.memory_id}`);
        return {row,action:'attribute',checked};
      });
      db.transaction(()=>{
        for(const decision of decisions){
          const {row}=decision;
          if(decision.action==='quarantine')m.patchMemory(row.id,row.companion_id,{do_not_mention:1});
          else {
            const edited=m.patchMemory(row.id,row.companion_id,{content:decision.checked.content});
            if(!edited)throw new Error(`Edit rejected: ${row.id}`);
            db.prepare('UPDATE companion_memories SET memory_subject=?,memory_evidence=?,embedding=NULL WHERE id=?')
              .run(decision.checked.subject,JSON.stringify(decision.checked.evidence),row.id);
          }
        }
      })();
      result.applied=decisions.map(d=>({memory_id:d.row.id,action:d.action}));
      result.integrity=db.pragma('integrity_check',{simple:true});
    } finally { db.close(); }
    return result;
  }finally{source.close();}
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try {
  const args={};for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i];if(!['--db','--manifest','--output-db','--report'].includes(key)||!process.argv[i+1])throw new Error('Usage: --db INPUT [--manifest REVIEW.json --output-db NEW_COPY] [--report NEW_REPORT.json]');args[key]=process.argv[i+1];}
  const report=await auditMemoryProvenance({dbPath:args['--db'],manifestPath:args['--manifest'],outputDb:args['--output-db']});
  if(args['--report'])fs.writeFileSync(args['--report'],JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({mode:report.mode,total:report.total,unknown:report.unknown,restricted:report.restricted,applied:report.applied?.length || 0,integrity:report.integrity || null}));
 }catch(error){console.error(`memory provenance audit: ${error.message}`);process.exitCode=1;}
}
