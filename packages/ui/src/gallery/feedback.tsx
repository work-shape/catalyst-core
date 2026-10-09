import { InlineError } from "../feedback/inline-error";
import { Spinner, type SpinnerSize } from "../feedback/spinner";
import { Samples, type GalleryGroup } from "./entry";

const spinnerSizes: readonly SpinnerSize[] = ["xs", "sm", "md", "lg"];

export const feedbackGallery: GalleryGroup = {
  id: "feedback",
  entries: [
    {
      name: "Spinner",
      components: ["Spinner"],
      render: () => (
        <Samples>
          {spinnerSizes.map((size) => (
            <Spinner key={size} size={size} />
          ))}
        </Samples>
      )
    },
    {
      name: "InlineError",
      components: ["InlineError"],
      render: (text) => <InlineError className="max-w-sm">{text.errorMessage}</InlineError>
    }
  ]
};
