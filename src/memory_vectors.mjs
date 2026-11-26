import { createHash } from 'node:crypto';

export const hashMemoryContent = text => createHash('sha256').update(String(text)).digest('hex');
export function validEmbeddingDescriptor(value) {
  return !!value && value.version === 1
    && typeof value.provider === 'string' && /^[a-z0-9_-]{1,64}$/i.test(value.provider)
    && typeof value.model === 'string' && !!value.model.trim() && value.model.length <= 256
    && !/[\x00-\x1f\x7f]/.test(value.model)
    && Number.isSafeInteger(value.dimension) && value.dimension > 0 && value.dimension <= 65536
    && typeof value.endpointId === 'string' && /^[a-f0-9]{64}$/.test(value.endpointId);
}
export function sameEmbeddingSpace(a,b) {
  return validEmbeddingDescriptor(a) && validEmbeddingDescriptor(b)
    && ['version','provider','model','dimension','endpointId'].every(key=>a[key]===b[key]);
}
export function validMemoryVector(result,content) {
  if (!result || !validEmbeddingDescriptor(result.descriptor) || !Array.isArray(result.vector)
    || result.vector.length !== result.descriptor.dimension || !/^[a-f0-9]{64}$/.test(result.contentHash || '')) return false;
  if (content !== undefined && result.contentHash !== hashMemoryContent(content)) return false;
  let norm=0;
  for (const value of result.vector) {
    const packed=Math.fround(value);
    if (typeof value!=='number' || !Number.isFinite(value) || !Number.isFinite(packed)) return false;
    norm+=packed*packed;
  }
  return Number.isFinite(norm) && norm>0;
}
export function storedMemoryVector(row) {
  try {
    if (!row.embedding || row.embedding.length%4!==0 || !row.embedding_meta) return null;
    const meta=typeof row.embedding_meta==='string'?JSON.parse(row.embedding_meta):row.embedding_meta;
    const bytes=row.embedding;
    const vector=Array.from(new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)));
    const result={...meta,vector};
    return validMemoryVector(result,row.content)?result:null;
  }catch{return null;}
}
export function memoryCosine(a,b) {
  if(a.length!==b.length || !a.length)return null;
  let dot=0,aa=0,bb=0;
  for(let i=0;i<a.length;i++){dot+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i];}
  const result=dot/Math.sqrt(aa*bb);
  return Number.isFinite(result)?Math.max(-1,Math.min(1,result)):null;
}
