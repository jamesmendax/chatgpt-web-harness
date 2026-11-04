import fs from "fs/promises";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { pathToFileURL } from "url";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validatePath } from "../lib/path-security.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolError } from "../lib/tool-result.js";
import { findBrowserExecutable } from "../lib/browser-runtime.js";

const execFileAsync = promisify(execFile);
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

async function chromiumScreenshot(
  target: string,
  outputPath: string,
  width: number,
  height: number,
  timeoutMs: number
): Promise<void> {
  const browser = findBrowserExecutable();
  if (!browser) {
    throw new Error("No supported Chromium browser found. Set CHATGPT_BROWSER_PATH to Edge/Chrome/Chromium executable.");
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt-local-coder-browser-"));
  try {
    await execFileAsync(
      browser,
      [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-first-run",
        "--disable-extensions",
        "--run-all-compositor-stages-before-draw",
        `--user-data-dir=${profileDir}`,
        `--window-size=${width},${height}`,
        `--screenshot=${outputPath}`,
        target,
      ],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }
    );
  } finally {
    await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }

  const stat = await fs.stat(outputPath).catch(() => null);
  if (!stat?.isFile() || stat.size === 0) throw new Error("Browser finished without producing a screenshot");
}

async function resolveBrowserTarget(raw: string): Promise<{ target: string; label: string }> {
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    return { target: url.toString(), label: url.toString() };
  }

  const localPath = await validatePath(trimmed);
  const stat = await fs.stat(localPath);
  if (!stat.isFile()) throw new Error("Local browser target must be a file");
  return { target: pathToFileURL(localPath).toString(), label: localPath };
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

        await chromiumScreenshot(pathToFileURL(svgPath).toString(), outputPath, width, height, timeout_ms);
        const { bytes, mimeType } = await readImageForModel(outputPath);
        return visualResult(
          "render_svg",
          { source_path: svgPath, output_path: outputPath, width, height, bytes: bytes.length, browser: findBrowserExecutable() },
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

        await chromiumScreenshot(resolved.target, outputPath, width, height, timeout_ms);
        const { bytes, mimeType } = await readImageForModel(outputPath);
        return visualResult(
          "capture_webpage",
          { target: resolved.label, output_path: outputPath, width, height, bytes: bytes.length, browser: findBrowserExecutable() },
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
