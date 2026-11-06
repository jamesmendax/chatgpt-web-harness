import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type BrowserServer, type Page } from "playwright-core";
import { closeOwnedBrowserServer } from "./owned-browser-cleanup.js";
import { privateOfficeAutomationScript } from "./visual-review-office.js";
import { validatePath } from "./path-security.js";
import {
  fileSignature,
  getVisualReviewFreshness,
  getVisualReviewRecord,
  saveVisualReviewRecord,
  type VisualArtifactKind,
  type VisualQualityBar,
} from "./visual-review-state.js";

const execFileAsync = promisify(execFile);
const MAX_RENDER_DIMENSION = 4096;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_TOTAL_RETURN_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_PAGES = 12;
const MAX_FOCUS = 8;
// Chromium can take longer to tear down after several sequential visual
// reviews, especially while the user's Chrome instance is under load. Keep
// cleanup bounded, but do not turn a successful capture into a false failure
// merely because a graceful close needs a few extra seconds.
const MAX_VISUAL_CLEANUP_MS = 15_000;
const MAX_PDF_SCREENSHOT_ATTEMPTS = 5;
const ownedVisualServers = new WeakMap<Browser, BrowserServer>();

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export interface VisualFocusInput {
  label?: string;
  selector?: string;
  pair_selector?: string;
  page?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  unit?: "ratio" | "px";
}

export interface VisualReviewInput {
  target: string;
  kind?: "auto" | VisualArtifactKind;
  quality_bar?: VisualQualityBar;
  output_dir?: string;
  width?: number;
  height?: number;
  pages?: number[];
  focus?: VisualFocusInput[];
  compare_to?: string;
  full_page?: boolean;
  timeout_ms?: number;
  max_images?: number;
  allow_office_running?: boolean;
}

const VISUAL_QUALITY_BAR_RANK: Record<VisualQualityBar, number> = {
  draft: 0,
  standard: 1,
  polished: 2,
};

export interface VisualImagePayload {
  path: string;
  label: string;
  bytes: Buffer;
  mime_type: string;
}

export interface VisualReviewExecution {
  data: Record<string, unknown>;
  images: VisualImagePayload[];
}

interface ResolvedTarget {
  target: string;
  label: string;
  sourcePath?: string;
}

interface RenderResult {
  renderer: string;
  overviewPath: string;
  pagePaths: string[];
  pageMap: Map<number, string>;
  focusPaths: string[];
  focusDetails: Array<Record<string, unknown>>;
  machineIssues: string[];
  advisories: string[];
  diagnostics: Record<string, unknown>;
}

interface BrowserCaptureResult {
  overviewPath: string;
  focusPaths: string[];
  focusDetails: Array<Record<string, unknown>>;
  machineIssues: string[];
  advisories: string[];
  diagnostics: Record<string, unknown>;
}

interface SvgCanvasDiagnostics {
  capture_mode: "fit_canvas" | "incomplete";
  full_canvas_captured: boolean;
  has_view_box: boolean;
  synthetic_view_box: boolean;
  source_width?: number;
  source_height?: number;
  effective_view_box?: { x: number; y: number; width: number; height: number };
  output_width: number;
  output_height: number;
  fitted_width?: number;
  fitted_height?: number;
  viewport_applied: boolean;
  reason?: string;
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const normalized = Number.isFinite(value) ? Math.floor(value as number) : fallback;
  return Math.max(min, Math.min(max, normalized));
}

function imageMimeType(filePath: string): string | null {
  return IMAGE_MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? null;
}

async function readImage(filePath: string): Promise<{ bytes: Buffer; mimeType: string }> {
  const mimeType = imageMimeType(filePath);
  if (!mimeType) throw new Error(`Unsupported preview image type: ${path.extname(filePath) || "none"}`);
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size === 0) throw new Error(`Preview image is missing or empty: ${filePath}`);
  if (stat.size > MAX_IMAGE_BYTES) throw new Error(`Preview image is ${stat.size} bytes; limit is ${MAX_IMAGE_BYTES}`);
  return { bytes: await fs.readFile(filePath), mimeType };
}

async function imageDataUrl(filePath: string): Promise<string> {
  const { bytes, mimeType } = await readImage(filePath);
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

function browserCandidates(): string[] {
  const envPath = process.env.CHATGPT_BROWSER_PATH?.trim();
  const candidates: string[] = [];
  if (envPath) candidates.push(envPath);
  if (process.platform === "win32") {
    candidates.push(
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
    );
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge"
    );
  }
  return candidates;
}

export function findVisualBrowserExecutable(): string | null {
  for (const candidate of browserCandidates()) {
    try {
      if (candidate && fsSync.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

interface VisualDeadline {
  timeoutMs: number;
  remainingMs: () => number;
}

function createVisualDeadline(timeoutMs: number): VisualDeadline {
  const bounded = Math.max(1, Math.floor(timeoutMs));
  const expiresAt = Date.now() + bounded;
  return {
    timeoutMs: bounded,
    remainingMs: () => Math.max(0, expiresAt - Date.now()),
  };
}

function visualDeadlineError(label: string, deadline: VisualDeadline): Error {
  return new Error(`${label} timed out after ${deadline.timeoutMs}ms`);
}

function visualOperationTimeout(deadline: VisualDeadline, label: string, requestedMs = deadline.timeoutMs): number {
  const remaining = Math.floor(deadline.remainingMs());
  if (remaining <= 0) throw visualDeadlineError(label, deadline);
  return Math.max(1, Math.min(Math.floor(requestedMs), remaining));
}

async function withBoundedTimeout<T>(
  label: string,
  timeoutMs: number,
  operation: () => Promise<T>,
  onTimeout?: () => void | Promise<void>
): Promise<T> {
  const bounded = Math.max(1, Math.floor(timeoutMs));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { void Promise.resolve(onTimeout?.()).catch(() => undefined); } catch {}
      reject(new Error(`${label} timed out after ${bounded}ms`));
    }, bounded);
    timer.unref?.();
    Promise.resolve()
      .then(operation)
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      );
  });
}

async function withVisualDeadline<T>(
  label: string,
  deadline: VisualDeadline,
  operation: () => Promise<T>,
  onTimeout?: () => void | Promise<void>
): Promise<T> {
  const remaining = visualOperationTimeout(deadline, label);
  return withBoundedTimeout(label, remaining, operation, onTimeout).catch((error) => {
    if (error instanceof Error && error.message === `${label} timed out after ${remaining}ms`) {
      throw visualDeadlineError(label, deadline);
    }
    throw error;
  });
}

function normalizeVisualError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function withVisualCleanup<T>(
  operation: () => Promise<T>,
  cleanup: () => Promise<Error | undefined>
): Promise<T> {
  let result!: T;
  let primaryError: Error | undefined;
  try {
    result = await operation();
  } catch (error) {
    primaryError = normalizeVisualError(error);
  }

  let cleanupError: Error | undefined;
  try {
    cleanupError = await cleanup();
  } catch (error) {
    cleanupError = normalizeVisualError(error);
  }

  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  return result;
}

async function closeVisualResource(
  label: string,
  deadline: VisualDeadline,
  close: () => Promise<unknown>
): Promise<Error | undefined> {
  const closePromise = Promise.resolve().then(close);
  const remaining = Math.floor(deadline.remainingMs());
  if (remaining <= 0) {
    void closePromise.catch(() => undefined);
    return visualDeadlineError(label, deadline);
  }
  try {
    await withBoundedTimeout(label, Math.min(MAX_VISUAL_CLEANUP_MS, remaining), () => closePromise);
    return undefined;
  } catch (error) {
    return normalizeVisualError(error);
  }
}

async function closeVisualPage(page: Page, deadline: VisualDeadline, label: string): Promise<Error | undefined> {
  if (page.isClosed()) return undefined;
  return closeVisualResource(label, deadline, () => page.close());
}

