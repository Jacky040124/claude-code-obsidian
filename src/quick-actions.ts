export interface QuickAction {
  id: string;
  label: string;
  prompt: string; // {{selection}} placeholder
  mode: "replace" | "insert_after";
  enabled: boolean;
}

export const DEFAULT_QUICK_ACTIONS: QuickAction[] = [
  {
    id: "summarize",
    label: "Summarize",
    prompt: "Summarize the following text concisely. Return ONLY the summary:\n\n{{selection}}",
    mode: "insert_after",
    enabled: true,
  },
  {
    id: "rewrite",
    label: "Rewrite",
    prompt: "Rewrite the following text to be clearer and more concise. Return ONLY the rewritten text, no explanations:\n\n{{selection}}",
    mode: "replace",
    enabled: true,
  },
  {
    id: "fix_grammar",
    label: "Fix Grammar",
    prompt: "Fix grammar and spelling in the following text. Return ONLY the corrected text, no explanations:\n\n{{selection}}",
    mode: "replace",
    enabled: true,
  },
  {
    id: "translate_en",
    label: "Translate to English",
    prompt: "Translate the following text to English. Return ONLY the translation:\n\n{{selection}}",
    mode: "replace",
    enabled: true,
  },
  {
    id: "explain",
    label: "Explain",
    prompt: "Explain the following text in simple terms:\n\n{{selection}}",
    mode: "insert_after",
    enabled: true,
  },
];
