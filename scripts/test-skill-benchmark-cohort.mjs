import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { checkSkillBenchmarkCohort, normalizeSkillCatalogue } from "./skill-benchmark-cohort.mjs";

const sha = (letter) => letter.repeat(64);
const fixture = {
  catalog_sha256: sha("a"), skill_count: 2,
  skills: [
    {id:"alpha",content_sha256:sha("b"),allow_implicit:true,allow_explicit:true},
    {id:"manual",content_sha256:sha("c"),allow_implicit:false,allow_explicit:true},
  ],
};
const clone = (value) => structuredClone(value);
const checks = [];
assert.equal(checkSkillBenchmarkCohort(fixture,fixture,fixture).status,"CATALOG_MATCHED_ONLY");
assert.equal(checkSkillBenchmarkCohort(fixture,fixture,fixture).model_trial_accepted,false);
checks.push("matching frozen catalogue is a structural check only, never a model trial");

const beforeDrift = clone(fixture); beforeDrift.catalog_sha256 = sha("d");
assert.throws(()=>checkSkillBenchmarkCohort(fixture,beforeDrift,fixture),/A10_CATALOG_DRIFT/);
const afterDrift = clone(fixture); afterDrift.catalog_sha256 = sha("e");
assert.throws(()=>checkSkillBenchmarkCohort(fixture,fixture,afterDrift),/A10_CATALOG_DRIFT/);
checks.push("hash drift before or after trial blocks scoring");

const policyDrift = clone(fixture); policyDrift.skills[1].allow_implicit = true;
assert.throws(()=>checkSkillBenchmarkCohort(fixture,fixture,policyDrift),/A10_CATALOG_MEMBER_MISMATCH/);
const contentDrift = clone(fixture); contentDrift.skills[0].content_sha256 = sha("f");
assert.throws(()=>checkSkillBenchmarkCohort(fixture,contentDrift,fixture),/A10_CATALOG_MEMBER_MISMATCH/);
checks.push("stale top-level hash cannot conceal policy or content changes");

const short = clone(fixture); short.skills.pop();
assert.throws(()=>normalizeSkillCatalogue(short),/A10_CATALOG_INCOMPLETE/);
const partial = clone(fixture); partial.next_offset=1;
assert.throws(()=>normalizeSkillCatalogue(partial),/A10_CATALOG_INCOMPLETE/);
const duplicate = clone(fixture); duplicate.skills[1].id="alpha";
assert.throws(()=>normalizeSkillCatalogue(duplicate),/A10_CATALOG_INCOMPLETE/);
checks.push("partial/duplicated catalogue metadata fails closed");

const spoofed = clone(fixture);
spoofed.host_verified = true;
spoofed.independent_conversation = "fake-chat-id";
const admission=checkSkillBenchmarkCohort(fixture,spoofed,spoofed);
assert.equal(admission.independent_conversation_verified,false);
assert.equal(admission.model_trial_accepted,false);
checks.push("client/JSON self-asserted Host/session labels never count as independent trial proof");

if(process.argv[2] && process.argv[3]){
  const historical=JSON.parse(await fs.readFile(process.argv[2],"utf8"));
  const current=JSON.parse(await fs.readFile(process.argv[3],"utf8"));
  assert.equal(current.skill_count,36,"expected observed v36 fixture");
  assert.equal(checkSkillBenchmarkCohort(current,current,current).model_trial_accepted,false);
  assert.throws(()=>checkSkillBenchmarkCohort(historical,current,current),/A10_CATALOG_DRIFT/);
  checks.push("observed historical-35 vs current-36 archived catalogue drift rejected");
}
console.log(`A1.0 Skill cohort preflight PASS: ${checks.length} structural groups; independent trials NOT_RUN`);
for(const check of checks)console.log("  PASS",check);
