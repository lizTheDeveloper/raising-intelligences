import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import * as Sentry from "@sentry/browser";
import { App } from "./App";
import { startSessionTracking } from "./analytics";
import "./global.css";

/**
 * Browser error reporting to GlitchTip (project 6). The server has reported via
 * @sentry/node since 2026-07-26, but the client had none at all — so every
 * crash in this SPA was invisible, which is most of what players actually hit.
 *
 * Guarded on the build-time DSN: unset (local dev, or a build without the
 * VITE_SENTRY_DSN arg) means no init and no network calls.
 */
if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE,
    sendDefaultPii: false,
    sampleRate: 1.0,
    // This game's transcripts are intimate parent/child roleplay. Never let a
    // crash report carry user identity or the conversation itself.
    beforeSend(event) {
      delete event.user;
      // Drop benign network/abort noise — a dropped connection or a fetch/SSE
      // aborted on unmount is a browser network-layer failure ("Load failed",
      // "Failed to fetch", AbortError), NOT a code bug, and there's nothing the
      // app can do but retry. These were the bulk of this project's GlitchTip
      // volume. Filter in beforeSend (not ignoreErrors) because the handlers
      // below capture manually, which bypasses ignoreErrors.
      const msg =
        event.exception?.values?.[0]?.value ?? (typeof event.message === "string" ? event.message : "");
      if (/load failed|failed to fetch|networkerror|operation was aborted|aborterror/i.test(msg)) {
        return null;
      }
      // Chrome/Firefox extensions (ad blockers, password managers, etc.) inject
      // content scripts into every page, including this one. When their
      // background script tries to message a tab that's already closed or
      // navigated away, the extension throws inside our page context and the
      // window "error"/"unhandledrejection" listeners below capture it as if
      // it were our own crash (issue #151). It isn't reachable or fixable from
      // application code, so drop it rather than let it page us every time a
      // player has a stale extension installed.
      if (/runtime\.sendMessage\(\)|extension context invalidated/i.test(msg)) {
        return null;
      }
      return event;
    },
  });
  window.addEventListener("error", (e) => Sentry.captureException(e.error));
  window.addEventListener("unhandledrejection", (e) => Sentry.captureException(e.reason));
}

if (import.meta.env.PROD) {
  // Load analytics from the host matching the domain the user actually reached.
  // Some ISPs (e.g. Comcast) SNI-block the .xyz TLD, which is why we also serve
  // on .ai — a user on multiversegames.ai cannot reach analytics.multiversestudios.xyz,
  // so hardcoding either host silently drops half the traffic. Pick by domain;
  // default to .ai (the non-blocked host) for anything else. Both hosts serve the
  // same Umami instance and are allowlisted in the server CSP (see app.ts).
  const analyticsHost = location.hostname.endsWith("multiversestudios.xyz")
    ? "https://analytics.multiversestudios.xyz"
    : "https://analytics.multiversegames.ai";
  const s = document.createElement("script");
  s.defer = true;
  s.src = `${analyticsHost}/script.js`;
  s.dataset.websiteId = "70687d81-c604-4643-a6b6-9d0bccdba970";
  document.head.appendChild(s);
}

// `return_visit` + the seven `session_milestone` beats. Safe to call before the
// Umami script has landed: analytics.ts queues until the global appears (which
// is the whole reason that queue exists — this script is inserted dynamically
// and so resolves well after first render).
startSessionTracking();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
