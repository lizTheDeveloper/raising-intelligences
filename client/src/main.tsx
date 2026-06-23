import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./global.css";

if (import.meta.env.PROD) {
  const s = document.createElement("script");
  s.defer = true;
  s.src = "https://analytics.multiversestudios.xyz/script.js";
  s.dataset.websiteId = "38d680a7-28d1-42fd-9fd5-a66702675b88";
  document.head.appendChild(s);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
