import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../dist/server-factory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const tmpDir = path.join(root, ".visual-test-tmp");

function assertImageResult(result, toolName) {
  if (!result?.structuredContent?.ok) throw new Error(`${toolName}: structuredContent not ok`);
  const image = result.content?.find((block) => block.type === "image");
  if (!image) throw new Error(`${toolName}: no MCP image content block returned`);
  if (!image.mimeType?.startsWith("image/")) throw new Error(`${toolName}: invalid mime type`);
  if (!image.data || image.data.length < 20) throw new Error(`${toolName}: empty image payload`);
  return image;
}

await fs.rm(tmpDir, { recursive: true, force: true });
await fs.mkdir(tmpDir, { recursive: true });

const pngPath = path.join(tmpDir, "pixel.png");
await fs.writeFile(
  pngPath,
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlTtGQAAAAASUVORK5CYII=", "base64")
);

const svgPath = path.join(tmpDir, "sample.svg");
await fs.writeFile(
  svgPath,
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200"><rect width="320" height="200" fill="white"/><circle cx="100" cy="100" r="60" fill="#4f46e5"/><path d="M170 55 L280 100 L170 145 Z" fill="#f59e0b"/></svg>'
);

const htmlPath = path.join(tmpDir, "sample.html");
await fs.writeFile(
  htmlPath,
  '<!doctype html><html><body style="margin:0;background:white"><main style="font:40px sans-serif;padding:40px"><b>Visual loop test</b><div style="width:240px;height:120px;background:#22c55e;margin-top:20px"></div></main></body></html>'
);

const server = createMcpServer(tmpDir, 30_000, [tmpDir], true);
const client = new Client({ name: "visual-test-client", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

try {
  const listed = await client.listTools();
  const names = new Set(listed.tools.map((tool) => tool.name));
  for (const required of ["open_image", "render_svg", "capture_webpage"]) {
    if (!names.has(required)) throw new Error(`tools/list missing ${required}`);
  }

  const opened = await client.callTool({ name: "open_image", arguments: { path: pngPath } });
  const openedImage = assertImageResult(opened, "open_image");
  console.log(`OK open_image ${openedImage.mimeType} ${openedImage.data.length} base64 chars`);

  const rendered = await client.callTool({
    name: "render_svg",
    arguments: { path: svgPath, width: 640, height: 400, timeout_ms: 30_000 },
  });
  const renderedImage = assertImageResult(rendered, "render_svg");
  console.log(`OK render_svg ${renderedImage.mimeType} ${renderedImage.data.length} base64 chars`);

  const captured = await client.callTool({
    name: "capture_webpage",
    arguments: { target: htmlPath, width: 800, height: 500, timeout_ms: 30_000 },
  });
  const capturedImage = assertImageResult(captured, "capture_webpage");
  console.log(`OK capture_webpage ${capturedImage.mimeType} ${capturedImage.data.length} base64 chars`);
} finally {
  await client.close().catch(() => {});
  await server.close().catch(() => {});
  await fs.rm(tmpDir, { recursive: true, force: true });
}
