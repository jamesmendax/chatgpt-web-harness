---
name: visual-qa
description: Inspect rendered images, SVG, web UI, charts, documents and slides when appearance matters, record observed defects and compare meaningful revisions.
---
# Visual review

Use `visual_review(target)` to obtain real rendered images, optional focus crops, diagnostics and a versioned `review_id`.

Inspect the returned pixels before claiming visual verification. A successful export, an existing file or a model-declared PASS alone does not prove that the artifact looks correct.

## Review the actual artifact

1. Check requested content, then clipping, overlap, layout, typography and readability.
2. Use the task's own design goals to judge composition and finish. Independent artifacts may use their own style; the Web Harness desktop keeps Aura.
3. Record visible findings with `visual_review(action=assess)` or `visual_review(action=critique)`. Either may be used first. Scores and improvement suggestions are optional observations.
4. When a concrete defect justifies another revision, fix the source and render again with `compare_to=<review_id>`. Stop once the user's requested result is ready; there is no fixed iteration count or numeric score gate.
5. If an earlier evaluation was mistaken, revise or withdraw it and state the reason. Preserve source and time in the review history.

## Evidence

Distinguish rendered images, model observations and actual requirement verification. Keep unverified claims unverified. A recorded review or task completion does not authorize another action and is not a prerequisite for using a tool.

`visual_review(action=status)` without an ID returns the latest record in the current session, or an empty state. Missing screenshots, stale artifacts and incomplete page coverage remain visible facts rather than invented visual success.

## SVG

For an explicitly vector deliverable, inspect whether it contains raster images and follow the user's format requirement. Use focus crops for spatial details when useful.
