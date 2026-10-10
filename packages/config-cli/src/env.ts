export const CONFIG_CLI_ENV_NAMES = {
  CATALYST_API_KEY: "CATALYST_API_KEY",
  CHAT_UI_ORIGIN: "CHAT_UI_ORIGIN"
} as const;

export type ConfigCliEnv = Readonly<Record<string, string | undefined>>;

// Local auth seeding also reads the email variable named by instance configuration.
export function readConfigCliEnv(env?: ConfigCliEnv): ConfigCliEnv {
  return env ?? process.env;
}
