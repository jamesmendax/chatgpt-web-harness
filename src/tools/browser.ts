import fs from "fs/promises";
import path from "path";
import { createHash, randomUUID } from "crypto";
import { pathToFileURL } from "url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validatePath } from "../lib/path-security.js";
import { toolError, toolResult } from "../lib/tool-result.js";
import {
  beginBrowserTurnFence,
  observeBrowserTurnFence,
  type BrowserTurnFenceState,
  type BrowserTurnSnapshot,
} from "../lib/browser-turn-fence.js";
import { findBrowserExecutable } from "../lib/browser-runtime.js";
import { saveBrowserTurnCheckpoint } from "../lib/browser-turn-checkpoint.js";
import { browserPageTargetId, rebindBrowserPageToTarget } from "../lib/browser-session-rebind.js";
import { registerRuntimeStatusProvider } from "../lib/runtime-status-registry.js";

const MAX_BROWSER_SESSIONS = 4;
const DEFAULT_IDLE_TTL_MS = 10 * 60 * 1000;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_TEXT_EXCERPT = 5000;
const MAX_CONSOLE_ITEMS = 100;

interface BrowserSession {
  id: string;
  context: BrowserContext;
  page: Page;
  console: Array<{ type: string; text: string; at: string }>;
  createdAt: number;
  lastUsedAt: number;
  targetId: string;
  turnFence?: BrowserTurnFenceState;
  turnSelectors?: BrowserTurnSelectors;
  turnSendPending?: boolean;
}

interface BrowserPayload extends Record<string, unknown> {
  ok: boolean;
  tool: string;
  summary: string;
  data: Record<string, unknown>;
}

interface BrowserTurnSelectors {
  user: string;
  assistant: string;
  generation: string;
  toolInflight?: string;
  failure?: string;
  visibleText: string;
}

const sessions = new Map<string, BrowserSession>();
let sharedBrowser: Browser | null = null;
let cleanupTimer: NodeJS.Timeout | null = null;

function idleTtlMs(): number {
  const parsed = Number.parseInt(process.env.BROWSER_SESSION_TTL_MS || "", 10);
  return Number.isFinite(parsed) && parsed >= 60_000 ? parsed : DEFAULT_IDLE_TTL_MS;
}

function browserImageResult(tool: string, data: Record<string, unknown>, image: Buffer, summary: string) {
  if (image.length > MAX_IMAGE_BYTES) throw new Error(`Browser screenshot exceeds ${MAX_IMAGE_BYTES} bytes`);
  const payload: BrowserPayload = { ok: true, tool, summary, data };
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
      { type: "image" as const, data: image.toString("base64"), mimeType: "image/png" },
    ],
    structuredContent: payload,
  };
}

async function closeSharedBrowserIfUnused(): Promise<void> {
  if (sessions.size === 0 && sharedBrowser) {
    const browser = sharedBrowser;
    sharedBrowser = null;
    await browser.close().catch(() => {});
  }
}

async function closeSession(sessionId: string): Promise<boolean> {
  const session = sessions.get(sessionId);
  if (!session) return false;
  sessions.delete(sessionId);
  await session.context.close().catch(() => {});
  await closeSharedBrowserIfUnused();
  return true;
}

async function cleanupIdleSessions(): Promise<void> {
  const cutoff = Date.now() - idleTtlMs();
  const stale = [...sessions.values()].filter((session) => session.lastUsedAt < cutoff).map((session) => session.id);
  for (const id of stale) await closeSession(id);
}

function ensureCleanupTimer(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    cleanupIdleSessions().catch(() => {});
  }, 60_000);
  cleanupTimer.unref?.();
}

async function ensureBrowser(): Promise<Browser> {
  await cleanupIdleSessions();
  if (sharedBrowser?.isConnected()) return sharedBrowser;
  const executablePath = findBrowserExecutable();
  if (!executablePath) {
    throw new Error("No supported Chromium browser found. Set CHATGPT_BROWSER_PATH to Edge/Chrome/Chromium executable.");
  }
  sharedBrowser = await chromium.launch({
    executablePath,
    headless: true,
    args: ["--disable-gpu", "--no-first-run", "--disable-extensions"],
  });
  ensureCleanupTimer();
  return sharedBrowser;
}

