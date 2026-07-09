import { Buffer } from "node:buffer";
import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const fileId = params.fileId;

  if (!fileId) {
    throw new Response("Missing file id.", { status: 400 });
  }

  const uploadedFile = await db.uploadedFile.findFirst({
    where: {
      id: fileId,
      batch: {
        store: {
          shop: session.shop,
        },
      },
    },
    select: {
      originalFilename: true,
      rawContentBase64: true,
      contentSha256: true,
    },
  });

  if (!uploadedFile?.rawContentBase64) {
    throw new Response("Raw CSV was not found.", { status: 404 });
  }

  const bytes = Buffer.from(uploadedFile.rawContentBase64, "base64");

  return new Response(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${safeFilename(uploadedFile.originalFilename)}"`,
        ...(uploadedFile.contentSha256
          ? { "X-Content-Sha256": uploadedFile.contentSha256 }
          : {}),
      },
    },
  );
};

function safeFilename(filename: string) {
  return filename.replace(/["\r\n]/g, "_") || "stocky-export.csv";
}
