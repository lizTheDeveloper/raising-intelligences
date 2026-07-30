import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import * as Sentry from "@sentry/browser";
import { App } from "./App";
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
    sendDefaultPii: false,
    sampleRate: 1.0,
    // This game's transcripts are intimate parent/child roleplay. Never let a
    // crash report carry user identity or the conversation itself.
    beforeSend(event) {
      delete event.user;
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
