const REQUEST_LOG_ORIGIN = "http://localhost";

export function getSafeRequestPath(requestUrl) {
  if (typeof requestUrl !== "string" || requestUrl.length === 0) {
    return "/";
  }

  try {
    return new URL(requestUrl, REQUEST_LOG_ORIGIN).pathname || "/";
  } catch {
    return "/";
  }
}

export function createSafeRequestLogger({ write = console.info } = {}) {
  return (request, response, next) => {
    const startedAt = performance.now();

    response.once("finish", () => {
      const requestPath = getSafeRequestPath(
        request.originalUrl ?? request.url,
      );
      const durationMs = performance.now() - startedAt;

      write(
        `${request.method} ${requestPath} ${response.statusCode} - ${durationMs.toFixed(1)} ms`,
      );
    });

    next();
  };
}
