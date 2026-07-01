#!/usr/bin/env node

import { spawn } from "node:child_process";

const validate = spawn("npm", ["run", "prisma:validate"], {
  env: {
    ...process.env,
    DATABASE_URL:
      process.env.DATABASE_URL ??
      "postgresql://stocky_escape_kit:stocky_escape_kit@localhost:5432/stocky_escape_kit",
  },
  stdio: "inherit",
});

validate.on("close", (code) => {
  if (code !== 0) {
    process.exit(code ?? 1);
  }

  console.log("Prisma schema risk gate passed.");
});
