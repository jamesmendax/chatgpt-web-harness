// Runtime file retention shared by release staging and isolated tests.
// TypeScript's standard-library declarations are input data for the embedded
// Language Service, not disposable development declarations.
export function shouldPruneRuntimeFile(relativePath) {
  const rel = String(relativePath).replaceAll('\\', '/').toLowerCase();
  // Runtime diagnostics belong to the local run, never the distributable.
  if (rel.endsWith('.log')) return true;
  if (!rel.startsWith('node_modules/')) return false;
  const standardLibrary = /^node_modules\/typescript\/lib\/lib(?:\.[^/]+)?\.d\.ts$/.test(rel);
  if (standardLibrary) return false;
  return rel.endsWith('.map') || rel.endsWith('.d.ts');
}
