import fs from "node:fs/promises";
import path from "node:path";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Stored ZIP entries make the OOXML fixtures deterministic and dependency-free.
// Native Office is needed to render the fixture, never to construct or save it.
export function officeFixtureZip(entries) {
  const local = [];
  const directory = [];
  let offset = 0;
  for (const [name, xml] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name);
    const bytes = Buffer.from(xml);
    const crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE((46 << 9) | (11 << 5) | 6, 12);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    local.push(header, nameBytes, bytes);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8);
    record.writeUInt16LE((46 << 9) | (11 << 5) | 6, 14);
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(bytes.length, 20); record.writeUInt32LE(bytes.length, 24);
    record.writeUInt16LE(nameBytes.length, 28); record.writeUInt32LE(offset, 42);
    directory.push(record, nameBytes);
    offset += header.length + nameBytes.length + bytes.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(directory.length / 2, 8); end.writeUInt16LE(directory.length / 2, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, central, end]);
}

export function inspectOfficeFixture(bytes) {
  const entries = {};
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 18);
    const nameSize = bytes.readUInt16LE(offset + 26);
    const extraSize = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameSize).toString();
    const dataOffset = offset + 30 + nameSize + extraSize;
    const data = bytes.subarray(dataOffset, dataOffset + size);
    if (crc32(data) !== bytes.readUInt32LE(offset + 14)) throw new Error(`Fixture ZIP checksum mismatch: ${name}`);
    entries[name] = data.toString();
    offset = dataOffset + size;
  }
  if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("Fixture ZIP central directory is missing");
  return entries;
}

const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const relNs = "http://schemas.openxmlformats.org/package/2006/relationships";
const officeRel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const aNs = "http://schemas.openxmlformats.org/drawingml/2006/main";
const pNs = "http://schemas.openxmlformats.org/presentationml/2006/main";
const group = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const clrMap = '<p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/>';
const rels = (...items) => declaration + `<Relationships xmlns="${relNs}">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${officeRel}/${type}" Target="${target}"/>`).join("")}</Relationships>`;
const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
const theme = declaration + `<a:theme xmlns:a="${aNs}" name="Office fixture"><a:themeElements><a:clrScheme name="Fixture"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F3F4F6"/></a:lt2>${["33AA55","2563EB","F59E0B","DC2626","7C3AED","0891B2"].map((c,i)=>`<a:accent${i+1}><a:srgbClr val="${c}"/></a:accent${i+1}>`).join("")}<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Fixture"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Fixture"><a:fillStyleLst>${fill.repeat(3)}</a:fillStyleLst><a:lnStyleLst>${[6350,12700,19050].map(w=>`<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr">${fill}<a:prstDash val="solid"/></a:ln>`).join("")}</a:lnStyleLst><a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${fill.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;

export const pptxFixtureEntries = {
  "[Content_Types].xml": declaration + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' + [["presentation", "presentation.main"],["slides/slide1","slide"],["slideLayouts/slideLayout1","slideLayout"],["slideMasters/slideMaster1","slideMaster"]].map(([part,type])=>`<Override PartName="/ppt/${part}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.${type}+xml"/>`).join("") + '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>',
  "_rels/.rels": rels(["rId1", "officeDocument", "ppt/presentation.xml"]),
  "ppt/presentation.xml": declaration + `<p:presentation xmlns:p="${pNs}" xmlns:a="${aNs}" xmlns:r="${officeRel}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
  "ppt/_rels/presentation.xml.rels": rels(["rId1", "slideMaster", "slideMasters/slideMaster1.xml"], ["rId2", "slide", "slides/slide1.xml"]),
  "ppt/slides/slide1.xml": declaration + `<p:sld xmlns:p="${pNs}" xmlns:a="${aNs}"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${group}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Fixture title"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="10363200" cy="1371600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="3400"><a:solidFill><a:srgbClr val="111827"/></a:solidFill><a:latin typeface="Arial"/></a:rPr><a:t>Universal Visual Review</a:t></a:r><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Green pixel witness"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="2743200"/><a:ext cx="10363200" cy="2743200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="33AA55"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`,
  "ppt/slides/_rels/slide1.xml.rels": rels(["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"]),
  "ppt/slideLayouts/slideLayout1.xml": declaration + `<p:sldLayout xmlns:p="${pNs}" xmlns:a="${aNs}" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${group}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
  "ppt/slideLayouts/_rels/slideLayout1.xml.rels": rels(["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]),
  "ppt/slideMasters/slideMaster1.xml": declaration + `<p:sldMaster xmlns:p="${pNs}" xmlns:a="${aNs}" xmlns:r="${officeRel}"><p:cSld><p:spTree>${group}</p:spTree></p:cSld>${clrMap}<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`,
  "ppt/slideMasters/_rels/slideMaster1.xml.rels": rels(["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"], ["rId2", "theme", "../theme/theme1.xml"]),
  "ppt/theme/theme1.xml": theme,
};

export const docxFixtureEntries = {
  "[Content_Types].xml": declaration + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  "_rels/.rels": rels(["rId1", "officeDocument", "word/document.xml"]),
  "word/document.xml": declaration + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="48"/><w:b/></w:rPr><w:t>Universal Visual Review</w:t></w:r></w:p><w:p><w:r><w:rPr><w:sz w:val="28"/></w:rPr><w:t>Word page rendering evidence from a deterministic OOXML fixture.</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>',
};

export async function createOfficeFixtures(workspace) {
  await fs.mkdir(workspace, { recursive: true });
  const pptxPath = path.join(workspace, "sample.pptx");
  const docxPath = path.join(workspace, "sample.docx");
  await fs.writeFile(pptxPath, officeFixtureZip(pptxFixtureEntries));
  await fs.writeFile(docxPath, officeFixtureZip(docxFixtureEntries));
  return { pptxPath, docxPath };
}
