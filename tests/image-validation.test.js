import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  decodeImageDataUrl,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS,
  MAX_LOGO_BYTES,
  MAX_PROJECT_IMAGE_BYTES,
  MAX_PROJECT_IMAGES_TOTAL_BYTES,
  validateProjectImages
} from "../netlify/functions/_shared/images.js";

const REAL_PNG = readFileSync(new URL("../assets/customer-starrag.png", import.meta.url));
const REAL_JPEG = readFileSync(new URL("../assets/project-conveyor.jpeg", import.meta.url));
const REAL_WEBP = readFileSync(new URL("../assets/hero-cnc.webp", import.meta.url));

// A complete 1x1 GIF89a: logical screen, global palette, image descriptor,
// LZW clear/pixel/end codes, sub-block terminator and GIF trailer.
const VALID_GIF = Buffer.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
  0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
  0x00, 0x00, 0x00, 0xff, 0xff, 0xff,
  0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0x02, 0x02, 0x44, 0x01, 0x00, 0x3b
]);

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < CRC32_TABLE.length; i += 1) {
  let value = i;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  CRC32_TABLE[i] = value >>> 0;
}

function crc32(bytes, start, end) {
  let crc = 0xffffffff;
  for (let offset = start; offset < end; offset += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[offset]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk, 4, 8 + data.length), 8 + data.length);
  return chunk;
}

const sizedPngs = new Map();
function sizedPng(targetSize) {
  if (sizedPngs.has(targetSize)) return sizedPngs.get(targetSize);
  const iendStart = REAL_PNG.length - 12;
  assert.equal(REAL_PNG.subarray(iendStart + 4, iendStart + 8).toString("ascii"), "IEND");
  const paddingLength = targetSize - REAL_PNG.length - 12;
  assert.ok(paddingLength >= 8, "target PNG size must leave room for a valid tEXt payload");
  const padding = Buffer.alloc(paddingLength, 0x78);
  Buffer.from("padding\0", "latin1").copy(padding);
  const result = Buffer.concat([
    REAL_PNG.subarray(0, iendStart),
    pngChunk("tEXt", padding),
    REAL_PNG.subarray(iendStart)
  ]);
  assert.equal(result.length, targetSize);
  sizedPngs.set(targetSize, result);
  return result;
}

function dataUrl(bytes, type) {
  return `data:${type};base64,${bytes.toString("base64")}`;
}

function sizedPngDataUrl(size) {
  return dataUrl(sizedPng(size), "image/png");
}

function rewritePngHeader(bytes, width, height) {
  const copy = Buffer.from(bytes);
  assert.equal(copy.subarray(12, 16).toString("ascii"), "IHDR");
  copy.writeUInt32BE(width, 16);
  copy.writeUInt32BE(height, 20);
  copy.writeUInt32BE(crc32(copy, 12, 29), 29);
  return copy;
}

function corruptPngImageData(bytes) {
  const copy = Buffer.from(bytes);
  let offset = 8;
  while (offset + 12 <= copy.length) {
    const length = copy.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (copy.subarray(typeStart, dataStart).toString("ascii") === "IDAT" && length > 4) {
      copy[dataStart + Math.floor(length / 2)] ^= 0x01;
      copy.writeUInt32BE(crc32(copy, typeStart, dataEnd), dataEnd);
      return copy;
    }
    offset = dataEnd + 4;
  }
  throw new Error("PNG fixture has no mutable IDAT chunk");
}

function rewriteJpegFrame(bytes, width, height) {
  const copy = Buffer.from(bytes);
  let offset = 2;
  while (offset < copy.length) {
    if (copy[offset] !== 0xff) throw new Error("Invalid JPEG fixture");
    while (copy[offset] === 0xff) offset += 1;
    const marker = copy[offset];
    offset += 1;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) {
      const dataStart = offset + 2;
      copy.writeUInt16BE(height, dataStart + 1);
      copy.writeUInt16BE(width, dataStart + 3);
      return copy;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = copy.readUInt16BE(offset);
    offset += length;
  }
  throw new Error("JPEG fixture has no start-of-frame segment");
}

function rewriteGifCanvas(bytes, width, height) {
  const copy = Buffer.from(bytes);
  copy.writeUInt16LE(width, 6);
  copy.writeUInt16LE(height, 8);
  return copy;
}

function rewriteWebpFrame(bytes, width, height) {
  const copy = Buffer.from(bytes);
  assert.equal(copy.subarray(12, 16).toString("ascii"), "VP8 ");
  const dataStart = 20;
  copy.writeUInt16LE((copy.readUInt16LE(dataStart + 6) & 0xc000) | width, dataStart + 6);
  copy.writeUInt16LE((copy.readUInt16LE(dataStart + 8) & 0xc000) | height, dataStart + 8);
  return copy;
}

