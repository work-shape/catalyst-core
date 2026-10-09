import { AppError } from "@vivd-catalyst/core";

/**
 * Keys that held provider settings before the `infrastructure` section. Each is refused with
 * the place it moved to, so an instance whose config was not moved stops at startup with the
 * key and its new place instead of running on a provider nobody chose. There is no alias.
 */
const MOVED_KEYS: { path: string[]; message: string }[] = [
  {
    path: ["modelProviders"],
    message:
      "'modelProviders' moved to 'infrastructure.models', a map from each provider's name to its entry: 'id' becomes the map key, 'type' becomes 'provider', the two '...EnvName' fields become 'credentialSecret' and 'organizationSecret', and 'compliance.residency' becomes 'region'"
  },
  {
    path: ["mail"],
    message:
      "'mail' moved to 'infrastructure.mail': the two '...EnvName' fields become 'apiKeySecret' and 'apiSecretSecret', and an instance without mail leaves the key out instead of setting 'enabled: false'"
  },
  {
    path: ["executionWorkspaces", "runner"],
    message:
      "'executionWorkspaces.runner' moved to 'infrastructure.sandbox': 'mode' becomes 'provider', and 'networkMode' and 'readOnlyRootFilesystem' are fixed and no longer settings"
  },
  {
    // Refused here as well as by the capability, so a process that does not load the
    // capability stops on the old key too.
    path: ["capabilities", "documentProcessing", "objectStorage"],
    message:
      "'capabilities.documentProcessing.objectStorage' moved to 'infrastructure.objectStorage.files': 'kind' becomes 'provider', the vendor's 'region' becomes 'bucketRegion', and 'region' now states where the data is processed"
  }
];

export function refuseMovedInfrastructureKeys(input: unknown): void {
  for (const moved of MOVED_KEYS) {
    if (hasPath(input, moved.path)) {
      throw new AppError("VALIDATION_FAILED", moved.message, {
        issues: [{ path: moved.path, message: moved.message }]
      });
    }
  }
}

function hasPath(input: unknown, path: string[]): boolean {
  let current = input;
  for (const key of path) {
    if (typeof current !== "object" || current === null || !(key in current)) {
      return false;
    }
    current = Reflect.get(current, key);
  }
  return true;
}
