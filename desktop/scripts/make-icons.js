"use strict";
// Aura is the default application icon family. The legacy renderer mark is
// regenerated only when explicitly requested with --classic.
const iconArgs = process.argv.slice(2);
if (iconArgs.includes("--classic") && iconArgs.includes("--aura")) {
  throw new Error("Choose either --classic or --aura, not both.");
}
if (!iconArgs.includes("--classic")) {
  Promise.resolve().then(() => require("./make-aura-icons.cjs").generate()).catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
  return;
}
process.argv = process.argv.filter(arg => arg !== "--classic");
// 从品牌 logo（白色 MCP 立方标记，透明底）生成应用图标资源，无需外部图像库。
//   build/icon.png      512×512，深色圆角底 + 白色标记 —— 用于 exe / 安装包 / 窗口 / 托盘
//   renderer/logo.png   裁边后的白色标记（透明底），供深色界面内联显示
// 用法: node scripts/make-icons.js [源 PNG]
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const DESKTOP_ROOT = path.resolve(__dirname, "..");
const SOURCE = process.argv[2] || path.join(DESKTOP_ROOT, "build", "logo-source.png");
// 与 renderer/styles.css 的 --bg-elevated 保持一致，图标看起来像界面的一部分。
const ICON_BG = [23, 23, 23];
const ICON_SIZE = 512;
const ICON_PAD = 0.14; // 标记四周留白占比
const ICON_RADIUS = 0.22; // 圆角半径占比

/* ---------- PNG 解码（支持 1/2/4/8 位，索引/灰度/真彩） ---------- */

