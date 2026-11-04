// 通过 CDP 在渲染进程里求值，用于测量真实布局尺寸（Node 22+ 自带 WebSocket）。
// 用法: node scripts/cdp-eval.js <port> "<javascript 表达式>"
const port = process.argv[2] || "9222";
const expression = process.argv[3] || "1";

async function main() {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await res.json();
  const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error("没有可调试的 page 目标");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const result = await new Promise((resolve, reject) => {
    const id = 1;
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== id) return;
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    });
    ws.send(JSON.stringify({
      id,
      method: "Runtime.evaluate",
      params: { expression, returnByValue: true, awaitPromise: true },
    }));
    setTimeout(() => reject(new Error("求值超时")), 10000);
  });
  ws.close();
  if (result.exceptionDetails) {
    console.error("异常:", result.exceptionDetails.text, result.exceptionDetails.exception?.description || "");
    process.exit(1);
  }
  const value = result.result.value;
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 1));
}

main().catch((err) => {
  console.error("CDP 失败:", err.message);
  process.exit(1);
});
