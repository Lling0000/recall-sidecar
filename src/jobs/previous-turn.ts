const REFERENCE_PHRASES = [
  "还是不对",
  "刚才那个",
  "换一种",
  "不对",
  "不是这样",
  "再改一下",
  "try again",
] as const;

export function shouldIncludePreviousTurn(prompt: string): boolean {
  const compact = prompt.replace(/\s/gu, "");
  if (Array.from(compact).length <= 40) return true;
  const normalized = prompt.toLocaleLowerCase();
  return REFERENCE_PHRASES.some((phrase) => normalized.includes(phrase));
}
