import { inflateSync } from "node:zlib";

export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
export const MAX_PROJECT_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_PROJECT_IMAGES_TOTAL_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 16_384;
export const MAX_IMAGE_PIXELS = 40_000_000;

const MAX_DECODED_IMAGE_BYTES = 160 * 1024 * 1024;
const MAX_GIF_FRAMES = 200;

export const ALLOWED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif"
]);

function dimensionsAreSafe(width, height) {
  return Number.isInteger(width)
    && Number.isInteger(height)
    && width > 0
    && height > 0
    && width <= MAX_IMAGE_DIMENSION
    && height <= MAX_IMAGE_DIMENSION
    && width * height <= MAX_IMAGE_PIXELS;
}

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

function pngPasses(width, height, interlace) {
  if (!interlace) return [{ width, height }];

  const xStarts = [0, 4, 0, 2, 0, 1, 0];
  const yStarts = [0, 0, 4, 0, 2, 0, 1];
  const xSteps = [8, 8, 4, 4, 2, 2, 1];
  const ySteps = [8, 8, 8, 4, 4, 2, 2];
  return xStarts.map((xStart, index) => ({
    width: width > xStart ? Math.ceil((width - xStart) / xSteps[index]) : 0,
    height: height > yStarts[index] ? Math.ceil((height - yStarts[index]) / ySteps[index]) : 0
  }));
}

function validatePngScanlines(compressed, width, height, bitDepth, colorType, interlace) {
  const channelsByColorType = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const bitsPerPixel = channelsByColorType[colorType] * bitDepth;
  const passes = pngPasses(width, height, interlace);
  let expectedLength = 0;

  for (const pass of passes) {
    if (!pass.width || !pass.height) continue;
    const rowLength = Math.ceil((pass.width * bitsPerPixel) / 8);
    expectedLength += pass.height * (rowLength + 1);
    if (expectedLength > MAX_DECODED_IMAGE_BYTES) return false;
  }

  let decoded;
  try {
    decoded = inflateSync(compressed, { maxOutputLength: expectedLength });
  } catch {
    return false;
  }
  if (decoded.length !== expectedLength) return false;

  let offset = 0;
  for (const pass of passes) {
    if (!pass.width || !pass.height) continue;
    const rowLength = Math.ceil((pass.width * bitsPerPixel) / 8);
    for (let row = 0; row < pass.height; row += 1) {
      if (decoded[offset] > 4) return false;
      offset += rowLength + 1;
    }
  }
  return offset === decoded.length;
}

function validatePng(bytes) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 57 || !signature.every((value, index) => bytes[index] === value)) {
    return false;
  }

  let offset = 8;
  let width;
  let height;
  let bitDepth;
  let colorType;
  let interlace;
  let sawHeader = false;
  let sawPalette = false;
  let paletteEntries = 0;
  let sawImageData = false;
  let imageDataEnded = false;
  const imageData = [];

  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) return false;
    const length = bytes.readUInt32BE(offset);
    if (length > 0x7fffffff) return false;
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (chunkEnd > bytes.length) return false;

    const type = bytes.subarray(typeStart, dataStart).toString("ascii");
    if (!/^[A-Za-z]{4}$/.test(type)) return false;
    if (bytes.readUInt32BE(dataEnd) !== crc32(bytes, typeStart, dataEnd)) return false;
    if (!sawHeader && type !== "IHDR") return false;
    if (sawImageData && type !== "IDAT") imageDataEnded = true;

    if (type === "IHDR") {
      if (sawHeader || offset !== 8 || length !== 13) return false;
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      bitDepth = bytes[dataStart + 8];
      colorType = bytes[dataStart + 9];
      const validDepths = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16]
      };
      if (!dimensionsAreSafe(width, height)
        || !validDepths[colorType]?.includes(bitDepth)
        || bytes[dataStart + 10] !== 0
        || bytes[dataStart + 11] !== 0
        || ![0, 1].includes(bytes[dataStart + 12])) {
        return false;
      }
      interlace = bytes[dataStart + 12];
      sawHeader = true;
    } else if (type === "PLTE") {
      if (sawPalette || sawImageData || !length || length % 3 !== 0 || length > 768) return false;
      if (colorType === 0 || colorType === 4) return false;
      paletteEntries = length / 3;
      if (colorType === 3 && paletteEntries > 2 ** bitDepth) return false;
      sawPalette = true;
    } else if (type === "IDAT") {
      if (imageDataEnded || (colorType === 3 && !sawPalette)) return false;
      sawImageData = true;
      imageData.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      if (length !== 0 || !sawImageData || chunkEnd !== bytes.length) return false;
      const compressed = Buffer.concat(imageData);
      return compressed.length > 0
        && validatePngScanlines(compressed, width, height, bitDepth, colorType, interlace);
    } else if ((bytes[typeStart] & 0x20) === 0) {
      // Unknown critical chunks cannot be safely decoded.
      return false;
    }

    offset = chunkEnd;
  }

  return false;
}

