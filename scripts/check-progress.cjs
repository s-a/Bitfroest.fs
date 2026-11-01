const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const contract = path.join(root, 'media/commander-progress.d.ts');
function check(files, overrides = new Map()) {
  const options = { allowJs: true, checkJs: true, strictNullChecks: true, noEmit: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS, skipLibCheck: true, types: [] };
  const host = ts.createCompilerHost(options), readFile = host.readFile;
  host.readFile = file => overrides.get(path.resolve(file)) ?? readFile(file);
  const program = ts.createProgram([contract, ...files], options, host);
  const checker = program.getTypeChecker(), failures = [];
  const eventSymbol = checker.getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(contract))).find(symbol => symbol.name === 'ProgressEvent');
  const eventType = checker.getDeclaredTypeOfSymbol(eventSymbol);
  const statusSymbol = checker.getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(contract))).find(symbol => symbol.name === 'StatusSnapshot');
  const statusType = checker.getDeclaredTypeOfSymbol(statusSymbol);
  const activitySymbol = checker.getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(contract))).find(symbol => symbol.name === 'StatusActivity');
  const activityType = checker.getDeclaredTypeOfSymbol(activitySymbol);
  const terminalSymbol = checker.getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(contract))).find(symbol => symbol.name === 'TerminalStatusSnapshot');
  const terminalType = checker.getDeclaredTypeOfSymbol(terminalSymbol);
  for (const file of files) {
    const source = program.getSourceFile(file); if (!source) continue;
    const diagnostics = program.getSemanticDiagnostics(source);
    const fail = (node, message) => { const point = source.getLineAndCharacterOfPosition(node.getStart()); failures.push(`${path.relative(root, file)}:${point.line + 1}:${point.character + 1}: ${message}`); };
    function visit(node) {
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        const signature = checker.getResolvedSignature(node);
        const declaration = signature?.declaration;
        const declaredHere = declaration && path.resolve(declaration.getSourceFile().fileName) === contract;
        if (declaredHere) {
          const required = declaration.parameters.filter(parameter => !parameter.questionToken && !parameter.initializer && !parameter.dotDotDotToken).length;
          if (node.arguments.length < required) fail(node, `Expected ${required} progress contract arguments`);
          for (const [index, argument] of node.arguments.entries()) {
            if (!signature.parameters[index]) continue;
            if (!checker.isTypeAssignableTo(checker.getTypeAtLocation(argument), checker.getTypeOfSymbolAtLocation(signature.parameters[index], node))) fail(node, 'Argument does not satisfy the progress contract');
          }
          for (const diagnostic of diagnostics) if (diagnostic.start >= node.getStart() && diagnostic.start < node.end) fail(node, ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
          const argument = node.arguments[0];
          if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'event' && argument) {
            const type = checker.getTypeAtLocation(argument);
            for (const field of ['overall', 'current']) {
              const property = type.getProperty(field);
              if (!property || type.flags & ts.TypeFlags.Any || checker.getTypeOfSymbolAtLocation(property, argument).flags & ts.TypeFlags.Any) fail(node, `The ${field} measurement must have a concrete contract type`);
            }
          }
        }
        const name = declaredHere && declaration.name ? declaration.name.text : ts.isPropertyAccessExpression(expression) ? expression.name.text : ts.isIdentifier(expression) ? expression.text : '';
        const notificationProgress = declaration && path.resolve(declaration.getSourceFile().fileName) === path.join(root, 'media/workbench-vendor.js') && ts.isClassDeclaration(declaration.parent) && declaration.parent.name?.text === 'NotificationViewItem';
        if (['setProgress', 'finishProgress'].includes(name) && (ts.isPropertyAccessExpression(expression) || declaredHere) && !notificationProgress) {
          const argument = node.arguments[0], property = argument && checker.getTypeAtLocation(argument).getProperty('progress');
          const type = property && checker.getTypeOfSymbolAtLocation(property, argument);
          if (!type || type.flags & ts.TypeFlags.Any || !checker.isTypeAssignableTo(type, name === 'finishProgress' ? terminalType : statusType)) fail(node, name === 'finishProgress' ? 'Finishing progress requires a terminal status planner snapshot' : 'The status bar requires a status planner snapshot');
          if (argument) for (const field of ['id', 'phase', 'total', 'completed', 'fileTotal', 'fileCompleted']) if (checker.getTypeAtLocation(argument).getProperty(field)) fail(node, 'Independent status counters and identities are not allowed');
        }
        if (name === 'setActivity' && (ts.isPropertyAccessExpression(expression) || declaredHere)) {
          const argument = node.arguments[1], type = argument && checker.getTypeAtLocation(argument);
          if (!argument || !type || type.flags & ts.TypeFlags.Any || !checker.isTypeAssignableTo(type, activityType)) fail(node, 'Background activity requires a status planner snapshot or an explicit null to clear it');
        }
        if (name === 'onProgress') {
          const argument = node.arguments[0];
          if (!argument) fail(node, 'A progress event is required');
          else {
            const type = checker.getTypeAtLocation(argument);
            if (type.flags & ts.TypeFlags.Any || !checker.isTypeAssignableTo(type, eventType)) fail(node, 'Progress callbacks require the versioned progress contract');
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return [...new Set(failures)];
}
function productFiles() {
  return [root, path.join(root, 'media')].flatMap(directory => fs.readdirSync(directory).filter(name => name.endsWith('.js')).map(name => path.join(directory, name)));
}
if (require.main === module) {
  const failures = check(productFiles());
  if (failures.length) { process.stderr.write(failures.join('\n') + '\n'); process.exitCode = 1; }
  else process.stdout.write('Progress contracts passed.\n');
}
module.exports = { check, productFiles };
