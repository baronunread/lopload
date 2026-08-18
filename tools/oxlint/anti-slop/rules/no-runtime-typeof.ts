import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

type RuntimeFunction = ESTree.ArrowFunctionExpression | ESTree.Function;

function isRuntimeFunction(node: ESTree.Node): node is RuntimeFunction {
	return (
		node.type === "ArrowFunctionExpression" ||
		node.type === "FunctionDeclaration" ||
		node.type === "FunctionExpression"
	);
}

function isInsideTypeGuard(node: ESTree.Node): boolean {
	let current: ESTree.Node | null = node.parent;
	while (current !== null && current.type !== "Program") {
		if (isRuntimeFunction(current)) {
			return current.returnType?.typeAnnotation.type === "TSTypePredicate";
		}
		current = current.parent;
	}
	return false;
}

const NARROWING_OPERATORS = new Set(["===", "!==", "==", "!="]);

/** True when this `typeof x` is used to branch/narrow (a comparison, or
 * directly as a condition) rather than as a plain value — e.g. returned or
 * logged. Only the former discards a caller's ability to decode the value
 * properly; reading `typeof x` as a diagnostic string is introspection, not
 * an ad-hoc representation check. */
function isNarrowingUse(node: ESTree.Node): boolean {
	const { parent } = node;
	if (parent.type === "BinaryExpression" && NARROWING_OPERATORS.has(parent.operator)) return true;
	if (parent.type === "SwitchStatement" && parent.discriminant === node) return true;
	if (
		(parent.type === "IfStatement" ||
			parent.type === "ConditionalExpression" ||
			parent.type === "WhileStatement" ||
			parent.type === "DoWhileStatement") &&
		parent.test === node
	) {
		return true;
	}
	if (parent.type === "LogicalExpression") return isNarrowingUse(parent);
	if (parent.type === "UnaryExpression" && parent.operator === "!") return isNarrowingUse(parent);
	return false;
}

/** Disallow runtime typeof checks that narrow unparsed values instead of decoding them. */
export const noRuntimeTypeofRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow runtime typeof checks; external values must be decoded into meaningful types at their I/O boundary.",
		},
		messages: {
			runtimeTypeof:
				"A `typeof` check narrows a representation without establishing its contract. Parse input at its I/O boundary, then branch on the domain value.",
		},
		schema: [
			{
				type: "object",
				properties: {
					allowInTypeGuards: { type: "boolean" },
				},
				additionalProperties: false,
			},
		],
		defaultOptions: [{ allowInTypeGuards: false }],
	},
	createOnce(context) {
		return {
			UnaryExpression(node) {
				const option = context.options?.[0];
				const allowInTypeGuards =
					typeof option === "object" &&
					option !== null &&
					!Array.isArray(option) &&
					option.allowInTypeGuards === true;
				if (
					node.operator === "typeof" &&
					isNarrowingUse(node) &&
					(!allowInTypeGuards || !isInsideTypeGuard(node))
				) {
					context.report({ node, messageId: "runtimeTypeof" });
				}
			},
		};
	},
});
