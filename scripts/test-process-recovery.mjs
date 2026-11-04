#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readProcessLogPage } from "../dist/lib/process-journal.js";

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "wh-process-recovery-"));
try {
  const logPath = path.join(sandbox, "combined.log");
  // Put a four-byte code point exactly across the existing 1024-byte page
  // limit, then repeat multibyte output across later pages.
  const prefix = "A".repeat(1023);
  const suffix = Array.from({ length: 320 }, (_, index) => `row-${index}: 中文😀 café\n`).join("");
  const logText = `${prefix}😀${suffix}`;
  await fs.writeFile(logPath, logText, "utf8");
  const expectedSize = Buffer.byteLength(logText, "utf8");

  let offset = 0;
  let rebuilt = "";
  let pages = 0;
  while (true) {
    const page = await readProcessLogPage(logPath, offset, 1024);
    assert.equal(page.offset, offset, "returned cursor must remain stable across valid pages");
    assert.equal(Buffer.byteLength(page.content, "utf8"), page.bytes_read, "page content must match its byte cursor");
    assert.ok(!page.content.includes("\uFFFD"), "page boundary must not create a replacement character");
    rebuilt += page.content;
    pages += 1;
    if (page.next_offset === null) {
      assert.equal(page.eof, true);
      offset = page.size;
      break;
    }
    assert.ok(page.next_offset > offset, "pagination cursor must advance");
    offset = page.next_offset;
  }

  assert.ok(pages > 1, "fixture must exercise more than one page");
  assert.equal(rebuilt, logText, "UTF-8 log pagination must be lossless");
  assert.equal(offset, expectedSize, "final cursor must be the log byte size");

  const emojiOffset = Buffer.byteLength(prefix, "utf8");
  const middleOfEmoji = await readProcessLogPage(logPath, emojiOffset + 1, 1024);
  assert.equal(middleOfEmoji.offset, emojiOffset, "misaligned legacy cursor must be rewound to a code-point boundary");
  assert.ok(middleOfEmoji.content.startsWith("😀"));

  const atEnd = await readProcessLogPage(logPath, expectedSize, 1024);
  assert.deepEqual(atEnd, {
    content: "",
    offset: expectedSize,
    bytes_read: 0,
    next_offset: null,
    size: expectedSize,
    eof: true,
  });
} finally {
  await fs.rm(sandbox, { recursive: true, force: true });
}

console.log("process-recovery PASS: UTF-8-safe byte pagination, legacy cursor alignment, and EOF cursor verified");
