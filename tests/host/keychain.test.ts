import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { MacKeychain } from "../../src/macos/keychain.js";

test(
  "macOS Keychain stores the API Key outside files and environment",
  { skip: process.platform !== "darwin" },
  async () => {
    const keychain = new MacKeychain();
    const original = await keychain.get();
    const canary = `clm-host-${randomBytes(24).toString("base64url")}`;
    try {
      await keychain.set(canary);
      assert.equal(await keychain.get(), canary);
      assert.equal(Object.values(process.env).includes(canary), false);
    } finally {
      if (original) await keychain.set(original);
      else await keychain.delete();
    }
  },
);
