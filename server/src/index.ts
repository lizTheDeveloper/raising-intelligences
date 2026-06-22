import express from "express";
import cors from "cors";
import { createGameRoutes } from "./routes/game.js";
import { ConversationEngine } from "./game/conversation-engine.js";
import { ClaudeLLMClient } from "./llm/claude.js";

const app = express();
app.use(cors());
app.use(express.json());

const llm = new ClaudeLLMClient();
const engine = new ConversationEngine(llm);

app.use("/api", createGameRoutes(engine));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
