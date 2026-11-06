import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";

export function officePixelWitness(png, kind) {
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  assert.equal(png[24], 8, "Office witness requires an 8-bit PNG");
  assert.equal(png[28], 0, "Office witness requires noninterlaced native PNG pixels");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[png[25]];
  assert.ok(channels, "Unsupported native Office PNG color type");
  let palette, transparency;
  const idat = [];
  for (let offset = 8; offset < png.length;) {
    const size = png.readUInt32BE(offset), name = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + size);
    if (name === "IDAT") idat.push(data);
    if (name === "PLTE") palette = data;
    if (name === "tRNS") transparency = data;
    offset += size + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  assert.equal(raw.length, height * (stride + 1));
  let previous = Buffer.alloc(stride), green = 0, dark = 0, documentDark = 0;
  const paeth = (left, above, diagonal) => {
    const p = left + above - diagonal;
    const a = Math.abs(p - left), b = Math.abs(p - above), c = Math.abs(p - diagonal);
    return a <= b && a <= c ? left : b <= c ? above : diagonal;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], row = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    assert.ok(filter <= 4, "Native PNG contains an invalid row filter");
    for (let index = 0; index < stride; index++) {
      const left = index >= channels ? row[index - channels] : 0, above = previous[index], diagonal = index >= channels ? previous[index - channels] : 0;
      row[index] = (row[index] + [0, left, above, Math.floor((left + above) / 2), paeth(left, above, diagonal)][filter]) & 255;
    }
    for (let x = 0; x < width; x++) {
      const index = x * channels;
      let r, g, b, alpha = 255;
      if (png[25] === 3) { const value = row[index]; r = palette[value * 3]; g = palette[value * 3 + 1]; b = palette[value * 3 + 2]; alpha = transparency?.[value] ?? 255; }
      else if (png[25] === 0 || png[25] === 4) { r = g = b = row[index]; if (channels === 2) alpha = row[index + 1]; }
      else { r = row[index]; g = row[index + 1]; b = row[index + 2]; if (channels === 4) alpha = row[index + 3]; }
      if (alpha < 128) continue;
      if (Math.abs(r - 51) < 4 && Math.abs(g - 170) < 4 && Math.abs(b - 85) < 4) green++;
      if (r < 120 && g < 120 && b < 120) {
        dark++;
        if (x > width * 0.15 && x < width * 0.85 && y < height * 0.5) documentDark++;
      }
    }
    previous = row;
  }
  if (kind === "pptx") assert.ok(green > width * height * 0.2, "PowerPoint did not render the fixture's green rectangle");
  else assert.ok(documentDark > 100, "Word rendered a blank page without the fixture text (viewer surround excluded)");
  return { green_pixels: green, dark_pixels: dark, document_dark_pixels: documentDark, total_pixels: width * height };
}
