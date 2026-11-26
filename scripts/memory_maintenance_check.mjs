/** Offline: Node20/22 --experimental-vm-modules scripts/memory_maintenance_check.mjs */
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const temp = mkdtempSync(path.join(tmpdir(), 'memory-maintenance-'));
process.env.DB_PATH = path.join(temp, 'fixture.db');
process.env.LOG_DIR = path.join(temp, 'logs');
process.env.TZ = 'Asia/Shanghai';
globalThis.fetch = async () => { throw new Error('Network forbidden'); };
const dbApi = await import('../src/db.mjs');
const db = dbApi.getDb(); db.pragma('foreign_keys = OFF');
let active = [], modelCalls = 0, modelHook = () => {}, monthlyExists = false, modelInputs = [];
let providerResult = null, providerHook = () => {};
const context = vm.createContext({ console, process, Buffer, Date, URL, setInterval, clearInterval });
const modules = new Map();
const logs = [];
async function load(file) {
  if (modules.has(file)) return modules.get(file);
  let source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
  if (file === 'plan_tasks.mjs') source += '\nexport { runHourlyCleanup,runMemoryDecay,compactOldEpisodicMemories,runMonthly,runArchiveDailySchedule };';
  const module = new vm.SourceTextModule(source, { context, identifier: file }); modules.set(file, module);
  await module.link(async spec => {
    if (['./memory_v2.mjs', './privacy_filter.mjs', './memory_admission.mjs', './memory_vectors.mjs', './memory_retrieval.mjs'].includes(spec)) return load(spec.slice(2));
    const stubKey = `stub:${file}:${spec}`;
    if (modules.has(stubKey)) return modules.get(stubKey);
    const names = [...source.matchAll(/(?:import|export)\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g)]
      .filter(m => m[2] === spec).flatMap(m => m[1].replace(/\/\/[^\n]*/g, '').split(',').map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean));
    const values = Object.fromEntries(names.map(name => [name, () => { throw new Error(`Unexpected ${spec}:${name}`); }]));
    if (spec.startsWith('node:')) Object.assign(values, await import(spec));
    if (spec === './db.mjs') Object.assign(values, dbApi, {
      getAllActiveCompanions: () => active,
      getRecentSummaries: () => [],
      summaryMemoryExists: (...args) => monthlyExists || dbApi.summaryMemoryExists(...args),
    });
    if (spec === './logger.mjs') values.log = (...args) => logs.push(args.join(' '));
    if (spec === './ai.mjs') Object.assign(values, {
      embedText: async text => { providerHook(text); return providerResult?.vector ?? null; },
      embedTextWithDescriptor: async text => { providerHook(text); return providerResult; },
      generateReply: async (_system, _history, input) => { modelCalls++; modelInputs.push(input); modelHook(); return `合成的压缩摘要 ${modelCalls}`; },
    });
    if (spec === './chat_response.mjs') values.isChatFallback = result => result === 'FALLBACK';
    if (spec === 'node:fs/promises') Object.assign(values, { mkdir: async () => {}, writeFile: async () => {} });
    if (spec === 'node:path') values.default = path;
    const stub = new vm.SyntheticModule(Object.keys(values), function () { for (const [key, value] of Object.entries(values)) this.setExport(key, value); }, { context });
    // Node 20 can crash during evaluate if an unretained synthetic module wrapper
    // is collected after linking. Keep every module alive for the complete run.
    modules.set(stubKey, stub);
    return stub;
  });
  return module;
}
console.log('memory_maintenance_check: loading production modules');
const planModule = await load('plan_tasks.mjs');
console.log('memory_maintenance_check: evaluating production modules');
await planModule.evaluate();
console.log('memory_maintenance_check: production modules ready');
const plan = planModule.namespace, memory = modules.get('memory_v2.mjs').namespace;
let passed = 0, failed = 0, sequence = 920000;
const sqlTime = date => date.toISOString().slice(0, 19).replace('T', ' ');
const oldTime = sqlTime(new Date(Date.now() - 120 * 86400000));
function fixture() {
  const id = ++sequence; db.prepare('INSERT INTO companions(id,user_id,bot_id,name) VALUES(?,?,?,?)').run(id,id,'fixture','合成角色');
  const companion = { id, user_id: id, name: '合成角色' };
  const add = (content, fields = {}) => {
    const memoryId = dbApi.saveMemory({ companionId: id, userId: id, content, memoryType: 'event', memoryLayer: 'event', importance: 3, pinned: false });
    const patch = { created_at: oldTime, memory_subject: 'user', ...fields };
    db.prepare(`UPDATE companion_memories SET ${Object.keys(patch).map(key => `${key}=?`).join(',')} WHERE id=?`).run(...Object.values(patch), memoryId);
    return memoryId;
  };
  const turn = (created = oldTime) => {
    const row = dbApi.saveConversationTurn(id,'user','我喜欢蓝色。');
    db.prepare('UPDATE companion_conversation_turns SET created_at=? WHERE id=?').run(created,row.id); return row.id;
  };
  return { companion, add, turn };
}
async function check(name, fn) {
  console.log(`RUN ${name}`);
  db.prepare('DELETE FROM companion_memories').run(); db.prepare('DELETE FROM companion_conversation_turns').run();
  db.prepare('UPDATE wechat_accounts SET is_active=0').run();
  active=[]; modelCalls=0; modelInputs=[]; modelHook=()=>{}; monthlyExists=false; providerResult=null; providerHook=()=>{}; logs.length=0;
  try { await fn(); passed++; } catch(error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
}
try {
  await check('decay visits all 401 rows without touching use timestamps', async () => {
    const f=fixture(); for(let i=0;i<401;i++)f.add(`event ${i}`,{last_used_at:null,decay_score:1});
    await plan.runMemoryDecay();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM companion_memories WHERE decay_score<1').get().n,401);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM companion_memories WHERE last_used_at IS NOT NULL').get().n,0);
  });
  await check('no-write page advances cursor and upper bound excludes later rows', () => {
    const f=fixture(), now=new Date('2026-10-20T00:00:00Z');
    const ids=Array.from({length:5},(_,i)=>f.add(`event ${i}`,{created_at:'2026-10-20 00:00:00',decay_score:1}));
    const first=memory.applyMemoryDecayBatch(db,{batchSize:2,afterId:0,upperId:ids[3],now});
    assert.equal(first.written,0); assert.equal(first.nextCursor,ids[1]); assert.equal(first.done,false);
    const second=memory.applyMemoryDecayBatch(db,{batchSize:2,afterId:first.nextCursor,upperId:ids[3],now});
    assert.equal(second.nextCursor,ids[3]); assert.equal(second.done,true);
  });
  await check('decay excludes hidden blocked nonactive locked and pinned rows', () => {
    const f=fixture(); for(const fields of [{do_not_mention:1},{recall_blocked:1},{memory_status:'archived'},{locked:1},{pinned:1}])f.add('protected',fields);
    const result=memory.applyMemoryDecayBatch(db,{batchSize:200});
    assert.equal(result.checked,0); assert.equal(result.written,0);
  });
  await check('SQLite timestamps are interpreted as UTC during decay', () => {
    const score=memory.computeMemoryDecay({created_at:'2026-10-19 23:00:00',memory_weight:3},new Date('2026-10-20T00:00:00Z'));
    const expected=Math.exp(-(1/24)*Math.LN2/45);
    assert.ok(Math.abs(score-expected)<1e-10);
  });
  await check('hourly cleanup retains all 300 recent turns before daily summary', async () => {
    const f=fixture();for(let i=0;i<300;i++)f.turn(sqlTime(new Date(Date.now()-4*3600000)));
    await plan.runHourlyCleanup();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM companion_conversation_turns').get().n,300);
    assert.equal(dbApi.getConversationContext(f.companion.id,500).length,50);
  });
  await check('old referenced evidence and latest100 survive while unreferenced old turns expire', async () => {
    const f=fixture(), ids=Array.from({length:250},()=>f.turn());
    f.add('source with old evidence',{memory_evidence:JSON.stringify([{turn_id:ids[0],role:'user',quote:'我喜欢蓝色。'}])});
    f.add('legacy malformed evidence',{memory_evidence:'{broken'});
    f.add('legacy scalar evidence',{memory_evidence:'[1,"bad",null]'});
    await plan.runHourlyCleanup();
    const rows=db.prepare('SELECT id FROM companion_conversation_turns ORDER BY id').all().map(row=>row.id);
    assert.deepEqual(rows,[ids[0],...ids.slice(-100)]);
  });
  await check('compaction saves legal summary and keeps marked source rows', async () => {
    const f=fixture(), ids=Array.from({length:5},(_,i)=>f.add(`old event ${i}`));
    await plan.compactOldEpisodicMemories(f.companion);
    const rows=db.prepare('SELECT * FROM companion_memories ORDER BY id').all();
    const summary=rows.find(row=>row.memory_type==='monthly_summary');
    assert.ok(summary); assert.equal(summary.importance,10); assert.deepEqual(JSON.parse(summary.source_memory_ids),ids);
    assert.equal(rows.length,6); assert.ok(rows.filter(row=>ids.includes(row.id)).every(row=>row.compacted_into===summary.id));
    await plan.compactOldEpisodicMemories(f.companion); assert.equal(modelCalls,1);
    dbApi.softDeleteMemory(ids[0],f.companion.id);
    assert.ok(!dbApi.getRecallableMemories(f.companion.id,f.companion.user_id).some(row=>row.id===summary.id));
  });
  await check('compaction keeps each subject separate and labels the complete input', async () => {
    const f=fixture(), groups=new Map();
    for(const subject of ['user','companion','shared','unknown']) {
      groups.set(subject,Array.from({length:3},(_,i)=>f.add(`我是${subject}来源的第${i}条合成事实`,{memory_subject:subject})));
    }
    await plan.compactOldEpisodicMemories(f.companion);
    const summaries=db.prepare("SELECT * FROM companion_memories WHERE memory_type='monthly_summary'").all();
    assert.equal(summaries.length,4,'do not mix speakers into a single unknown summary');
    for(const [subject,ids] of groups) {
      const summary=summaries.find(row=>row.memory_subject===subject);
      assert.ok(summary,`retain ${subject} subject`);
      assert.deepEqual(JSON.parse(summary.source_memory_ids),ids);
      const call=Number(summary.content.match(/合成的压缩摘要 (\d+)$/)[1]);
      const input=modelInputs[call-1];
      assert.ok(input.includes(`[subject=${subject}]`),'model sees authoritative subject');
      for(const other of groups.keys())if(other!==subject)assert.ok(!input.includes(`[subject=${other}]`));
      assert.ok(dbApi.getMemories(f.companion.id,f.companion.user_id).some(row=>row.id===summary.id));
    }
  });
  await check('sparse mixed subjects stay uncompressed and direct mixed batches are rejected', async () => {
    const f=fixture(),ids=['user','companion','unknown'].map((subject,i)=>f.add(`来源${i}`,{memory_subject:subject}));
    await plan.compactOldEpisodicMemories(f.companion);
    assert.equal(modelCalls,0);
    const revision=dbApi.getMemoryRecallBarrier(f.companion.id,f.companion.user_id).revision;
    assert.equal(dbApi.compactMemories({companionId:f.companion.id,userId:f.companion.user_id,sourceIds:ids,
      content:'不可混合第一人称',expectedRecallRevision:revision}),null);
    assert.ok(dbApi.getMemories(f.companion.id,f.companion.user_id).every(row=>!row.compacted_into));
  });
  await check('compaction marking failure rolls back summary and retries without losing sources', async () => {
    const f=fixture(); for(let i=0;i<5;i++)f.add(`old event ${i}`);
    db.exec("CREATE TEMP TRIGGER reject_compaction BEFORE UPDATE OF compacted_into ON companion_memories WHEN NEW.compacted_into IS NOT NULL BEGIN SELECT RAISE(ABORT,'injected failure'); END");
    try { await plan.compactOldEpisodicMemories(f.companion); }
    finally { db.exec('DROP TRIGGER reject_compaction'); }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM companion_memories').get().n,5);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM companion_memories WHERE compacted_into IS NOT NULL').get().n,0);
    await plan.compactOldEpisodicMemories(f.companion);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM companion_memories').get().n,6);
  });
  await check('compaction frozen upper bound leaves new arrivals for the next run', async () => {
    const f=fixture();for(let i=0;i<5;i++)f.add(`old event ${i}`);
    const late=[]; modelHook=()=>{if(!late.length)for(let i=0;i<3;i++)late.push(f.add(`late event ${i}`));};
    await plan.compactOldEpisodicMemories(f.companion);
    assert.equal(modelCalls,1);
    assert.ok(db.prepare('SELECT * FROM companion_memories').all().filter(row=>late.includes(row.id)).every(row=>row.compacted_into==null));
    modelHook=()=>{}; await plan.compactOldEpisodicMemories(f.companion); assert.equal(modelCalls,2);
  });
  await check('pinning while compaction model waits rejects the complete batch', async () => {
    const f=fixture(),ids=Array.from({length:5},(_,i)=>f.add(`old event ${i}`));
    modelHook=()=>dbApi.patchMemory(ids[0],f.companion.id,{pinned:1});
    await plan.compactOldEpisodicMemories(f.companion);
    assert.equal(modelCalls,1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM companion_memories').get().n,5);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM companion_memories WHERE compacted_into IS NOT NULL').get().n,0);
  });
  await check('compaction advances beyond 200 same-month sources and sparse early months', async () => {
    const f=fixture(); f.add('sparse',{created_at:'2010-01-01 00:00:00'});
    for(let i=0;i<405;i++)f.add(`old event ${i}`);
    await plan.compactOldEpisodicMemories(f.companion);
    const rows=db.prepare("SELECT * FROM companion_memories WHERE memory_type='monthly_summary'").all();
    assert.ok(rows.length>=3); const ids=rows.flatMap(row=>JSON.parse(row.source_memory_ids));
    assert.equal(new Set(ids).size,405); assert.equal(ids.length,405);
    assert.equal(new Set(rows.map(row=>row.content.split('：')[0])).size,rows.length);
  });
  await check('every compacted long source is fully shown in its corresponding model request', async () => {
    const f=fixture();for(let i=0;i<30;i++)f.add(`source-${i} ${'甲'.repeat(1000)} end-${i}`);
    await plan.compactOldEpisodicMemories(f.companion);
    const summaries=db.prepare("SELECT * FROM companion_memories WHERE memory_type='monthly_summary'").all();
    const included=new Set();
    for(const row of summaries){
      const call=Number(row.content.match(/合成的压缩摘要 (\d+)$/)[1]);
      for(const id of JSON.parse(row.source_memory_ids)){
        const source=db.prepare('SELECT content FROM companion_memories WHERE id=?').get(id);
        assert.ok(modelInputs[call-1].includes(source.content),`source ${id} must appear completely in request ${call}`);
        included.add(id);
      }
    }
    assert.equal(included.size,30);
  });
  await check('oversized single source stays uncompressed while complete smaller sources proceed', async () => {
    const f=fixture(),long=f.add(`long ${'甲'.repeat(12000)} end`);
    for(let i=0;i<3;i++)f.add(`small source ${i}`);
    await plan.compactOldEpisodicMemories(f.companion);
    assert.equal(db.prepare('SELECT compacted_into FROM companion_memories WHERE id=?').get(long).compacted_into,null);
    const summaries=db.prepare("SELECT * FROM companion_memories WHERE memory_type='monthly_summary'").all();
    assert.equal(summaries.length,1);assert.equal(JSON.parse(summaries[0].source_memory_ids).length,3);
  });
  for(const mode of ['existing summary','no weekly summaries']) await check(`monthly ${mode} does not skip maintenance`, async () => {
    const f=fixture(); for(let i=0;i<5;i++)f.add(`old event ${i}`); active=[f.companion]; monthlyExists=mode==='existing summary';
    await plan.runMonthly('2026-10-01'); assert.ok(modelCalls>0);
    assert.ok(db.prepare("SELECT COUNT(*) AS n FROM companion_memories WHERE memory_type='monthly_summary'").get().n>0);
  });
  await check('revocation while compaction model waits preserves all originals and rejects stale summary', async () => {
    const f=fixture(), ids=Array.from({length:5},(_,i)=>f.add(`old event ${i}`));
    modelHook=()=>dbApi.softDeleteMemory(ids[0],f.companion.id);
    await plan.compactOldEpisodicMemories(f.companion);
    assert.equal(modelCalls,1); assert.equal(db.prepare("SELECT COUNT(*) AS n FROM companion_memories WHERE memory_type='monthly_summary'").get().n,0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM companion_memories').get().n,5);
  });
  await check('locked and pinned sources never enter compaction input', async () => {
    const f=fixture(); f.add('LOCKED',{locked:1}); f.add('PINNED',{pinned:1}); for(let i=0;i<5;i++)f.add(`old event ${i}`);
    await plan.compactOldEpisodicMemories(f.companion);
    const rows=db.prepare("SELECT * FROM companion_memories WHERE memory_type='monthly_summary'").all(); assert.equal(rows.length,1);
    const ids=JSON.parse(rows[0].source_memory_ids);
    assert.ok(db.prepare("SELECT * FROM companion_memories WHERE content IN ('LOCKED','PINNED')").all().every(row=>!ids.includes(row.id)));
  });
  await check('legacy cosine ignores a vector from a different embedding space', async () => {
    const f=fixture(), descriptor={version:1,provider:'custom',model:'m1',dimension:2,endpointId:'a'.repeat(64)};
    const content='different lexical contents';const hash=text=>createHash('sha256').update(text).digest('hex');
    const fields={embedding:Buffer.from(new Float32Array([1,0]).buffer)};
    if(db.prepare('PRAGMA table_info(companion_memories)').all().some(row=>row.name==='embedding_meta')) fields.embedding_meta=JSON.stringify({descriptor:{...descriptor,model:'other'},contentHash:hash(content)});
    f.add(content,fields);providerResult={vector:[1,0],descriptor,contentHash:hash('query')};
    assert.equal(await memory.findSimilarMemoryByEmbedding(f.companion.id,'query',{userId:f.companion.user_id,subject:'user'}),null);
  });
  for(const variant of ['same-space','endpoint','dimension','content-hash','untagged','nonfinite','query-hash']) await check(`legacy vector validation: ${variant}`, async () => {
    const f=fixture(),descriptor={version:1,provider:'custom',model:'m1',dimension:2,endpointId:'a'.repeat(64)};
    const content='different lexical contents',hash=text=>createHash('sha256').update(text).digest('hex');
    const meta={descriptor:{...descriptor},contentHash:hash(content)};
    if(variant==='endpoint')meta.descriptor.endpointId='b'.repeat(64);
    if(variant==='dimension')meta.descriptor.dimension=3;
    if(variant==='content-hash')meta.contentHash=hash('obsolete content');
    const target=f.add(content,{embedding:Buffer.from(new Float32Array([variant==='nonfinite'?NaN:1,0]).buffer),
      embedding_meta:variant==='untagged'?null:JSON.stringify(meta)});
    providerResult={vector:[1,0],descriptor,contentHash:hash(variant==='query-hash'?'other query':'query')};
    const result=await memory.findSimilarMemoryByEmbedding(f.companion.id,'query',{userId:f.companion.user_id,subject:'user'});
    assert.equal(result?.id??null,variant==='same-space'?target:null);
  });
  for(const revoke of [false,true]) await check(`schedule indexes stored canonical content with metadata; revoke=${revoke}`, async () => {
    const f=fixture(),id=f.companion.id,dateKey='2026-10-20';
    db.prepare('INSERT INTO users(id,wechat_user_id) VALUES(?,?)').run(id,`fixture-${id}`);
    db.prepare('INSERT INTO wechat_accounts(bot_id,bot_token,wechat_user_id,is_active) VALUES(?,?,?,1)').run(`fixture-${id}`,'synthetic',`fixture-${id}`);
    dbApi.saveDailySchedule(id,dateKey,[{time:'12:00',activity:revoke?'散步':'用户散步',importance:6}],null);
    const anchor=revoke?f.add('anchor'):null;let supplied;
    providerHook=text=>{
      supplied=text;providerResult={vector:[1,0],descriptor:{version:1,provider:'custom',model:'m1',dimension:2,endpointId:'a'.repeat(64)},
        contentHash:createHash('sha256').update(text).digest('hex')};
      if(revoke)dbApi.softDeleteMemory(anchor,id);
    };
    await plan.runArchiveDailySchedule(dateKey);
    const row=db.prepare('SELECT * FROM companion_memories WHERE companion_id=? AND id!=? ORDER BY id DESC').get(id,anchor??0);
    assert.ok(row);assert.equal(supplied,row.content);
    if(revoke){assert.equal(row.embedding,null);assert.equal(row.embedding_meta,null);}
    else {assert.ok(row.embedding);assert.equal(JSON.parse(row.embedding_meta).contentHash,createHash('sha256').update(row.content).digest('hex'));}
  });
} finally { db.close(); process.on('exit',()=>rmSync(temp,{recursive:true,force:true})); }
console.log(`memory_maintenance_check: ${passed} passed, ${failed} failed`);
process.exitCode=failed?1:0;