async function closeVisualBrowser(browser: Browser, deadline: VisualDeadline): Promise<Error | undefined> {
  const server = ownedVisualServers.get(browser);
  if (!server) return closeVisualResource("Visual browser close", deadline, () => browser.close());
  ownedVisualServers.delete(browser);
  void browser.close().catch(() => undefined);
  try {
    await closeOwnedBrowserServer(server, Math.min(MAX_VISUAL_CLEANUP_MS, Math.max(1, deadline.remainingMs())));
    return undefined;
  } catch (error) {
    return normalizeVisualError(error);
  }
}

async function launchVisualBrowser(deadline: VisualDeadline): Promise<Browser> {
  const executablePath = findVisualBrowserExecutable();
  if (!executablePath) {
    throw new Error("No supported Chromium browser found. Set CHATGPT_BROWSER_PATH to Edge/Chrome/Chromium executable.");
  }
  let launchPromise: Promise<Browser> | undefined;
  return withVisualDeadline(
    "Visual browser launch",
    deadline,
    () => {
      launchPromise = (async () => {
        const server = await chromium.launchServer({
        executablePath,
        headless: true,
        host: "127.0.0.1",
        timeout: Math.min(120_000, visualOperationTimeout(deadline, "Visual browser launch")),
        args: [
          "--disable-gpu",
          "--hide-scrollbars",
          "--no-first-run",
          "--disable-extensions",
          "--allow-file-access-from-files",
        ],
        });
        try {
          const browser = await chromium.connect(server.wsEndpoint(), {
            timeout: visualOperationTimeout(deadline, "Visual browser connect"),
          });
          ownedVisualServers.set(browser, server);
          return browser;
        } catch (error) {
          await closeOwnedBrowserServer(server, MAX_VISUAL_CLEANUP_MS);
          throw error;
        }
      })();
      return launchPromise;
    },
    () => {
      void launchPromise?.then((browser) => closeVisualBrowser(browser, deadline)).catch(() => undefined);
    }
  );
}

async function withVisualPage<T>(
  browser: Browser,
  deadline: VisualDeadline,
  label: string,
  viewport: { width: number; height: number; deviceScaleFactor?: number },
  operation: (page: Page) => Promise<T>
): Promise<T> {
  let pagePromise: Promise<Page> | undefined;
  const page = await withVisualDeadline(
    `${label} open`,
    deadline,
    () => {
      pagePromise = browser.newPage({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: viewport.deviceScaleFactor,
      });
      return pagePromise;
    },
    () => {
      void pagePromise
        ?.then((latePage) => closeVisualPage(latePage, deadline, `${label} close`))
        .catch(() => undefined);
    }
  );
  let closePromise: Promise<Error | undefined> | undefined;
  const close = (): Promise<Error | undefined> => closePromise || (closePromise = closeVisualPage(page, deadline, `${label} close`));
  return withVisualCleanup(
    () => withVisualDeadline(label, deadline, () => operation(page), () => { void close(); }),
    close
  );
}

async function withVisualBrowser<T>(
  label: string,
  deadline: VisualDeadline,
  operation: (browser: Browser) => Promise<T>
): Promise<T> {
  const browser = await launchVisualBrowser(deadline);
  let closePromise: Promise<Error | undefined> | undefined;
  const close = (): Promise<Error | undefined> => closePromise || (closePromise = closeVisualBrowser(browser, deadline));
  return withVisualCleanup(
    () => withVisualDeadline(label, deadline, () => operation(browser), () => { void close(); }),
    close
  );
}

async function resolveTarget(rawTarget: string): Promise<ResolvedTarget> {
  const trimmed = rawTarget.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    return { target: url.toString(), label: url.toString() };
  }
  const sourcePath = await validatePath(trimmed);
  const stat = await fs.stat(sourcePath);
  if (!stat.isFile()) throw new Error("Visual review target must be a file or HTTP/HTTPS URL");
  return { target: pathToFileURL(sourcePath).toString(), label: sourcePath, sourcePath };
}

function detectKind(resolved: ResolvedTarget, explicit: VisualReviewInput["kind"]): VisualArtifactKind {
  if (explicit && explicit !== "auto") return explicit;
  if (!resolved.sourcePath) return "url";
  const extension = path.extname(resolved.sourcePath).toLowerCase();
  if (IMAGE_MIME_BY_EXT[extension]) return "image";
  if (extension === ".svg") return "svg";
  if (extension === ".html" || extension === ".htm") return "html";
  if (extension === ".pdf") return "pdf";
  if (extension === ".pptx") return "pptx";
  if (extension === ".docx") return "docx";
  throw new Error(`Unsupported visual artifact type: ${extension || "none"}. Use image, SVG, HTML/URL, PDF, PPTX, or DOCX.`);
}

async function createOutputDirectory(workspaceRoot: string, requested?: string): Promise<string> {
  const candidate = requested?.trim()
    ? await validatePath(requested)
    : await validatePath(path.join(workspaceRoot, ".chatgpt-local-coder", "visual-reviews", `${Date.now()}-${randomUUID().slice(0, 8)}`));
  await fs.mkdir(candidate, { recursive: true });
  return candidate;
}

function selectorForFocus(focus: VisualFocusInput): string | null {
  const selector = focus.selector?.trim();
  return selector || null;
}

function rectDistance(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): number {
  const dx = Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width), 0);
  const dy = Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height), 0);
  return Math.sqrt(dx * dx + dy * dy);
}

function unionRect(
  a: { x: number; y: number; width: number; height: number },
  b?: { x: number; y: number; width: number; height: number }
): { x: number; y: number; width: number; height: number } {
  if (!b) return { ...a };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

async function pageMetrics(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    const clipped: Array<Record<string, unknown>> = [];
    const elements = Array.from(document.querySelectorAll<HTMLElement>("body *")).slice(0, 5000);
    for (const element of elements) {
      const style = getComputedStyle(element);
      const horizontal = element.scrollWidth > element.clientWidth + 2;
      const vertical = element.scrollHeight > element.clientHeight + 2;
      const clips = ["hidden", "clip"].includes(style.overflow) || ["hidden", "clip"].includes(style.overflowX) || ["hidden", "clip"].includes(style.overflowY);
      if ((horizontal || vertical) && clips) {
        clipped.push({
          tag: element.tagName.toLowerCase(),
          id: element.id || undefined,
          class_name: typeof element.className === "string" ? element.className.slice(0, 120) : undefined,
          client_width: element.clientWidth,
          scroll_width: element.scrollWidth,
          client_height: element.clientHeight,
          scroll_height: element.scrollHeight,
        });
        if (clipped.length >= 20) break;
      }
    }
    return {
      title: document.title,
      viewport_width: window.innerWidth,
      viewport_height: window.innerHeight,
      document_width: Math.max(root.scrollWidth, body?.scrollWidth || 0),
      document_height: Math.max(root.scrollHeight, body?.scrollHeight || 0),
      clipped_elements: clipped,
      clipped_element_count: clipped.length,
    };
  });
}

async function waitForVisualStability(page: Page, deadline: VisualDeadline): Promise<void> {
  const availableMs = visualOperationTimeout(deadline, "Visual font stabilization");
  const fontWaitMs = Math.min(3_000, Math.max(250, Math.floor(availableMs / 4)));
  await withVisualDeadline("Visual font stabilization", deadline, () => page.evaluate(async (waitMs) => {
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (fonts?.ready) {
      await Promise.race([
        fonts.ready,
        new Promise<void>((resolve) => setTimeout(resolve, waitMs)),
      ]);
    }
  }, fontWaitMs)).catch(() => undefined);
  const settleMs = Math.min(350, Math.max(80, Math.floor(availableMs / 100)));
  await withVisualDeadline(
    "Visual stability settle",
    deadline,
    () => page.waitForTimeout(Math.min(settleMs, visualOperationTimeout(deadline, "Visual stability settle", settleMs)))
  );
}

