import { TextDecoder } from "node:util";

export type StockyCsvEncoding =
  "utf-8" | "utf-16le" | "utf-16be" | "windows-1252";

export function decodeStockyCsvBytes(bytes: Uint8Array): {
  content: string;
  encoding: StockyCsvEncoding;
} {
  if (hasPrefix(bytes, [0xef, 0xbb, 0xbf])) {
    return decode(bytes, "utf-8");
  }

  if (hasPrefix(bytes, [0xff, 0xfe])) {
    return decode(bytes, "utf-16le");
  }

  if (hasPrefix(bytes, [0xfe, 0xff])) {
    return decode(bytes, "utf-16be");
  }

  const inferredUtf16 = inferBomlessUtf16(bytes);
  if (inferredUtf16) {
    return decode(bytes, inferredUtf16);
  }

  try {
    return decode(bytes, "utf-8");
  } catch {
    // Excel and older Stocky workflows commonly save CSVs in the Windows
    // Western code page. Preserve the original bytes separately, but decode
    // that text deliberately instead of silently replacing invalid UTF-8.
    return decode(bytes, "windows-1252", false);
  }
}

function decode(bytes: Uint8Array, encoding: StockyCsvEncoding, fatal = true) {
  return {
    content: new TextDecoder(encoding, { fatal }).decode(bytes),
    encoding,
  };
}

function hasPrefix(bytes: Uint8Array, prefix: number[]) {
  return prefix.every((value, index) => bytes[index] === value);
}

function inferBomlessUtf16(
  bytes: Uint8Array,
): Extract<StockyCsvEncoding, "utf-16le" | "utf-16be"> | null {
  const sampleLength = Math.min(bytes.length - (bytes.length % 2), 1024);
  const pairCount = sampleLength / 2;

  if (pairCount < 4) {
    return null;
  }

  let evenNulls = 0;
  let oddNulls = 0;

  for (let index = 0; index < sampleLength; index += 2) {
    if (bytes[index] === 0) evenNulls += 1;
    if (bytes[index + 1] === 0) oddNulls += 1;
  }

  if (oddNulls / pairCount >= 0.35 && evenNulls / pairCount <= 0.1) {
    return "utf-16le";
  }

  if (evenNulls / pairCount >= 0.35 && oddNulls / pairCount <= 0.1) {
    return "utf-16be";
  }

  return null;
}
