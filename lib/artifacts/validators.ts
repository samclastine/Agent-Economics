export const ALLOWED_ARTIFACT_PATHS = [
  '/brief.md', '/checklist.md',
  '/report.md', '/analysis.md',
  '/README.md', '/src/App.tsx', '/preview.html',
  '/openapi.yaml', '/src/server.ts', '/tests/report.md',
] as const;
export type ArtifactPath = (typeof ALLOWED_ARTIFACT_PATHS)[number];

/**
 * A423 jobs may name their own deliverable (for example
 * `research-report.md` or `/artifacts/research-report.md`) instead of using
 * one of the fixed template paths. Accept those names only when they
 * are a single safe file name (optionally under /artifacts/) with a known
 * extension; never accept traversal or arbitrary directories.
 */
const SAFE_A423_PATH = /^\/?(?:artifacts\/)?[A-Za-z0-9][A-Za-z0-9._-]*\.(?:md|txt|json|html|tsx|ts|yaml)$/;

export function isAllowedPath(path: string): path is ArtifactPath {
  return (ALLOWED_ARTIFACT_PATHS as readonly string[]).includes(path) || SAFE_A423_PATH.test(path);
}

export function validateArtifact(input: {
  path: string;
  content: string;
  acceptanceSpec?: Record<string, unknown>;
}): { passed: boolean; checks: { name: string; passed: boolean; detail?: string }[] } {
  const checks: { name: string; passed: boolean; detail?: string }[] = [];
  const spec = input.acceptanceSpec ?? {};
  const content = input.content ?? '';

  checks.push({
    name: 'allowed_path',
    passed: isAllowedPath(input.path),
    detail: input.path,
  });

  const expectedPath = (spec.path as string) ?? input.path;
  checks.push({
    name: 'expected_path',
    passed: input.path === expectedPath,
    detail: `expected ${expectedPath}`,
  });

  const words = content.trim().split(/\s+/).filter(Boolean).length;
  const minWords = (spec.minWords as number) ?? 0;
  const maxWords = (spec.maxWords as number) ?? Infinity;
  checks.push({
    name: 'word_count',
    passed: words >= minWords && words <= maxWords,
    detail: `${words} words (want ${minWords}-${maxWords === Infinity ? '∞' : maxWords})`,
  });

  for (const section of (spec.requiredSections as string[]) ?? []) {
    const re = new RegExp(`^#+\\s*${section}`, 'im');
    checks.push({
      name: `section:${section}`,
      passed: re.test(content),
      detail: section,
    });
  }

  const numberedSteps = (spec.requiredNumberedItems as number) ?? 0;
  if (numberedSteps > 0) {
    const matches = content.match(/^\s*\d+[.)]\s+/gm) ?? [];
    checks.push({
      name: 'numbered_items',
      passed: matches.length === numberedSteps,
      detail: `${matches.length} found, want ${numberedSteps}`,
    });
  }

  const minLen = (spec.minChars as number) ?? 0;
  checks.push({
    name: 'min_chars',
    passed: content.length >= minLen,
    detail: `${content.length} chars`,
  });

  return { passed: checks.every((c) => c.passed), checks };
}