async function fitSvgCanvasToViewport(
  page: Page,
  width: number,
  height: number,
  deadline: VisualDeadline,
  viewportApplied: boolean
): Promise<SvgCanvasDiagnostics> {
  return withVisualDeadline("SVG canvas fit", deadline, () => page.evaluate(({ outputWidth, outputHeight, viewportWasApplied }) => {
    const incomplete = (reason: string): SvgCanvasDiagnostics => ({
      capture_mode: "incomplete",
      full_canvas_captured: false,
      has_view_box: false,
      synthetic_view_box: false,
      output_width: outputWidth,
      output_height: outputHeight,
      viewport_applied: viewportWasApplied,
      reason,
    });
    const root = document.documentElement;
    if (!root || root.tagName.toLowerCase() !== "svg") {
      return incomplete("The SVG document root was not available as an SVG element.");
    }
    const svg = root as unknown as SVGSVGElement;
    const parseLength = (raw: string | null): number | undefined => {
      if (!raw) return undefined;
      const match = raw.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*(px|pt|pc|in|cm|mm|q)?$/i);
      if (!match) return undefined;
      const value = Number(match[1]);
      if (!Number.isFinite(value) || value <= 0) return undefined;
      const units = { px: 1, pt: 96 / 72, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6 } as Record<string, number>;
      const converted = value * (units[(match[2] || "px").toLowerCase()] || 1);
      return Number.isFinite(converted) && converted > 0 ? converted : undefined;
    };
    const parseViewBox = (raw: string | null): { x: number; y: number; width: number; height: number } | undefined => {
      if (!raw) return undefined;
      const values = raw.trim().split(/[\s,]+/).map(Number);
      if (values.length !== 4 || values.some((value) => !Number.isFinite(value)) || values[2] <= 0 || values[3] <= 0) return undefined;
      return { x: values[0], y: values[1], width: values[2], height: values[3] };
    };
    const originalViewBox = parseViewBox(svg.getAttribute("viewBox"));
    const widthAttr = parseLength(svg.getAttribute("width"));
    const heightAttr = parseLength(svg.getAttribute("height"));
    const effectiveViewBox = originalViewBox || (
      widthAttr && heightAttr
        ? { x: 0, y: 0, width: widthAttr, height: heightAttr }
        : undefined
    );
    if (!effectiveViewBox) {
      return incomplete("The SVG has no valid viewBox or explicit width/height from which a complete canvas can be derived. Supply an artboard before review; drawable bounds alone omit margins and effects.");
    }
    // Fit the authored outer canvas without changing its viewBox mapping.
    const sourceWidth = widthAttr ?? (heightAttr ? heightAttr * effectiveViewBox.width / effectiveViewBox.height : effectiveViewBox.width);
    const sourceHeight = heightAttr ?? (widthAttr ? widthAttr * effectiveViewBox.height / effectiveViewBox.width : effectiveViewBox.height);
    const scale = Math.min(outputWidth / sourceWidth, outputHeight / sourceHeight);
    if (!Number.isFinite(scale) || scale <= 0) {
      return incomplete("The SVG canvas aspect ratio cannot be fitted to the requested output bounds.");
    }
    const syntheticViewBox = !originalViewBox;
    if (syntheticViewBox) {
      svg.setAttribute("viewBox", `${effectiveViewBox.x} ${effectiveViewBox.y} ${effectiveViewBox.width} ${effectiveViewBox.height}`);
    }
    const fittedWidth = sourceWidth * scale;
    const fittedHeight = sourceHeight * scale;
    const left = (outputWidth - fittedWidth) / 2;
    const top = (outputHeight - fittedHeight) / 2;
    svg.style.setProperty("display", "block", "important");
    svg.style.setProperty("position", "fixed", "important");
    svg.style.setProperty("left", `${left}px`, "important");
    svg.style.setProperty("top", `${top}px`, "important");
    svg.style.setProperty("margin", "0", "important");
    svg.style.setProperty("width", `${fittedWidth}px`, "important");
    svg.style.setProperty("height", `${fittedHeight}px`, "important");
    svg.style.setProperty("max-width", "none", "important");
    svg.style.setProperty("max-height", "none", "important");
    svg.style.setProperty("overflow", "hidden", "important");
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const rect = svg.getBoundingClientRect();
    const fitsViewport = viewportWasApplied && viewportWidth === outputWidth && viewportHeight === outputHeight &&
      Math.abs(rect.x - left) <= 1 && Math.abs(rect.y - top) <= 1 &&
      Math.abs(rect.width - fittedWidth) <= 1 && Math.abs(rect.height - fittedHeight) <= 1 &&
      rect.x >= -1 && rect.y >= -1 && rect.right <= outputWidth + 1 && rect.bottom <= outputHeight + 1;
    if (!fitsViewport) {
      return {
        capture_mode: "incomplete",
        full_canvas_captured: false,
        has_view_box: Boolean(originalViewBox),
        synthetic_view_box: syntheticViewBox,
        source_width: sourceWidth,
        source_height: sourceHeight,
        effective_view_box: effectiveViewBox,
        output_width: outputWidth,
        output_height: outputHeight,
        fitted_width: sourceWidth * scale,
        fitted_height: sourceHeight * scale,
        viewport_applied: viewportWasApplied,
        reason: `SVG canvas did not fit inside the requested viewport (${viewportWidth}x${viewportHeight}); full canvas evidence is incomplete.`,
      };
    }
    return {
      capture_mode: "fit_canvas",
      full_canvas_captured: true,
      has_view_box: Boolean(originalViewBox),
      synthetic_view_box: syntheticViewBox,
      source_width: sourceWidth,
      source_height: sourceHeight,
      effective_view_box: effectiveViewBox,
      output_width: outputWidth,
      output_height: outputHeight,
      fitted_width: sourceWidth * scale,
      fitted_height: sourceHeight * scale,
      viewport_applied: viewportWasApplied,
    };
  }, { outputWidth: width, outputHeight: height, viewportWasApplied: viewportApplied }));
}

async function captureSelectorFocus(
  page: Page,
  focusItems: VisualFocusInput[],
  outputDir: string,
  deadline: VisualDeadline
): Promise<{
  paths: string[];
  details: Array<Record<string, unknown>>;
  issues: string[];
}> {
  const paths: string[] = [];
  const details: Array<Record<string, unknown>> = [];
  const issues: string[] = [];
  const metrics = await withVisualDeadline("Visual focus metrics", deadline, () => pageMetrics(page));
  const documentWidth = Number(metrics.document_width) || 1;
  const documentHeight = Number(metrics.document_height) || 1;

  for (let index = 0; index < Math.min(focusItems.length, MAX_FOCUS); index++) {
    page.setDefaultTimeout(visualOperationTimeout(deadline, "Visual focus capture"));
    const focus = focusItems[index];
    const selector = selectorForFocus(focus);
    if (!selector) continue;
    const locator = page.locator(selector).first();
    if ((await locator.count()) === 0) {
      issues.push(`Requested focus selector was not found: ${selector}`);
      details.push({ label: focus.label || selector, selector, found: false });
      continue;
    }
    await locator.scrollIntoViewIfNeeded().catch(() => undefined);
    const box = await locator.boundingBox();
    if (!box || box.width <= 0 || box.height <= 0) {
      issues.push(`Requested focus selector is not visible: ${selector}`);
      details.push({ label: focus.label || selector, selector, found: true, visible: false });
      continue;
    }

    let pairBox: { x: number; y: number; width: number; height: number } | undefined;
    if (focus.pair_selector?.trim()) {
      const pair = page.locator(focus.pair_selector.trim()).first();
      if ((await pair.count()) === 0) {
        issues.push(`Requested paired focus selector was not found: ${focus.pair_selector.trim()}`);
      } else {
        pairBox = (await pair.boundingBox()) ?? undefined;
      }
    }

    const combined = unionRect(box, pairBox);
    const padding = 28;
    const clip = {
      x: Math.max(0, combined.x - padding),
      y: Math.max(0, combined.y - padding),
      width: Math.max(1, Math.min(documentWidth - Math.max(0, combined.x - padding), combined.width + padding * 2)),
      height: Math.max(1, Math.min(documentHeight - Math.max(0, combined.y - padding), combined.height + padding * 2)),
    };
    const outputPath = path.join(outputDir, `focus-${String(index + 1).padStart(2, "0")}.png`);
    await page.screenshot({
      path: outputPath,
      type: "png",
      clip,
      animations: "disabled",
      timeout: visualOperationTimeout(deadline, "Visual focus screenshot"),
    });
    paths.push(outputPath);

    const svgBox = await locator.evaluate((element) => {
      const candidate = element as SVGGraphicsElement;
      if (typeof candidate.getBBox !== "function") return null;
      try {
        const value = candidate.getBBox();
        return { x: value.x, y: value.y, width: value.width, height: value.height };
      } catch {
        return null;
      }
    }).catch(() => null);

    details.push({
      label: focus.label || selector,
      selector,
      pair_selector: focus.pair_selector,
      found: true,
      visible: true,
      bounding_box: box,
      pair_bounding_box: pairBox,
      distance_px: pairBox ? rectDistance(box, pairBox) : undefined,
      overlaps_pair: pairBox ? rectDistance(box, pairBox) === 0 : undefined,
      svg_box: svgBox,
      crop_path: outputPath,
    });
  }
  return { paths, details, issues };
}

