import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Vault, VaultError } from "@/server/security/vault";

const key = () => randomBytes(32).toString("base64");

describe("the vault that seals health information", () => {
  it("round-trips text, JSON and bytes", () => {
    const vault = new Vault(key());
    expect(vault.openText(vault.sealText("કેટલા દિવસથી તાવ છે?", "ctx"), "ctx")).toBe("કેટલા દિવસથી તાવ છે?");
    expect(vault.openJson(vault.sealJson({ a: [1, 2], b: "x" }, "ctx"), "ctx")).toEqual({ a: [1, 2], b: "x" });
    const bytes = randomBytes(5000);
    expect(vault.open(vault.seal(bytes, "ctx"), "ctx").equals(bytes)).toBe(true);
  });

  it("never stores the plaintext, and a fresh IV makes the same value seal differently every time", () => {
    const vault = new Vault(key());
    const a = vault.sealText("Patient: Asha Patel, chest pain", "ctx");
    const b = vault.sealText("Patient: Asha Patel, chest pain", "ctx");
    expect(a.equals(b)).toBe(false);
    expect(a.toString("latin1")).not.toContain("Asha");
    expect(a.toString("utf8")).not.toContain("chest pain");
  });

  it("refuses a value opened with a different context: a sealed value copied to another row, consultation or customer is useless", () => {
    const vault = new Vault(key());
    const sealed = vault.sealText("secret", "org-A|consultation-1|patient");
    expect(() => vault.openText(sealed, "org-B|consultation-1|patient")).toThrow(VaultError); // another customer
    expect(() => vault.openText(sealed, "org-A|consultation-2|patient")).toThrow(VaultError); // another consultation
    expect(() => vault.openText(sealed, "org-A|consultation-1|note")).toThrow(VaultError); // another kind of value
    expect(vault.openText(sealed, "org-A|consultation-1|patient")).toBe("secret");
  });

  it("detects any tampering, truncation or a different key", () => {
    const vault = new Vault(key());
    const sealed = vault.sealText("secret", "ctx");
    for (const at of [0, 1, 13, 28, sealed.length - 1]) {
      const copy = Buffer.from(sealed);
      copy[at] = copy[at]! ^ 0xff;
      expect(() => vault.openText(copy, "ctx"), `byte ${at}`).toThrow(VaultError);
    }
    expect(() => vault.open(sealed.subarray(0, sealed.length - 3), "ctx")).toThrow(VaultError);
    expect(() => vault.open(Buffer.alloc(5), "ctx")).toThrow(VaultError);
    expect(() => new Vault(key()).openText(sealed, "ctx")).toThrow(VaultError);
  });

  it("says nothing about the data or the key when it fails", () => {
    const vault = new Vault(key());
    try {
      vault.openText(Buffer.from(vault.sealText("Asha Patel has diabetes", "ctx")), "other");
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toMatch(/Asha|diabetes|ctx|other/);
    }
  });

  it("rejects a key that is not 32 bytes", () => {
    expect(() => new Vault(Buffer.alloc(16).toString("base64"))).toThrow(/32 bytes/);
    expect(() => new Vault("")).toThrow(/32 bytes/);
  });
});
