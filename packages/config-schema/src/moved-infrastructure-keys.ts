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
      "'modelProviders' moved to 'infrastructure.models', a map from each provider's name to its entry: 'id' becomes the map key, 'type' becomes 'provider', the two '...EnvName' fields become 'credentialSecret' and 'organizationSecret', and 'compliance.residency' becomes 'region'. 'region' is now required for a provider that sends data outside the instance"
  },
  {
    path: ["mail"],
    message:
      "'mail' moved to 'infrastructure.mail': the two '...EnvName' fields become 'apiKeySecret' and 'apiSecretSecret', and an instance without mail leaves the key out instead of setting 'enabled: false'. Drop 'enabled: true'. 'region' is now required for a provider that sends data outside the instance"
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
      "'capabilities.documentProcessing.objectStorage' moved to 'infrastructure.objectStorage.files': 'kind' becomes 'provider', the vendor's 'region' becomes 'bucketRegion', 'accessKeyIdEnvName' becomes 'accessKeySecret' and 'secretAccessKeyEnvName' becomes 'secretKeySecret'. 'region' now states where the data is processed and is required for a provider that sends data outside the instance"
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
