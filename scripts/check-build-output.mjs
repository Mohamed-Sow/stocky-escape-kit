#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const build = spawn("npm", ["run", "build"], {
  env: {
    ...process.env,
    DATABASE_URL:
      process.env.DATABASE_URL ??
      "postgresql://stocky_escape_kit:stocky_escape_kit@localhost:5432/stocky_escape_kit",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";

build.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  output += text;
  process.stdout.write(text);
});

build.stderr.on("data", (chunk) => {
  const text = chunk.toString();
  output += text;
  process.stderr.write(text);
});

build.on("close", (code) => {
  if (code !== 0) {
    process.exit(code ?? 1);
  }

  const failures = [];

  if (output.includes("Future Flag Warning")) {
    failures.push(
      "React Router future-flag warnings returned. Keep react-router.config.ts aligned with the installed @react-router/dev future flags.",
    );
  }

  const assetDirectory = path.join(process.cwd(), "build", "client", "assets");
  const browserAssets = readdirSync(assetDirectory).filter((filename) =>
    filename.endsWith(".js"),
  );
  const prismaBrowserImports = browserAssets.filter((filename) =>
    readFileSync(path.join(assetDirectory, filename), "utf8").includes(
      '.prisma/client/index-browser',
    ),
  );

  if (prismaBrowserImports.length > 0) {
    failures.push(
      `Browser bundles contain Prisma runtime imports that prevent hydration: ${prismaBrowserImports.join(", ")}. Use type-only Prisma imports and client-safe constants in rendered routes.`,
    );
  }

  if (failures.length > 0) {
    console.error("Build output risk gate failed.");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log("Build output risk gate passed.");
});
