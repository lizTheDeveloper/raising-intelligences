import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./global.css";

if (import.meta.env.PROD) {
  const s = document.createElement("script");
  s.defer = true;
  s.src = "https://analytics.multiversestudios.xyz/script.js";
  s.dataset.websiteId = "70687d81-c604-4643-a6b6-9d0bccdba970";
  document.head.appendChild(s);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
