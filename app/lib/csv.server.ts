export type CsvParseResult = {
  headers: string[];
  rows: Array<{
    sourceRowNumber: number;
    values: string[];
  }>;
  errors: string[];
};

export function parseCsv(input: string): CsvParseResult {
  const text = input.replace(/^\uFEFF/, "");
  const delimiter = detectDelimiter(text);
  const rows: Array<{ values: string[]; sourceRowNumber: number }> = [];
  const errors: string[] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let lineNumber = 1;
  let rowStartLine = 1;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const nextChar = text[index + 1];

    if (inQuotes) {
      if (char === '"' && nextChar === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
        if (char === "\n") {
          lineNumber += 1;
        }
      }
      continue;
    }

    if (char === '"' && field.length === 0) {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push({ values: row, sourceRowNumber: rowStartLine });
      row = [];
      field = "";
      lineNumber += 1;
      rowStartLine = lineNumber;
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (inQuotes) {
    errors.push("CSV ended before a quoted field was closed.");
  }

  if (field.length > 0 || row.length > 0 || text.endsWith(delimiter)) {
    row.push(field);
    rows.push({ values: row, sourceRowNumber: rowStartLine });
  }

  const nonEmptyRows = rows.filter((candidate) =>
    candidate.values.some((value) => value.trim().length > 0),
  );

  const [headerRow, ...bodyRows] = nonEmptyRows;
  const headers = headerRow?.values ?? [];

  return {
    headers: headers.map((header) => header.trim()),
    rows: bodyRows.map(({ values, sourceRowNumber }) => ({
      sourceRowNumber,
      values,
    })),
    errors,
  };
}

export function toCsv(rows: string[][]) {
  return rows
    .map((row) =>
      row
        .map((value) => {
          const escapedValue = escapeSpreadsheetFormula(value);

          if (/[",\n\r]/.test(escapedValue)) {
            return `"${escapedValue.replace(/"/g, '""')}"`;
          }

          return escapedValue;
        })
        .join(","),
    )
    .join("\n");
}

function escapeSpreadsheetFormula(value: string) {
  if (/^[\t\r]/.test(value) || /^\s*[=+\-@]/.test(value)) {
    return `'${value}`;
  }

  return value;
}

function detectDelimiter(text: string) {
  const firstNonEmptyLine =
    text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  const candidates = [",", ";", "\t"];

  return candidates
    .map((delimiter) => ({
      delimiter,
      count: countOutsideQuotes(firstNonEmptyLine, delimiter),
    }))
    .sort((left, right) => right.count - left.count)[0].delimiter;
}

function countOutsideQuotes(text: string, delimiter: string) {
  let count = 0;
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const nextChar = text[index + 1];

    if (char === '"' && inQuotes && nextChar === '"') {
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (!inQuotes && char === delimiter) {
      count += 1;
    }
  }

  return count;
}
