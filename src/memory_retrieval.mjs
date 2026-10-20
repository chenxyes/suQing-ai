import {isMemoryRecallable} from './memory_admission.mjs';
import {validMemoryVector,storedMemoryVector,sameEmbeddingSpace,memoryCosine} from './memory_vectors.mjs';

function utcMillis(value,fallback) {
  if(!value)return fallback;
  const text=String(value).replace(' ','T');
  const parsed=Date.parse(/(?:Z|[+-]\d\d:?\d\d)$/i.test(text)?text:`${text}Z`);
  return Number.isFinite(parsed)?parsed:fallback;
}
export function memoryDecayScore(row,now=new Date()) {
  if(!isMemoryRecallable(row))return 0;
  if(row.pinned || row.locked)return 1;
  const time=Number(now);const created=utcMillis(row.created_at,time);
  const reference=Math.max(created,utcMillis(row.last_used_at,created));
  const days=Math.max(0,(time-reference)/86400000);
  const weight=Number(row.memory_weight ?? 3);const halfLife=weight>=4?90:weight<=1?14:45;
  return Math.exp(-days*Math.LN2/halfLife);
}
function tokens(text) {
  const clean=String(text || '').normalize('NFKC').toLowerCase();const words=new Set(clean.match(/[a-z0-9]{2,}/g)||[]);
  const chinese=clean.replace(/什么|怎么|可以|一起|一下|请问|是不是|能不能/g,'').replace(/[我你他她的了在是有个吗呢呀吧]/g,'');
  for(const chunk of chinese.match(/[\p{Script=Han}]+/gu)||[]){for(let i=0;i+1<chunk.length;i++)words.add(chunk.slice(i,i+2));}
  return words;
}
export function rankMemoryCandidates(rows,message,{queryEmbedding=null,limit=7,now=new Date(),maxPinned=2}={}) {
  const eligible=rows.filter(isMemoryRecallable);const ids=new Set(eligible.map(row=>row.id));
  const queryTokens=tokens(message);const useVector=validMemoryVector(queryEmbedding,message);
  const scored=eligible.filter(row=>!row.compacted_into || !ids.has(row.compacted_into)).map(row=>{
    const own=tokens(row.content);let matched=0;for(const token of queryTokens)if(own.has(token))matched++;
    const lexical=queryTokens.size?matched/queryTokens.size:0;
    const stored=useVector?storedMemoryVector(row):null;
    const similarity=stored && sameEmbeddingSpace(stored.descriptor,queryEmbedding.descriptor)
      ? memoryCosine(stored.vector,queryEmbedding.vector):null;
    const relevant=lexical>0 || (similarity!=null && similarity>=0.25);
    const decay=memoryDecayScore(row,now);
    const score=lexical*1.5+Math.max(0,similarity??0)*0.85+decay*0.08
      +Math.min(10,Math.max(0,row.importance??5))*0.004+Math.min(5,Math.max(0,row.memory_weight??3))*0.006
      +(row.pinned?0.015:0)+(row.locked?0.01:0);
    return {...row,similarity,lexical_score:lexical,_recall_score:score,_relevant:relevant};
  }).sort((a,b)=>Number(b._relevant)-Number(a._relevant)||b._recall_score-a._recall_score||b.id-a.id);
  const result=[];let pins=0;const count=Math.max(0,Math.min(200,Number(limit)||0));
  for(const row of scored){
    if(result.length>=count)break;
    // The quota protects fallback slots; it must not discard relevant pinned facts.
    const pinnedFallback=row.pinned && !row._relevant;
    if(pinnedFallback && pins>=maxPinned)continue;
    if(pinnedFallback)pins++;
    result.push(row);
  }
  return result;
}
