export function parseStockyDecimal(value: string | null | undefined) {
  if (!value?.trim()) {
    return null;
  }

  let candidate = value.trim();
  let negative = false;

  if (/^\(.*\)$/.test(candidate)) {
    negative = true;
    candidate = candidate.slice(1, -1);
  }

  candidate = candidate
    .replace(/^[A-Z]{3}\s*/i, "")
    .replace(/\s*[A-Z]{3}$/i, "")
    .replace(/[$£€¥₹%]/g, "")
    .replace(/[\s']/g, "");

  if (!candidate || !/^[+-]?[\d.,]+$/.test(candidate)) {
    return null;
  }

  const sign = candidate.startsWith("-") || negative ? -1 : 1;
  candidate = candidate.replace(/^[+-]/, "");

  const commaIndex = candidate.lastIndexOf(",");
  const dotIndex = candidate.lastIndexOf(".");

  if (commaIndex >= 0 && dotIndex >= 0) {
    const decimalSeparator = commaIndex > dotIndex ? "," : ".";
    const thousandsSeparator = decimalSeparator === "," ? "." : ",";
    candidate = candidate.split(thousandsSeparator).join("");
    candidate = candidate.replace(decimalSeparator, ".");
  } else {
    const separator = commaIndex >= 0 ? "," : dotIndex >= 0 ? "." : null;

    if (separator) {
      const parts = candidate.split(separator);
      const looksLikeThousands =
        parts.length > 2 && parts.slice(1).every((part) => part.length === 3);

      if (parts.length === 2 && parts[1].length === 3) {
        return null;
      }

      candidate = looksLikeThousands
        ? parts.join("")
        : `${parts.slice(0, -1).join("")}.${parts.at(-1)}`;
    }
  }

  const parsed = Number(candidate) * sign;
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseStockyInteger(value: string | null | undefined) {
  const parsed = parseStockyDecimal(value);
  if (parsed !== null && Number.isSafeInteger(parsed)) {
    return parsed;
  }

  const thousandsCandidate = value
    ?.trim()
    .replace(/^[A-Z]{3}\s*/i, "")
    .replace(/\s*[A-Z]{3}$/i, "")
    .replace(/[$£€¥₹%\s']/g, "");

  if (/^[+-]?\d{1,3}(?:[.,]\d{3})+$/.test(thousandsCandidate ?? "")) {
    const integer = Number(thousandsCandidate?.replace(/[.,]/g, ""));
    return Number.isSafeInteger(integer) ? integer : null;
  }

  return null;
}

export function formatShopifyDecimal(
  value: string | null | undefined,
  fractionDigits = 2,
) {
  const parsed = parseStockyDecimal(value);
  return parsed === null ? "" : parsed.toFixed(fractionDigits);
}