function isJpegStartOfFrame(marker) {
  return marker >= 0xc0
    && marker <= 0xcf
    && ![0xc4, 0xc8, 0xcc].includes(marker);
}

function validateJpeg(bytes) {
  if (bytes.length < 16 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;

  let offset = 2;
  let sawFrame = false;
  let sawScan = false;

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return false;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return false;
    const marker = bytes[offset];
    offset += 1;

    if (marker === 0x00 || marker === 0xd8) return false;
    if (marker === 0xd9) return sawFrame && sawScan && offset === bytes.length;
    if (marker >= 0xd0 && marker <= 0xd7) return false;
    if (marker === 0x01) continue;
    if (offset + 2 > bytes.length) return false;

    const length = bytes.readUInt16BE(offset);
    if (length < 2) return false;
    const dataStart = offset + 2;
    const segmentEnd = offset + length;
    if (segmentEnd > bytes.length) return false;

    if (isJpegStartOfFrame(marker)) {
      if (sawFrame || length < 11) return false;
      const precision = bytes[dataStart];
      const height = bytes.readUInt16BE(dataStart + 1);
      const width = bytes.readUInt16BE(dataStart + 3);
      const components = bytes[dataStart + 5];
      if (![8, 12, 16].includes(precision)
        || !dimensionsAreSafe(width, height)
        || components < 1
        || components > 4
        || length !== 8 + (3 * components)) {
        return false;
      }
      sawFrame = true;
    }

    if (marker !== 0xda) {
      offset = segmentEnd;
      continue;
    }

    if (!sawFrame || length < 8) return false;
    const scanComponents = bytes[dataStart];
    if (scanComponents < 1 || scanComponents > 4 || length !== 6 + (2 * scanComponents)) {
      return false;
    }
    sawScan = true;
    offset = segmentEnd;
    let entropyBytes = 0;

    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) {
        entropyBytes += 1;
        offset += 1;
        continue;
      }

      const entropyMarkerStart = offset;
      offset += 1;
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.length) return false;
      const entropyMarker = bytes[offset];
      if (entropyMarker === 0x00) {
        entropyBytes += 1;
        offset += 1;
      } else if (entropyMarker >= 0xd0 && entropyMarker <= 0xd7) {
        offset += 1;
      } else {
        offset = entropyMarkerStart;
        break;
      }
    }

    if (!entropyBytes) return false;
  }

  return false;
}

function readGifSubBlocks(bytes, offset, collect) {
  const parts = [];
  let totalLength = 0;

  while (offset < bytes.length) {
    const length = bytes[offset];
    offset += 1;
    if (length === 0) {
      return {
        data: collect ? Buffer.concat(parts, totalLength) : null,
        offset
      };
    }
    if (offset + length > bytes.length) return null;
    if (collect) {
      parts.push(bytes.subarray(offset, offset + length));
      totalLength += length;
    }
    offset += length;
  }

  return null;
}

