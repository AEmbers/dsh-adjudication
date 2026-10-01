/**
 * frontend-engineering — P5 anchor verifier (contract v2, extension point 2).
 *
 * A RE-EXPORT, DELIBERATELY — see `domains/backend-engineering/anchor.js` for
 * the full argument. The short version: the diff anchor's TOLERANCE (strip the
 * diff marker, ignore whitespace, everything else literal) is the one property
 * that must not differ between two domains that both claim the `diff-line`
 * anchor. A second implementation would raise this domain's anchor rate by
 * exactly the amount of the extra looseness, and nothing in review would show it.
 *
 * What IS domain-specific lives in `index.js` (the anchor kind, unchanged) and
 * in the rules: a frontend reviewer asks different questions, but a claim may
 * point at exactly the same thing.
 */

import codeReviewAnchor, { allMatches, matchesAt } from '../code-review/anchor.js'

/** The file this verifier is reused from — asserted by `test.mjs`. */
export const REUSED_FROM = '../code-review/anchor.js'

export { allMatches, matchesAt }

/** The reference verify function, object-identical. */
export const verify = codeReviewAnchor.verify

export default codeReviewAnchor
