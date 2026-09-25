'use strict';

const { app, nativeImage } = require('electron');
const { createThumbarIcons } = require('../src/thumbar-icons');

app.whenReady().then(() => {
  const icons = createThumbarIcons(nativeImage);
  for (const [name, icon] of Object.entries(icons)) {
    if (icon.isEmpty() || icon.getSize().width !== 32 || icon.getSize().height !== 32) {
      throw new Error(`Invalid Windows thumbnail icon: ${name}`);
    }
  }
  console.log('STEENY_THUMBAR_ICONS_OK');
  app.quit();
}).catch(error => {
  console.error(error);
  app.exit(1);
});
