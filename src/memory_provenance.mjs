/** Evidence checks constrain attribution, not the truth of a speaker's assertion. */
export const MEMORY_SUBJECTS = new Set(['user', 'companion', 'shared']);
export function normalizedMemoryClaim(content) {
  return String(content || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}
function standaloneAssertion(turn, quote, shared) {
  const text=String(turn.content || '').trim();
  // Fail closed for indirect/conditional language. Do not turn a substring of
  // "if I had ..." or a quoted assistant statement into personal evidence.
  if (/[?？“”「」『』"]|如果|假如|假设|要是|比如|例如|假装|扮演|开玩笑|听说|据说|是假的|不是真的|原话|台词|引用|转述|(?:你|他|她)(?:刚才|之前|曾经)?说|(?:if|suppose|imagine|said|says|asked|not true|false statement)\b/i.test(text)) return false;
  const clauses=text.split(/[，,。.!！；;\n]+/).map(s=>s.trim()).filter(Boolean);
  const clean=quote.replace(/[。.!！；;]+$/u,'').trim();
  if (!clauses.includes(clean) && clean !== text.replace(/[。.!！；;]+$/u,'').trim()) return false;
  if (/(?:吗|么|呢)$/.test(clean)) return false;
  if (/^(?:我(?:觉得|以为|猜你|记得你)|I\s+(?:think|guess|heard))/.test(clean)) return false;
  return shared ? /^(?:我们|咱们|we\b)/i.test(clean)
    : /^(?:我(?!们)|本人|咱(?!们)|I\b)/i.test(clean);
}
export function validateMemoryEvidence({subject,evidence,turns}) {
  if (!MEMORY_SUBJECTS.has(subject) || !Array.isArray(evidence) || !evidence.length || evidence.length>6) return null;
  const byId=new Map(turns.map(t=>[t.id,t])); const checked=[];
  for (const item of evidence) {
    if (!item || !Number.isSafeInteger(item.turn_id) || typeof item.quote!=='string') return null;
    const turn=byId.get(item.turn_id); const quote=item.quote.trim();
    if (!turn || Number(turn.synthetic || 0)!==0 || !['user','assistant'].includes(turn.role)
      || quote.length<3 || quote.length>500 || !turn.content.includes(quote)) return null;
    if ((subject==='user' && turn.role!=='user') || (subject==='companion' && turn.role!=='assistant')) return null;
    if (!standaloneAssertion(turn,quote,subject==='shared')) return null;
    checked.push({turn_id:turn.id,role:turn.role,quote});
  }
  if (subject==='shared' && !['user','assistant'].every(role=>checked.some(e=>e.role===role))) return null;
  const unique=[...new Map(checked.map(e=>[`${e.turn_id}:${e.quote}`,e])).values()];
  return {subject,evidence:unique,content:unique.map(e=>subject==='shared'?`${e.role}：${e.quote}`:e.quote).join('；')};
}

export function isRelatedExplicitCorrection(previous, evidence) {
  if (!evidence.every(e=>e.role==='user')) return false;
  const text=evidence.map(e=>e.quote).join('；');
  if (!/更正|纠正|记错|说错|不是我|我(?:并)?没有|我(?:已经)?不再|我不是|\b(?:correction|incorrect|wrong|I do not|I don't|I have no)\b/i.test(text)) return false;
  // Require the corrected claim itself to be mentioned, not just a generic
  // "you are wrong" attached to an unrelated model-selected memory ID.
  const old=String(previous.content || '');
  if (old.length>=4 && text.includes(old)) return true;
  const topic=s=>normalizedMemoryClaim(s).replace(/用户|本人|我们|咱们|一个|一位|不是|没有|不再|已经|更正|纠正|记错|说错|喜欢|有|是|我|他|她|你|的|了|并/g,'');
  const a=topic(old); const b=topic(evidence.map(e=>e.quote).join(''));
  return a.length>=2 && b.includes(a);
}
