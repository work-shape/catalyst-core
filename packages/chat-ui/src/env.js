// Plain JavaScript so that the Vite plugin beside it loads without a build.
/** @returns {{ clientConfigPath: string | undefined }} */
export function readChatUiEnv() {
  return { clientConfigPath: process.env.CLIENT_CONFIG_PATH };
}
