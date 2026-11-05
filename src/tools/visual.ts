import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validatePath } from "../lib/path-security.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolError } from "../lib/tool-result.js";
import { launchBrowser } from "../lib/browser-runtime.js";
import { resolveBrowserTarget } from "../lib/browser-target.js";

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_RENDER_DIMENSION = 4096;

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

interface VisualPayload extends Record<string, unknown> {
  ok: boolean;
  tool: string;
  summary: string;
  data: Record<string, unknown>;
}

function visualResult(tool: string, data: Record<string, unknown>, image: Buffer, mimeType: string, summary: string) {
  const payload: VisualPayload = { ok: true, tool, summary, data };
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
      { type: "image" as const, data: image.toString("base64"), mimeType },
    ],
    structuredContent: payload,
  };
}

function imageMimeType(filePath: string): string | null {
  return IMAGE_MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? null;
}

async function readImageForModel(filePath: string, maxBytes = MAX_IMAGE_BYTES): Promise<{ bytes: Buffer; mimeType: string }> {
  const mimeType = imageMimeType(filePath);
  if (!mimeType) throw new Error("Unsupported image type. Use PNG, JPEG, WebP, or GIF.");
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error("Path is not a file");
  if (stat.size > maxBytes) {
    throw new Error(`Image is ${stat.size} bytes; limit is ${maxBytes}. Render or resize a smaller preview first.`);
  }
  return { bytes: await fs.readFile(filePath), mimeType };
}