async function resolveTarget(raw: string): Promise<string> {
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) return new URL(trimmed).toString();
  if (/^file:\/\//i.test(trimmed)) return trimmed;
  const localPath = await validatePath(trimmed);
  const stat = await fs.stat(localPath);
  if (!stat.isFile()) throw new Error("Local browser target must be a file");
  return pathToFileURL(localPath).toString();
}

function attachDiagnostics(session: BrowserSession): void {
  session.page.on("console", (message) => {
    session.console.push({ type: message.type(), text: message.text().slice(0, 3000), at: new Date().toISOString() });
    if (session.console.length > MAX_CONSOLE_ITEMS) session.console.splice(0, session.console.length - MAX_CONSOLE_ITEMS);
  });
  session.page.on("pageerror", (error) => {
    session.console.push({ type: "pageerror", text: error.message.slice(0, 3000), at: new Date().toISOString() });
    if (session.console.length > MAX_CONSOLE_ITEMS) session.console.splice(0, session.console.length - MAX_CONSOLE_ITEMS);
  });
}

async function pageMetadata(session: BrowserSession): Promise<Record<string, unknown>> {
  session.lastUsedAt = Date.now();
  const page = session.page;
  const [title, text] = await Promise.all([
    page.title().catch(() => ""),
    page.locator("body").innerText({ timeout: 2000 }).catch(() => ""),
  ]);
  const recentConsole = session.console.slice(-20);
  return {
    session_id: session.id,
    url: page.url(),
    title,
    text_excerpt: text.slice(0, MAX_TEXT_EXCERPT),
    console_recent: recentConsole,
    console_errors: recentConsole.filter((item) => ["error", "warning", "pageerror"].includes(item.type)),
    active_sessions: sessions.size,
    idle_ttl_ms: idleTtlMs(),
  };
}

async function snapshot(session: BrowserSession, fullPage = false): Promise<Buffer> {
  const image = await session.page.screenshot({ type: "png", fullPage, animations: "disabled", caret: "hide" });
  return Buffer.from(image);
}

async function rebindSameTab(session: BrowserSession): Promise<boolean> {
  const rebound = await rebindBrowserPageToTarget(session.context, session.page, session.targetId);
  if (!rebound.page) return false;
  if (session.page !== rebound.page) {
    session.page = rebound.page;
    attachDiagnostics(session);
  }
  session.lastUsedAt = Date.now();
  return true;
}

async function persistTurnCheckpoint(session: BrowserSession, phase: string): Promise<string | null> {
  if (!session.turnFence) return null;
  try {
    return await saveBrowserTurnCheckpoint({
      version: 1,
      session_id: session.id,
      target_id: session.targetId,
      phase,
      fence: session.turnFence,
      updated_at: new Date().toISOString(),
      terminal: session.turnFence.completed,
    });
  } catch {
    // Browser correctness must not depend on checkpoint I/O. The checkpoint is
    // a durable recovery/audit aid, while the in-memory fence remains truth for
    // the active browser runtime.
    return null;
  }
}

function getSession(sessionId: string): BrowserSession {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Unknown or expired browser session_id");
  session.lastUsedAt = Date.now();
  return session;
}

async function visibleCount(page: Page, selector: string | undefined): Promise<number> {
  if (!selector) return 0;
  return page.locator(selector).evaluateAll((elements) => elements.filter((element) => {
    const node = element as HTMLElement;
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }).length);
}

