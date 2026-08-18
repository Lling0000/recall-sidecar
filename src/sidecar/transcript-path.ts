import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative } from "node:path";

function isInside(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

export async function validateTranscriptPath(
  path: string,
  sessionId: string,
  allowedRoots: readonly string[],
): Promise<string> {
  const canonicalPath = await realpath(path);
  const info = await stat(canonicalPath);
  if (!info.isFile() || !canonicalPath.endsWith(".jsonl")) {
    throw new Error("invalid_transcript_file");
  }
  if (!basename(canonicalPath).includes(sessionId)) {
    throw new Error("transcript_session_mismatch");
  }
  for (const root of allowedRoots) {
    const canonicalRoot = await realpath(root);
    if (isInside(canonicalRoot, canonicalPath)) return canonicalPath;
  }
  throw new Error("transcript_outside_allowed_roots");
}
