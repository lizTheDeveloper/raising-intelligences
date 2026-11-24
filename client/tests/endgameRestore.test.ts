import { test } from "node:test";
import assert from "node:assert/strict";
import { restoredEndgame } from "../src/endgameRestore.js";

test("a finished game's state gives back its report card and epilogue", () => {
  assert.deepEqual(restoredEndgame({ phase: "report_card", epilogue: "They grew up.", reportCard: "# Wren\nkind." }), {
    epilogue: "They grew up.",
    reportCard: "# Wren\nkind.",
  });
});

test("empty strings and missing fields are not taken (they'd clobber text that arrived first)", () => {
  assert.deepEqual(restoredEndgame({ phase: "event_intro", epilogue: "", reportCard: "" }), {});
  assert.deepEqual(restoredEndgame({ phase: "report_card" }), {});
  assert.deepEqual(restoredEndgame(null), {});
  assert.deepEqual(restoredEndgame({ reportCard: 42 }), {});
});
