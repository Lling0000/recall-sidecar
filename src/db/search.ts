import type { MemoryCard } from "../types.js";

const CJK_SEQUENCE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const WORD = /[\p{L}\p{N}_-]{3,}/gu;

function cjkNgrams(value: string): string[] {
  const characters = Array.from(value);
  const result: string[] = [];
  for (const width of [2, 3]) {
    for (let index = 0; index + width <= characters.length; index += 1) {
      result.push(characters.slice(index, index + width).join(""));
    }
  }
  return result;
}

export function searchTokens(input: string): string[] {
  const tokens: string[] = [];
  for (const match of input.matchAll(CJK_SEQUENCE)) {
    if (match[0]) tokens.push(...cjkNgrams(match[0]));
  }
  for (const match of input.toLocaleLowerCase().matchAll(WORD)) {
    if (match[0]) tokens.push(match[0]);
  }
  return [...new Set(tokens)].slice(0, 32);
}

export function safeFtsQuery(input: string): string | null {
  const tokens = searchTokens(input);
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
}

export function searchableCardText(card: MemoryCard): string {
  const text = [
    card.kind,
    card.title,
    card.knowledge,
    card.rationale,
    card.applicability,
  ].join(" ");
  return `${text} ${searchTokens(text).join(" ")}`;
}
