import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createIssueThreadInteractionSchema, requestConfirmationPayloadSchema } from '@paperclipai/shared';
import { readDocumentReviewEvidence } from '../services/document-review-evidence.js';
import { documentReadResult } from '../services/native-runtime/document-read-receipt.js';
import { redactPaperclipSemanticValue } from '../../../packages/paperclip-runner/src/semantic-tools/redaction.js';

const binding={companyId:randomUUID(),issueId:randomUUID(),agentId:randomUUID(),runId:randomUUID()};
const revisionId=randomUUID();
const document={id:randomUUID(),key:'root-technical-return',latestRevisionId:revisionId,latestRevisionNumber:1,
  body:'あ😀'.repeat(Math.floor(528471/7))+'x'.repeat(528471%7)};
const sha=(s:string)=>createHash('sha256').update(Buffer.from(s,'utf8')).digest('hex');
describe('fixed supporting evidence contract',()=>{
  it('retains the entire supporting tuple through public schema save and readback',()=>{
    const supportingDocuments=[{companyId:binding.companyId,issueId:binding.issueId,documentId:document.id,
      key:document.key,revisionId,revisionNumber:1}];
    const request={kind:'request_confirmation',addresseeAgentId:binding.agentId,
      payload:{version:1,prompt:'SYNTHETIC fixed supporting evidence',target:{type:'issue_document',issueId:binding.issueId,
        documentId:randomUUID(),key:'main-target',revisionId:randomUUID()},supportingDocuments}};
    const parsed=createIssueThreadInteractionSchema.parse(request);
    const saved=JSON.parse(JSON.stringify(parsed));
    const read=requestConfirmationPayloadSchema.parse(saved.payload);
    expect(read.supportingDocuments).toEqual(supportingDocuments);
    expect(read.target).toEqual(request.payload.target);
    if(process.env.QA_SCOPE_OUTPUT) writeFileSync(process.env.QA_SCOPE_OUTPUT,JSON.stringify({synthetic:true,request,parsed,saved,read},null,2)+'\n');
  });
  it.each(['omitted', 'null', 'same', 'foreign'] as const)(
    'resolves an empty evidence target issueId consistently: %s', async mode => {
      const target = { type: 'issue_document' as const, documentId: randomUUID(), key: 'target', revisionId: randomUUID(),
        ...(mode === 'omitted' ? {} : { issueId: mode === 'null' ? null : mode === 'same' ? binding.issueId : randomUUID() }) };
      const db = { select: () => { throw new Error('empty evidence must not query the database'); } };
      const result = await readDocumentReviewEvidence(db as any, { companyId: binding.companyId,
        issueId: binding.issueId, reviewerId: binding.agentId,
        payload: { version: 1, prompt: 'Synthetic target issue default', target, supportingDocuments: [] } });
      expect(result).toEqual(mode === 'foreign' ? null : []);
    });
  it('delivers all 528471 synthetic UTF8 bytes through bounded ranges and real semantic redaction',()=>{
    const chunks:string[]=[], receipts:unknown[]=[];let offset=0;
    for (;;) {
      const raw=documentReadResult(binding,document,{revisionId,offsetBytes:offset,maxBytes:16384});
      const output=redactPaperclipSemanticValue(raw) as any;
      expect(output.range.returnedBytes).toBe(Buffer.byteLength(output.document.body));
      expect(output.range.chunkSha256).toBe(sha(output.document.body));
      expect(output.readReceipt.bodySha256).toBe(sha(document.body));
      expect(output.readReceipt.bodyBytes).toBe(528471);
      chunks.push(output.document.body);receipts.push({readReceipt:output.readReceipt,range:output.range});
      if (output.range.nextOffsetBytes===null) break;
      expect(output.range.nextOffsetBytes).toBeGreaterThan(offset);offset=output.range.nextOffsetBytes;
    }
    expect(chunks.join('')).toBe(document.body);
    expect(sha(chunks.join(''))).toBe(sha(document.body));
    if(process.env.QA_EVIDENCE_OUTPUT) writeFileSync(process.env.QA_EVIDENCE_OUTPUT,JSON.stringify({synthetic:true,
      bodyBytes:Buffer.byteLength(document.body),bodySHA256:sha(document.body),receipts},null,2)+'\n');
  });
  it.each(['companyId','issueId','authorAgentId','scope'])('rejects unknown supporting tuple field %s',key=>{
    const item={companyId:binding.companyId,issueId:binding.issueId,documentId:document.id,key:document.key,
      revisionId,revisionNumber:1,...(key==='companyId'||key==='issueId'?{[key]:'not-a-uuid'}:{[key]:'self-authorized'})};
    expect(requestConfirmationPayloadSchema.safeParse({version:1,prompt:'Synthetic',supportingDocuments:[item]}).success).toBe(false);
  });
  it('rejects a caller revision different from the assigned revision',()=>{
    expect(()=>documentReadResult(binding,document,{revisionId:randomUUID(),offsetBytes:0,maxBytes:16384})).toThrow('invalid_document_read_range');
  });
  it('rejects a range without a saved revision identity',()=>{
    expect(()=>documentReadResult(binding,{...document,latestRevisionId:null},{revisionId:null,offsetBytes:0,maxBytes:16384})).toThrow('invalid_document_read_range');
  });
  it('rejects a split UTF8 offset rather than fabricating replacement characters',()=>{
    expect(()=>documentReadResult(binding,document,{revisionId,offsetBytes:1,maxBytes:16384})).toThrow('invalid_document_read_utf8_offset');
  });
  it('rejects protected content before splitting even across a chunk boundary',()=>{
    const secret={...document,body:'x'.repeat(16380)+' sk_'+'a'.repeat(30)};
    expect(()=>documentReadResult(binding,secret,{revisionId,offsetBytes:0,maxBytes:16384})).toThrow('document_read_range_protected_data');
  });
});
