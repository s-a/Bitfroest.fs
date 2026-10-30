const { WritableStream } = require('node:stream/web');
const { stop } = require('./zip-io');

async function resolvePassword(entry, settings = {}) {
  if (!entry.encrypted) return undefined;
  let password = settings.password, attempt = 0;
  while (true) {
    stop(settings.signal);
    if (typeof password !== 'string') {
      if (!settings.onPassword) throw new Error('Für diesen ZIP-Eintrag ist ein Passwort erforderlich.');
      password = await settings.onPassword({ name: entry.filename, attempt, signal: settings.signal }); stop(settings.signal);
      if (password === undefined) throw new DOMException('Passworteingabe abgebrochen.', 'AbortError');
    }
    try {
      await entry.getData(new WritableStream(), { password, signal: settings.signal, checkPasswordOnly: true });
      return password;
    } catch (error) {
      if (error.message !== 'Invalid password' || !settings.onPassword) throw error;
      attempt++; password = undefined;
    }
  }
}
module.exports = { resolvePassword };
