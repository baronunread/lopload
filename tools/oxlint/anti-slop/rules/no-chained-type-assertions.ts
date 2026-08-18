import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

type TypeAssertionExpression = ESTree.TSAsExpression | ESTree.TSTypeAssertion;

function isTypeAssertionExpression(node: ESTree.Node): node is TypeAssertionExpression {
  return node.type === "TSAsExpression" || node.type === "TSTypeAssertion";
}

function unwrapParenthesizedExpression(expression: ESTree.Expression): ESTree.Expression {
  let current = expression;
  while (current.type === "ParenthesizedExpression") {
    current = current.expression;
  }
  return current;
}

function isConstAssertion(node: TypeAssertionExpression): boolean {
  const { typeAnnotation } = node;
  return (
    typeAnnotation.type === "TSTypeReference" &&
    typeAnnotation.typeName.type === "Identifier" &&
    typeAnnotation.typeName.name === "const"
  );
}

/** `x as unknown as T` (or `as any as T`) is TypeScript's sanctioned bridge
 * between two structurally-unrelated types — e.g. coercing a plain object
 * literal into a class with private fields for a test double. That's a
 * single controlled hop through the top type, not a chain of narrowing
 * steps discarding real evidence, so it's exempted; anything deeper, or a
 * two-hop chain not going through unknown/any, still isn't. */
function isTopTypeAssertion(node: TypeAssertionExpression): boolean {
  const { typeAnnotation } = node;
  return typeAnnotation.type === "TSUnknownKeyword" || typeAnnotation.type === "TSAnyKeyword";
}

function isUnknownBridgeChain(node: TypeAssertionExpression): boolean {
  if (node.type !== "TSAsExpression" && node.type !== "TSTypeAssertion") return false;
  const inner = unwrapParenthesizedExpression(node.expression);
  if (!isTypeAssertionExpression(inner)) return false;
  if (!isTopTypeAssertion(inner)) return false;
  const innermost = unwrapParenthesizedExpression(inner.expression);
  return !isTypeAssertionExpression(innermost);
}

function isOutermostAssertionInChain(node: TypeAssertionExpression): boolean {
  let current: ESTree.Expression = node;
  let parent = node.parent;

  while (parent.type === "ParenthesizedExpression" && parent.expression === current) {
    current = parent;
    parent = parent.parent;
  }

  return !isTypeAssertionExpression(parent) || parent.expression !== current;
}

function isForbiddenAssertionChain(node: TypeAssertionExpression): boolean {
  let assertionCount = 0;
  let hasNonConstAssertion = false;
  let current: ESTree.Expression = node;

  while (isTypeAssertionExpression(current)) {
    assertionCount += 1;
    hasNonConstAssertion ||= !isConstAssertion(current);
    current = unwrapParenthesizedExpression(current.expression);
  }

  return assertionCount > 1 && hasNonConstAssertion;
}

/** Disallow nested TypeScript type assertions, while permitting chains made only of const assertions. */
export const noChainedTypeAssertionsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow chained TypeScript as and angle-bracket assertions, including parenthesized chains.",
    },
    messages: {
      chained:
        "This assertion chain discards type evidence. Keep the original precise type, or parse untrusted input at its boundary before narrowing it.",
    },
  },
  createOnce(context) {
    const checkTypeAssertion = (node: TypeAssertionExpression) => {
      if (!isOutermostAssertionInChain(node) || !isForbiddenAssertionChain(node)) return;
      if (isUnknownBridgeChain(node)) return;
      context.report({ node, messageId: "chained" });
    };

    return {
      TSAsExpression: checkTypeAssertion,
      TSTypeAssertion: checkTypeAssertion,
    };
  },
});
