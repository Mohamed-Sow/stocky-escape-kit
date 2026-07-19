export function safeDownloadFilename(filename: string) {
  const sanitized = Array.from(filename, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    const unsafe =
      character === '"' ||
      character === "/" ||
      character === "\\" ||
      codePoint <= 0x1f ||
      codePoint === 0x7f;

    return unsafe ? "_" : character;
  }).join("");

  return sanitized.slice(0, 200) || "stocky-export.csv";
}

export function attachmentContentDisposition(filename: string) {
  const safe = safeDownloadFilename(filename);
  const asciiFallback = Array.from(safe, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint >= 0x20 && codePoint <= 0x7e ? character : "_";
  }).join("");
  const encoded = encodeURIComponent(safe).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}
