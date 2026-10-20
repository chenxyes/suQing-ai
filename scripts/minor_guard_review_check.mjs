import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
let reply='';
const context=vm.createContext({console});
const deps={
 './ai.mjs':{extractStructuredInfo:async()=>reply},
 './db.mjs':{patchCompanion:()=>{throw new Error('No writes allowed');}},
 './logger.mjs':{log:()=>{}},
};
const mod=new vm.SourceTextModule(await readFile(new URL('../src/minor_guard.mjs',import.meta.url),'utf8'),{context});
await mod.link(async name=>{
 const values=deps[name];assert.ok(values);
 return new vm.SyntheticModule(Object.keys(values),function(){for(const [key,value] of Object.entries(values))this.setExport(key,value);},{context});
});
await mod.evaluate();
const {detectMinorSignal,detectMinorSmart}=mod.namespace;
const cite=(source,quote)=>JSON.stringify({minor:true,evidence:[{source,quote}]});
await test('explicit current minor self disclosure survives incidental address to the assistant',async()=>{
 const text='我今年16岁请你记住';reply=cite('latest',text);
 assert.equal((await detectMinorSmart(text)).level,'strong');
});
await test('explicit adult age prevents school enrollment alone being treated as minor age',async()=>{
 const text='我今年18岁，我读高三';reply=cite('latest','我读高三');
 assert.notEqual(detectMinorSignal(text).level,'strong');
 assert.notEqual((await detectMinorSmart(text)).level,'strong');
});
await test('current adult declaration prevents older minor-age evidence from relocking the speaker',async()=>{
 const text='我现在已经19岁了，在高中当老师';reply=cite('recent:0','我17岁');
 assert.notEqual((await detectMinorSmart(text,[{role:'user',content:'我17岁'}])).level,'strong');
});
await test('an age question is not a current age assertion',async()=>{
 const text='我16岁吗？';reply=cite('latest','我16岁');
 assert.notEqual(detectMinorSignal(text).level,'strong');
 assert.notEqual((await detectMinorSmart(text)).level,'strong');
});
await test('a negated self attribution does not borrow the third persons age',async()=>{
 const text='并不是我16岁，是我妹妹';reply=cite('latest','我16岁');
 assert.notEqual(detectMinorSignal(text).level,'strong');
 assert.notEqual((await detectMinorSmart(text)).level,'strong');
});
await test('weak school matcher cannot absorb its own interrogative wording',async()=>{
 const text='我是不是初中生？';reply=cite('latest',text);
 assert.notEqual((await detectMinorSmart(text)).level,'strong');
});
await test('weak school matcher cannot absorb negated school identity',async()=>{
 const text='我不是初中生';reply=cite('latest',text);
 assert.notEqual((await detectMinorSmart(text)).level,'strong');
});
