const fs = require('node:fs');
const path = require('node:path');

function createLicenseInformation(vscode, options) {
  const scheme = 'bitfroest-licenses';
  const english = () => !String(options.language()).toLowerCase().startsWith('de');
  const text = (de, en, language) => language === 'en' ? en : de;
  const read = name => {
    let file = path.join(options.extensionPath, name);
    if (name === 'LICENSE' && !fs.existsSync(file)) file += '.txt';
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
  };
  const escape = value => String(value).replace(/[\\`*_{}[\]()<>!|]/g, '\\$&');
  function document(language) {
    const manifest = JSON.parse(read('package.json'));
    const components = JSON.parse(read('licenses/components.json'));
    const author = typeof manifest.author === 'string' ? manifest.author : manifest.author?.name;
    const title = text('Lizenzen und Danksagungen', 'Licenses and acknowledgements', language);
    const result = [
      `# ${title}`, '', `## Bitfroest.fs ${escape(manifest.version)}`, '',
      `${text('Autor', 'Author', language)}: ${escape(author || text('Noch nicht angegeben', 'Not yet specified', language))}`, '',
      `${text('Lizenz', 'License', language)}: [Apache License 2.0 (Apache-2.0)](https://www.apache.org/licenses/LICENSE-2.0)`, '',
      text('Nutzung, Bearbeitung und Weitergabe sind auch für kommerzielle Zwecke erlaubt. Relevante Urheber- und Lizenzhinweise bleiben erhalten; geänderte Dateien sind zu kennzeichnen. Der vollständige Lizenztext ist maßgeblich.', 'Use, modification and redistribution are permitted, including commercial use. Relevant copyright and license notices must be retained; modified files must be identified. The full license text governs.', language), '',
      text('**Nutzung auf eigene Gefahr.** Die Software wird im vorhandenen Zustand ohne Gewährleistung bereitgestellt, soweit gesetzlich zulässig. Für Gewährleistung und Haftung gelten die Regelungen der Apache License 2.0, insbesondere Abschnitte 7 und 8. Zwingende gesetzliche Rechte bleiben unberührt.', '**Use at your own risk.** The software is provided as is, without warranties, to the extent permitted by applicable law. Warranty and liability are governed by the Apache License 2.0, in particular Sections 7 and 8. Mandatory statutory rights remain unaffected.', language), '',
      text('## Verwendete Komponenten', '## Included components', language), ''
    ];
    for (const component of components) {
      result.push(`### ${escape(component.name)}${component.version ? ` · ${escape(component.version)}` : ''}`, '',
        `${text('Urheber', 'Copyright holder', language)}: ${escape(component.author)}`, '',
        `${text('Lizenz', 'License', language)}: [${escape(component.license)}](${component.licenseUrl})`, '',
        `[${text('Originalquelle', 'Original source', language)}](${component.source})`, '',
        component.description[language], '');
    }
    result.push(text('## Vollständige Lizenztexte', '## Full license texts', language), '',
      text('Die folgenden Texte sind im Erweiterungspaket enthalten und ohne Internetzugriff lesbar. Fremdbestandteile behalten ihre jeweiligen Lizenzbedingungen.', 'The following texts are included in the extension package and can be read offline. Third-party components retain their respective license terms.', language), '');
    const files = new Map([['LICENSE', 'Apache License 2.0'], ['NOTICE', 'Bitfroest.fs · NOTICE']]);
    for (const component of components) for (const file of component.files) files.set(file, file.split('/').at(-1));
    for (const [file, title] of files) {
      const content = read(file);
      const fence = '`'.repeat(Math.max(3, ...[...content.matchAll(/`+/g)].map(match => match[0].length + 1)));
      result.push(`### ${escape(title)}`, '', `${fence}text`, content, fence, '');
    }
    return result.join('\n');
  }
  const provider = {
    provideTextDocumentContent(uri) {
      const match = /^bitfroest-licenses:\/(de|en)\/licenses\.md$/.exec(uri.toString());
      if (!match) throw new Error('Unbekannte Lizenzressource / Unknown license resource.');
      return document(match[1]);
    }
  };
  const subscription = vscode.workspace.registerTextDocumentContentProvider(scheme, provider);
  return {
    async open() {
      const uri = vscode.Uri.parse(`${scheme}:/${english() ? 'en' : 'de'}/licenses.md`);
      provider.provideTextDocumentContent(uri);
      try { await vscode.commands.executeCommand('markdown.showPreview', uri); }
      catch { await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false }); }
    },
    dispose() { subscription.dispose(); }
  };
}

module.exports = { createLicenseInformation };