async function captureBrowserArtifact(
  resolved: ResolvedTarget,
  outputDir: string,
  width: number,
  height: number,
  deadline: VisualDeadline,
  fullPage: boolean,
  focusItems: VisualFocusInput[],
  fitSvgCanvas: boolean
): Promise<BrowserCaptureResult> {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  return withVisualBrowser("Visual browser capture", deadline, (browser) => withVisualPage(
    browser,
    deadline,
    "Visual browser capture page",
    { width, height, deviceScaleFactor: 1 },
    async (page) => {
      page.setDefaultTimeout(visualOperationTimeout(deadline, "Visual browser capture"));
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text().slice(0, 1000));
      });
      page.on("pageerror", (error) => pageErrors.push(error.message.slice(0, 1000)));
      page.on("requestfailed", (request) => requestFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || "failed"}`.slice(0, 1000)));
      let svgViewportApplied = false;
      if (fitSvgCanvas) {
        try {
          await withVisualDeadline("SVG viewport setup", deadline, () => page.setViewportSize({ width, height }));
          svgViewportApplied = true;
        } catch (error) {
          pageErrors.push(`SVG viewport setup failed: ${normalizeVisualError(error).message}`);
        }
      }
      await page.goto(resolved.target, { waitUntil: "domcontentloaded", timeout: visualOperationTimeout(deadline, "Visual page navigation") });
      await waitForVisualStability(page, deadline);
      let svgCanvas: SvgCanvasDiagnostics | undefined;
      if (fitSvgCanvas) {
        try {
          svgCanvas = await fitSvgCanvasToViewport(page, width, height, deadline, svgViewportApplied);
        } catch (error) {
          svgCanvas = {
            capture_mode: "incomplete",
            full_canvas_captured: false,
            has_view_box: false,
            synthetic_view_box: false,
            output_width: width,
            output_height: height,
            viewport_applied: svgViewportApplied,
            reason: `SVG canvas fit failed: ${normalizeVisualError(error).message}`,
          };
        }
      }
      const metrics = await withVisualDeadline("Visual page metrics", deadline, () => pageMetrics(page));
      const documentHeight = Number(metrics.document_height) || height;
      const documentWidth = Number(metrics.document_width) || width;
      const useFullPage = fullPage && documentHeight <= MAX_RENDER_DIMENSION * 4 && documentWidth <= MAX_RENDER_DIMENSION;
      const overviewPath = path.join(outputDir, "overview.png");
      await page.screenshot({
        path: overviewPath,
        type: "png",
        fullPage: useFullPage,
        animations: "disabled",
        timeout: visualOperationTimeout(deadline, "Visual overview screenshot"),
      });
      const selectorFocus = await captureSelectorFocus(page, focusItems, outputDir, deadline);
      const machineIssues = [
        ...(Number(metrics.viewport_width) !== width || Number(metrics.viewport_height) !== height
          ? ["Requested viewport was not applied; capture geometry is not verified."] : []),
        ...(fullPage && !useFullPage
          ? ["Requested full-page capture exceeds the safe render size and is incomplete. Review bounded sections or a paginated export before claiming full-document completion."] : []),
        ...pageErrors.map((error) => `Page error: ${error}`),
        ...consoleErrors.map((error) => `Console error: ${error}`),
        ...selectorFocus.issues,
        ...(svgCanvas && !svgCanvas.full_canvas_captured ? [`SVG canvas capture incomplete: ${svgCanvas.reason || "the requested canvas was not fully fitted to the output viewport"}.`] : []),
      ];
      const clippedCount = Number(metrics.clipped_element_count) || 0;
      const advisories = [
        ...requestFailures.slice(0, 10).map((failure) => `Request failed: ${failure}`),
        ...(clippedCount > 0 ? [`Detected ${clippedCount} element(s) with clipped/overflowing content.`] : []),
        ...(fullPage && !useFullPage ? ["Full-page capture was bounded because the document exceeded the safe render size."] : []),
      ];
      return {
        overviewPath,
        focusPaths: selectorFocus.paths,
        focusDetails: selectorFocus.details,
        machineIssues,
        advisories,
        diagnostics: {
          ...metrics,
          console_errors: consoleErrors,
          page_errors: pageErrors,
          request_failures: requestFailures,
          full_page_requested: fullPage,
          full_page_captured: useFullPage,
          ...(svgCanvas ? { svg_canvas: svgCanvas } : {}),
          browser: findVisualBrowserExecutable(),
        },
      };
    }
  ));
}

async function captureImageArtifact(
  sourcePath: string,
  outputDir: string,
  width: number,
  height: number,
  deadline: VisualDeadline
): Promise<BrowserCaptureResult> {
  return withVisualBrowser("Visual image capture", deadline, (browser) => withVisualPage(
    browser,
    deadline,
    "Visual image capture page",
    { width, height, deviceScaleFactor: 1 },
    async (page) => {
      page.setDefaultTimeout(visualOperationTimeout(deadline, "Visual image capture"));
      const dataUrl = await imageDataUrl(sourcePath);
      await page.setContent(
        `<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%;background:#eef2f5;display:grid;place-items:center;overflow:hidden}img{display:block;max-width:100%;max-height:100%;object-fit:contain}</style></head><body><img id="artifact" src="${dataUrl}"></body></html>`,
        { waitUntil: "load", timeout: visualOperationTimeout(deadline, "Visual image content") }
      );
      await page.locator("#artifact").waitFor({ state: "visible", timeout: visualOperationTimeout(deadline, "Visual image element") });
      const dimensions = await page.locator("#artifact").evaluate((element) => {
        const image = element as HTMLImageElement;
        return { natural_width: image.naturalWidth, natural_height: image.naturalHeight };
      });
      const overviewPath = path.join(outputDir, "overview.png");
      await page.screenshot({ path: overviewPath, type: "png", animations: "disabled", timeout: visualOperationTimeout(deadline, "Visual image screenshot") });
      return {
        overviewPath,
        focusPaths: [],
        focusDetails: [],
        machineIssues: [],
        advisories: [],
        diagnostics: { ...dimensions, browser: findVisualBrowserExecutable() },
      };
    }
  ));
}

function estimatePdfPageCount(pdfBytes: Buffer): number {
  const text = pdfBytes.toString("latin1");
  const directPages = (text.match(/\/Type\s*\/Page\b/g) || []).length;
  const counts = [...text.matchAll(/\/Count\s+(\d+)/g)]
    .map((match) => Number.parseInt(match[1], 10))
    .filter((value) => Number.isFinite(value) && value > 0 && value < 10000);
  return Math.max(1, directPages, counts.length ? Math.max(...counts) : 1);
}

