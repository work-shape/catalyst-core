import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "../api-contract/openapi.json",
  output: {
    path: "src/generated",
    clean: true
  },
  plugins: ["@hey-api/client-fetch"]
});
