import compression from "compression";
import express from "express";
import { createRequestHandler } from "@react-router/express";
import { createSafeRequestLogger } from "./request-logging.mjs";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "0.0.0.0";
const build = await import("../build/server/index.js");
const app = express();

app.disable("x-powered-by");
app.use(compression());
app.use(
  "/assets",
  express.static("build/client/assets", {
    immutable: true,
    maxAge: "1y",
  }),
);
app.use(express.static("build/client", { maxAge: "1h" }));
app.use(createSafeRequestLogger());
app.all(
  "*",
  createRequestHandler({
    build,
    mode: process.env.NODE_ENV,
  }),
);

const server = app.listen(port, host, () => {
  console.info(`[stocky-escape-kit] listening on ${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    server.close((error) => {
      if (error) {
        console.error(error);
        process.exitCode = 1;
      }
    });
  });
}
