const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/gu;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu;
const PAT =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,})\b/gu;
const LONG_TOKEN = /\b[A-Za-z0-9_-]{40,}\b/gu;

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  let result = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    result -= probability * Math.log2(probability);
  }
  return result;
}

function redactHighEntropy(value: string): string {
  return value.replace(LONG_TOKEN, (token) => {
    const hasLetters = /[A-Za-z]/u.test(token);
    const hasNumbers = /[0-9]/u.test(token);
    return hasLetters && hasNumbers && entropy(token) >= 3.5
      ? "[REDACTED_HIGH_ENTROPY_KEY]"
      : token;
  });
}

export function redactSecrets(value: string): string {
  return redactHighEntropy(
    value
      .replace(PEM_BLOCK, "[REDACTED_PEM]")
      .replace(JWT, "[REDACTED_JWT]")
      .replace(PAT, "[REDACTED_PAT]"),
  );
}
