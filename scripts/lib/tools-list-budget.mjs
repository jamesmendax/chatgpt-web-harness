/**
 * One discovery budget for every slim tools/list verification path.
 * Measure the UTF-8 tools payload, excluding protocol/client envelope fields.
 * This module only observes schemas and annotations; it never compacts them.
 */
export const SLIM_TOOLS_LIST_BUDGET = Object.freeze({
  softBytes: 40960,
  hardBytes: 49152,
  topN: 10,
});

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function assessToolsListBudget(listed) {
  if (!listed || !Array.isArray(listed.tools)) {
    throw new TypeError("tools/list budget requires a tools array");
  }
  const { tools } = listed;
  const { softBytes, hardBytes, topN } = SLIM_TOOLS_LIST_BUDGET;
  const bytes = jsonBytes({ tools });
  const largestTools = tools
    .map((tool) => ({ name: String(tool.name ?? "<unnamed>"), bytes: jsonBytes(tool) }))
    .sort((left, right) => right.bytes - left.bytes || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .slice(0, topN);
  return {
    bytes,
    toolCount: tools.length,
    softBytes,
    hardBytes,
    status: bytes > hardBytes ? "fail" : bytes > softBytes ? "warn" : "pass",
    largestTools,
  };
}

export function assertToolsListBudget(listed, {
  label = "slim tools/list",
  report = console.log,
  warn = console.warn,
} = {}) {
  const assessment = assessToolsListBudget(listed);
  report(`TOOLS_LIST_BUDGET ${JSON.stringify({ label, ...assessment })}`);
  const largest = assessment.largestTools.map(({ name, bytes }) => `${name}=${bytes}`).join(", ");
  const diagnostic = `${label}: ${assessment.bytes} bytes; soft=${assessment.softBytes}, hard=${assessment.hardBytes}; largest ${assessment.largestTools.length}: ${largest}`;
  if (assessment.status === "fail") {
    throw new Error(`tools/list hard budget exceeded: ${diagnostic}`);
  }
  if (assessment.status === "warn") {
    warn(`tools/list soft budget exceeded: ${diagnostic}`);
  }
  return assessment;
}