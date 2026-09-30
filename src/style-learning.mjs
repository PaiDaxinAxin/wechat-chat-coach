import { z } from 'zod';

const text = (maximum) => z.string().trim().max(maximum);
const id = z.string().trim().min(1).max(128);

export class StyleLearningError extends Error {
  constructor(code) { super(code); this.name = 'StyleLearningError'; this.code = code; }
}

export const StyleRuleInputSchema = z.strictObject({
  target: z.enum(['current_preference', 'growth_goal']),
  text: text(500).min(1),
  conditions: text(1_000).default(''),
  limits: text(1_000).default(''),
});

export const StyleReviewInputSchema = z.strictObject({
  counterpartId: id,
  suggestionId: id,
  ownVersion: text(5_000).min(1),
  why: text(2_000).default(''),
  reasonKind: z.enum(['style', 'strategy', 'fact', 'unknown']).default('unknown'),
  // Self-reported fit of the original AI suggestion's expression, not the
  // edited version's score or the counterpart's response/effectiveness.
  styleFit: z.enum(['like', 'mixed', 'unlike', 'unknown']).default('unknown'),
  // Willingness to try that expression does not establish an acquired trait.
  willingness: z.enum(['try', 'avoid', 'undecided']).default('undecided'),
});

const replacement = {
  rule: StyleRuleInputSchema,
  supersedesId: id.optional(),
};
export const StyleRuleChangeSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('propose'), ...replacement }),
  z.strictObject({ type: z.literal('adopt_new'), ...replacement }),
  z.strictObject({ type: z.literal('adopt'), candidateId: id }),
  z.strictObject({ type: z.literal('revoke'), ruleId: id }),
]);

export const StyleLearningInputSchema = z.strictObject({
  requestId: z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/),
  expectedRevision: z.number().int().nonnegative(),
  review: StyleReviewInputSchema.optional(),
  ruleChange: StyleRuleChangeSchema.optional(),
});

export const STYLE_REVIEW_VERSION = 'style-review-1';
export const MAX_ACTIVE_STYLE_RULES = 20;

// Caller supplies its own account's records. The projection deliberately omits
// cases, original replies, personal ratings, observations and source identities.
export function appliedPersonalStyle(rules, activeRevision) {
  if (!Array.isArray(rules) || !Number.isInteger(activeRevision) || activeRevision < 0) throw new StyleLearningError('INVALID_STYLE_LEARNING');
  const active = rules.filter((rule) => rule?.status === 'adopted');
  if (!active.length) return undefined;
  if (active.length > MAX_ACTIVE_STYLE_RULES) throw new StyleLearningError('STYLE_ACTIVE_LIMIT');
  const parsed = active.map((rule) => {
    const result = StyleRuleInputSchema.safeParse({ target: rule.target, text: rule.text, conditions: rule.conditions, limits: rule.limits });
    if (!result.success) throw new StyleLearningError('INVALID_STYLE_RULE');
    return result.data;
  });
  return { activeRevision, rules: parsed };
}

export function validateAppliedPersonalStyle(input) {
  const result = z.strictObject({ activeRevision: z.number().int().nonnegative(), rules: z.array(StyleRuleInputSchema).min(1).max(MAX_ACTIVE_STYLE_RULES) }).safeParse(input);
  if (!result.success) throw new StyleLearningError('INVALID_STYLE_LEARNING');
  return result.data;
}