function normalizePages(requested: number[] | undefined, pageCount: number): number[] {
  const values = requested?.length
    ? requested
    : Array.from({ length: Math.min(pageCount, MAX_PAGES) }, (_, index) => index + 1);
  return [...new Set(values.map((value) => Math.floor(value)).filter((value) => value >= 1 && value <= pageCount))].slice(0, MAX_PAGES);
}

function isVisualTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "TimeoutError" || /\b(?:timed out|timeout(?: of)? .* exceeded)\b/i.test(error.message);
}

function isTransientPdfCaptureReadinessError(error: unknown): boolean {
  const message = normalizeVisualError(error).message;
  return /(?:unable|failed|could not) to capture (?:a )?screenshot|screenshot capture (?:is )?(?:not ready|temporarily unavailable)/i.test(message);
}

/** Internal behavioral seams used by the focused lifecycle tests. */
export const __visualHarnessTestHooks = Object.freeze({
  createVisualDeadline,
  withVisualDeadline,
  withVisualCleanup,
  closeVisualResource,
  isTransientPdfCaptureReadinessError,
});

async function renderPdfPages(
  pdfPath: string,
  outputDir: string,
  width: number,
  height: number,
  deadline: VisualDeadline,
  requestedPages?: number[]
): Promise<{
  pagePaths: string[];
  pageMap: Map<number, string>;
  pageCount: number;
  advisories: string[];
  diagnostics: Record<string, unknown>;
}> {
  const pdfBytes = await fs.readFile(pdfPath);
  const pageCount = estimatePdfPageCount(pdfBytes);
  const pages = normalizePages(requestedPages, pageCount);
  const pagePaths: string[] = [];
  const pageMap = new Map<number, string>();
  const errors: string[] = [];
  return withVisualBrowser("Visual PDF capture", deadline, async (browser) => {
    for (const pageNumber of pages) {
      const outputPath = await withVisualPage(
        browser,
        deadline,
        `Visual PDF page ${pageNumber}`,
        { width, height, deviceScaleFactor: 1 },
        async (page) => {
        page.setDefaultTimeout(visualOperationTimeout(deadline, `Visual PDF page ${pageNumber}`));
        page.on("pageerror", (error) => errors.push(error.message.slice(0, 1000)));
        const target = `${pathToFileURL(pdfPath).toString()}#page=${pageNumber}&zoom=page-fit`;
        await page.goto(target, { waitUntil: "domcontentloaded", timeout: visualOperationTimeout(deadline, `Visual PDF page ${pageNumber} navigation`) });
        try {
          await withVisualDeadline(
            `Visual PDF page ${pageNumber} load`,
            deadline,
            () => page.waitForLoadState("load", { timeout: Math.min(5_000, visualOperationTimeout(deadline, `Visual PDF page ${pageNumber} load`)) })
          );
        } catch (error) {
          if (!isVisualTimeoutError(error) || deadline.remainingMs() <= 0) throw error;
        }
        const settleMs = Math.min(1400, Math.max(500, Math.floor(deadline.timeoutMs / 20)));
        await withVisualDeadline(
          `Visual PDF page ${pageNumber} stabilization`,
          deadline,
          () => page.waitForTimeout(Math.min(settleMs, visualOperationTimeout(deadline, `Visual PDF page ${pageNumber} stabilization`, settleMs)))
        );
        const toolbar = Math.min(64, Math.max(0, height - 100));
        const outputPath = path.join(outputDir, `page-${String(pageNumber).padStart(3, "0")}.png`);
        let screenshotError: unknown;
        for (let attempt = 1; attempt <= MAX_PDF_SCREENSHOT_ATTEMPTS; attempt++) {
          try {
            await page.screenshot({
              path: outputPath,
              type: "png",
              clip: { x: 0, y: toolbar, width, height: height - toolbar },
              animations: "disabled",
              timeout: visualOperationTimeout(deadline, `Visual PDF page ${pageNumber} screenshot`),
            });
            screenshotError = undefined;
            break;
          } catch (error) {
            screenshotError = error;
            if (
              attempt === MAX_PDF_SCREENSHOT_ATTEMPTS ||
              page.isClosed() ||
              !isTransientPdfCaptureReadinessError(error)
            ) break;
            const remaining = deadline.remainingMs();
            if (remaining <= 0) break;
            const retryDelay = Math.max(1, Math.min(500 * attempt, 2_000, Math.floor(remaining)));
            try {
              await withVisualDeadline(
                `Visual PDF page ${pageNumber} screenshot retry ${attempt}`,
                deadline,
                () => page.waitForTimeout(retryDelay)
              );
            } catch {
              break;
            }
          }
        }
        if (screenshotError) throw new Error(`Visual PDF page ${pageNumber} capture failed after bounded retries: ${normalizeVisualError(screenshotError).message}`, { cause: screenshotError });
        return outputPath;
        }
      );
      pagePaths.push(outputPath);
      pageMap.set(pageNumber, outputPath);
    }
    return {
      pagePaths,
      pageMap,
      pageCount,
      advisories: [
        "PDF pages are captured through the installed Chromium PDF viewer; page-count detection is best-effort for unusual PDFs.",
      ],
      diagnostics: { requested_pages: pages, estimated_page_count: pageCount, page_errors: errors, browser: findVisualBrowserExecutable() },
    };
  });
}

async function officeProcessIds(processName: "WINWORD" | "POWERPNT"): Promise<number[]> {
  if (process.platform !== "win32") return [];
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process ${processName} -ErrorAction SilentlyContinue).Id -join ','`],
      { windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024 }
    );
    return stdout.trim().split(",").map((value) => Number.parseInt(value, 10)).filter(Number.isFinite);
  } catch (error) {
    throw new Error(`OFFICE_PROCESS_INSPECTION_FAILED: Cannot safely inspect ${processName}`, { cause: error });
  }
}

async function runPowerShellScript(
  scriptPath: string,
  args: string[],
  deadline: VisualDeadline,
  officeProcessName: "WINWORD" | "POWERPNT",
  allowOfficeRunning: boolean
): Promise<{ stdout: string; stderr: string }> {
  if (process.platform !== "win32") throw new Error("Office rendering currently requires Windows PowerShell automation");
  const before = await officeProcessIds(officeProcessName);
  if (before.length > 0 && !allowOfficeRunning) {
    throw new Error(`${officeProcessName} is already running. Safe Office rendering was skipped to avoid touching the user's open Office session. Close it or set allow_office_running=true.`);
  }
  let child: ReturnType<typeof spawn> | undefined;
  // ChildProcess retains the exact PowerShell process handle on Windows.
  // Closing that helper also closes its private Office kill-on-close job.
  const abort = (): void => { child?.kill(); };
  return withVisualDeadline(
    "Office renderer",
    deadline,
    () => new Promise((resolve, reject) => {
      child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
      );
      let stdout = "";
      let stderr = "";
      let settled = false;
      child.stdout?.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-100000); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-100000); });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
        else reject(new Error([stderr.trim(), stdout.trim()].filter(Boolean).join("\n") || `Office renderer exited with code ${code}`));
      });
    }),
    abort
  );
}