async function readBrowserTurnSnapshot(
  session: BrowserSession,
  selectors: BrowserTurnSelectors,
  activityRevision: number
): Promise<BrowserTurnSnapshot> {
  const page = session.page;
  const [userTurnCount, assistantTurnCount, generationCount, toolInflightCount, visibleText, failureVisible] = await Promise.all([
    page.locator(selectors.user).count(),
    page.locator(selectors.assistant).count(),
    visibleCount(page, selectors.generation),
    visibleCount(page, selectors.toolInflight),
    // An unreadable DOM is unknown, not an idle page that proves completion.
    page.locator(selectors.visibleText).innerText({ timeout: 2000 }),
    visibleDeliveryFailure(page, selectors.failure),
  ]);
  return {
    tab_id: session.targetId,
    observed_at_ms: Date.now(),
    user_turn_count: userTurnCount,
    assistant_turn_count: assistantTurnCount,
    generation_active: generationCount > 0,
    tool_inflight_count: toolInflightCount,
    activity_revision: Math.max(0, Math.floor(activityRevision)),
    visible_text_hash: createHash("sha256").update(visibleText, "utf8").digest("hex"),
    failure_visible: failureVisible,
  };
}

async function visibleDeliveryFailure(page: Page, selector?: string): Promise<boolean> {
  if (selector && await visibleCount(page, selector) > 0) return true;
  return page.evaluate(() => {
    // Keep the known-error surface rules aligned with the Companion adapter;
    // conversation text and unrelated Retry buttons are not delivery status.
    const patterns = ["connection interrupted", "waiting for the complete answer", "message delivery timed out",
      "chatgpt stream recovery polling timed out", "连接中断", "正在等待完整回复", "消息传递超时", "消息发送超时"];
    const visible = (element: Element): boolean => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const matches = (element: Element): boolean => {
      if (!visible(element)) return false;
      const text = ((element as HTMLElement).innerText || element.textContent || "").toLowerCase();
      return patterns.some((pattern) => text.includes(pattern));
    };
    for (const element of document.querySelectorAll("[role='alert'], [aria-live='assertive'], [data-testid*='error'], [data-testid*='retry']")) {
      if (matches(element)) return true;
    }
    for (const button of document.querySelectorAll("button")) {
      if (!visible(button) || !/^(retry|重试)$/i.test((button.getAttribute("aria-label") || button.textContent || "").trim())) continue;
      let element: Element | null = button;
      for (let depth = 0; element && depth < 5; depth++, element = element.parentElement) {
        if (element === document.body || element === document.documentElement || ["BODY", "HTML", "MAIN"].includes(element.tagName)
          || ["user", "assistant"].includes(element.getAttribute("data-message-author-role") || "")) break;
        if (matches(element)) return true;
      }
    }
    return false;
  });
}

export function getBrowserRuntimeStatus() {
  const now = Date.now();
  return {
    active_sessions: sessions.size,
    browser_connected: Boolean(sharedBrowser?.isConnected()),
    idle_ttl_ms: idleTtlMs(),
    max_sessions: MAX_BROWSER_SESSIONS,
    sessions: [...sessions.values()].map((session) => ({
      id: session.id,
      age_ms: now - session.createdAt,
      idle_ms: now - session.lastUsedAt,
      url: session.page.url(),
      target_id: session.targetId,
    })),
  };
}

