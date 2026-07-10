import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";

function showClientFailure() {
  if (document.getElementById("client-startup-failure")) return;

  const notice = document.createElement("div");
  notice.id = "client-startup-failure";
  notice.setAttribute("role", "alert");
  notice.textContent =
    "The interactive workspace could not start. Reload the Shopify Admin page and try again.";
  notice.style.cssText =
    "position:fixed;inset:auto 16px 16px;z-index:2147483647;padding:12px 14px;border:1px solid #e0a6a0;border-radius:10px;background:#fee4e2;color:#912018;font:600 14px/1.4 system-ui,sans-serif";
  document.body.appendChild(notice);
}

try {
  startTransition(() => {
    hydrateRoot(
      document,
      <StrictMode>
        <HydratedRouter />
      </StrictMode>,
    );
  });
} catch {
  showClientFailure();
}