test("accepts complete PNG, JPEG, GIF and WebP fixtures", () => {
  const fixtures = [
    ["image/png", REAL_PNG],
    ["image/jpeg", REAL_JPEG],
    ["image/gif", VALID_GIF],
    ["image/webp", REAL_WEBP]
  ];
  for (const [type, bytes] of fixtures) {
    const decoded = decodeImageDataUrl(dataUrl(bytes, type), MAX_PROJECT_IMAGE_BYTES);
    assert.equal(decoded?.contentType, type, `${type} fixture should be accepted`);
    assert.equal(decoded?.bytes.length, bytes.length);
  }
});

test("logo image enforces the exact 2 MiB boundary", () => {
  const exact = decodeImageDataUrl(sizedPngDataUrl(MAX_LOGO_BYTES), MAX_LOGO_BYTES);
  assert.equal(exact?.bytes.byteLength, MAX_LOGO_BYTES);
  assert.equal(
    decodeImageDataUrl(sizedPngDataUrl(MAX_LOGO_BYTES + 1), MAX_LOGO_BYTES),
    null
  );
});

test("project image enforces the exact 4 MiB boundary", () => {
  const exact = decodeImageDataUrl(sizedPngDataUrl(MAX_PROJECT_IMAGE_BYTES), MAX_PROJECT_IMAGE_BYTES);
  assert.equal(exact?.bytes.byteLength, MAX_PROJECT_IMAGE_BYTES);
  assert.equal(
    decodeImageDataUrl(sizedPngDataUrl(MAX_PROJECT_IMAGE_BYTES + 1), MAX_PROJECT_IMAGE_BYTES),
    null
  );
});

test("combined project images enforce the exact 4 MiB request budget", () => {
  const half = MAX_PROJECT_IMAGES_TOTAL_BYTES / 2;
  const exactHalf = sizedPngDataUrl(half);
  assert.equal(validateProjectImages([exactHalf, exactHalf])?.length, 2);
  assert.equal(validateProjectImages([exactHalf, sizedPngDataUrl(half + 1)]), null);
});

test("declared MIME type must match a complete image structure", () => {
  assert.equal(decodeImageDataUrl(dataUrl(REAL_PNG, "image/jpeg"), MAX_LOGO_BYTES), null);
  assert.equal(
    decodeImageDataUrl(dataUrl(Buffer.from("not an image"), "image/png"), MAX_LOGO_BYTES),
    null
  );
});

test("truncated PNG, JPEG, GIF and WebP files are rejected", () => {
  const fixtures = [
    ["image/png", REAL_PNG],
    ["image/jpeg", REAL_JPEG],
    ["image/gif", VALID_GIF],
    ["image/webp", REAL_WEBP]
  ];
  for (const [type, bytes] of fixtures) {
    const truncated = bytes.subarray(0, bytes.length - 1);
    assert.equal(
      decodeImageDataUrl(dataUrl(truncated, type), MAX_PROJECT_IMAGE_BYTES),
      null,
      `${type} truncation should be rejected`
    );
  }
});

test("PNG with valid chunk CRC but corrupt compressed pixels is rejected", () => {
  const corrupt = corruptPngImageData(REAL_PNG);
  assert.equal(decodeImageDataUrl(dataUrl(corrupt, "image/png"), MAX_PROJECT_IMAGE_BYTES), null);
});

test("GIF with malformed LZW pixels is rejected", () => {
  const corrupt = Buffer.from(VALID_GIF);
  corrupt[31] = 0xff;
  assert.equal(decodeImageDataUrl(dataUrl(corrupt, "image/gif"), MAX_LOGO_BYTES), null);
});

test("all formats reject a canvas above the pixel ceiling", () => {
  const width = 10_000;
  const height = Math.floor(MAX_IMAGE_PIXELS / width) + 1;
  const fixtures = [
    ["image/png", rewritePngHeader(REAL_PNG, width, height)],
    ["image/jpeg", rewriteJpegFrame(REAL_JPEG, width, height)],
    ["image/gif", rewriteGifCanvas(VALID_GIF, width, height)],
    ["image/webp", rewriteWebpFrame(REAL_WEBP, width, height)]
  ];
  for (const [type, bytes] of fixtures) {
    assert.equal(
      decodeImageDataUrl(dataUrl(bytes, type), MAX_PROJECT_IMAGE_BYTES),
      null,
      `${type} pixel ceiling should be enforced`
    );
  }
});

test("formats with larger coordinate fields reject an extreme dimension", () => {
  const width = MAX_IMAGE_DIMENSION + 1;
  const fixtures = [
    ["image/png", rewritePngHeader(REAL_PNG, width, 1)],
    ["image/jpeg", rewriteJpegFrame(REAL_JPEG, width, 1)],
    ["image/gif", rewriteGifCanvas(VALID_GIF, width, 1)]
  ];
  for (const [type, bytes] of fixtures) {
    assert.equal(
      decodeImageDataUrl(dataUrl(bytes, type), MAX_PROJECT_IMAGE_BYTES),
      null,
      `${type} dimension ceiling should be enforced`
    );
  }
});
