import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const FORBIDDEN_SYMBOL_NAME = "shape";

function containsForbiddenSymbolName(name: string): boolean {
  return name.toLowerCase().includes(FORBIDDEN_SYMBOL_NAME);
}

/** Ban the case-insensitive substring "shape" in every JavaScript and TypeScript symbol name. */
export const noForbiddenTermInSymbolNamesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        'Disallow the case-insensitive substring "shape" in JavaScript, TypeScript, private, and JSX symbol names.',
    },
    messages: {
      forbiddenSymbolName:
        'Rename symbol "{{name}}" for its domain role; "shape" describes structure rather than ownership.',
    },
  },
  createOnce(context) {
    const reportForbiddenSymbolName = (node: ESTree.Node & { name: string }) => {
      if (!containsForbiddenSymbolName(node.name)) return;
      context.report({
        node,
        messageId: "forbiddenSymbolName",
        data: { name: node.name },
      });
    };

    return {
      Identifier(node) {
        const { parent } = node;
        // A property read/write off an external value (e.g. an SDK's
        // response.shapeId) or an imported name isn't a symbol this
        // codebase declares, so it can't be renamed here.
        if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) {
          return;
        }
        if (parent.type === "ImportSpecifier" && parent.imported === node) return;
        reportForbiddenSymbolName(node);
      },
      PrivateIdentifier: reportForbiddenSymbolName,
      JSXIdentifier(node) {
        // JSX attribute names are dictated by the component they're passed
        // to, not a symbol this codebase declares — e.g. a UI library's
        // `shape` prop can't be renamed by its consumer.
        if (node.parent.type === "JSXAttribute") return;
        reportForbiddenSymbolName(node);
      },
    };
  },
});