export async function chromiumScreenshot(
  target: string, outputPath: string, width: number, height: number, timeoutMs: number
): Promise<{ browser: string; browser_version: string; cleanup_errors: string[]; phases: string[] }> {
  const deadline = Date.now() + timeoutMs;
  const remaining = (phase: string) => {
    const value = deadline - Date.now();
    if (value <= 0) throw new Error(`Screenshot deadline exceeded in ${phase}`);
    return value;
  };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  let phase = "launch";
  let browser: Awaited<ReturnType<typeof launchBrowser>>["browser"] | undefined;
  let context: Awaited<ReturnType<NonNullable<typeof browser>["newContext"]>> | undefined;
  const cleanupErrors: string[] = [];
  const phases: string[] = [];
  const bounded = async <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} deadline exceeded`)), ms); })]); }
    finally { if (timer) clearTimeout(timer); }
  };
  let result: { browser: string; browser_version: string; cleanup_errors: string[]; phases: string[] } | undefined;
  let failure: string | undefined;
  try {
    const launched = await launchBrowser(remaining(phase));
    browser = launched.browser; phases.push("launch");
    const browserVersion = browser.version();
    phase = "context";
    context = await bounded(browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 }), remaining(phase), phase);
    const page = await bounded(context.newPage(), remaining(phase), phase);
    phases.push("context");
    phase = "navigation";
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: remaining(phase) });
    phases.push("navigation");
    phase = "screenshot";
    await page.screenshot({ path: outputPath, type: "png", timeout: remaining(phase), animations: "disabled" });
    phases.push("screenshot");
    result = { browser: launched.executablePath, browser_version: browserVersion, cleanup_errors: cleanupErrors, phases };
  } catch (error) {
    failure = `Screenshot failed during ${phase}: ${String(error)}`;
  } finally {
    if (context) await bounded(context.close(), 5000, "close context").then(() => phases.push("close context")).catch(error => cleanupErrors.push(`close context: ${String(error)}`));
    if (browser) await bounded(browser.close(), 5000, "close browser").then(() => phases.push("close browser")).catch(error => cleanupErrors.push(`close browser: ${String(error)}`));
  }
  if (failure) throw new Error(`${failure}; phases=${JSON.stringify(phases)}; cleanup_errors=${JSON.stringify(cleanupErrors)}`);
  return result!;
}

export function registerVisualTools(server: McpServer): void {
  server.registerTool(
    "open_image",
    {
      title: "Open Image",
      description:
        "Open a local PNG/JPEG/WebP/GIF as real MCP image content so ChatGPT can inspect it visually. Prefer this over read_file_base64 for visual QA.",
      inputSchema: {
        path: z.string().min(1).describe("Local image path"),
        max_bytes: z.number().int().positive().max(MAX_IMAGE_BYTES).optional().default(8 * 1024 * 1024),
      },
      annotations: toolAnnotations("read"),
    },
    async ({ path: inputPath, max_bytes }) => {
      try {
        const filePath = await validatePath(inputPath);
        const { bytes, mimeType } = await readImageForModel(filePath, max_bytes);
        return visualResult(
          "open_image",
          { path: filePath, bytes: bytes.length, mime_type: mimeType },
          bytes,
          mimeType,
          `open_image: ${filePath}`
        );
      } catch (error) {
        return toolError("open_image", error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    "render_svg",
    {
      title: "Render SVG",
      description:
        "Render a local SVG through installed Edge/Chrome/Chromium and return the PNG preview as real image content for visual inspection.",
      inputSchema: {
        path: z.string().min(1).describe("SVG file path"),
        output_path: z.string().min(1).optional().describe("Optional PNG output path; defaults beside the SVG"),
        width: z.number().int().min(64).max(MAX_RENDER_DIMENSION).optional().default(1024),
        height: z.number().int().min(64).max(MAX_RENDER_DIMENSION).optional().default(1024),
        timeout_ms: z.number().int().min(1000).max(120000).optional().default(30000),
      },
      annotations: toolAnnotations("command"),
    },
    async ({ path: inputPath, output_path, width, height, timeout_ms }) => {
      try {
        const svgPath = await validatePath(inputPath);
        if (path.extname(svgPath).toLowerCase() !== ".svg") throw new Error("render_svg requires an .svg file");
        const stat = await fs.stat(svgPath);
        if (!stat.isFile()) throw new Error("SVG path is not a file");

        const outputPath = output_path
          ? await validatePath(output_path)
          : path.join(path.dirname(svgPath), `${path.basename(svgPath, ".svg")}.preview.png`);
        if (path.extname(outputPath).toLowerCase() !== ".png") throw new Error("render_svg output_path must end in .png");

        const capture = await chromiumScreenshot(pathToFileURL(svgPath).toString(), outputPath, width, height, timeout_ms);
        const { bytes, mimeType } = await readImageForModel(outputPath);
        return visualResult(
          "render_svg",
          { source_path: svgPath, output_path: outputPath, width, height, bytes: bytes.length, ...capture },
          bytes,
          mimeType,
          `render_svg: ${svgPath}`
        );
      } catch (error) {
        return toolError("render_svg", error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    "capture_webpage",
    {
      title: "Capture Webpage",
      description:
        "Render an HTTP/HTTPS page or local HTML file in installed Edge/Chrome/Chromium, save a PNG screenshot, and return the screenshot as image content for visual QA.",
      inputSchema: {
        target: z.string().min(1).describe("HTTP/HTTPS URL or local HTML/file path"),
        output_path: z.string().min(1).optional().describe("Optional PNG output path"),
        width: z.number().int().min(320).max(MAX_RENDER_DIMENSION).optional().default(1440),
        height: z.number().int().min(240).max(MAX_RENDER_DIMENSION).optional().default(1000),
        timeout_ms: z.number().int().min(1000).max(120000).optional().default(30000),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: true },
    },
    async ({ target, output_path, width, height, timeout_ms }) => {
      try {
        const resolved = await resolveBrowserTarget(target);
        const outputPath = output_path
          ? await validatePath(output_path)
          : await validatePath(path.join(".chatgpt-local-coder", "previews", `web-${Date.now()}.png`));
        if (path.extname(outputPath).toLowerCase() !== ".png") throw new Error("capture_webpage output_path must end in .png");

        const capture = await chromiumScreenshot(resolved.target, outputPath, width, height, timeout_ms);
        const { bytes, mimeType } = await readImageForModel(outputPath);
        return visualResult(
          "capture_webpage",
          { target: resolved.label, output_path: outputPath, width, height, bytes: bytes.length, ...capture },
          bytes,
          mimeType,
          `capture_webpage: ${resolved.label}`
        );
      } catch (error) {
        return toolError("capture_webpage", error instanceof Error ? error.message : String(error));
      }
    }
  );
}
