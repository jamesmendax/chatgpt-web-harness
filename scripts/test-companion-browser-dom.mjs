/** WP14 real-browser discovered regression: historical visible reply must not replace newer assistant progress. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { normalizeVisibleFeedbackLedger } from "../dist/lib/visible-feedback-ledger.js";

const dir=path.dirname(fileURLToPath(import.meta.url));
const helperCode=await fs.readFile(path.resolve(dir,"../browser-companion/visible-feedback-ledger.js"),"utf8");
const sandbox={};
vm.createContext(sandbox);
vm.runInContext(helperCode,sandbox);
const h=sandbox.HarnessVisibleFeedbackLedger;
const checks=[];
const old={status:"observed",signature:"historical:old-hash",source:"dom_observation"};
const fresh={status:"observed",signature:"newer:new-hash",source:"dom_observation"};
const evenNewer={status:"observed",signature:"later:additional",source:"dom_observation"};

const baseline=h.updateAssistantRenderRevision(null,"turn",old,1100);
assert.equal(baseline.revision,0);
assert.equal(baseline.event_time_ms,null);
checks.push("Pre-turn older assistant is only a baseline");

const current=h.updateAssistantRenderRevision(baseline,"turn",fresh,1200);
assert.equal(current.revision,1);
assert.equal(current.event_time_ms,1200);
checks.push("New assistant identity produces revision1 and event time1200");

const fallback=h.updateAssistantRenderRevision(current,"turn",old,1300);
assert.equal(fallback.revision,1,"Observed OLDER assistant after newer DOM node removed cannot be a fresh text revision");
assert.equal(fallback.signature,fresh.signature,"Keep original newest signature instead of demoting to history");
assert.equal(fallback.event_time_ms,1200,"DOM fallback cannot manufacture a new assistant event clock");
assert.equal(fallback.visible,false,"Historical fallback is not latest current-turn reply");
const restored=h.updateAssistantRenderRevision(fallback,"turn",fresh,1400);
assert.equal(restored.revision,1,"Unchanged newer message reinserted after historical fallback must not be new output");
assert.equal(restored.event_time_ms,1200);
assert.equal(restored.visible,true);
checks.push("Old visible answer on remove and unchanged new answer on reinsert cause no fresh revisions");

const second=h.updateAssistantRenderRevision(restored,"turn",evenNewer,1500);
assert.equal(second.revision,2);
assert.equal(second.event_time_ms,1500);
const intermediate=h.updateAssistantRenderRevision(second,"turn",fresh,1600);
assert.equal(intermediate.revision,2,"An already seen intermediate assistant should not advance revisions");
assert.equal(intermediate.visible,false);
const back=h.updateAssistantRenderRevision(intermediate,"turn",evenNewer,1700);
assert.equal(back.revision,2);
assert.equal(back.visible,true);
checks.push("Genuinely new signature increments and previous intermediate signature remains historical");

const ledger=h.buildVisibleFeedbackLedger({
  turn_id:"turn",turn_started_at_ms:1100,observed_at_ms:1800,
  rendered:evenNewer,render_state:back,
  mutation_revision:7,execution_revision:4,execution_event_time_ms:1700,
  generation_active:false,tool_inflight_count:0,
  transport:{state:"online",revision:2,event_time_ms:1800},
});
const normalized=normalizeVisibleFeedbackLedger(ledger,1900,null,"turn");
assert.equal(normalized.ok,true,normalized.ok?"":normalized.detail);
assert.equal(normalized.value.signals.assistant_text_rendered.revision,2);
assert.equal(normalized.value.signals.assistant_text_rendered.event_time_ms,1500);
assert.equal(normalized.value.signals.assistant_text_emitted.status,"unavailable");
checks.push("Four-signal downstream receipt retains DOM event1500 despite new transport ACK at1800");

console.log("A2 WP14 historical fallback anti-false-progress PASS:",checks.length,"groups");
for(const c of checks) console.log(" PASS",c);
