import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("applies the defaults", () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      databaseUrl: "postgresql://vola:vola@localhost:5432/vola",
      testDatabaseUrl: "postgresql://vola:vola@localhost:5432/vola_test",
      redisUrl: null,
      host: "0.0.0.0",
      port: 8300,
      prefix: "/vola",
      logLevel: "info",
      maxUploadBytes: 512 * 1024 * 1024,
      uploadTtlHours: 24,
    });
    expect(isAbsolute(config.storagePath)).toBe(true);
    expect(config.storagePath.endsWith("/var/storage")).toBe(true);
  });

  it("reads VOLA_* values, treats empty as unset and trims the prefix", () => {
    const config = loadConfig({
      VOLA_DATABASE_URL: "postgres://u:p@db:5432/x",
      VOLA_REDIS_URL: "redis://cache:6379/1",
      VOLA_PORT: "9000",
      VOLA_PREFIX: "/files/",
      VOLA_LOG_LEVEL: "",
      VOLA_STORAGE_PATH: "/data/storage",
      VOLA_MAX_UPLOAD_BYTES: "1048576",
      VOLA_UPLOAD_TTL_HOURS: "72",
      UNRELATED: "ignored",
    });
    expect(config.databaseUrl).toBe("postgres://u:p@db:5432/x");
    expect(config.redisUrl).toBe("redis://cache:6379/1");
    expect(config.port).toBe(9000);
    expect(config.prefix).toBe("/files");
    expect(config.logLevel).toBe("info");
    expect(config.storagePath).toBe("/data/storage");
    expect(config.maxUploadBytes).toBe(1_048_576);
    expect(config.uploadTtlHours).toBe(72);
  });

  it("rejects a bad database URL with one clear message", () => {
    const attempt = () => loadConfig({ VOLA_DATABASE_URL: "mysql://nope" });
    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow(/VOLA_DATABASE_URL: must be a postgresql:\/\/ URL/);
  });

  it("lists every invalid variable", () => {
    try {
      loadConfig({
        VOLA_PORT: "http",
        VOLA_PREFIX: "vola",
        VOLA_LOG_LEVEL: "loud",
        VOLA_MAX_UPLOAD_BYTES: "0",
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const { issues, message } = error as ConfigError;
      expect(issues.map((i) => i.split(":")[0])).toEqual([
        "VOLA_PORT",
        "VOLA_PREFIX",
        "VOLA_MAX_UPLOAD_BYTES",
        "VOLA_LOG_LEVEL",
      ]);
      expect(message).toMatch(
        /^invalid configuration: VOLA_PORT: .*; VOLA_PREFIX: .*; VOLA_LOG_LEVEL/,
      );
    }
  });
});
