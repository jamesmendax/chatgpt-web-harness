import { runPostEditHooks } from "./post-edit-hooks.js";

export async function enrichAfterEdit<T extends Record<string, unknown>>(
  data: T,
  filePaths: string[],
  dryRun?: boolean
): Promise<T> {
  if (dryRun || !filePaths.length) return data;
  const hooks = await runPostEditHooks(filePaths);
  const visualTargets = [...new Set(filePaths.filter((file) => /\.(svg|html?|pdf|pptx|docx)$/i.test(file)))];
  // A successful write proves persistence, not visual quality. Deliver the
  // next step even in a plain chat with no active Goal or durable task.
  const visual = visualTargets.length ? {
    visual_review_required: true,
    visual_review_status: "not_reviewed_after_edit",
    next_required_action: "review_changed_visual_artifacts",
    visual_review_hint: "The file was saved. Inspect its full rendered appearance before claiming visual completion; writing bytes does not verify the requested design.",
    visual_review_targets: visualTargets.map((target) => ({ tool: "visual_review", arguments: { action: "review", target } })),
  } : {};
  return { ...data, ...hooks, ...visual };
}
