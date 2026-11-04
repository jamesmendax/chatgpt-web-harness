import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

process.env.CHATGPT_TOOL_PROFILE = "slim";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const tmpRoot = path.join(root, ".tool-test-tmp", "visual-review");
const workspace = path.join(tmpRoot, "workspace");
process.env.CODEX_HOME = path.join(tmpRoot, "codex-home");

await fs.rm(tmpRoot, { recursive: true, force: true });
await fs.mkdir(workspace, { recursive: true });

const svgPath = path.join(workspace, "relationship.svg");
const initialSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400">
  <rect width="640" height="400" fill="#f5f7fa"/>
  <circle id="left" cx="180" cy="200" r="82" fill="#3b82f6"/>
  <circle id="right" cx="460" cy="200" r="82" fill="#f59e0b"/>
  <path id="connector" d="M262 200H378" stroke="#1f2937" stroke-width="18" stroke-linecap="round"/>
</svg>`;
await fs.writeFile(svgPath, initialSvg, "utf-8");

const htmlPath = path.join(workspace, "page.html");
await fs.writeFile(
  htmlPath,
  `<!doctype html><html><head><title>Visual harness</title><style>
  body{margin:0;background:#eef2f7;font:24px sans-serif}.hero{margin:40px;padding:32px;background:white;border-radius:18px}
  .card{width:320px;height:140px;background:#22c55e;display:grid;place-items:center;color:white;border-radius:14px}
  </style></head><body><main class="hero"><h1>Universal review</h1><div id="card" class="card">Rendered UI</div></main></body></html>`,
  "utf-8"
);

const pngPath = path.join(workspace, "pixel.png");
await fs.writeFile(
  pngPath,
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlTtGQAAAAASUVORK5CYII=", "base64")
);

const { createMcpServer } = await import("../dist/server-factory.js");
const { findVisualBrowserExecutable } = await import("../dist/lib/visual-harness.js");
const server = createMcpServer(workspace, 30_000, [workspace], true);
const client = new Client({ name: "visual-review-test", version: "1" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

const TEST_INTENT = JSON.stringify({
  intent_revision: 1,
  objective: "Exercise isolated visual-review and stale-render fixtures",
  scope: ["temporary visual-review workspace and generated review state"],
  out_of_scope: [], deliverables: ["visual review quality, freshness, and coverage assertions"],
  success_criteria: ["review, critique, assessment, and fixture mutations behave deterministically"],
  constraints: [], protected_resources: [], known_facts: ["all file mutations are confined to tmpRoot"],
  assumptions: [], delegated_decisions: [], remaining_nonblocking_uncertainties: [],
  closure_items: [], ambiguities: [], clarification_round: 0, questions_in_round: 0,
  resolution_mode: "none",
});

const rawCallTool = (request) => client.callTool(request);
function callTool(request) {
  const visualMutation = request?.name === "visual_review" && request?.arguments?.action !== "status";
  const fileMutation = request?.name === "write_file";
  if (!visualMutation && !fileMutation) return rawCallTool(request);
  return rawCallTool({
    ...request,
    arguments: { ...(request.arguments ?? {}), _intent: TEST_INTENT },
  });
}

function data(result) {
  if (!result?.structuredContent?.ok) throw new Error(JSON.stringify(result?.structuredContent || result));
  return result.structuredContent.data;
}

function imageBlocks(result) {
  return (result.content || []).filter((block) => block.type === "image");
}

const strongQualityScores = {
  task_fidelity: 4.5,
  composition: 4.25,
  visual_hierarchy: 4.25,
  coherence: 4.5,
  craft_precision: 4.25,
  professional_readiness: 4.25,
};

async function critiqueReview(reviewId, options = {}) {
  const worthwhile = options.worthwhile === true;
  return data(await callTool({
    name: "visual_review",
    arguments: {
      action: "critique",
      review_id: reviewId,
      inspected_full_render: true,
      first_impression: options.firstImpression || "polished",
      delivery_recommendation: options.recommendation || "accept",
      quality_scores: options.scores || strongQualityScores,
      critical_issues: options.criticalIssues || [],
      major_issues: options.majorIssues || [],
      minor_issues: options.minorIssues || [],
      strengths: options.strengths || ["The rendered artifact is coherent and presentation-ready at the locked quality bar."],
      improvement_opportunities: worthwhile
        ? (options.improvementOpportunities || ["One concrete, high-value visual refinement remains worthwhile."])
        : [],
      further_improvement_worthwhile: worthwhile,
      assessment_summary: options.summary || "External-reviewer Critic inspected the real rendered pixels independently of creator effort.",
    },
  }));
}

try {
  const listed = await client.listTools();
  const names = new Set(listed.tools.map((tool) => tool.name));
  if (!names.has("visual_review")) throw new Error("visual_review missing from slim");
  const visualTool = listed.tools.find((tool) => tool.name === "visual_review");
  const visualProperties = visualTool?.inputSchema?.properties || {};
  for (const field of [
    "quality_bar",
    "first_impression",
    "delivery_recommendation",
    "quality_scores",
    "critical_issues",
    "major_issues",
    "minor_issues",
    "comparison",
    "strengths",
    "improvement_opportunities",
    "further_improvement_worthwhile",
  ]) {
    if (!(field in visualProperties)) throw new Error(`visual_review universal quality schema field missing: ${field}`);
  }
  if (names.has("open_image") || names.has("render_svg") || names.has("capture_webpage")) {
    throw new Error("legacy visual primitives should stay hidden in slim");
  }

  const reviewed = await callTool({
    name: "visual_review",
    arguments: {
      target: svgPath,
      width: 640,
      height: 400,
      focus: [{ label: "circle relationship", selector: "#left", pair_selector: "#right" }],
      max_images: 4,
    },
  });
  const first = data(reviewed);
  if (first.kind !== "svg" || !first.review_id) throw new Error("SVG review metadata missing");
  if (first.visual_status !== "rendered_current" || first.model_visual_status !== "pending") throw new Error("new render/semantic status split missing");
  if (reviewed.content?.[0]?.type !== "image") throw new Error("full render pixels are not the first tool content block");
  if (imageBlocks(reviewed).length < 2) throw new Error("SVG review did not return overview and focus pixels");
  const focus = first.diagnostics?.focus?.[0];
  if (!focus?.found || !(focus.distance_px > 0) || !focus.crop_path) throw new Error("selector geometry/focus crop missing");
  if (first.machine_blocking_issues.length !== 0) throw new Error(`unexpected SVG issue: ${first.machine_blocking_issues.join("; ")}`);

  const fresh = data(await callTool({
    name: "visual_review",
    arguments: { action: "status", review_id: first.review_id },
  }));
  if (!fresh.fresh || !fresh.verifiable || !fresh.machine_ready || fresh.model_visual_ready || fresh.model_visual_status !== "pending") throw new Error("fresh review status invalid");

  // Draft is intentionally lenient: a major issue with recommendation=revise
  // remains non-contradictory at the draft bar. The first Critic write must
  // still win deterministically when two callers race on one review_id.
  const draftReview = data(await callTool({
    name: "visual_review",
    arguments: { target: svgPath, quality_bar: "draft", width: 640, height: 400 },
  }));
  const draftCritiqueArguments = {
    action: "critique",
    review_id: draftReview.review_id,
    inspected_full_render: true,
    first_impression: "rough",
    delivery_recommendation: "revise",
    quality_scores: {
      task_fidelity: 3,
      composition: 3,
      visual_hierarchy: 3,
      coherence: 3,
      craft_precision: 3,
      professional_readiness: 3,
    },
    major_issues: ["A draft still needs a major composition refinement."],
    strengths: ["The exploratory structure is visible."],
    further_improvement_worthwhile: false,
  };
  const concurrentDraftCritiques = await Promise.all([
    callTool({ name: "visual_review", arguments: draftCritiqueArguments }),
    callTool({ name: "visual_review", arguments: draftCritiqueArguments }),
  ]);
  const successfulDraftCritiques = concurrentDraftCritiques.filter((result) => result.structuredContent?.ok === true);
  const rejectedDraftCritiques = concurrentDraftCritiques.filter((result) => result.structuredContent?.ok === false);
  if (successfulDraftCritiques.length !== 1 || rejectedDraftCritiques.length !== 1 || !JSON.stringify(rejectedDraftCritiques[0]).includes("Critic decision is immutable")) {
    throw new Error("concurrent Critic writes were not serialized with immutable first-writer semantics");
  }
  const draftCritiqueData = successfulDraftCritiques[0].structuredContent.data;
  if (draftCritiqueData.model_visual_quality_gate.status !== "acceptable") {
    throw new Error("draft quality bar incorrectly rejected a major issue with recommendation=revise");
  }
  const draftAssessment = data(await callTool({
    name: "visual_review",
    arguments: {
      action: "assess",
      review_id: draftReview.review_id,
      verdict: "pass",
      inspected_full_render: true,
      further_improvement_worthwhile: false,
      assessment_summary: "Draft gate regression: exploratory work may retain a major issue when it is not recommended for acceptance.",
    },
  }));
  if (!draftAssessment.model_visual_ready || !draftAssessment.model_visual_iteration_ready) {
    throw new Error("draft review did not expose server-calculated ready evidence after a valid assessment");
  }

  const html = await callTool({
    name: "visual_review",
    arguments: { target: htmlPath, width: 900, height: 600, focus: [{ selector: "#card" }], full_page: true },
  });
  const htmlData = data(html);
  if (htmlData.kind !== "html" || htmlData.diagnostics.page_errors.length !== 0 || htmlData.diagnostics.console_errors.length !== 0) {
    throw new Error("HTML runtime diagnostics invalid");
  }
  if (imageBlocks(html).length < 2) throw new Error("HTML review did not return focus image");

  const slowFontServer = http.createServer((req, res) => {
    if (req.url === "/never.woff2") return;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><style>@font-face{font-family:Never;src:url('/never.woff2') format('woff2')}body{font-family:Never,sans-serif;font-size:48px}</style></head><body>bounded visual timeout</body></html>`);
  });
  await new Promise((resolve, reject) => {
    slowFontServer.once("error", reject);
    slowFontServer.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = slowFontServer.address();
    if (!address || typeof address === "string") throw new Error("slow-font test server did not bind");
    const startedAt = Date.now();
    const boundedReview = await callTool({
      name: "visual_review",
      arguments: { target: `http://127.0.0.1:${address.port}/`, width: 640, height: 400, timeout_ms: 1000 },
    });
    const elapsed = Date.now() - startedAt;
    if (elapsed > 8000) throw new Error(`visual_review timeout watchdog exceeded bound: ${elapsed}ms`);
    const boundedPayload = boundedReview.structuredContent;
    if (boundedPayload?.ok !== true && boundedPayload?.ok !== false) throw new Error("bounded visual review returned no stable tool envelope");
  } finally {
    slowFontServer.closeAllConnections?.();
    await new Promise((resolve) => slowFontServer.close(() => resolve()));
  }

  const imageReview = await callTool({ name: "visual_review", arguments: { target: pngPath, width: 640, height: 400 } });
  const imageReviewData = data(imageReview);
  if (imageReviewData.kind !== "image" || imageBlocks(imageReview).length !== 1) throw new Error("image review failed");

  const selfReportedPassWithoutCritic = await callTool({
    name: "visual_review",
    arguments: {
      action: "assess",
      review_id: imageReviewData.review_id,
      verdict: "pass",
      inspected_full_render: true,
      further_improvement_worthwhile: false,
    },
  });
  if (
    selfReportedPassWithoutCritic.structuredContent?.ok !== false ||
    !JSON.stringify(selfReportedPassWithoutCritic).includes("VISUAL_CRITIQUE_REQUIRED")
  ) {
    throw new Error("creator self-reported PASS was accepted without an independent Critic phase");
  }

  const lowQualityCritique = await critiqueReview(imageReviewData.review_id, {
    firstImpression: "rough",
    recommendation: "revise",
    scores: {
      task_fidelity: 3,
      composition: 2.25,
      visual_hierarchy: 2,
      coherence: 2.5,
      craft_precision: 1.75,
      professional_readiness: 1.5,
    },
    majorIssues: ["The artifact is visibly rough and not ready to be handed to a user as a finished result."],
    worthwhile: true,
    improvementOpportunities: ["Rework the visible composition and craft to reach a presentable finished-product standard."],
    summary: "Negative benchmark: recognizable/renderable does not imply acceptable visual quality.",
  });
  if (lowQualityCritique.model_visual_quality_gate.status !== "failed") {
    throw new Error("low-quality Critic benchmark was not rejected by the server quality gate");
  }
  const reCritiqueSamePixels = await callTool({
    name: "visual_review",
    arguments: {
      action: "critique",
      review_id: imageReviewData.review_id,
      inspected_full_render: true,
      first_impression: "polished",
      delivery_recommendation: "accept",
      quality_scores: strongQualityScores,
      critical_issues: [],
      major_issues: [],
      minor_issues: [],
      strengths: ["Attempted post-hoc self-approval."],
      improvement_opportunities: [],
      further_improvement_worthwhile: false,
    },
  });
  if (
    reCritiqueSamePixels.structuredContent?.ok !== false ||
    !JSON.stringify(reCritiqueSamePixels).includes("Critic decision is immutable")
  ) {
    throw new Error("creator could overwrite a low-quality Critic decision on the same pixels");
  }
  const lowQualitySemanticPass = data(await callTool({
    name: "visual_review",
    arguments: {
      action: "assess",
      review_id: imageReviewData.review_id,
      verdict: "pass",
      inspected_full_render: true,
      improvement_opportunities: ["Rework the visible composition and craft to reach a presentable finished-product standard."],
      further_improvement_worthwhile: true,
      assessment_summary: "Semantically recognizable, but the Critic quality gate remains authoritative.",
    },
  }));
  if (
    lowQualitySemanticPass.model_visual_semantic_status !== "pass" ||
    lowQualitySemanticPass.model_visual_quality_status !== "failed" ||
    lowQualitySemanticPass.model_visual_iteration_ready
  ) {
    throw new Error("semantic PASS incorrectly overrode a failed finished-product visual quality gate");
  }

  const contradictoryCritique = await callTool({
    name: "visual_review",
    arguments: {
      action: "critique",
      review_id: htmlData.review_id,
      inspected_full_render: true,
      first_impression: "acceptable",
      delivery_recommendation: "accept",
      quality_scores: strongQualityScores,
      critical_issues: [],
      major_issues: [],
      minor_issues: [],
      strengths: ["The page renders correctly."],
      improvement_opportunities: ["A clearly worthwhile improvement still remains."],
      further_improvement_worthwhile: false,
    },
  });
  if (
    contradictoryCritique.structuredContent?.ok !== false ||
    !JSON.stringify(contradictoryCritique).includes("VISUAL_CRITIQUE_CONTRADICTION")
  ) {
    throw new Error("contradictory Critic assessment did not fail closed");
  }

  const browserPath = findVisualBrowserExecutable();
  if (!browserPath) throw new Error("test requires installed Edge/Chrome/Chromium");
  const pdfPath = path.join(workspace, "document.pdf");
  const browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ["--disable-gpu"] });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await page.setContent('<main style="font:36px sans-serif;padding:60px"><h1>PDF visual review</h1><p>Page rendering evidence.</p></main>');
    await page.pdf({ path: pdfPath, format: "A4", printBackground: true });
  } finally {
    await browser.close();
  }
  const pdfReview = await callTool({ name: "visual_review", arguments: { target: pdfPath, pages: [1], width: 1000, height: 1000 } });
  const pdfData = data(pdfReview);
  if (pdfData.kind !== "pdf" || pdfData.page_paths.length !== 1 || imageBlocks(pdfReview).length < 1) throw new Error("PDF review failed");

  const task = data(await callTool({
    name: "task_state",
    arguments: { action: "create", goal: "Verify stale visual review enforcement", visual_required: true },
  }));
  const taskId = task.handoff.task_id;
  const taskReview = data(await callTool({
    name: "visual_review",
    arguments: { target: svgPath, width: 640, height: 400 },
  }));
  const taskCritique = await critiqueReview(taskReview.review_id);
  if (taskCritique.model_visual_quality_gate.status !== "acceptable") throw new Error("normal high-quality Critic path did not clear the server quality gate");
  await callTool({
    name: "visual_review",
    arguments: {
      action: "assess",
      review_id: taskReview.review_id,
      verdict: "pass",
      inspected_full_render: true,
      further_improvement_worthwhile: false,
      assessment_summary: "Initial render inspected for stale-source guard test.",
    },
  });
  await callTool({
    name: "write_file",
    arguments: { path: svgPath, content: initialSvg.replace("#3b82f6", "#8b5cf6") },
  });
  const staleComplete = await callTool({ name: "task_state", arguments: { action: "complete", task_id: taskId } });
  if (staleComplete.structuredContent?.ok !== false || !JSON.stringify(staleComplete).includes("Source changed")) {
    throw new Error("stale visual review did not block completion");
  }

  const finalReviewResult = await callTool({
    name: "visual_review",
    arguments: { target: svgPath, width: 640, height: 400, compare_to: taskReview.review_id, max_images: 3 },
  });
  const finalReview = data(finalReviewResult);
  if (!finalReview.comparison_path || !(finalReview.diagnostics.comparison.changed_pixel_ratio > 0)) {
    throw new Error("before-after comparison evidence missing");
  }
  if (imageBlocks(finalReviewResult).length < 2) throw new Error("comparison pixels not returned");

  const pendingComplete = await callTool({ name: "task_state", arguments: { action: "complete", task_id: taskId } });
  if (pendingComplete.structuredContent?.ok !== false || !JSON.stringify(pendingComplete).includes("semantically inspected")) {
    throw new Error("unassessed rendered pixels did not block completion");
  }

  await callTool({
    name: "visual_review",
    arguments: {
      action: "assess",
      review_id: finalReview.review_id,
      verdict: "fail",
      inspected_full_render: true,
      issues: ["Seeded visual issue for completion-gate test"],
      comparison: "regressed",
    },
  });
  const failedAssessmentComplete = await callTool({ name: "task_state", arguments: { action: "complete", task_id: taskId } });
  if (failedAssessmentComplete.structuredContent?.ok !== false || !JSON.stringify(failedAssessmentComplete).includes("model visual assessment failed")) {
    throw new Error("failed model visual assessment did not block completion");
  }

  const reclassify = await callTool({
    name: "visual_review",
    arguments: {
      action: "assess",
      review_id: finalReview.review_id,
      verdict: "pass",
      inspected_full_render: true,
      comparison: "improved",
      strengths: ["Seeded comparison evidence"],
      further_improvement_worthwhile: false,
    },
  });
  if (reclassify.structuredContent?.ok !== false || !JSON.stringify(reclassify).includes("cannot be reclassified")) {
    throw new Error("failed render could be reclassified without a fresh visual review");
  }

  await callTool({
    name: "write_file",
    arguments: { path: svgPath, content: initialSvg.replace("#3b82f6", "#10b981") },
  });
  const improvableReview = data(await callTool({
    name: "visual_review",
    arguments: { target: svgPath, width: 640, height: 400, compare_to: finalReview.review_id, max_images: 3 },
  }));
  await critiqueReview(improvableReview.review_id, {
    worthwhile: true,
    improvementOpportunities: ["One more deliberate visual refinement remains worthwhile."],
  });
  const improvableAssessment = data(await callTool({
    name: "visual_review",
    arguments: {
      action: "assess",
      review_id: improvableReview.review_id,
      verdict: "pass",
      inspected_full_render: true,
      comparison: "improved",
      strengths: ["The new version visibly improves the seeded color treatment."],
      improvement_opportunities: ["One more deliberate visual refinement remains worthwhile."],
      further_improvement_worthwhile: true,
      assessment_summary: "Fresh full render and comparison inspected; acceptable, improved, but still worth one more iteration.",
    },
  }));
  if (improvableAssessment.model_visual_assessment.comparison !== "improved" || improvableAssessment.model_visual_assessment.further_improvement_worthwhile !== true) {
    throw new Error("V3 improvement assessment fields were not persisted");
  }
  if (improvableAssessment.model_visual_iteration.current_iteration !== 3 || improvableAssessment.model_visual_iteration.max_iterations !== 5 || improvableAssessment.model_visual_iteration.limit_reached) {
    throw new Error("V3 visual iteration state did not report iteration 3 of 5 correctly");
  }
  if (!improvableAssessment.model_visual_iteration.continuation_required || improvableAssessment.model_visual_iteration.termination_reason !== "continue") {
    throw new Error("worthwhile improvement before iteration 5 did not require continuation");
  }
  const improvableComplete = await callTool({ name: "task_state", arguments: { action: "complete", task_id: taskId } });
  if (improvableComplete.structuredContent?.ok !== false || !JSON.stringify(improvableComplete).includes("iteration 4 of 5")) {
    throw new Error("improvable passing visual review did not block final completion");
  }
  const skipIteration = await callTool({
    name: "visual_review",
    arguments: {
      action: "assess",
      review_id: improvableReview.review_id,
      verdict: "pass",
      inspected_full_render: true,
      comparison: "improved",
      strengths: ["The new version visibly improves the seeded color treatment."],
      further_improvement_worthwhile: false,
    },
  });
  if (skipIteration.structuredContent?.ok !== false) {
    throw new Error("same rendered pixels could erase a worthwhile-improvement decision without revision");
  }

  await callTool({
    name: "write_file",
    arguments: { path: svgPath, content: initialSvg.replace("#3b82f6", "#14b8a6") },
  });
  const passedReview = data(await callTool({
    name: "visual_review",
    arguments: { target: svgPath, width: 640, height: 400, compare_to: improvableReview.review_id, max_images: 3 },
  }));
  await critiqueReview(passedReview.review_id, {
    worthwhile: true,
    improvementOpportunities: ["A final bounded refinement remains worthwhile before the hard cap."],
  });
  const passedAssessment = data(await callTool({
    name: "visual_review",
    arguments: {
      action: "assess",
      review_id: passedReview.review_id,
      verdict: "pass",
      inspected_full_render: true,
      comparison: "improved",
      strengths: ["The follow-up version is visibly cleaner than the prior accepted version."],
      improvement_opportunities: ["A final bounded refinement remains worthwhile before the hard cap."],
      further_improvement_worthwhile: true,
      assessment_summary: "Fresh full render and comparison inspected; the fourth visual version is improved but still worth one final bounded refinement.",
    },
  }));
  if (passedAssessment.model_visual_assessment.comparison !== "improved" || passedAssessment.model_visual_assessment.further_improvement_worthwhile !== true) {
    throw new Error("iteration 4 did not preserve worthwhile improvement state");
  }
  if (passedAssessment.model_visual_iteration.current_iteration !== 4 || passedAssessment.model_visual_iteration.limit_reached || !passedAssessment.model_visual_iteration.continuation_required) {
    throw new Error("iteration 4 should still require continuation when worthwhile improvement remains");
  }
  const fourthComplete = await callTool({ name: "task_state", arguments: { action: "complete", task_id: taskId } });
  if (fourthComplete.structuredContent?.ok !== false || !JSON.stringify(fourthComplete).includes("iteration 5 of 5")) {
    throw new Error("iteration 4 worthwhile improvement did not block completion before the cap");
  }

  await callTool({
    name: "write_file",
    arguments: { path: svgPath, content: initialSvg.replace("#3b82f6", "#0f766e") },
  });
  const cappedReview = data(await callTool({
    name: "visual_review",
    arguments: { target: svgPath, width: 640, height: 400, compare_to: passedReview.review_id, max_images: 3 },
  }));
  await critiqueReview(cappedReview.review_id, {
    worthwhile: true,
    improvementOpportunities: ["A theoretical sixth polish could exist, but autonomous refinement must stop at the configured cap."],
  });
  const cappedAssessment = data(await callTool({
    name: "visual_review",
    arguments: {
      action: "assess",
      review_id: cappedReview.review_id,
      verdict: "pass",
      inspected_full_render: true,
      comparison: "improved",
      strengths: ["The fifth bounded version visibly improves the prior treatment."],
      improvement_opportunities: ["A theoretical sixth polish could exist, but autonomous refinement must stop at the configured cap."],
      further_improvement_worthwhile: true,
      assessment_summary: "The fifth visual version still has theoretical improvement potential, but the universal autonomous iteration cap has been reached.",
    },
  }));
  const cappedIteration = cappedAssessment.model_visual_iteration;
  if (cappedIteration.current_iteration !== 5 || cappedIteration.max_iterations !== 5 || !cappedIteration.limit_reached) {
    throw new Error("visual iteration cap did not report iteration 5 of 5");
  }
  if (cappedIteration.continuation_required || cappedIteration.termination_reason !== "max_iterations_reached") {
    throw new Error("iteration 5 should stop autonomous continuation even when improvement remains worthwhile");
  }
  if (cappedAssessment.model_visual_quality_status !== "ready" || !cappedAssessment.model_visual_iteration_ready) {
    throw new Error("passing iteration 5 did not become delivery-ready under the hard cap");
  }
  const completed = data(await callTool({ name: "task_state", arguments: { action: "complete", task_id: taskId } }));
  if (!completed.deliverable_ready || completed.handoff.status !== "completed") throw new Error("iteration 5 hard cap did not allow a passing fresh covered artifact to complete");

  const multiPagePath = path.join(workspace, "multi-page.pdf");
  const multiPageBrowser = await chromium.launch({ executablePath: browserPath, headless: true, args: ["--disable-gpu"] });
  try {
    const page = await multiPageBrowser.newPage({ viewport: { width: 900, height: 600 } });
    const sections = Array.from({ length: 14 }, (_, index) => `<section style="break-after:page;height:900px;font:42px sans-serif;padding:70px"><h1>Visual page ${index + 1}</h1></section>`).join("");
    await page.setContent(`<html><body style="margin:0">${sections}</body></html>`);
    await page.pdf({ path: multiPagePath, width: "900px", height: "1100px", printBackground: true });
  } finally {
    await multiPageBrowser.close();
  }
  const batchOne = data(await callTool({ name: "visual_review", arguments: { target: multiPagePath, width: 900, height: 1000, max_images: 12, timeout_ms: 90_000 } }));
  if (batchOne.page_count < 14 || batchOne.delivered_pages.length !== 12 || batchOne.delivered_pages[0] !== 1 || batchOne.delivered_pages[11] !== 12) {
    throw new Error(`paged visual review did not return the first consecutive batch: ${JSON.stringify(batchOne.delivered_pages)}`);
  }
  await critiqueReview(batchOne.review_id);
  const batchOneAssessment = data(await callTool({
    name: "visual_review",
    arguments: { action: "assess", review_id: batchOne.review_id, verdict: "pass", inspected_full_render: true, further_improvement_worthwhile: false, assessment_summary: "Inspected all first-batch page images." },
  }));
  if (batchOneAssessment.model_visual_coverage.complete || !batchOneAssessment.model_visual_coverage.missing_pages.includes(13)) {
    throw new Error("partial multi-page visual coverage was incorrectly marked complete");
  }
  const batchTwo = data(await callTool({ name: "visual_review", arguments: { target: multiPagePath, pages: [13, 14], width: 900, height: 1000, max_images: 12, timeout_ms: 90_000 } }));
  await critiqueReview(batchTwo.review_id);
  const batchTwoAssessment = data(await callTool({
    name: "visual_review",
    arguments: { action: "assess", review_id: batchTwo.review_id, verdict: "pass", inspected_full_render: true, further_improvement_worthwhile: false, assessment_summary: "Inspected the remaining full page images." },
  }));
  if (!batchTwoAssessment.model_visual_coverage.complete || batchTwoAssessment.model_visual_coverage.passed_pages.length < 14) {
    throw new Error("multi-page visual coverage did not accumulate across review batches");
  }

  console.log(`visual-review: direct pixels, semantic gate, iterative improvement loop, full multi-page coverage, SVG/HTML/image/PDF, comparison, freshness, and task completion guard OK (${listed.tools.length} slim tools)`);
} finally {
  await client.close().catch(() => undefined);
  await server.close().catch(() => undefined);
  if (process.env.KEEP_VISUAL_TEST_ARTIFACTS !== "1") await fs.rm(tmpRoot, { recursive: true, force: true });
}
