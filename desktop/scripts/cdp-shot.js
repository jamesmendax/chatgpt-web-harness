// 通过 CDP 截取渲染进程画面：不受其他置顶窗口遮挡，也不受 DPI 缩放影响。
// 用法: node scripts/cdp-shot.js <port> <输出png> [宽] [高]
const fs = require("fs");

const port = process.argv[2] || "9333";
const out = process.argv[3] || "shot.png";
const width = Number(process.argv[4] || 0);
const height = Number(process.argv[5] || 0);

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error("没有可调试的 page 目标");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)));
    else entry.resolve(msg.result);
  });
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${method} 超时`));
      }, 20000);
    });

  if (width && height) {
    // 用设备度量覆盖固定 CSS 视口，截图尺寸与 DPI 无关，便于跨机器复现。
    await send("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: 1, mobile: false,
    });
    await new Promise((r) => setTimeout(r, 600));
  }
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  if (width && height) await send("Emulation.clearDeviceMetricsOverride", {});
  ws.close();
  fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log(`${width || "auto"}x${height || "auto"} -> ${out} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
}

main().catch((err) => {
  console.error("截图失败:", err.message);
  process.exit(1);
});