async function exportPptx(
  sourcePath: string,
  outputDir: string,
  width: number,
  height: number,
  deadline: VisualDeadline,
  allowOfficeRunning: boolean
): Promise<string[]> {
  const slideDir = path.join(outputDir, "slides");
  await fs.mkdir(slideDir, { recursive: true });
  const isolatedInput = path.join(outputDir, `office-input-${randomUUID()}.pptx`);
  await fs.copyFile(sourcePath, isolatedInput);
  const scriptPath = path.join(outputDir, "export-pptx.ps1");
  await fs.writeFile(scriptPath, privateOfficeAutomationScript, "utf-8");
  try {
    await runPowerShellScript(
      scriptPath,
      ["-InputPath", isolatedInput, "-OutputPath", slideDir, "-Kind", "pptx", "-Width", String(width), "-Height", String(height)],
      deadline,
      "POWERPNT",
      allowOfficeRunning
    );
  } finally {
    await fs.rm(scriptPath, { force: true }).catch(() => undefined);
    await fs.rm(isolatedInput, { force: true }).catch(() => undefined);
  }
  const names = (await fs.readdir(slideDir)).filter((name) => /\.png$/i.test(name));
  names.sort((left, right) => {
    const leftNumber = Number.parseInt(left.match(/\d+/)?.[0] || "0", 10);
    const rightNumber = Number.parseInt(right.match(/\d+/)?.[0] || "0", 10);
    return leftNumber - rightNumber || left.localeCompare(right);
  });
  if (names.length === 0) throw new Error("PowerPoint finished without exporting slide images");
  return names.map((name) => path.join(slideDir, name));
}

async function exportDocxToPdf(
  sourcePath: string,
  outputDir: string,
  deadline: VisualDeadline,
  allowOfficeRunning: boolean
): Promise<string> {
  const pdfPath = path.join(outputDir, "document.pdf");
  const isolatedInput = path.join(outputDir, `office-input-${randomUUID()}.docx`);
  await fs.copyFile(sourcePath, isolatedInput);
  const scriptPath = path.join(outputDir, "export-docx.ps1");
  await fs.writeFile(scriptPath, privateOfficeAutomationScript, "utf-8");
  try {
    await runPowerShellScript(
      scriptPath,
      ["-InputPath", isolatedInput, "-OutputPath", pdfPath, "-Kind", "docx"],
      deadline,
      "WINWORD",
      allowOfficeRunning
    );
  } finally {
    await fs.rm(scriptPath, { force: true }).catch(() => undefined);
    await fs.rm(isolatedInput, { force: true }).catch(() => undefined);
  }
  const stat = await fs.stat(pdfPath).catch(() => null);
  if (!stat?.isFile() || stat.size === 0) throw new Error("Word finished without exporting a PDF");
  return pdfPath;
}

async function createContactSheet(imagePaths: string[], outputPath: string, deadline: VisualDeadline): Promise<string> {
  if (imagePaths.length === 1) return imagePaths[0];
  const cards = await withVisualDeadline("Visual contact sheet image loading", deadline, () => Promise.all(imagePaths.slice(0, MAX_PAGES).map(async (imagePath, index) => {
    const dataUrl = await imageDataUrl(imagePath);
    return `<figure><figcaption>Page ${index + 1}</figcaption><img src="${dataUrl}"></figure>`;
  })));
  return withVisualBrowser("Visual contact sheet", deadline, (browser) => withVisualPage(
    browser,
    deadline,
    "Visual contact sheet page",
    { width: 1600, height: 1000, deviceScaleFactor: 1 },
    async (page) => {
    page.setDefaultTimeout(visualOperationTimeout(deadline, "Visual contact sheet"));
    await page.setContent(
      `<!doctype html><html><head><style>body{margin:0;padding:24px;background:#e9eef2;font:18px sans-serif;color:#243746}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}figure{margin:0;background:white;border-radius:12px;padding:12px;box-shadow:0 3px 14px #0002}figcaption{font-weight:700;margin:0 0 8px}img{display:block;width:100%;height:360px;object-fit:contain;background:#f7f8fa}</style></head><body><div class="grid">${cards.join("")}</div></body></html>`,
      { waitUntil: "load", timeout: visualOperationTimeout(deadline, "Visual contact sheet content") }
    );
    await page.screenshot({
      path: outputPath,
      type: "png",
      fullPage: true,
      animations: "disabled",
      timeout: visualOperationTimeout(deadline, "Visual contact sheet screenshot"),
    }).catch((error) => { throw new Error(`Visual contact sheet capture failed (${imagePaths.length} pages): ${normalizeVisualError(error).message}`, { cause: error }); });
    return outputPath;
    }
  ));
}

async function cropRasterRegions(
  pageMap: Map<number, string>,
  focuses: VisualFocusInput[],
  outputDir: string,
  deadline: VisualDeadline
): Promise<{ paths: string[]; details: Array<Record<string, unknown>>; issues: string[] }> {
  const regionFocus = focuses.filter((focus) => focus.x !== undefined || focus.y !== undefined || focus.width !== undefined || focus.height !== undefined).slice(0, MAX_FOCUS);
  if (regionFocus.length === 0) return { paths: [], details: [], issues: [] };
  const paths: string[] = [];
  const details: Array<Record<string, unknown>> = [];
  const issues: string[] = [];
  return withVisualBrowser("Visual raster focus capture", deadline, async (browser) => {
    for (let index = 0; index < regionFocus.length; index++) {
      const focus = regionFocus[index];
      const pageNumber = Math.max(1, Math.floor(focus.page || 1));
      const sourcePath = pageMap.get(pageNumber);
      if (!sourcePath) {
        issues.push(`Requested focus page was not rendered: ${pageNumber}`);
        continue;
      }
      const outputPath = path.join(outputDir, `region-${String(index + 1).padStart(2, "0")}.png`);
      const captured = await withVisualPage(
        browser,
        deadline,
        `Visual raster focus ${index + 1}`,
        { width: 100, height: 100, deviceScaleFactor: 1 },
        async (page) => {
          page.setDefaultTimeout(visualOperationTimeout(deadline, `Visual raster focus ${index + 1}`));
          const dataUrl = await withVisualDeadline(
            `Visual raster focus ${index + 1} image loading`,
            deadline,
            () => imageDataUrl(sourcePath)
          );
          await page.setContent(
            `<html><body style="margin:0"><img id="artifact" style="display:block" src="${dataUrl}"></body></html>`,
            { waitUntil: "load", timeout: visualOperationTimeout(deadline, `Visual raster focus ${index + 1} content`) }
          );
          const dimensions = await withVisualDeadline(
            `Visual raster focus ${index + 1} dimensions`,
            deadline,
            () => page.locator("#artifact").evaluate((element) => {
              const image = element as HTMLImageElement;
              return { width: image.naturalWidth, height: image.naturalHeight };
            })
          );
          await withVisualDeadline(
            `Visual raster focus ${index + 1} viewport`,
            deadline,
            () => page.setViewportSize({
              width: Math.max(1, Math.min(MAX_RENDER_DIMENSION, dimensions.width)),
              height: Math.max(1, Math.min(MAX_RENDER_DIMENSION, dimensions.height)),
            })
          );
          const ratio = focus.unit !== "px";
          const x = ratio ? (focus.x ?? 0) * dimensions.width : (focus.x ?? 0);
          const y = ratio ? (focus.y ?? 0) * dimensions.height : (focus.y ?? 0);
          const width = ratio ? (focus.width ?? 1) * dimensions.width : (focus.width ?? dimensions.width);
          const height = ratio ? (focus.height ?? 1) * dimensions.height : (focus.height ?? dimensions.height);
          const clip = {
            x: Math.max(0, Math.min(dimensions.width - 1, x)),
            y: Math.max(0, Math.min(dimensions.height - 1, y)),
            width: Math.max(1, Math.min(dimensions.width - Math.max(0, x), width)),
            height: Math.max(1, Math.min(dimensions.height - Math.max(0, y), height)),
          };
          await page.screenshot({
            path: outputPath,
            type: "png",
            clip,
            animations: "disabled",
            timeout: visualOperationTimeout(deadline, `Visual raster focus ${index + 1} screenshot`),
          });
          return clip;
        }
      );
      paths.push(outputPath);
      details.push({ label: focus.label || `Page ${pageNumber} region`, page: pageNumber, unit: focus.unit || "ratio", clip: captured, crop_path: outputPath });
    }
    return { paths, details, issues };
  });
}

