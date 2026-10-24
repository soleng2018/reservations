import { describe, expect, it } from "vitest";
import {
  bootstrapInput,
  resolveSecretsDir,
  secretsDirFromEnv,
} from "./db-container";

describe("secretsDirFromEnv", () => {
  it("reads the value and lets a later line win", () => {
    expect(secretsDirFromEnv("A=1\nSECRETS_DIR=/a\nSECRETS_DIR=/b\n")).toBe(
      "/b",
    );
  });
  it("drops quotes and ignores an empty or commented value", () => {
    expect(secretsDirFromEnv('SECRETS_DIR="/s"')).toBe("/s");
    expect(secretsDirFromEnv("SECRETS_DIR=")).toBeUndefined();
    expect(secretsDirFromEnv("# SECRETS_DIR=/x")).toBeUndefined();
  });
});

describe("resolveSecretsDir", () => {
  it("defaults to .secrets in the repo root", () => {
    expect(resolveSecretsDir("/r", undefined)).toBe("/r/.secrets");
  });
  it("keeps an absolute path and resolves a relative one from docker/", () => {
    expect(resolveSecretsDir("/r", "/home/x/secrets")).toBe("/home/x/secrets");
    expect(resolveSecretsDir("/r", "../s")).toBe("/r/s");
  });
});

describe("bootstrapInput", () => {
  it("puts the password in a psql variable ahead of the file", () => {
    expect(bootstrapInput("abc", "select 1;")).toBe(
      "\\set pw 'abc'\nselect 1;",
    );
  });
  it("refuses a password psql would misread", () => {
    expect(() => bootstrapInput("a'b", "")).toThrow();
    expect(() => bootstrapInput("a\nb", "")).toThrow();
  });
});
