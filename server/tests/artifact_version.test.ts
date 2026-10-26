import { describe, expect, test } from "vitest";
import { check_artifact_version } from "../src/artifact_version.js";

describe("artifact version", () => {
  test("accepts numeric version 2", () => {
    expect(check_artifact_version({ schema_version: 2 })).toEqual({ ok: true });
  });

  test.each([
    [{}, undefined],
    [{ schema_version: 1 }, 1],
    [{ schema_version: "2" }, "2"],
    [{ schema_version: 3 }, 3],
  ])("rejects unsupported version %j", (value, found_version) => {
    expect(check_artifact_version(value)).toEqual({
      ok: false,
      code: "ARTIFACT_VERSION_UNSUPPORTED",
      found_version,
    });
  });
});
