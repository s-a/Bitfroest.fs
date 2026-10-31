const { loadNativeApi } = require('./native-api');

async function maximizeWindow(titleToken, options = {}) {
  const session = (options.nativeApi || loadNativeApi()).openSession();
  let timer;
  try {
    const result = await Promise.race([
      session.invoke('windows.maximize', { titleToken }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('Zeitlimit beim Maximieren des Fensters überschritten.'), { code: 'WindowTimeout' })), options.timeout ?? 12000);
      })
    ]);
    if (result?.maximized !== true) {
      throw Object.assign(new Error('Das native Fenster wurde nicht als maximiert bestätigt.'), { code: 'InvalidNativeResponse' });
    }
    return { maximized: true };
  } finally {
    clearTimeout(timer);
    session.close();
  }
}

module.exports = { maximizeWindow };
