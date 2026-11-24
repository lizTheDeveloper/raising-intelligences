import { describe, it, expect } from "vitest";
import { readDevHarness, devMatrixVerifier, DevIdentity, devMockLlm } from "../src/dev/harness.js";
import { AgeVerification } from "../src/stranger/identity.js";
import { InMemoryStrangerStore } from "../src/stranger/store.js";
import { InMemoryChildSafetyStore } from "../src/safety/child-safety/store.js";
import { strangerConfig } from "./helpers/fake-identity.js";

describe("the local test harness", () => {
  it("is refused outright in production", () => {
    const env = { NODE_ENV: "production", RI_DEV_FAKE_MATRIX: "true", RI_DEV_FAKE_IDENTITY: "true", RI_DEV_MOCK_LLM: "true" };
    expect(readDevHarness(env)).toEqual({ fakeMatrix: false, fakeIdentity: false, mockLlm: false });
    expect(readDevHarness({ RI_DEV_FAKE_MATRIX: "true" }).fakeMatrix).toBe(true);
  });

  it("dev tokens sign in only with the flag on; other tokens go to the real verifier", async () => {
    const real = async (t: unknown) => (t === "real" ? "@real:multiversegames.ai" : null);
    const off = devMatrixVerifier(real, { fakeMatrix: false, fakeIdentity: false, mockLlm: false });
    const on = devMatrixVerifier(real, { fakeMatrix: true, fakeIdentity: false, mockLlm: false });
    expect(await off("dev:@ash:local")).toBeNull();
    expect(await on("dev:@ash:local")).toBe("@ash:local");
    expect(await on("real")).toBe("@real:multiversegames.ai");
    expect(await on("dev:not a handle")).toBeNull();
  });

  it("the fake ID check admits an adult only where test-mode checks are allowed (never in production)", async () => {
    for (const [cfg, admitted] of [
      [strangerConfig({ production: false, allowTestIdentity: true }), true],
      [strangerConfig({ production: false, allowTestIdentity: false }), false],
      [strangerConfig({ production: true, allowTestIdentity: true }), false],
    ] as const) {
      const age = new AgeVerification({ store: new InMemoryStrangerStore(), api: new DevIdentity(), config: () => cfg, childSafety: new InMemoryChildSafetyStore(), pepper: "k".repeat(64) });
      await age.recordConsent("@ash:local", (await import("../src/stranger/identity.js")).CONSENT_VERSION);
      const started = await age.start("@ash:local", null);
      expect("url" in started && started.url.startsWith(cfg.publicBaseUrl)).toBe(true);
      await age.check("@ash:local");
      expect((await age.adultForPool("@ash:local")).ok).toBe(admitted);
    }
  });

  it("the canned model never runs out of scenes", async () => {
    const m = devMockLlm();
    for (let i = 0; i < 5000; i++) expect(await m.completeJson("", "")).toBeTruthy();
  });
});

describe("DevIdentity session ids", () => {
  it("never repeat across restarts (a persistent database keeps the old ones)", async () => {
    const { DevIdentity } = await import("../src/dev/harness.js");
    const params = { return_url: "http://x/", "metadata[ri_subject]": "s" } as never;
    const a = await new DevIdentity().createVerificationSession(params);
    const b = await new DevIdentity().createVerificationSession(params);
    expect(a.id).not.toBe(b.id);
  });
});
