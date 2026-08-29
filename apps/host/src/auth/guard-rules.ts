/**
 * Which credential a route expects.
 *
 * Naming the principal rather than listing "open" paths is the difference
 * between a route that is unauthenticated and one that is authenticated by
 * something other than an operator cookie. `/ws/node` and `/mcp` were both in
 * the second group and were both handled by an early `return`, which reads
 * identically to having no rule at all.
 */
export type GuardPrincipal =
  | "anonymous"
  | "bootstrap"
  | "transaction"
  | "operator"
  | "node-protocol"
  | "enrollment"
  | "lead";

export type GuardRule = {
  method: string | "*";
  pattern: RegExp;
  principal: GuardPrincipal;
};

/**
 * Ordered, method-aware, and anchored.
 *
 * Anchoring matters: the set this replaces compared whole strings, so adding a
 * parameterized route meant either listing every id or leaving it out — and
 * leaving it out is how `/api/auth/device/poll/<flowId>` would have ended up
 * behind an operator cookie it cannot have yet. Matching on a prefix instead
 * would open `/api/health/secrets` along with `/api/health`.
 */
export const GUARD_RULES: readonly GuardRule[] = [
  { method: "GET", pattern: /^\/api\/health$/, principal: "anonymous" },
  { method: "GET", pattern: /^\/api\/auth\/status$/, principal: "anonymous" },
  { method: "POST", pattern: /^\/api\/auth\/bootstrap$/, principal: "anonymous" },
  { method: "POST", pattern: /^\/api\/auth\/configure$/, principal: "bootstrap" },
  { method: "POST", pattern: /^\/api\/auth\/code\/start$/, principal: "anonymous" },
  { method: "GET", pattern: /^\/api\/auth\/entra\/callback$/, principal: "transaction" },
  { method: "POST", pattern: /^\/api\/auth\/device\/start$/, principal: "anonymous" },
  {
    method: "POST",
    pattern: /^\/api\/auth\/device\/poll\/[^/]+$/,
    principal: "transaction",
  },
  { method: "POST", pattern: /^\/api\/auth\/login$/, principal: "anonymous" },
  /*
   * A portable restore is the one operation whose principal depends on the
   * Host's own state: a claimed Host asks one of its administrators, and a
   * Host nobody owns has nobody to ask and takes the console claim code
   * instead. The guard cannot know which, so — like the login routes it sits
   * beside — the rule here only establishes that the name and origin checks
   * still apply, and the route states the proof it needs.
   */
  {
    method: "POST",
    pattern: /^\/api\/backup\/portable\/import$/,
    principal: "anonymous",
  },
  { method: "GET", pattern: /^\/ws\/node$/, principal: "node-protocol" },
  {
    method: "POST",
    pattern: /^\/api\/nodes\/enrollment\/challenge$/,
    principal: "enrollment",
  },
  { method: "POST", pattern: /^\/api\/nodes\/register$/, principal: "enrollment" },
  { method: "POST", pattern: /^\/mcp$/, principal: "lead" },
];

/**
 * The principal a request must satisfy.
 *
 * Everything unmatched is an operator route. That default is the point: a route
 * added tomorrow is protected by having been added, not by somebody remembering
 * to protect it.
 */
export function requiredPrincipal(method: string, pathname: string): GuardPrincipal {
  const wanted = method.toUpperCase();
  for (const rule of GUARD_RULES) {
    if (rule.method !== "*" && rule.method !== wanted) continue;
    if (rule.pattern.test(pathname)) return rule.principal;
  }
  return "operator";
}

/** Methods that change something, and therefore need a CSRF proof. */
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isStateChanging(method: string): boolean {
  return UNSAFE_METHODS.has(method.toUpperCase());
}
