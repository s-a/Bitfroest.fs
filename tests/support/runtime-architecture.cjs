const { Linter } = require('eslint');

function staticString(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'BinaryExpression' && node.operator === '+') {
    const left = staticString(node.left), right = staticString(node.right);
    if (left !== undefined && right !== undefined) return left + right;
  }
  if (node?.type === 'TemplateLiteral' && !node.expressions.length) return node.quasis[0].value.cooked;
  return undefined;
}

function memberName(node) {
  return node.computed ? staticString(node.property) : node.property.name;
}

function isProcess(node) {
  return node.type === 'Identifier' && node.name === 'process' || node.type === 'MemberExpression' && memberName(node) === 'process' && node.object.type === 'Identifier' && node.object.name === 'globalThis';
}

const rule = {
  meta: { schema: [], messages: { violation: '{{reason}}' } },
  create(context) {
    const report = (node, reason) => context.report({ node, messageId: 'violation', data: { reason } });
    function checkModule(node, source) {
      const name = staticString(source);
      if (name === undefined) report(node, 'Dynamic module loading prevents runtime verification.');
      else if (/^(?:node:)?(?:child_process|module|vm)$/.test(name)) report(node, `External execution or opaque loader access is forbidden: ${name}.`);
    }
    function checkCall(node) {
      const callee = node.callee;
      if (callee.type === 'Identifier' && callee.name === 'require' || callee.type === 'MemberExpression' && memberName(callee) === 'require') checkModule(node, node.arguments[0]);
      if (callee.type === 'Identifier' && ['eval', 'Function'].includes(callee.name)) report(node, 'Runtime code generation prevents execution-policy verification.');
    }
    return {
      ImportDeclaration: node => checkModule(node, node.source),
      ExportNamedDeclaration: node => { if (node.source) checkModule(node, node.source); },
      ExportAllDeclaration: node => checkModule(node, node.source),
      ImportExpression: node => checkModule(node, node.source),
      CallExpression: checkCall,
      NewExpression: checkCall,
      Identifier(node) {
        if (node.name !== 'require') return;
        const parent = node.parent;
        const call = parent.type === 'CallExpression' && parent.callee === node;
        const availability = parent.type === 'UnaryExpression' && parent.operator === 'typeof';
        const property = parent.type === 'MemberExpression' && parent.property === node && !parent.computed;
        if (!call && !availability && !property) report(node, 'Aliasing the module loader prevents runtime verification.');
      },
      MemberExpression(node) {
        const name = memberName(node);
        if (isProcess(node.object) && ['binding', '_linkedBinding', 'getBuiltinModule', 'dlopen', 'mainModule'].includes(name)) report(node, 'Direct runtime loader access is forbidden.');
        if (name === 'require' && !(node.parent.type === 'CallExpression' && node.parent.callee === node)) report(node, 'Aliasing the module loader prevents runtime verification.');
      }
    };
  }
};

function inspectRuntimeSource(source, filename) {
  const linter = new Linter();
  return linter.verify(source, [{
    files: ['**/*.{js,cjs,mjs}'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    plugins: { runtime: { rules: { 'no-external-execution': rule } } },
    rules: { 'runtime/no-external-execution': 'error' }
  }], { filename, allowInlineConfig: false }).map(message => ({
    file: filename, line: message.line || 1, message: message.message
  }));
}

module.exports = { inspectRuntimeSource };
