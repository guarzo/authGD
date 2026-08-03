/**
 * Prettier is configured to match the code that already exists, not the other
 * way round. Every non-default here was chosen by measuring the reformat churn
 * across src/, tests/, e2e/ and scripts/:
 *
 *   printWidth  files changed  lines changed
 *   80 (default)          88           2724
 *   85                    73           1798
 *   90                    63           1200   <- chosen
 *   100                   68           1081
 *
 * 90 matches how the codebase is already hand-wrapped (p99 line length is 95)
 * and touches the fewest files. Widening past 90 starts *re-joining* lines that
 * were deliberately broken for readability, which is churn in the wrong
 * direction.
 *
 * Everything else is Prettier's default, which the codebase already follows:
 * double quotes, semicolons, 2-space indent, trailing commas.
 */
export default {
  printWidth: 90,
};