function validateGifLzw(data, minimumCodeSize, expectedPixels, paletteSize) {
  const clearCode = 1 << minimumCodeSize;
  const endCode = clearCode + 1;
  const prefix = new Uint16Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4096);
  for (let index = 0; index < clearCode; index += 1) suffix[index] = index;

  let codeSize = minimumCodeSize + 1;
  let nextCode = endCode + 1;
  let bitOffset = 0;
  let oldCode = -1;
  let firstValue = 0;
  let outputPixels = 0;
  let sawClearCode = false;

  function readCode() {
    if (bitOffset + codeSize > data.length * 8) return null;
    let code = 0;
    for (let bit = 0; bit < codeSize; bit += 1) {
      code |= ((data[(bitOffset + bit) >>> 3] >>> ((bitOffset + bit) & 7)) & 1) << bit;
    }
    bitOffset += codeSize;
    return code;
  }

  while (true) {
    let code = readCode();
    if (code === null) return false;
    if (code === clearCode) {
      codeSize = minimumCodeSize + 1;
      nextCode = endCode + 1;
      oldCode = -1;
      sawClearCode = true;
      continue;
    }
    if (code === endCode) {
      return sawClearCode
        && oldCode >= 0
        && outputPixels === expectedPixels
        && (data.length * 8) - bitOffset < 8;
    }
    if (!sawClearCode) return false;

    const inputCode = code;
    if (oldCode < 0) {
      if (code >= clearCode || code >= paletteSize) return false;
      firstValue = code;
      outputPixels += 1;
      oldCode = code;
      if (outputPixels > expectedPixels) return false;
      continue;
    }

    let stackLength = 0;
    if (code === nextCode) {
      stack[stackLength] = firstValue;
      stackLength += 1;
      code = oldCode;
    } else if (code > nextCode) {
      return false;
    }

    while (code >= clearCode) {
      if (code >= nextCode || stackLength >= stack.length) return false;
      stack[stackLength] = suffix[code];
      stackLength += 1;
      code = prefix[code];
    }
    if (code >= paletteSize || stackLength >= stack.length) return false;
    firstValue = suffix[code];
    stack[stackLength] = firstValue;
    stackLength += 1;
    outputPixels += stackLength;
    if (outputPixels > expectedPixels) return false;

    if (nextCode < 4096) {
      prefix[nextCode] = oldCode;
      suffix[nextCode] = firstValue;
      nextCode += 1;
      if (nextCode === (1 << codeSize) && codeSize < 12) codeSize += 1;
    }
    oldCode = inputCode;
  }
}

function validateGif(bytes) {
  if (bytes.length < 35) return false;
  const version = bytes.subarray(0, 6).toString("ascii");
  if (version !== "GIF87a" && version !== "GIF89a") return false;

  const canvasWidth = bytes.readUInt16LE(6);
  const canvasHeight = bytes.readUInt16LE(8);
  if (!dimensionsAreSafe(canvasWidth, canvasHeight)) return false;

  const screenFlags = bytes[10];
  const hasGlobalPalette = Boolean(screenFlags & 0x80);
  const globalPaletteSize = hasGlobalPalette ? 2 ** ((screenFlags & 0x07) + 1) : 0;
  let offset = 13;
  if (hasGlobalPalette) {
    offset += globalPaletteSize * 3;
    if (offset > bytes.length) return false;
  }

  let frames = 0;
  let totalFramePixels = 0;

  while (offset < bytes.length) {
    const blockType = bytes[offset];
    offset += 1;

    if (blockType === 0x3b) {
      return frames > 0 && offset === bytes.length;
    }

    if (blockType === 0x21) {
      if (offset >= bytes.length) return false;
      const label = bytes[offset];
      offset += 1;
      if (label === 0xf9) {
        if (offset + 6 > bytes.length || bytes[offset] !== 4 || bytes[offset + 5] !== 0) return false;
        const packed = bytes[offset + 1];
        if ((packed & 0xe0) !== 0 || ((packed >>> 2) & 0x07) > 3) return false;
        offset += 6;
        continue;
      }
      if (label === 0xff && bytes[offset] !== 11) return false;
      if (label === 0x01 && bytes[offset] !== 12) return false;
      if (![0xff, 0x01, 0xfe].includes(label)) return false;
      const extension = readGifSubBlocks(bytes, offset, false);
      if (!extension) return false;
      offset = extension.offset;
      continue;
    }

    if (blockType !== 0x2c || offset + 9 > bytes.length) return false;
    const left = bytes.readUInt16LE(offset);
    const top = bytes.readUInt16LE(offset + 2);
    const width = bytes.readUInt16LE(offset + 4);
    const height = bytes.readUInt16LE(offset + 6);
    const imageFlags = bytes[offset + 8];
    offset += 9;
    if ((imageFlags & 0x18) !== 0
      || !dimensionsAreSafe(width, height)
      || left + width > canvasWidth
      || top + height > canvasHeight) {
      return false;
    }

    const hasLocalPalette = Boolean(imageFlags & 0x80);
    const localPaletteSize = hasLocalPalette ? 2 ** ((imageFlags & 0x07) + 1) : 0;
    if (hasLocalPalette) {
      offset += localPaletteSize * 3;
      if (offset > bytes.length) return false;
    }
    const paletteSize = hasLocalPalette ? localPaletteSize : globalPaletteSize;
    if (!paletteSize || offset >= bytes.length) return false;

    const minimumCodeSize = bytes[offset];
    offset += 1;
    if (minimumCodeSize < 2 || minimumCodeSize > 8) return false;
    const imageBlocks = readGifSubBlocks(bytes, offset, true);
    if (!imageBlocks || !imageBlocks.data.length) return false;
    offset = imageBlocks.offset;

    const framePixels = width * height;
    frames += 1;
    totalFramePixels += framePixels;
    if (frames > MAX_GIF_FRAMES
      || totalFramePixels > MAX_IMAGE_PIXELS
      || !validateGifLzw(imageBlocks.data, minimumCodeSize, framePixels, paletteSize)) {
      return false;
    }
  }

  return false;
}

