export const CLIENT_CONFIG_PATH_ENV_NAME = "CLIENT_CONFIG_PATH";

export function readChatUiEnv(): { clientConfigPath: string | undefined } {
  return { clientConfigPath: process.env[CLIENT_CONFIG_PATH_ENV_NAME] };
}
