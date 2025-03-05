import Debug from "debug";
import * as estreeWalker from "estree-walker"; 
import * as estreeToJs from "estree-util-to-js";
import { VFileMessage } from "vfile-message";

// Use DEBUG=recma-jsx-if-for for debugging output
const debug = Debug("recma-jsx-if-for");
const debugFile = Debug("recma-jsx-if-for-file");
const debugTree = Debug("recma-jsx-if-for-tree");

const hideProps = ["type", "start", "end", "loc", "range"];

export default function recmaJsxIfFor() {
  return (tree, file) => {
    debugFile(debugFile.enabled && `\n📄 OLD ${file.path}\n${unparse(tree)}\n`);
    debugTree(debugTree.enabled && `\n🌳 OLD ${file.path}\n${pretty(tree)}`);

    estreeWalker.walk(tree, {
      leave(node, ...args) {
        const handler = nodeTypeHandlers[node.type];
        if (handler) handler.call(this, node, ...args);
      },
    });

    debugFile(debugFile.enabled && `\n📄 NEW ${file.path}\n${unparse(tree)}`);
    debugTree(debugTree.enabled && `\n🌳 NEW ${file.path}\n${pretty(tree)}`);
  }
}

const nodeTypeHandlers = {
  JSXElement: function(node, ...args) {
    if (node.openingElement.name.type === "JSXIdentifier") {
      const handler = elementNameHandlers[node.openingElement?.name?.name];
      if (handler) handler.call(this, node, ...args);
    }
  },

  CallExpression: function(node, parent, prop, index) {
    if (
      node.callee.type === "Identifier" &&
      node.callee.name === "_missingMdxReference" &&
      node.arguments.length >= 1 &&
      node.arguments[0].type === "Literal"
    ) {
      // MDX inserts code to check every referenced component name.
      // We've rewritten the elements away, but we have to nerf the check also.
      const arg = node.arguments[0].value;
      if (Object.keys(elementNameHandlers).includes(arg)) {
        debug("Disabling %s", unparse(node));
        this.replace({ type: "EmptyStatement" })
      }
    }
  },
};

const elementNameHandlers = {
  // Rewrite <$for var={name} of={expr}>...</$for>
  // to <>{(expr).map((name) => <>...</>)}</>
  $for: function(node, parent) {
    const open = node.openingElement;
    const nodeContext = [parent, node, open];
    debug("Rewriting %s", debug.enabled && unparse(open));
    const { var: varAttr, of: ofAttr, ...extraAttrs } = Object.fromEntries(
      open.attributes.map(a => [a.name.name, a])
    );
    if (varAttr?.value?.type !== "JSXExpressionContainer") {
      fail(`Need var={name} in ${unparse(open)}`, nodeContext);
    }
    if (ofAttr?.value?.type !== "JSXExpressionContainer") {
      fail(`Need of={expression} in ${unparse(open)}`, nodeContext);
    }
    if (Object.keys(extraAttrs).length > 0) {
      const attr = extraAttrs[Object.keys(extraAttrs)[0]];
      fail(`Bad attribute in ${unparse(open)}`, [...nodeContext, attr]);
    }

    const varContext = [...nodeContext, varAttr];
    const newExpr = {
      type: "CallExpression",
      callee: {
        type: "MemberExpression",
        object: ofAttr.value.expression,
        property: { type: "Identifier", name: "map" },
      },
      arguments: [{
        type: "ArrowFunctionExpression",
        id: null,
        expression: true,
        params: [patternFromExpr(varAttr.value.expression, varContext)],
        body: wrapNodesForExpr(node.children),
      }],
    };

    this.replace(wrapExprForParent(newExpr, parent));
  },

  // Rewrite <$if test={expr}>...</$if> to <>{(expr) ? <>...</> : null}</>
  $if: function(node, parent, prop, index) {
    const chain = [node];

    if (parent && prop && index >= 0) {
      var pi = index + 1;
      debug("CHECKING %s", parent[prop][pi]?.openingElement?.name?.name);
      while (parent[prop][pi]?.openingElement?.name?.name === "$else-if") ++pi;
      if (parent[prop][pi]?.openingElement?.name?.name === "$else") ++pi;
      chain.push(...parent[prop].splice(index + 1, pi - (index + 1)));
    }

    debug(
      "Rewriting if-chain:\n  %s",
      debug.enabled && chain.map(n => unparse(n.openingElement)).join("\n  ")
    );

    var newExpr = { type: "Literal", value: null };

    for (var cond of chain.reverse()) {
      const open = cond.openingElement;
      const condContext = [parent, cond, open];
      const { test: testAttr, ...extraAttrs } = Object.fromEntries(
        open.attributes.map(a => [a.name.name, a])
      );
      if (Object.keys(extraAttrs).length > 0) {
        const attr = extraAttrs[Object.keys(extraAttrs)[0]];
        fail(`Bad attribute in ${unparse(open)}`, [...condContext, attr], attr);
      }

      if (["$if", "$else-if"].includes(cond.openingElement.name.name)) {
        if (testAttr?.value?.type !== "JSXExpressionContainer") {
          fail(`Need test={expression} in ${unparse(open)}`, condContext);
        }
        newExpr = {
          type: "ConditionalExpression",
          test: testAttr.value.expression,
          consequent: wrapNodesForExpr(cond.children),
          alternate: newExpr,
        };
      } else if (cond.openingElement.name.name === "$else") {
        if (testAttr) {
          fail(`Unexpected test=... in ${unparse(open)}`, condContext);
        }
        newExpr = wrapNodesForExpr(cond.children);
      } else {
        assert(false, `Bad element ${unparse(cond)}`);
      }
    }

    this.replace(wrapExprForParent(newExpr, parent));
  },

  "$else-if": function(node, parent, prop, index) {
    const open = node.openingElement;
    fail(`Need preceding <$if> for ${unparse(open)}`, [parent, node, open]);
  },

  "$else": function(node, parent, prop, index) {
    const open = node.openingElement;
    fail(`Need preceding <$if> for ${unparse(open)}`, [parent, node, open]);
  },

  // Rewrite <$let var={name} value={expr}/>...</$let>
  // to <>{((name) => <>...</>)((expr))}</>
  $let: function(node, parent) {
    const open = node.openingElement;
    debug("Rewriting %s", debug.enabled && unparse(open));

    const nodeContext = [parent, node, open];
    const { var: varAttr, value: valAttr, ...extraAttrs } = Object.fromEntries(
      open.attributes.map(a => [a.name.name, a])
    );
    if (varAttr?.value?.type !== "JSXExpressionContainer") {
      fail(`Need var={name} in ${unparse(open)}`, nodeContext);
    }
    if (valAttr?.value?.type !== "JSXExpressionContainer") {
      fail(`Need value={expression} in ${unparse(open)}`, nodeContext);
    }
    if (Object.keys(extraAttrs).length > 0) {
      const attr = extraAttrs[Object.keys(extraAttrs)[0]];
      fail(`Bad attribute in ${unparse(open)}`, [...nodeContext, attr]);
    }

    const varContext = [...nodeContext, varAttr];
    const newExpr = {
      type: "CallExpression",
      callee: {
        type: "ArrowFunctionExpression",
        expression: true,
        params: [patternFromExpr(varAttr.value.expression, varContext)],
        body: wrapNodesForExpr(node.children),
      },
      arguments: [valAttr.value.expression],
    };

    this.replace(wrapExprForParent(newExpr, parent));
  },
};