function decodePng(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`不是 PNG: ${file}`);
  let pos = 8;
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  let palette = null, trns = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "PLTE") palette = Buffer.from(data);
    else if (type === "tRNS") trns = Buffer.from(data);
    else if (type === "IDAT") idat.push(Buffer.from(data));
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (![1, 2, 4, 8].includes(depth)) throw new Error(`不支持的位深度 ${depth}`);
  if (interlace) throw new Error("不支持隔行扫描 PNG");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`不支持的 colorType ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = Math.ceil((width * channels * depth) / 8);
  const bpp = Math.max(1, Math.floor((channels * depth) / 8));
  const out = Buffer.alloc(height * stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const line = raw.subarray(rp, rp + stride);
    rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      const x = line[i];
      let v;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`未知滤波器 ${filter}`);
      }
      cur[i] = v & 0xff;
    }
  }

  const sample = (y, x) => {
    if (depth === 8) return out[y * stride + x];
    const perByte = 8 / depth;
    const byte = out[y * stride + Math.floor(x / perByte)];
    return (byte >> (8 - depth * ((x % perByte) + 1))) & ((1 << depth) - 1);
  };
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let r, g, b, a = 255;
      if (colorType === 6) { const o = i * 4; r = out[o]; g = out[o + 1]; b = out[o + 2]; a = out[o + 3]; }
      else if (colorType === 2) { const o = i * 3; r = out[o]; g = out[o + 1]; b = out[o + 2]; }
      else if (colorType === 4) { const o = i * 2; r = g = b = out[o]; a = out[o + 1]; }
      else if (colorType === 0) { const v = sample(y, x); const max = (1 << depth) - 1; r = g = b = Math.round((v / max) * 255); }
      else {
        const idx = sample(y, x);
        r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2];
        if (trns && idx < trns.length) a = trns[idx];
      }
      const o = i * 4;
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a;
    }
  }
  return { width, height, rgba };
}

/* ---------- PNG 编码（8 位 RGBA） ---------- */

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function encodePng(img) {
  const { width, height, rgba } = img;
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------- 几何处理 ---------- */

function trim(img, alphaThreshold = 8) {
  let minX = img.width, maxX = -1, minY = img.height, maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.rgba[(y * img.width + x) * 4 + 3] <= alphaThreshold) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) throw new Error("源图全透明");
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    img.rgba.copy(rgba, y * width * 4, ((y + minY) * img.width + minX) * 4, ((y + minY) * img.width + maxX + 1) * 4);
  }
  return { width, height, rgba };
}

/** 双线性缩放，保留 alpha（对细笔画比最近邻平滑得多）。 */
function resize(img, width, height) {
  const rgba = Buffer.alloc(width * height * 4);
  const sx = img.width / width;
  const sy = img.height / height;
  for (let y = 0; y < height; y++) {
    const fy = Math.min(img.height - 1, (y + 0.5) * sy - 0.5);
    const y0 = Math.max(0, Math.floor(fy));
    const y1 = Math.min(img.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(img.width - 1, (x + 0.5) * sx - 0.5);
      const x0 = Math.max(0, Math.floor(fx));
      const x1 = Math.min(img.width - 1, x0 + 1);
      const wx = fx - x0;
      const di = (y * width + x) * 4;
      for (let ch = 0; ch < 4; ch++) {
        const p00 = img.rgba[(y0 * img.width + x0) * 4 + ch];
        const p10 = img.rgba[(y0 * img.width + x1) * 4 + ch];
        const p01 = img.rgba[(y1 * img.width + x0) * 4 + ch];
        const p11 = img.rgba[(y1 * img.width + x1) * 4 + ch];
        const top = p00 + (p10 - p00) * wx;
        const bottom = p01 + (p11 - p01) * wx;
        rgba[di + ch] = Math.round(top + (bottom - top) * wy);
      }
    }
  }
  return { width, height, rgba };
}

/** 圆角矩形底色画布，边缘做 2×2 超采样抗锯齿。 */
function roundedCanvas(size, radius, color) {
  const rgba = Buffer.alloc(size * size * 4);
  const inside = (px, py) => {
    const cx = Math.min(Math.max(px, radius), size - radius);
    const cy = Math.min(Math.max(py, radius), size - radius);
    const dx = px - cx;
    const dy = py - cy;
    return dx * dx + dy * dy <= radius * radius;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (const oy of [0.25, 0.75]) for (const ox of [0.25, 0.75]) if (inside(x + ox, y + oy)) hits++;
      const di = (y * size + x) * 4;
      rgba[di] = color[0]; rgba[di + 1] = color[1]; rgba[di + 2] = color[2];
      rgba[di + 3] = Math.round((hits / 4) * 255);
    }
  }
  return { width: size, height: size, rgba };
}

/** 把 src 以 alpha 混合方式贴到 dst 的 (dx,dy)。 */
function drawOver(dst, src, dx, dy) {
  for (let y = 0; y < src.height; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= dst.width) continue;
      const si = (y * src.width + x) * 4;
      const sa = src.rgba[si + 3] / 255;
      if (sa === 0) continue;
      const di = (ty * dst.width + tx) * 4;
      const da = dst.rgba[di + 3] / 255;
      const outA = sa + da * (1 - sa);
      for (let ch = 0; ch < 3; ch++) {
        const s = src.rgba[si + ch] * sa;
        const d = dst.rgba[di + ch] * da * (1 - sa);
        dst.rgba[di + ch] = Math.round(outA === 0 ? 0 : (s + d) / outA);
      }
      dst.rgba[di + 3] = Math.round(outA * 255);
    }
  }
}

/* ---------- 生成 ---------- */

const source = decodePng(SOURCE);
const mark = trim(source);
console.log(`源: ${path.relative(DESKTOP_ROOT, SOURCE)} ${source.width}×${source.height} → 裁边 ${mark.width}×${mark.height}`);

// 1) 界面内联用的白色标记（透明底，正方形画布居中，避免 CSS 拉伸变形）
const markSize = 256;
const markScale = Math.min(markSize / mark.width, markSize / mark.height);
const markScaled = resize(mark, Math.round(mark.width * markScale), Math.round(mark.height * markScale));
const markCanvas = { width: markSize, height: markSize, rgba: Buffer.alloc(markSize * markSize * 4) };
drawOver(markCanvas, markScaled, Math.round((markSize - markScaled.width) / 2), Math.round((markSize - markScaled.height) / 2));
const markOut = path.join(DESKTOP_ROOT, "renderer", "logo.png");
fs.writeFileSync(markOut, encodePng(markCanvas));
console.log(`写出 ${path.relative(DESKTOP_ROOT, markOut)} (${markSize}×${markSize}, 透明底)`);

// 2) 应用图标：深色圆角底 + 白色标记（浅色任务栏上也可见）
const inner = Math.round(ICON_SIZE * (1 - ICON_PAD * 2));
const iconScale = Math.min(inner / mark.width, inner / mark.height);
const iconMark = resize(mark, Math.round(mark.width * iconScale), Math.round(mark.height * iconScale));
const icon = roundedCanvas(ICON_SIZE, Math.round(ICON_SIZE * ICON_RADIUS), ICON_BG);
drawOver(icon, iconMark, Math.round((ICON_SIZE - iconMark.width) / 2), Math.round((ICON_SIZE - iconMark.height) / 2));
const iconOut = path.join(DESKTOP_ROOT, "build", "icon.png");
fs.writeFileSync(iconOut, encodePng(icon));
console.log(`写出 ${path.relative(DESKTOP_ROOT, iconOut)} (${ICON_SIZE}×${ICON_SIZE}, 深色圆角底)`);
