export type CommandKind = "test" | "build" | "lint" | "format" | "git" | "generic";

export interface CommandDiagnostic {
  level: "error" | "warning" | "info";
  message: string;
}

export interface TestSummary {
  passed?: number;
  failed?: number;
  skipped?: number;
}

export interface CommandObservation {
  command_kind: CommandKind;
  outcome: "passed" | "failed" | "timed_out";
  diagnostics: CommandDiagnostic[];
  key_lines: string[];
  test_summary?: TestSummary;
  warning_count: number;
}

const ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function cleanLine(value: string, max = 500): string {
  const line = stripAnsi(value).replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

function uniqueLines(lines: string[], limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    const line = cleanLine(raw);
    const key = line.toLowerCase();
    if (!line || seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= limit) break;
  }
  return out;
}

export function classifyCommand(command: string): CommandKind {
  const normalized = command.toLowerCase();
  if (/\b(test|pytest|vitest|jest|cargo test|go test|mvn test|gradle test)\b/.test(normalized)) return "test";
  if (/\b(build|compile|tsc|cargo build|go build|mvn package|gradle build)\b/.test(normalized)) return "build";
  if (/\b(lint|eslint|ruff|clippy|golangci-lint)\b/.test(normalized)) return "lint";
  if (/\b(format|prettier|gofmt|rustfmt|black)\b/.test(normalized)) return "format";
  if (/\bgit\s+/.test(normalized)) return "git";
  return "generic";
}

function extractLastCount(text: string, pattern: RegExp): number | undefined {
  let value: number | undefined;
  for (const match of text.matchAll(pattern)) {
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isFinite(parsed)) value = parsed;
  }
  return value;
}

function extractTestSummary(text: string): TestSummary | undefined {
  const cargo = [...text.matchAll(/test result:\s+\w+\.\s+(\d+) passed;\s+(\d+) failed;\s+(\d+) ignored/gi)].pop();
  if (cargo) {
    return {
      passed: Number.parseInt(cargo[1], 10),
      failed: Number.parseInt(cargo[2], 10),
      skipped: Number.parseInt(cargo[3], 10),
    };
  }

  const passed = extractLastCount(text, /\b(\d+)\s+passed\b/gi);
  const failed = extractLastCount(text, /\b(\d+)\s+failed\b/gi);
  const skipped = extractLastCount(text, /\b(\d+)\s+(?:skipped|ignored|pending)\b/gi);
  if (passed === undefined && failed === undefined && skipped === undefined) return undefined;
  return {
    ...(passed !== undefined ? { passed } : {}),
    ...(failed !== undefined ? { failed } : {}),
    ...(skipped !== undefined ? { skipped } : {}),
  };
}

function diagnosticLevel(line: string): CommandDiagnostic["level"] | null {
  const normalized = line.toLowerCase();
  if (/\b(0 failed|no errors?|without errors?)\b/.test(normalized)) return null;
  if (
    /\b(error|failed|failure|fatal|exception|assertionerror|traceback|npm err!|panic|segmentation fault|not found|cannot find|unable to)\b/.test(normalized) ||
    /\berror\s+ts\d+\b/.test(normalized)
  ) return "error";
  if (/\b(warn|warning|deprecated)\b/.test(normalized)) return "warning";
  if (/\b(passed|success|succeeded|all tests passed|test result:)\b/.test(normalized)) return "info";
  return null;
}

export function observeCommand(input: {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut?: boolean;
}): CommandObservation {
  const stdout = stripAnsi(input.stdout);
  const stderr = stripAnsi(input.stderr);
  const combined = `${stderr}\n${stdout}`;
  const lines = combined.split(/\r?\n/).filter((line) => line.trim());
  const diagnostics: CommandDiagnostic[] = [];

  for (const line of lines) {
    const level = diagnosticLevel(line);
    if (!level) continue;
    diagnostics.push({ level, message: cleanLine(line) });
    if (diagnostics.length >= 12) break;
  }

  const summaryLines = lines.filter((line) =>
    /\b(\d+\s+(?:passed|failed|skipped|ignored)|tests?:|test result:|build (?:passed|failed|succeeded)|all tests passed|error\s+ts\d+)\b/i.test(line)
  );
  const tailLines = lines.slice(-8);
  const keyLines = uniqueLines([...diagnostics.map((item) => item.message), ...summaryLines, ...tailLines], 16);
  const warningCount = diagnostics.filter((item) => item.level === "warning").length;
  const testSummary = extractTestSummary(combined);

  return {
    command_kind: classifyCommand(input.command),
    outcome: input.timedOut ? "timed_out" : input.exitCode === 0 ? "passed" : "failed",
    diagnostics,
    key_lines: keyLines,
    ...(testSummary ? { test_summary: testSummary } : {}),
    warning_count: warningCount,
  };
}

export function compactOutput(text: string, maxChars: number): {
  text: string;
  total_chars: number;
  omitted_chars: number;
  truncated: boolean;
} {
  const cleaned = stripAnsi(text).trim();
  const budget = Math.max(500, maxChars);
  if (cleaned.length <= budget) {
    return { text: cleaned, total_chars: cleaned.length, omitted_chars: 0, truncated: false };
  }

  const markerReserve = 80;
  const usable = Math.max(200, budget - markerReserve);
  const headLength = Math.max(100, Math.floor(usable * 0.35));
  const tailLength = Math.max(100, usable - headLength);
  const omitted = Math.max(0, cleaned.length - headLength - tailLength);
  const compacted = `${cleaned.slice(0, headLength).trimEnd()}\n\n[… ${omitted} characters omitted; full log saved …]\n\n${cleaned.slice(-tailLength).trimStart()}`;
  return {
    text: compacted,
    total_chars: cleaned.length,
    omitted_chars: omitted,
    truncated: true,
  };
}