async function resolveComparisonTarget(
  workspaceRoot: string,
  compareTo: string
): Promise<{ path: string; reviewId?: string }> {
  const trimmed = compareTo.trim();
  if (/^[a-f0-9-]{36}$/i.test(trimmed)) {
    const review = await getVisualReviewRecord(workspaceRoot, trimmed);
    const baseline = review.overview_path || review.output_paths[0];
    if (!baseline) throw new Error(`Visual review ${trimmed} has no preview image`);
    return { path: baseline, reviewId: trimmed };
  }
  return { path: await validatePath(trimmed) };
}

async function createComparison(
  baselinePath: string,
  currentPath: string,
  outputPath: string,
  deadline: VisualDeadline
): Promise<Record<string, unknown>> {
  const [before, after] = await withVisualDeadline(
    "Visual comparison image loading",
    deadline,
    () => Promise.all([imageDataUrl(baselinePath), imageDataUrl(currentPath)])
  );
  return withVisualBrowser("Visual comparison", deadline, (browser) => withVisualPage(
    browser,
    deadline,
    "Visual comparison page",
    { width: 1500, height: 950, deviceScaleFactor: 1 },
    async (page) => {
    page.setDefaultTimeout(visualOperationTimeout(deadline, "Visual comparison"));
    await page.setContent(
      `<!doctype html><html><head><style>body{margin:0;padding:22px;background:#e9eef2;font:18px sans-serif;color:#243746}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.card{background:white;padding:12px;border-radius:12px}.card h2{margin:0 0 8px;font-size:20px}.card img,.card canvas{display:block;width:100%;height:520px;object-fit:contain;background:#f7f8fa}.diff{grid-column:1/-1}</style></head><body><div class="grid"><section class="card"><h2>Before</h2><img id="before" src="${before}"></section><section class="card"><h2>After</h2><img id="after" src="${after}"></section><section class="card diff"><h2>Pixel difference</h2><canvas id="diff"></canvas></section></div><script>Promise.all([new Promise(r=>before.onload=r),new Promise(r=>after.onload=r)]).then(()=>{const w=Math.max(1,Math.min(before.naturalWidth,after.naturalWidth,1200));const h=Math.max(1,Math.min(before.naturalHeight,after.naturalHeight,800));const a=document.createElement('canvas');const b=document.createElement('canvas');a.width=b.width=diff.width=w;a.height=b.height=diff.height=h;const ac=a.getContext('2d'),bc=b.getContext('2d'),dc=diff.getContext('2d');ac.drawImage(before,0,0,w,h);bc.drawImage(after,0,0,w,h);const ad=ac.getImageData(0,0,w,h),bd=bc.getImageData(0,0,w,h),out=dc.createImageData(w,h);let changed=0,total=0;for(let i=0;i<ad.data.length;i+=4){const d=Math.abs(ad.data[i]-bd.data[i])+Math.abs(ad.data[i+1]-bd.data[i+1])+Math.abs(ad.data[i+2]-bd.data[i+2]);total+=d;if(d>36)changed++;out.data[i]=Math.min(255,d);out.data[i+1]=0;out.data[i+2]=0;out.data[i+3]=255;}dc.putImageData(out,0,0);window.__metrics={width:w,height:h,changed_pixel_ratio:changed/(w*h),mean_absolute_difference:total/(w*h*3)};window.__ready=true;});</script></body></html>`,
      { waitUntil: "load", timeout: visualOperationTimeout(deadline, "Visual comparison content") }
    );
    await page.waitForFunction(() => (window as Window & { __ready?: boolean }).__ready === true, undefined, { timeout: visualOperationTimeout(deadline, "Visual comparison readiness") });
    const metrics = await page.evaluate(() => (window as Window & { __metrics?: Record<string, unknown> }).__metrics || {});
    await page.screenshot({
      path: outputPath,
      type: "png",
      fullPage: true,
      animations: "disabled",
      timeout: visualOperationTimeout(deadline, "Visual comparison screenshot"),
    });
    return metrics;
    }
  ));
}

async function renderArtifact(
  resolved: ResolvedTarget,
  kind: VisualArtifactKind,
  outputDir: string,
  deadline: VisualDeadline,
  input: Required<Pick<VisualReviewInput, "width" | "height" | "timeout_ms" | "full_page" | "allow_office_running">> & Pick<VisualReviewInput, "pages" | "focus">
): Promise<RenderResult> {
  const focus = input.focus || [];
  if (kind === "image") {
    if (!resolved.sourcePath) throw new Error("Image review requires a local file");
    const captured = await captureImageArtifact(resolved.sourcePath, outputDir, input.width, input.height, deadline);
    const pageMap = new Map<number, string>([[1, captured.overviewPath]]);
    const regions = await cropRasterRegions(pageMap, focus, outputDir, deadline);
    return {
      renderer: "chromium-image",
      overviewPath: captured.overviewPath,
      pagePaths: [captured.overviewPath],
      pageMap,
      focusPaths: regions.paths,
      focusDetails: regions.details,
      machineIssues: regions.issues,
      advisories: captured.advisories,
      diagnostics: captured.diagnostics,
    };
  }

  if (kind === "svg" || kind === "html" || kind === "url") {
    const captured = await captureBrowserArtifact(
      resolved,
      outputDir,
      input.width,
      input.height,
      deadline,
      input.full_page,
      focus.filter((item) => Boolean(item.selector)),
      // A local SVG is a bounded canvas artifact. Keep remote URL/HTML
      // viewport semantics unchanged, even when a caller supplies kind=svg.
      kind === "svg" && Boolean(resolved.sourcePath)
    );
    const pageMap = new Map<number, string>([[1, captured.overviewPath]]);
    const regions = await cropRasterRegions(pageMap, focus, outputDir, deadline);
    return {
      renderer: kind === "svg" ? "playwright-svg" : "playwright-page",
      overviewPath: captured.overviewPath,
      pagePaths: [captured.overviewPath],
      pageMap,
      focusPaths: [...captured.focusPaths, ...regions.paths],
      focusDetails: [...captured.focusDetails, ...regions.details],
      machineIssues: [...captured.machineIssues, ...regions.issues],
      advisories: captured.advisories,
      diagnostics: captured.diagnostics,
    };
  }

  if (!resolved.sourcePath) throw new Error(`${kind.toUpperCase()} review requires a local file`);

  if (kind === "pdf") {
    const rendered = await renderPdfPages(resolved.sourcePath, outputDir, input.width, input.height, deadline, input.pages);
    const overviewPath = await createContactSheet(rendered.pagePaths, path.join(outputDir, "overview.png"), deadline);
    const regions = await cropRasterRegions(rendered.pageMap, focus, outputDir, deadline);
    return {
      renderer: "chromium-pdf-viewer",
      overviewPath,
      pagePaths: rendered.pagePaths,
      pageMap: rendered.pageMap,
      focusPaths: regions.paths,
      focusDetails: regions.details,
      machineIssues: regions.issues,
      advisories: rendered.advisories,
      diagnostics: rendered.diagnostics,
    };
  }

  if (kind === "pptx") {
    const allSlides = await exportPptx(resolved.sourcePath, outputDir, input.width, input.height, deadline, input.allow_office_running);
    const selectedPages = normalizePages(input.pages, allSlides.length);
    const pageMap = new Map<number, string>(allSlides.map((slide, index) => [index + 1, slide]));
    const pagePaths = selectedPages.map((pageNumber) => pageMap.get(pageNumber)!).filter(Boolean);
    const overviewPath = await createContactSheet(pagePaths, path.join(outputDir, "overview.png"), deadline);
    const regions = await cropRasterRegions(pageMap, focus, outputDir, deadline);
    return {
      renderer: "powerpoint-com",
      overviewPath,
      pagePaths,
      pageMap,
      focusPaths: regions.paths,
      focusDetails: regions.details,
      machineIssues: regions.issues,
      advisories: [],
      diagnostics: { page_count: allSlides.length, reviewed_pages: selectedPages },
    };
  }

  const pdfPath = await exportDocxToPdf(resolved.sourcePath, outputDir, deadline, input.allow_office_running);
  const rendered = await renderPdfPages(pdfPath, outputDir, input.width, input.height, deadline, input.pages);
  const overviewPath = await createContactSheet(rendered.pagePaths, path.join(outputDir, "overview.png"), deadline);
  const regions = await cropRasterRegions(rendered.pageMap, focus, outputDir, deadline);
  return {
    renderer: "word-com-to-pdf-to-chromium",
    overviewPath,
    pagePaths: rendered.pagePaths,
    pageMap: rendered.pageMap,
    focusPaths: regions.paths,
    focusDetails: regions.details,
    machineIssues: regions.issues,
    advisories: rendered.advisories,
    diagnostics: { ...rendered.diagnostics, exported_pdf: pdfPath },
  };
}

