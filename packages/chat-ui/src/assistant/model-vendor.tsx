import { Box } from "lucide-react";
import type { AgentSelectableModel } from "../workspace/agent-model-selection";

/** Logo marks from @lobehub/icons-static-svg (MIT), drawn in the current text colour. */
const vendors: Record<string, { label: string; path: string }> = {
  openai: {
    label: "OpenAI",
    path: "M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"
  },
  anthropic: {
    label: "Anthropic",
    path: "M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.522zm4.132 9.959L8.453 7.687 6.205 13.48H10.7z"
  },
  mistral: {
    label: "Mistral",
    path: "M3.428 3.4h3.429v3.428h3.429v3.429h-.002 3.431V6.828h3.427V3.4h3.43v13.714H24v3.429H13.714v-3.428h-3.428v-3.429h-3.43v3.428h3.43v3.429H0v-3.429h3.428V3.4zm10.286 13.715h3.428v-3.429h-3.427v3.429z"
  },
  google: {
    label: "Google",
    path: "M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"
  }
};

const vendorByModelId: Array<[RegExp, string]> = [
  [/^(gpt|chatgpt|o\d)/iu, "openai"],
  [/claude|opus|sonnet|haiku/iu, "anthropic"],
  [/mistral|codestral|magistral|pixtral/iu, "mistral"],
  [/gemini/iu, "google"]
];

/** Who makes a model: the vendor release config names, else what its model id suggests. */
export function modelVendor(model: Pick<AgentSelectableModel, "vendor" | "model">) {
  return (
    model.vendor?.toLowerCase() ??
    vendorByModelId.find(([pattern]) => pattern.test(model.model))?.[1]
  );
}

/** A vendor without a known logo keeps the name release config gave it. */
export function modelVendorLabel(model: Pick<AgentSelectableModel, "vendor" | "model">) {
  const vendor = modelVendor(model);
  return vendor ? (vendors[vendor]?.label ?? model.vendor) : undefined;
}

export function ModelVendorIcon({
  model,
  size = 16,
  className
}: {
  model: Pick<AgentSelectableModel, "vendor" | "model">;
  size?: number;
  className?: string;
}) {
  const vendor = vendors[modelVendor(model) ?? ""];
  if (!vendor) {
    return <Box size={size} className={className} aria-hidden="true" />;
  }
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      fillRule="evenodd"
      className={className}
      aria-hidden="true"
    >
      <path d={vendor.path} />
    </svg>
  );
}

// Twelve five-pointed stars on a circle, as on the flag.
const euStars = Array.from({ length: 12 }, (_, star) => {
  const angle = (star * Math.PI) / 6;
  const cx = 12 + 7.2 * Math.sin(angle);
  const cy = 12 - 7.2 * Math.cos(angle);
  return Array.from({ length: 10 }, (_, point) => {
    const radius = point % 2 === 0 ? 1.5 : 0.6;
    const pointAngle = (point * Math.PI) / 5;
    return `${(cx + radius * Math.sin(pointAngle)).toFixed(2)},${(cy - radius * Math.cos(pointAngle)).toFixed(2)}`;
  }).join(" ");
});

/** Marks a model whose provider processes data in the EU. */
export function EuResidencyBadge({ size = 16, label }: { size?: number; label: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className="shrink-0"
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <circle cx="12" cy="12" r="12" fill="#003399" />
      {euStars.map((points) => (
        <polygon key={points} points={points} fill="#ffcc00" />
      ))}
    </svg>
  );
}