function readUInt24LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readWebpChunks(bytes, start, end) {
  const chunks = [];
  let offset = start;

  while (offset < end) {
    if (offset + 8 > end) return null;
    const type = bytes.subarray(offset, offset + 4).toString("ascii");
    if (!/^[\x20-\x7e]{4}$/.test(type)) return null;
    const length = bytes.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const paddedEnd = dataEnd + (length & 1);
    if (paddedEnd > end || (length & 1 && bytes[dataEnd] !== 0)) return null;
    chunks.push({ type, data: bytes.subarray(dataStart, dataEnd) });
    offset = paddedEnd;
  }

  return offset === end ? chunks : null;
}

function vp8Dimensions(data) {
  if (data.length < 11) return null;
  const frameTag = data[0] | (data[1] << 8) | (data[2] << 16);
  const firstPartitionLength = frameTag >>> 5;
  if ((frameTag & 1) !== 0
    || ((frameTag >>> 1) & 0x07) > 3
    || ((frameTag >>> 4) & 1) !== 1
    || data[3] !== 0x9d
    || data[4] !== 0x01
    || data[5] !== 0x2a
    || 10 + firstPartitionLength > data.length) {
    return null;
  }
  const width = data.readUInt16LE(6) & 0x3fff;
  const height = data.readUInt16LE(8) & 0x3fff;
  return dimensionsAreSafe(width, height) ? { width, height } : null;
}

function vp8lDimensions(data) {
  if (data.length <= 5 || data[0] !== 0x2f) return null;
  const bits = data.readUInt32LE(1);
  if ((bits >>> 29) !== 0) return null;
  const width = (bits & 0x3fff) + 1;
  const height = ((bits >>> 14) & 0x3fff) + 1;
  return dimensionsAreSafe(width, height) ? { width, height } : null;
}

function webpImageDimensions(chunk) {
  if (chunk.type === "VP8 ") return vp8Dimensions(chunk.data);
  if (chunk.type === "VP8L") return vp8lDimensions(chunk.data);
  return null;
}

