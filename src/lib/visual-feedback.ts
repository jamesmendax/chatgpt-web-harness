import type { VisualReviewFreshness, VisualReviewRecord } from "./visual-review-state.js";

export function visualActionInputGuide(action: string, _record?: VisualReviewRecord): Record<string, unknown> {
  if (action === "review") return { required_fields: ["target"] };
  if (action === "status") return { required_fields: [] };
  if (action === "withdraw") return { required_fields: ["review_id"] };
  return { required_fields: action === "critique" ? ["review_id", "inspected_full_render", "first_impression", "delivery_recommendation", "quality_scores"] : ["review_id", "inspected_full_render", "verdict"],
    inspection_requirement: "Declare inspection only after actually viewing the returned images." };
}

export function visualDeliveryFeedback(state: VisualReviewFreshness): Record<string, unknown> {
  return { assessment_source: "calling_model_self_report", independent_quality_verified: false,
    delivery_ready: state.fresh && state.model_visual_ready,
    next_required_action: state.model_visual_status === "pending" ? "inspect_images_then_assess" : "none",
    next_action: null };
}
