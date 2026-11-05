import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/server-factory.js';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'wh-v32-visual-'));
const root = path.join(temp, 'workspace');
await fs.mkdir(root);
process.env.CODEX_HOME = path.join(temp, 'state');
process.env.CHATGPT_TOOL_PROFILE = 'full';
process.env.GOAL_WATCHDOG_ENABLED = 'false';
const target = path.join(root, 'review.svg');
await fs.writeFile(target, '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="#2470aa"/></svg>');
const server = createMcpServer(root, 10000, [root], false);
const client = new Client({name:'v32-visual',version:'1'});
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport); await client.connect(clientTransport);
const call = (name:string, args:Record<string,unknown>) => client.callTool({name,arguments:args,_meta:{'openai/session':'v32-visual-session'}});
const data = (result:any) => { assert.equal(result.structuredContent?.ok,true,JSON.stringify(result.structuredContent)); return result.structuredContent.data; };
try {
  const review = await call('visual_review',{action:'review',target,width:640,height:400});
  assert.ok(review.content.some((item:any) => item.type === 'image' && item.data), 'real rendered pixels must be returned');
  const reviewId = data(review).review_id;
  const initialStatus = data(await call('visual_review',{action:'status'}));
  assert.equal(initialStatus.record.id, reviewId, 'trusted session defaults to latest review');
  const assessed = data(await call('visual_review',{action:'assess',review_id:reviewId,verdict:'pass',inspected_full_render:true}));
  assert.equal(assessed.model_visual_assessment.verdict,'pass', 'assessment does not require prior critique');
  const scores = {task_fidelity:2,composition:2,visual_hierarchy:2,coherence:2,craft_precision:2,professional_readiness:2};
  data(await call('visual_review',{action:'critique',review_id:reviewId,inspected_full_render:true,first_impression:'rough',delivery_recommendation:'revise',quality_scores:scores}));
  data(await call('visual_review',{action:'assess',review_id:reviewId,verdict:'fail',inspected_full_render:true,issues:['Revised evaluation']}));
  const revised = data(await call('visual_review',{action:'status',review_id:reviewId}));
  assert.equal(revised.record.model_visual_assessment.verdict,'fail');
  assert.equal(revised.record.review_history.length,3);
  const withdrawn = data(await call('visual_review',{action:'withdraw',review_id:reviewId,assessment_summary:'Correction'}));
  assert.equal(withdrawn.record.model_visual_assessment,undefined);
  assert.equal(withdrawn.record.review_history.length,4);
  await fs.writeFile(target, '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="#cc5500"/></svg>');
  const stale = await call('visual_review',{action:'assess',review_id:reviewId,verdict:'pass',inspected_full_render:true});
  assert.equal(stale.structuredContent?.ok,false, 'changed artifact cannot reuse stale inspection');
  assert.match(JSON.stringify(stale.structuredContent),/VISUAL_REVIEW_STALE/);
  console.log('PASS v3.2 real SVG render, trusted status, unordered revision, withdrawal and stale-source detection');
} finally {
  await client.close(); await server.close(); await fs.rm(temp,{recursive:true,force:true});
}
