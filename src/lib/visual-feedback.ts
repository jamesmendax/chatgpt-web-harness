import type { VisualReviewFreshness, VisualReviewRecord } from "./visual-review-state.js";
import { visualQualityRequirements } from "./visual-review-state.js";

export function visualActionInputGuide(action: string, record?: VisualReviewRecord): Record<string, unknown> {
  if (action === "review") return { required_fields: ["target"] };
  if (action === "status") return { required_fields: ["review_id"] };
  if (action === "critique") return {
    required_fields: ["review_id", "inspected_full_render", "first_impression", "delivery_recommendation", "quality_scores", "further_improvement_worthwhile"],
    supply_after_inspection: ["inspected_full_render", "first_impression", "delivery_recommendation", "quality_scores", "critical_issues", "major_issues", "minor_issues", "strengths", "improvement_opportunities", "further_improvement_worthwhile"],
    quality_score_fields: ["task_fidelity", "composition", "visual_hierarchy", "coherence", "craft_precision", "professional_readiness"],
    ...(record ? { quality_requirements: visualQualityRequirements(record.quality_bar ?? "standard") } : {}),
    conditional_requirements: ["All six quality scores are numbers from 1 to 5.", "further_improvement_worthwhile=true requires concrete improvement_opportunities; false requires none.", "Accept cannot contradict blocking issues, reported major issues or the locked quality bar. Do not raise scores just to pass."],
    inspection_requirement: "Set inspected_full_render=true only after inspecting every returned full render/page image. Values must reflect the actual visible version.",
  };
  return {
    required_fields: ["review_id", "verdict", "inspected_full_render"],
    supply_after_inspection: ["verdict", "inspected_full_render", "issues", "further_improvement_worthwhile", "comparison", "strengths", "improvement_opportunities"],
    ...(record ? { quality_requirements: visualQualityRequirements(record.quality_bar ?? "standard") } : {}),
    conditional_requirements: ["verdict=pass requires further_improvement_worthwhile and a recorded critique on this review_id; the boolean must match that critique.", "verdict=fail requires at least one concrete issue.", "comparison=improved requires at least one concrete strength.", "For verdict=pass, further_improvement_worthwhile=true requires concrete improvement_opportunities; false requires none."],
    comparison_requirement: record?.comparison_path ? "Comparison pixels are present: inspect them and supply improved, unchanged or regressed." : record ? "No comparison pixels: use not_compared or omit comparison." : "If comparison pixels were returned, inspect them and supply improved, unchanged or regressed; otherwise use not_compared or omit comparison.",
    ...(record?.model_visual_critique ? { critique_further_improvement_worthwhile: record.model_visual_critique.further_improvement_worthwhile } : {}),
    inspection_requirement: "Do not claim an image was inspected or infer a passing verdict from these instructions.",
  };
}

/** Make the next operation explicit; operation success is not delivery readiness. */
export function visualDeliveryFeedback(state: VisualReviewFreshness): Record<string, unknown> {
  const record = state.record;
  const ready = state.fresh && state.machine_ready && state.model_visual_ready &&
    state.model_visual_iteration_ready && state.model_visual_coverage.complete;
  const review = { tool: "visual_review", arguments: { action: "review", target: record.target, compare_to: record.id, quality_bar: record.quality_bar ?? "standard" } };
  let action = "complete_visual_verification";
  let next: unknown = null;
  if (!state.fresh) {
    action = "review_current_source";
    next = review;
  } else if (!state.machine_ready || state.model_visual_quality_gate.status === "failed" || state.model_visual_status === "fail") {
    action = state.model_visual_iteration.limit_reached ? "report_unmet_quality_at_iteration_limit" : "repair_artifact_then_review";
    next = state.model_visual_iteration.limit_reached
      ? { target: record.target, review_id: record.id, report: "Describe unmet requirements; do not claim completion or start another review iteration." }
      : { edit_target: record.target, after_edit: review };
  } else if (!record.model_visual_critique) {
    action = "inspect_images_then_critique";
    next = { tool: "visual_review", arguments: { action: "critique", review_id: record.id }, ...visualActionInputGuide("critique", record) };
  } else if (state.model_visual_status === "pending") {
    action = "assess";
    next = { tool: "visual_review", arguments: { action: "assess", review_id: record.id }, ...visualActionInputGuide("assess", record) };
  } else if (!state.model_visual_coverage.complete) {
    action = "review_missing_pages";
    next = { tool: "visual_review", arguments: { ...review.arguments, pages: state.model_visual_coverage.missing_pages.slice(0, 12) } };
  } else if (state.model_visual_iteration.continuation_required) {
    action = "repair_artifact_then_review";
    next = { edit_target: record.target, after_edit: review };
  }
  return {
    delivery_ready: ready,
    assessment_source: "calling_model_self_report",
    independent_quality_verified: false,
    quality_requirements: visualQualityRequirements(record.quality_bar ?? "standard"),
    next_required_action: action,
    next_action: next,
    repair_focus: [...new Set([
      ...record.machine_blocking_issues,
      ...(record.model_visual_critique?.critical_issues ?? []),
      ...(record.model_visual_critique?.major_issues ?? []),
      ...(state.model_visual_quality_gate.reasons ?? []),
      ...state.model_visual_iteration.improvement_opportunities,
    ])].slice(0, 12),
  };
}