function patternFromExpr(node, context = []) {
  if (node.type === "Identifier") {
    return node;
  } else {
    fail(`Bad variable pattern ${unparse(node)}`, [...context, node]);
  }
}

function wrapExprForParent(node, parent) {
  const exprNode = {
    type: "JSXExpressionContainer",
    expression: node,
  };

  if (parent.type.startsWith("JSX")) {
    return exprNode;
  } else {
    return {
      type: "JSXFragment",
      openingFragment: { type: "JSXOpeningFragment" },
      children: [exprNode],
      closingFragment: { type: "JSXClosingFragment" },
    };
  }
}

function wrapNodesForExpr(nodes) {
  if (nodes.length == 1 && !nodes[0].type.startsWith("JSX")) {
    return nodes[0];
  } else {
    return {
      type: "JSXFragment",
      openingFragment: { type: "JSXOpeningFragment" },
      children: nodes,
      closingFragment: { type: "JSXClosingFragment" },
    };
  }
}

function fail(text, context = []) {
  var place;
  for (var node of context.reverse()) {
    if (node.loc) {
      place = { start: { ...node.loc.start }, end: { ...node.loc.end } };
      if (node.range) [place.start.offset, place.end.offset] = node.range;
      break;
    }
  }
  const message = new VFileMessage(text, { place, source: debug.namespace });
  message.fatal = true;
  throw message;
}

function unparse(tree) {
  return estreeToJs.toJs(tree, { handlers: estreeToJs.jsx }).value;
}

function pretty(tree, pre = "") {
  if (Array.isArray(tree)) {
    if (tree.length == 0) return "[]\n";
    return "\n" + tree.map((item, i) =>
      `${pre}  #${i} ${pretty(item, `${pre}  `)}`
    ).join("");
  } else if (typeof tree === "object" && tree) {
    return `${tree.type ? `[${tree.type}]` : ""}\n` +
      Object.entries(tree)
        .filter(([key, value]) => !hideProps.includes(key))
        .map(([k, v]) => `${pre}  ${k}: ${pretty(v, `${pre}  `)}`)
        .join("");
  } else {
    return JSON.stringify(tree) + "\n";
  }
}
