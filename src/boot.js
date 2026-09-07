// Bridge between the classic-script shell (app.js) and the ES modules.
// app.js cannot `import`, so each workspace exposes a small facade here.

import { initMail, activate, deactivate, silentSync, refreshLabels, openComposer } from './mail.js';
import {
  initDrive, activateDrive, deactivateDrive, silentSyncDrive
} from './drive/drive.js';
import { initSettings, openSettings } from './settings.js';

const mailRoot = document.getElementById('gm-root');
const driveRoot = document.getElementById('dr-root');
const settingsHost = document.getElementById('settings-modal');
const settingsButton = document.getElementById('settings-btn');

if (settingsHost) {
  initSettings(settingsHost, settingsButton);
  window.MatonKeys = { open: openSettings };
}

if (mailRoot) {
  initMail(mailRoot);
  window.MatonMail = {
    activate,
    deactivate,
    silentSync,
    refreshLabels,
    compose: () => openComposer({ mode: 'new' })
  };
}

if (driveRoot) {
  initDrive(driveRoot);
  window.MatonDrive = {
    activate: activateDrive,
    deactivate: deactivateDrive,
    silentSync: silentSyncDrive
  };
}

// Mail is the default workspace, so bring it up immediately.
document.body.dataset.workspace = document.body.dataset.workspace || 'mail';
if (document.body.dataset.workspace === 'mail' && window.MatonMail) window.MatonMail.activate();
