// The one module of the deployment kit's JavaScript that reads the environment.

/** Whether the run asked for the checks that need a Docker daemon (`CATALYST_DOCKER_CHECK=1`). */
export function dockerCheckAsked() {
  return process.env.CATALYST_DOCKER_CHECK === "1";
}
