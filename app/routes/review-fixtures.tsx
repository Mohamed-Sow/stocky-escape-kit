import { generateReviewerFixturePack } from "../lib/review-fixtures.server";

export const loader = async () => {
  const archive = await generateReviewerFixturePack();

  return new Response(archive, {
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Disposition":
        'attachment; filename="stocky-escape-kit-review-fixtures.zip"',
      "Content-Length": String(archive.byteLength),
      "Content-Type": "application/zip",
      "X-Content-Type-Options": "nosniff",
    },
  });
};
