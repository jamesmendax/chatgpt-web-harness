/** Structural freeze guard for A1.0 Skill routing benchmark cohorts.
 *
 * This checks ONLY completeness and policy/content immutability of catalogues.
 * It cannot authenticate ChatGPT conversations, attest human prompt origins or
 * award routing accuracy; those require a separately trusted Host capture.
 */
const SHA256 = /^[0-9a-f]{64}$/;
const fail = (code, message) => { throw new Error(`${code}: ${message}`); };

export function normalizeSkillCatalogue(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    fail("A10_CATALOG_INVALID", "catalog snapshot must be an object");
  }
  const sha = snapshot.catalog_sha256;
  const count = snapshot.skill_count ?? snapshot.total;
  const rows = snapshot.skills;
  if (typeof sha !== "string" || !SHA256.test(sha)) {
    fail("A10_CATALOG_INVALID", "missing catalog_sha256 fingerprint");
  }
  if (!Number.isInteger(count) || count < 1 || !Array.isArray(rows) || rows.length !== count ||
      (snapshot.next_offset !== undefined && snapshot.next_offset !== null)) {
    fail("A10_CATALOG_INCOMPLETE", "all catalogue pages and exact count are required");
  }
  const seen = new Set();
  const entries = rows.map((skill) => {
    const id = skill?.id;
    const content_sha256 = skill?.content_sha256;
    const allow_implicit = skill?.allow_implicit ?? skill?.invocation_policy?.allow_implicit;
    const allow_explicit = skill?.allow_explicit ?? skill?.invocation_policy?.allow_explicit;
    if (typeof id !== "string" || !id || seen.has(id)) {
      fail("A10_CATALOG_INCOMPLETE", "duplicate or missing Skill ID");
    }
    seen.add(id);
    if (typeof content_sha256 !== "string" || !SHA256.test(content_sha256) ||
        typeof allow_implicit !== "boolean" || typeof allow_explicit !== "boolean" ||
        (!allow_implicit && !allow_explicit)) {
      fail("A10_CATALOG_INVALID", `missing content/policy fingerprint for ${id}`);
    }
    return { id, content_sha256, allow_implicit, allow_explicit };
  }).sort((a, b) => a.id.localeCompare(b.id));
  return { catalog_sha256: sha, skill_count: count, skills: entries };
}

export function checkSkillBenchmarkCohort(frozen, before, after) {
  const reference = normalizeSkillCatalogue(frozen);
  const prior = normalizeSkillCatalogue(before);
  const later = normalizeSkillCatalogue(after);
  for (const sample of [prior, later]) {
    if (sample.catalog_sha256 !== reference.catalog_sha256 ||
        sample.skill_count !== reference.skill_count) {
      fail("A10_CATALOG_DRIFT", "trial catalogue is not the frozen cohort version");
    }
    // Even a buggy or malicious provider that reuses the old top-level hash
    // must not get a PASS after replacing a Skill file or invocation policy.
    if (JSON.stringify(sample.skills) !== JSON.stringify(reference.skills)) {
      fail("A10_CATALOG_MEMBER_MISMATCH", "skill content or policy changed under a stale catalogue hash");
    }
  }
  return {
    status: "CATALOG_MATCHED_ONLY",
    catalog_sha256: reference.catalog_sha256,
    skill_count: reference.skill_count,
    independent_conversation_verified: false,
    model_trial_accepted: false,
    next_required: "Authenticated Host-independent conversation receipt and real load/selection records; not a string supplied by a model or file.",
  };
}
