import assert from 'node:assert/strict';
import {buildSystemPrompt} from '../src/companion.mjs';
const c={id:1,name:'测试角色',user_id:1,affection_level:10,relationship_stage:'朋友'};
const memories=[
 {memory_type:'fact',memory_subject:'user',content:'用户证据标记'},
 {memory_type:'fact',memory_subject:'companion',content:'角色证据标记'},
 {memory_type:'event',memory_subject:'shared',content:'共同证据标记'},
 {memory_type:'fact',content:'未知历史标记'},
];
const prompt=buildSystemPrompt(c,{memories,longTermDigest:'历史摘要标记'});
for(const [label,content] of [['对方本人的陈述','用户证据标记'],['角色自身的陈述','角色证据标记'],['双方共同陈述','共同证据标记'],['归属待核实','未知历史标记']])assert.ok(prompt.includes(label)&&prompt.indexOf(label)<prompt.indexOf(content),label);
assert.ok(!prompt.includes('【你记得的关于他的片段】'));
assert.ok(!prompt.includes('请把这些当作你真实经历过的事'));
const derived=buildSystemPrompt(c,{memories:[
 {memory_subject:'companion',memory_type:'monthly_summary',memory_layer:'summary',content:'角色摘要标记'},
]});
assert.ok(derived.includes('摘要，非逐字原话'),'derived subject must not imply verbatim evidence');
assert.ok(derived.includes('角色自身的陈述'),'derived companion facts retain their subject');
console.log('memory subject prompt grouping passed');
