/** A vendor's model id as people read it: `gpt-5.6-sol` becomes "GPT-5.6 Sol". */
function formatModelLabel(model: string): string {
  return model.replace(/^gpt-/iu, "GPT-").replace(/-(sol|terra|luna)$/iu, (_, tier: string) => {
    return ` ${tier.charAt(0).toUpperCase()}${tier.slice(1).toLowerCase()}`;
  });
}

/**
 * The name people read for a model: the one release config gives it, else its model id tidied
 * up. A deployment name an operator chose, as on Azure, says nothing to a reader, so release
 * config names such a model.
 */
export function modelDisplayLabel(model: { label?: string; model: string }): string {
  return model.label ?? formatModelLabel(model.model);
}
