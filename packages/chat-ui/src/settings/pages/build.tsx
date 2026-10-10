import { BuildFrame } from "../../build-area/build-frame";
import { useBuildSource } from "../../build-area/build-data";

/** Build: the agents and skills the reader holds a right on, in the Build frame. */
export function BuildPage() {
  return <BuildFrame source={useBuildSource()} />;
}
