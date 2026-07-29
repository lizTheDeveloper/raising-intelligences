import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./global.css";

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
