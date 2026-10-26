import {createHash} from 'node:crypto';
export const sha256=text=>createHash('sha256').update(text,'utf8').digest('hex');
// Input schema permits one string field. JSON.stringify is canonical for this fixed shape.
export const inputHash=(input,nonce)=>sha256(`${nonce};${JSON.stringify({prompt:input.prompt})}`);
export const resultHash=(result,nonce)=>sha256(`${nonce};${result}`);
