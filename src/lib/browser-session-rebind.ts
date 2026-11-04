import type { BrowserContext, Page } from "playwright-core";

export async function browserPageTargetId(context: BrowserContext, page: Page): Promise<string> {
  const cdp = await context.newCDPSession(page);
  try {
    const result = await cdp.send("Target.getTargetInfo") as { targetInfo?: { targetId?: string } };
    const targetId = result.targetInfo?.targetId;
    if (!targetId) throw new Error("Chromium target id unavailable");
    return targetId;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** Resolve the original Chromium target inside the same BrowserContext. This
 * helper never opens a page and therefore cannot turn an ambiguous send into a
 * replay on a new target. */
export async function rebindBrowserPageToTarget(
  context: BrowserContext,
  current: Page | null,
  targetId: string,
): Promise<{ page: Page | null; rebound: boolean }> {
  for (const candidate of context.pages()) {
    if (candidate.isClosed()) continue;
    try {
      const candidateTarget = await browserPageTargetId(context, candidate);
      if (candidateTarget !== targetId) continue;
      return { page: candidate, rebound: current !== candidate };
    } catch {}
  }
  return { page: null, rebound: false };
}
