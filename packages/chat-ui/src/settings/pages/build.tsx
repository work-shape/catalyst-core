import { BuildFrame } from "../../build-area/build-frame";
import { useConfigAssetsData } from "../../build-area/build-data";

/** Build: the agents and skills of this instance in the Build frame, with its own data. */
export function BuildPage() {
  return <BuildFrame data={useConfigAssetsData()} />;
}
