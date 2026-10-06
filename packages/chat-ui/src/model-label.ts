/** Display label for a model id, shared by the chat model selector and the agent editor. */
export function formatModelLabel(model: string): string {
  return model.replace(/^gpt-/iu, "GPT-").replace(/-(sol|terra|luna)$/iu, (_, tier: string) => {
    return ` ${tier.charAt(0).toUpperCase()}${tier.slice(1).toLowerCase()}`;
  });
}