export async function performVisualReview(workspaceRoot: string, input: VisualReviewInput): Promise<VisualReviewExecution> {
  const timeoutMs = clampInteger(input.timeout_ms, 30_000, 1_000, 120_000);
  const deadline = createVisualDeadline(timeoutMs);
  const resolved = await resolveTarget(input.target);
  const kind = detectKind(resolved, input.kind);
  const width = clampInteger(input.width, kind === "svg" ? 1200 : 1440, 320, 2400);
  const height = clampInteger(input.height, kind === "svg" ? 800 : 1000, 240, 1800);
  const maxImages = clampInteger(input.max_images, 12, 1, 12);
  const outputDir = await createOutputDirectory(workspaceRoot, input.output_dir);
  const signatureBefore = resolved.sourcePath ? await fileSignature(resolved.sourcePath) : undefined;
  const rendered = await renderArtifact(resolved, kind, outputDir, deadline, {
    width,
    height,
    timeout_ms: timeoutMs,
    full_page: Boolean(input.full_page),
    allow_office_running: Boolean(input.allow_office_running),
    pages: input.pages,
    focus: input.focus?.slice(0, MAX_FOCUS),
  });

  let comparisonPath: string | undefined;
  let comparisonMetrics: Record<string, unknown> | undefined;
  let baselineReviewId: string | undefined;
  let effectiveQualityBar: VisualQualityBar = input.quality_bar ?? "standard";
  if (input.compare_to?.trim()) {
    const baseline = await resolveComparisonTarget(workspaceRoot, input.compare_to);
    comparisonPath = path.join(outputDir, "comparison.png");
    comparisonMetrics = await createComparison(baseline.path, rendered.overviewPath, comparisonPath, deadline);
    baselineReviewId = baseline.reviewId;
    if (baselineReviewId) {
      const baselineRecord = await getVisualReviewRecord(workspaceRoot, baselineReviewId);
      const baselineQualityBar = baselineRecord.quality_bar ?? "standard";
      effectiveQualityBar = input.quality_bar ?? baselineQualityBar;
    }
  }

  const signature = resolved.sourcePath ? await fileSignature(resolved.sourcePath) : undefined;
  if (signatureBefore && signature && signatureBefore.signature !== signature.signature) {
    rendered.machineIssues.push("Source changed while the visual review was rendering; rerun visual_review on the stable final source.");
  }
  const outputPaths = [...new Set([
    rendered.overviewPath,
    ...rendered.pagePaths,
    ...rendered.focusPaths,
    ...(comparisonPath ? [comparisonPath] : []),
  ])];
  const pagedArtifact = kind === "pdf" || kind === "pptx" || kind === "docx";
  const preferredPaths = [...new Set(pagedArtifact
    ? [
        ...rendered.pagePaths,
        rendered.overviewPath,
        ...rendered.focusPaths,
        ...(comparisonPath ? [comparisonPath] : []),
      ]
    : [
        rendered.overviewPath,
        ...rendered.focusPaths,
        ...(comparisonPath ? [comparisonPath] : []),
      ])].slice(0, maxImages);
  const images: VisualImagePayload[] = [];
  let returnedImageBytes = 0;
  for (let index = 0; index < preferredPaths.length; index++) {
    const imagePath = preferredPaths[index];
    const { bytes, mimeType } = await readImage(imagePath);
    if (images.length > 0 && returnedImageBytes + bytes.length > MAX_TOTAL_RETURN_IMAGE_BYTES) continue;
    images.push({
      path: imagePath,
      label: imagePath === rendered.overviewPath
        ? (pagedArtifact ? "overview/contact sheet" : "full render")
        : imagePath === comparisonPath
          ? "before-after comparison"
          : path.basename(imagePath),
      bytes,
      mime_type: mimeType,
    });
    returnedImageBytes += bytes.length;
  }

  const pageCount = pagedArtifact
    ? Math.max(1, Number(rendered.diagnostics.page_count ?? rendered.diagnostics.estimated_page_count) || rendered.pageMap.size || 1)
    : 1;
  const renderedPages = pagedArtifact ? [...rendered.pageMap.keys()].sort((a, b) => a - b) : [1];
  const deliveredPages = pagedArtifact
    ? [...rendered.pageMap.entries()]
        .filter(([, pagePath]) => images.some((image) => image.path === pagePath))
        .map(([pageNumber]) => pageNumber)
        .sort((a, b) => a - b)
    : (images.length > 0 ? [1] : []);

  const record = await saveVisualReviewRecord(workspaceRoot, {
    target: resolved.label,
    kind,
    quality_bar: effectiveQualityBar,
    renderer: rendered.renderer,
    source_path: resolved.sourcePath,
    source_signature: signature?.signature,
    source_size: signature?.size,
    source_mtime_ms: signature?.mtime_ms,
    overview_path: rendered.overviewPath,
    output_paths: outputPaths,
    page_paths: rendered.pagePaths,
    page_count: pageCount,
    rendered_pages: renderedPages,
    delivered_pages: deliveredPages,
    focus_paths: rendered.focusPaths,
    comparison_path: comparisonPath,
    baseline_review_id: baselineReviewId,
    machine_blocking_issues: rendered.machineIssues,
    machine_advisories: rendered.advisories,
    diagnostics: {
      ...rendered.diagnostics,
      focus: rendered.focusDetails,
      comparison: comparisonMetrics,
    },
  });
  const freshness = await getVisualReviewFreshness(workspaceRoot, record.id);

  return {
    data: {
      review_id: record.id,
      target: resolved.label,
      kind,
      quality_bar: effectiveQualityBar,
      renderer: rendered.renderer,
      visual_status: rendered.machineIssues.length === 0 ? "rendered_current" : "rendered_with_blocking_issues",
      render_status: rendered.machineIssues.length === 0 ? "clean" : "blocked",
      model_visual_status: "pending",
      model_visual_critique_required: false,
      model_visual_assessment_required: false,
      model_visual_instruction: "Inspect the returned images before recording a visual assessment. Findings, scores and further improvement are model declarations, not independent verification; evaluations can be revised or withdrawn.",
      source_signature: signature?.signature,
      overview_path: rendered.overviewPath,
      output_paths: outputPaths,
      page_paths: rendered.pagePaths,
      page_count: pageCount,
      rendered_pages: renderedPages,
      delivered_pages: deliveredPages,
      model_visual_coverage: freshness.model_visual_coverage,
      recommended_next_pages: freshness.model_visual_coverage.missing_pages.slice(0, MAX_PAGES),
      focus_paths: rendered.focusPaths,
      comparison_path: comparisonPath,
      machine_blocking_issues: rendered.machineIssues,
      machine_advisories: rendered.advisories,
      diagnostics: record.diagnostics,
      images_returned: images.map((image) => ({ path: image.path, label: image.label, mime_type: image.mime_type, bytes: image.bytes.length })),
      images_not_returned: outputPaths.filter((candidate) => !images.some((image) => image.path === candidate)),
      returned_image_bytes: returnedImageBytes,
      return_image_byte_limit: MAX_TOTAL_RETURN_IMAGE_BYTES,
    },
    images,
  };
}
