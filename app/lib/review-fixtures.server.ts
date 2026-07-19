import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { strToU8, zipSync } from "fflate";

const FIXTURE_DIRECTORY = path.join(process.cwd(), "fixtures", "stocky");

export async function generateReviewerFixturePack() {
  const filenames = (await readdir(FIXTURE_DIRECTORY))
    .filter(
      (filename) => filename.startsWith("stocky-") && filename.endsWith(".csv"),
    )
    .sort();

  if (filenames.length !== 10) {
    throw new Error(
      `Expected 10 canonical Stocky CSV fixtures, found ${filenames.length}.`,
    );
  }

  const entries: Record<string, Uint8Array> = {};

  await Promise.all(
    filenames.map(async (filename) => {
      entries[filename] = new Uint8Array(
        await readFile(path.join(FIXTURE_DIRECTORY, filename)),
      );
    }),
  );

  entries["README.txt"] = strToU8(
    [
      "Stocky Escape Kit canonical review fixtures",
      "",
      "These files contain fictional test data only.",
      "Upload all ten CSV files together as one migration run.",
      "Expected result: 38 imported rows, 33 warnings, and one malformed file failure.",
    ].join("\n"),
  );

  return zipSync(entries, { level: 6 });
}