export function registerBrowserTools(server: McpServer): void {
  registerRuntimeStatusProvider("browser", getBrowserRuntimeStatus);
  server.registerTool(
    "browser_open",
    {
      title: "Open Browser Session",
      description:
        "Open a persistent headless Edge/Chrome/Chromium session for a URL or local file and return the first screenshot as image content. Sessions auto-expire to control memory.",
      inputSchema: {
        target: z.string().min(1),
        width: z.number().int().min(320).max(3840).optional().default(1440),
        height: z.number().int().min(240).max(2160).optional().default(1000),
        wait_until: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).optional().default("load"),
        timeout_ms: z.number().int().min(1000).max(120000).optional().default(30000),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
    },
    async ({ target, width, height, wait_until, timeout_ms }) => {
      try {
        await cleanupIdleSessions();
        if (sessions.size >= MAX_BROWSER_SESSIONS) {
          throw new Error(`Browser session limit reached (${MAX_BROWSER_SESSIONS}); close an existing session first.`);
        }
        const browser = await ensureBrowser();
        const context = await browser.newContext({ viewport: { width, height } });
        const page = await context.newPage();
        const session: BrowserSession = {
          id: randomUUID(),
          context,
          page,
          console: [],
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          targetId: await browserPageTargetId(context, page),
        };
        attachDiagnostics(session);
        sessions.set(session.id, session);
        try {
          const resolvedTarget = await resolveTarget(target);
          await page.goto(resolvedTarget, { waitUntil: wait_until, timeout: timeout_ms });
          const [data, image] = await Promise.all([pageMetadata(session), snapshot(session)]);
          return browserImageResult("browser_open", data, image, `browser_open: ${page.url()}`);
        } catch (error) {
          await closeSession(session.id);
          throw error;
        }
      } catch (error) {
        return toolError("browser_open", error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    "browser_action",
    {
      title: "Browser Action",
      description:
        "Act inside a persistent browser session, then optionally return a fresh screenshot plus URL/title/body excerpt and recent console errors. Supports navigate, click, fill, press, hover, wait, evaluate, plus turn_send/turn_observe for same-tab send acceptance and completion fencing.",
      inputSchema: {
        session_id: z.string().uuid(),
        action: z.enum(["navigate", "click", "fill", "press", "hover", "wait", "evaluate", "turn_send", "turn_observe"]),
        selector: z.string().max(4000).optional(),
        text: z.string().max(20000).optional(),
        key: z.string().max(200).optional(),
        url: z.string().max(8000).optional(),
        script: z.string().max(50000).optional(),
        milliseconds: z.number().int().min(0).max(30000).optional(),
        timeout_ms: z.number().int().min(500).max(120000).optional().default(15000),
        screenshot: z.boolean().optional().default(true),
        full_page: z.boolean().optional().default(false),
        user_turn_selector: z.string().max(4000).optional(),
        assistant_turn_selector: z.string().max(4000).optional(),
        generation_selector: z.string().max(4000).optional(),
        tool_inflight_selector: z.string().max(4000).optional(),
        failure_selector: z.string().max(4000).optional(),
        visible_text_selector: z.string().max(4000).optional(),
        activity_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().default(0),
        ambiguity_ms: z.number().int().min(1000).max(120000).optional().default(15000),
        stable_ms: z.number().int().min(100).max(10000).optional().default(750),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
    },
    async ({
      session_id, action, selector, text, key, url, script, milliseconds, timeout_ms, screenshot, full_page,
      user_turn_selector, assistant_turn_selector, generation_selector, tool_inflight_selector, failure_selector, visible_text_selector,
      activity_revision, ambiguity_ms, stable_ms,
    }) => {
      try {
        await cleanupIdleSessions();
        const session = getSession(session_id);
        const page = session.page;
        let actionResult: unknown = null;

        if (action === "navigate") {
          if (!url) throw new Error("navigate requires url");
          await page.goto(await resolveTarget(url), { waitUntil: "load", timeout: timeout_ms });
        } else if (action === "click") {
          if (!selector) throw new Error("click requires selector");
          await page.locator(selector).click({ timeout: timeout_ms });
        } else if (action === "fill") {
          if (!selector) throw new Error("fill requires selector");
          if (text === undefined) throw new Error("fill requires text");
          await page.locator(selector).fill(text, { timeout: timeout_ms });
        } else if (action === "press") {
          if (!key) throw new Error("press requires key");
          if (selector) await page.locator(selector).press(key, { timeout: timeout_ms });
          else await page.keyboard.press(key);
        } else if (action === "hover") {
          if (!selector) throw new Error("hover requires selector");
          await page.locator(selector).hover({ timeout: timeout_ms });
        } else if (action === "wait") {
          await page.waitForTimeout(milliseconds ?? 1000);
        } else if (action === "evaluate") {
          if (!script) throw new Error("evaluate requires script");
          actionResult = await page.evaluate((source) => (0, eval)(source), script);
        } else if (action === "turn_send") {
          if (session.turnSendPending || (session.turnFence && !session.turnFence.completed)) {
            throw new Error("A send is already active or unconfirmed in this browser session; use turn_observe on the same tab before starting another turn.");
          }
          if (!selector) throw new Error("turn_send requires selector for the send control");
          if (!user_turn_selector || !assistant_turn_selector || !generation_selector || !visible_text_selector) {
            throw new Error("turn_send requires user_turn_selector, assistant_turn_selector, generation_selector, and visible_text_selector");
          }
          const selectors: BrowserTurnSelectors = {
            user: user_turn_selector,
            assistant: assistant_turn_selector,
            generation: generation_selector,
            toolInflight: tool_inflight_selector,
            failure: failure_selector,
            visibleText: visible_text_selector,
          };
          session.turnSendPending = true;
          try {
            const baseline = await readBrowserTurnSnapshot(session, selectors, activity_revision);
            if (baseline.failure_visible) {
              throw new Error("Visible delivery failure on the current page; preserve the existing tab and reconcile it before any new send. Do not retry or resubmit.");
            }
            session.turnSelectors = selectors;
            session.turnFence = beginBrowserTurnFence(session.id, baseline, { ambiguity_ms, stable_ms });
            const checkpointPath = await persistTurnCheckpoint(session, "send_activated");
            try {
              await page.locator(selector).click({ timeout: timeout_ms });
              actionResult = {
                send_activation: "invoked",
                turn_fence_active: true,
                baseline,
                resubmit_allowed: false,
                next_action: "observe_same_tab",
                checkpoint_path: checkpointPath,
              };
            } catch (sendError) {
              actionResult = {
                send_activation: "ambiguous",
                turn_fence_active: true,
                baseline,
                resubmit_allowed: false,
                next_action: "observe_same_tab",
                checkpoint_path: checkpointPath,
                error: sendError instanceof Error ? sendError.message : String(sendError),
              };
            }
          } finally {
            session.turnSendPending = false;
          }
        } else if (action === "turn_observe") {
          if (!session.turnFence || !session.turnSelectors) {
            throw new Error("turn_observe requires a prior turn_send in the same browser session");
          }
          let rebound = false;
          let current: BrowserTurnSnapshot;
          try {
            current = await readBrowserTurnSnapshot(session, session.turnSelectors, activity_revision);
          } catch (error) {
            rebound = await rebindSameTab(session);
            if (!rebound) throw error;
            current = await readBrowserTurnSnapshot(session, session.turnSelectors, activity_revision);
          }
          let decision = observeBrowserTurnFence(session.turnFence, current);
          if (decision.next_action === "rebind_same_tab") {
            rebound = await rebindSameTab(session) || rebound;
            if (rebound) {
              const fresh = await readBrowserTurnSnapshot(session, session.turnSelectors, activity_revision);
              decision = observeBrowserTurnFence(decision.state, fresh);
              current = fresh;
            }
          }
          session.turnFence = decision.state;
          const checkpointPath = await persistTurnCheckpoint(session, decision.phase);
          actionResult = {
            phase: decision.phase,
            next_action: decision.next_action,
            resubmit_allowed: decision.resubmit_allowed,
            reason: decision.reason,
            accepted: decision.state.accepted,
            acceptance_reason: decision.state.acceptance_reason,
            completed: decision.state.completed,
            same_tab_rebind_attempted: rebound,
            checkpoint_path: checkpointPath,
            current,
          };
        }

        const data = { ...(await pageMetadata(session)), action, action_result: actionResult };
        if (!screenshot) return toolResult("browser_action", data, { summary: `browser_action: ${action}` });
        const image = await snapshot(session, full_page);
        return browserImageResult("browser_action", data, image, `browser_action: ${action}`);
      } catch (error) {
        return toolError("browser_action", error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    "browser_close",
    {
      title: "Close Browser Session",
      description: "Close a persistent browser session. When the last session closes, the shared browser process is also terminated to release memory.",
      inputSchema: { session_id: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    },
    async ({ session_id }) => {
      try {
        const closed = await closeSession(session_id);
        return toolResult("browser_close", { session_id, closed, active_sessions: sessions.size });
      } catch (error) {
        return toolError("browser_close", error instanceof Error ? error.message : String(error));
      }
    }
  );
}
