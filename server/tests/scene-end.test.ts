import { describe, it, expect } from "vitest";
import {
  SCENE_END_TOKEN,
  SceneEndStreamFilter,
  containsSceneEnd,
  detectSceneEnd,
  shouldAutoEndScene,
  stripSceneEnd,
} from "../src/game/scene-end.js";
import { PARENT_MESSAGE_CAP } from "../src/game/state-machine.js";

describe("stripSceneEnd / containsSceneEnd", () => {
  it("removes the token and tidies surrounding whitespace", () => {
    expect(stripSceneEnd('She walks away. [SCENE_END]')).toBe("She walks away.");
    expect(stripSceneEnd("ok\n\n[SCENE_END]  ")).toBe("ok");
    expect(stripSceneEnd("[SCENE_END]mid [SCENE_END]")).toBe("mid");
  });

  it("contains is exact", () => {
    expect(containsSceneEnd("no token here")).toBe(false);
    expect(containsSceneEnd("walks off. [SCENE_END]")).toBe(true);
  });
});

describe("SceneEndStreamFilter", () => {
  function run(chunks: string[]): string {
    const f = new SceneEndStreamFilter();
    let out = "";
    for (const c of chunks) out += f.push(c);
    return out + f.flush();
  }

  it("scrubs a token delivered whole in one chunk", () => {
    expect(run(["She leaves. [SCENE_END]"])).toBe("She leaves. ");
  });

  it("scrubs a token split across chunk boundaries", () => {
    expect(run(["She leaves. [SCENE", "_END]"])).toBe("She leaves. ");
    // The space that preceded the token is honest streamed text; the saved
    // message is trimmed by stripSceneEnd.
    expect(run(["She leaves.", " [", "SC", "ENE", "_EN", "D", "]"])).toBe("She leaves. ");
  });

  it("scrubs multiple tokens", () => {
    expect(run(["a[SCENE_END]b[SCENE_END]"])).toBe("ab");
  });

  it("flushes a partial-token tail that never completed", () => {
    expect(run(["going [SCEN"])).toBe("going [SCEN");
  });

  it("never leaks any token substring even when the stream is one char per chunk", () => {
    const f = new SceneEndStreamFilter();
    let out = "";
    for (const ch of `Fine.${SCENE_END_TOKEN}`) out += f.push(ch);
    out += f.flush();
    expect(out).toBe("Fine.");
  });
});

describe("detectSceneEnd", () => {
  it("reports the sentinel when present", () => {
    expect(detectSceneEnd("whatever [SCENE_END]", 1)).toBe("sentinel");
  });

  it("fires the closing-action heuristic only once the scene has developed", () => {
    const closed = "I'm done. She picks up the blocks and walks away, upstairs to her room.";
    expect(detectSceneEnd(closed, 3)).toBeNull();
    expect(detectSceneEnd(closed, 4)).toBe("heuristic");
    expect(detectSceneEnd("He slams her door.", 6)).toBe("heuristic");
    expect(detectSceneEnd("No! Mine! I'm still building this.", 5)).toBeNull();
    expect(detectSceneEnd("I don't want to talk about it.", 2)).toBeNull();
  });
});

describe("shouldAutoEndScene", () => {
  it("ends only family_chat scenes", () => {
    expect(shouldAutoEndScene("family_chat", "sentinel", 2, PARENT_MESSAGE_CAP)).toBe(true);
    expect(shouldAutoEndScene("sidebar", "sentinel", 2, PARENT_MESSAGE_CAP)).toBe(false);
    expect(shouldAutoEndScene("adult_chat", "sentinel", 2, PARENT_MESSAGE_CAP)).toBe(false);
  });

  it("hard-ends at the message cap even with no scene-end signal", () => {
    expect(shouldAutoEndScene("family_chat", null, PARENT_MESSAGE_CAP, PARENT_MESSAGE_CAP)).toBe(true);
    expect(shouldAutoEndScene("family_chat", null, PARENT_MESSAGE_CAP - 1, PARENT_MESSAGE_CAP)).toBe(false);
  });
});
