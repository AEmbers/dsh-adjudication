/**
 * backend-engineering — P5 anchor verifier (contract v2, extension point 2).
 *
 * THIS FILE IS A RE-EXPORT, AND THAT IS THE DELIVERABLE
 * ----------------------------------------------------
 * The task's requirement is explicit: the diff-based domains must REUSE
 * code-review's diff anchor rather than build a second one. So this module does
 * not contain a matcher, a normaliser or a degradation ladder — it hands back
 * the reference verifier, object-identical, and says so here.
 *
 * Why not copy it: the anchor is the one component whose looseness is invisible.
 * A second implementation that tolerated one more character would raise the
 * anchor rate of this domain and nobody would see it in a diff. One
 * implementation, one tolerance, one place to audit.
 *
 * The domain's own contribution to P5 is in `index.js` (`anchor.kind` is
 * `diff-line`, the same kind) and in its rules: what a backend reviewer looks
 * for is different, but WHERE a claim may point is not. `test.mjs` asserts the
 * identity (`anchor === codeReviewAnchor`), so a future "small improvement"
 * made only here fails the domain's own test instead of passing silently.
 */

import codeReviewAnchor, { allMatches, matchesAt } from '../code-review/anchor.js'

/** The file this verifier is reused from — asserted by `test.mjs`. */
export const REUSED_FROM = '../code-review/anchor.js'

/** Re-exported so the domain's tests and evidence tools use the same matcher. */
export { allMatches, matchesAt }

/** The reference verify function, object-identical. */
export const verify = codeReviewAnchor.verify

export default codeReviewAnchor
