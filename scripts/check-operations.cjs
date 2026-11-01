const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const contract = path.join(root, 'media/commander-jobs.d.ts');

function check(files, overrides = new Map()) {
  const options = { allowJs: true, checkJs: true, noEmit: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS, skipLibCheck: true, types: [] };
  const host = ts.createCompilerHost(options), read = host.readFile;
  host.readFile = file => overrides.get(path.resolve(file)) ?? read(file);
  const program = ts.createProgram([contract, ...files], options, host), checker = program.getTypeChecker();
  const symbols = checker.getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(contract)));
  const declared = name => checker.getDeclaredTypeOfSymbol(symbols.find(symbol => symbol.name === name));
  const input = declared('OperationInput'), registry = declared('CommandRegistry'), actions = declared('ActionCommands'), errors = [];
  for (const file of files) {
    const source = program.getSourceFile(file); if (!source) continue;
    const diagnostics = program.getSemanticDiagnostics(source);
    function fail(node, message) { const point = source.getLineAndCharacterOfPosition(node.getStart()); errors.push(`${path.relative(root, file)}:${point.line + 1}:${point.character + 1}: ${message}`); }
    function validate(node, expected) {
      const type = checker.getTypeAtLocation(node);
      if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) || !checker.isTypeAssignableTo(type, expected)) fail(node, 'Operation does not satisfy the command contract');
      for (const diagnostic of diagnostics) if (diagnostic.start >= node.getStart() && diagnostic.start < node.end) fail(node, ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
    }
    function visit(node) {
      if (ts.isVariableDeclaration(node) && path.resolve(file) === path.join(root, 'media/commander-jobs.js')) {
        if (node.name.getText(source) === 'definitions') validate(node.initializer, registry);
        if (node.name.getText(source) === 'actionDefinitions') validate(node.initializer, actions);
      }
      if (ts.isCallExpression(node)) {
        const expression = node.expression, name = ts.isIdentifier(expression) ? expression.text : ts.isPropertyAccessExpression(expression) ? expression.name.text : '';
        const declaration = checker.getResolvedSignature(node)?.declaration;
        const contracted = declaration && path.resolve(declaration.getSourceFile().fileName) === contract;
        if (name === 'enqueueOperation' || name === 'operation' && contracted || name === 'add' && (contracted || ts.isPropertyAccessExpression(expression) && expression.expression.getText(source) === 'operationQueue')) {
          if (!node.arguments[0]) fail(node, 'An operation request is required'); else validate(node.arguments[0], input);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return [...new Set(errors)];
}
function productFiles() {
  return [root, path.join(root, 'media')].flatMap(directory => fs.readdirSync(directory).filter(name => name.endsWith('.js')).map(name => path.join(directory, name)));
}
if (require.main === module) {
  const errors = check(productFiles());
  if (errors.length) { process.stderr.write(errors.join('\n') + '\n'); process.exitCode = 1; }
  else process.stdout.write('Operation contracts passed.\n');
}
module.exports = { check, productFiles };
