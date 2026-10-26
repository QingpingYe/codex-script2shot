/** 运行产物契约版本检查。缺失版本按 legacy v1；本轮只接受数值 2。 */
export type ArtifactVersionCheck =
  | { ok: true }
  | {
      ok: false;
      code: "ARTIFACT_VERSION_UNSUPPORTED";
      found_version: unknown;
    };

export function check_artifact_version(value: unknown): ArtifactVersionCheck {
  const found_version =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>).schema_version
      : undefined;

  if (found_version === 2) {
    return { ok: true };
  }

  return {
    ok: false,
    code: "ARTIFACT_VERSION_UNSUPPORTED",
    found_version,
  };
}