function validateExtendedWebp(chunks) {
  if (chunks[0].type !== "VP8X" || chunks[0].data.length !== 10) return false;
  const header = chunks[0].data;
  const flags = header[0];
  if ((flags & 0xc1) !== 0 || header[1] !== 0 || header[2] !== 0 || header[3] !== 0) {
    return false;
  }
  const canvasWidth = readUInt24LE(header, 4) + 1;
  const canvasHeight = readUInt24LE(header, 7) + 1;
  if (!dimensionsAreSafe(canvasWidth, canvasHeight)) return false;

  const animated = Boolean(flags & 0x02);
  if (!animated) {
    if (chunks.some(chunk => chunk.type === "ANIM" || chunk.type === "ANMF")) return false;
    const images = chunks.filter(chunk => chunk.type === "VP8 " || chunk.type === "VP8L");
    if (images.length !== 1) return false;
    const dimensions = webpImageDimensions(images[0]);
    return Boolean(dimensions
      && dimensions.width === canvasWidth
      && dimensions.height === canvasHeight);
  }

  const animationHeaders = chunks.filter(chunk => chunk.type === "ANIM");
  const frames = chunks.filter(chunk => chunk.type === "ANMF");
  if (animationHeaders.length !== 1 || animationHeaders[0].data.length !== 6 || !frames.length) {
    return false;
  }
  if (chunks.some(chunk => chunk.type === "VP8 " || chunk.type === "VP8L")) return false;

  let totalFramePixels = 0;
  for (const frame of frames) {
    if (frame.data.length < 16 || (frame.data[15] & 0xfc) !== 0) return false;
    const x = readUInt24LE(frame.data, 0) * 2;
    const y = readUInt24LE(frame.data, 3) * 2;
    const width = readUInt24LE(frame.data, 6) + 1;
    const height = readUInt24LE(frame.data, 9) + 1;
    if (!dimensionsAreSafe(width, height)
      || x + width > canvasWidth
      || y + height > canvasHeight) {
      return false;
    }
    totalFramePixels += width * height;
    if (totalFramePixels > MAX_IMAGE_PIXELS) return false;

    const frameChunks = readWebpChunks(frame.data, 16, frame.data.length);
    if (!frameChunks) return false;
    const images = frameChunks.filter(chunk => chunk.type === "VP8 " || chunk.type === "VP8L");
    if (images.length !== 1) return false;
    const dimensions = webpImageDimensions(images[0]);
    if (!dimensions || dimensions.width !== width || dimensions.height !== height) return false;
  }

  return true;
}

function validateWebp(bytes) {
  if (bytes.length < 24
    || bytes.subarray(0, 4).toString("ascii") !== "RIFF"
    || bytes.subarray(8, 12).toString("ascii") !== "WEBP"
    || bytes.readUInt32LE(4) + 8 !== bytes.length) {
    return false;
  }

  const chunks = readWebpChunks(bytes, 12, bytes.length);
  if (!chunks?.length) return false;
  if (chunks[0].type === "VP8X") return validateExtendedWebp(chunks);
  if (chunks.length !== 1) return false;
  return Boolean(webpImageDimensions(chunks[0]));
}

function hasValidImageStructure(contentType, bytes) {
  if (contentType === "image/png") return validatePng(bytes);
  if (contentType === "image/jpeg") return validateJpeg(bytes);
  if (contentType === "image/gif") return validateGif(bytes);
  if (contentType === "image/webp") return validateWebp(bytes);
  return false;
}

export function decodeImageDataUrl(dataUrl, maxBytes) {
  if (typeof dataUrl !== "string" || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) return null;
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/s.exec(dataUrl);
  if (!match || match[2].length % 4 !== 0) return null;

  const contentType = match[1].toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) return null;

  let bytes;
  try {
    bytes = Buffer.from(match[2], "base64");
  } catch {
    return null;
  }

  if (!bytes.length
    || bytes.length > maxBytes
    || bytes.toString("base64") !== match[2]
    || !hasValidImageStructure(contentType, bytes)) {
    return null;
  }

  return { contentType, bytes };
}

export function validateProjectImages(images) {
  if (!Array.isArray(images)) return null;
  const decodedImages = [];
  let totalBytes = 0;

  for (const image of images) {
    const decoded = decodeImageDataUrl(image, MAX_PROJECT_IMAGE_BYTES);
    if (!decoded) return null;
    totalBytes += decoded.bytes.byteLength;
    if (totalBytes > MAX_PROJECT_IMAGES_TOTAL_BYTES) return null;
    decodedImages.push(decoded);
  }

  return decodedImages;
}
