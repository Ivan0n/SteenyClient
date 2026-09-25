'use strict';

const { app, BrowserWindow, nativeImage } = require('electron');
const { createThumbarIcons } = require('../src/thumbar-icons');

app.whenReady().then(async () => {
  if (process.platform !== 'win32') {
    console.log('STEENY_THUMBAR_SKIPPED not Windows');
    app.quit();
    return;
  }
  app.setAppUserModelId('fun.steeny.thumbar.smoke');
  const win = new BrowserWindow({ width: 320, height: 240, frame: false, show: false });
  await win.loadURL('data:text/html,<title>STEENY thumbnail test</title><body>STEENY</body>');
  win.show();
  await new Promise(resolve => setTimeout(resolve, 1000));
  const icons = createThumbarIcons(nativeImage);
  const installed = win.setThumbarButtons([
    { icon: icons.previous, tooltip: 'Предыдущий', flags: [], click() {} },
    { icon: icons.play, tooltip: 'Воспроизвести', flags: [], click() {} },
    { icon: icons.next, tooltip: 'Следующий', flags: [], click() {} },
  ]);
  const updated = installed && win.setThumbarButtons([
    { icon: icons.previous, tooltip: 'Предыдущий', flags: [], click() {} },
    { icon: icons.pause, tooltip: 'Пауза', flags: [], click() {} },
    { icon: icons.next, tooltip: 'Следующий', flags: [], click() {} },
  ]);
  console.log(`STEENY_THUMBAR_NATIVE_${installed && updated ? 'OK' : 'FAILED'}`);
  setTimeout(() => {
    win.destroy();
    app.exit(installed && updated ? 0 : 1);
  }, 300);
}).catch(error => {
  console.error(error);
  app.exit(1);
});
