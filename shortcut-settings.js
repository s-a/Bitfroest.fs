const { createCatalog, validate } = require('./media/commander-shortcuts');
const catalog = createCatalog(require('./package.json'));
function localizedCatalog(language) {
  const de = /^de/.test(language);
  const labels = de ? require('./package.nls.de.json') : require('./package.nls.json');
  const titles = {
    'bitfroest.search-key': de ? 'Dateisuche: Zugriffstaste' : 'File search: access key',
    'bitfroest.transfer-name-parts': de ? 'Dateinamenbestandteile markieren' : 'Select file name parts',
    'bitfroest.transfer-name-start': de ? 'Zum Anfang des Dateinamens' : 'Move to file name start',
    'bitfroest.ignore-dialog-function-key': de ? 'Funktionstaste im Dialog abfangen' : 'Consume function key in dialog',
    'bitfroest.toggle-selection-next': de ? 'Markieren und nächsten Eintrag wählen' : 'Toggle selection and advance',
    'bitfroest.search-normal': de ? 'Suchergebnisansicht verlassen' : 'Leave search results view',
    'bitfroest.search-duplicates': de ? 'Doppelte Suchtreffer markieren' : 'Select duplicate search results'
  };
  const details = { next: ['Nächste Fundstelle', 'Next match'], previous: ['Vorherige Fundstelle', 'Previous match'], reload: ['Neu laden', 'Reload'], edit: ['Bearbeiten', 'Edit'], cursor: ['Textcursor', 'Text cursor'], find: ['Suchen', 'Find'], inverse: ['Suchrichtung umkehren', 'Reverse search'], 'select-all': ['Alles markieren', 'Select all'], copy: ['Kopieren', 'Copy'], 'copy-hex': ['Als Hexadezimalwerte kopieren', 'Copy as hexadecimal'], first: ['Anfang', 'Start'], last: ['Ende', 'End'], 'extend-first': ['Bis Anfang markieren', 'Select to start'], 'extend-last': ['Bis Ende markieren', 'Select to end'], escape: ['Schließen', 'Close'] };
  return catalog.map(item => ({ ...item, title: titles[item.command] || labels[item.title.replace(/^%|%$/g, '')] || item.title, detail: item.command === 'bitfroest.lister-action' ? details[item.args]?.[de ? 0 : 1] : item.args?.reverseDirectories ? de ? 'Verzeichnisauswahl umkehren' : 'Reverse directory selection' : undefined }));
}
function effectiveBindings(settings) {
  return validate(catalog, settings.get('shortcuts.bindings', {}), process.platform);
}
module.exports = { catalog, localizedCatalog, effectiveBindings };
