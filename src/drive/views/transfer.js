// The download progress panel, in the corner like Drive's own transfer tray.

import { icon } from '../../icons.js';
import { esc } from '../../util.js';
import { driveState } from '../state.js';
import { formatFileSize } from '../util.js';

export function renderTransfer(container) {
  const transfer = driveState.transfer;

  if (!transfer || transfer.status !== 'running') {
    container.hidden = true;
    container.innerHTML = '';
    return;
  }

  const scanning = transfer.phase === 'scanning';
  const total = transfer.total || 0;
  const done = Math.min(transfer.done || 0, total);
  const percent = total ? Math.round((done / total) * 100) : 0;

  container.hidden = false;
  container.innerHTML = `
    <div class="dr-transfer" role="status" aria-live="polite">
      <div class="dr-transfer-head">
        <span class="dr-transfer-title">
          ${scanning ? 'Preparing download' : `Zipping ${done} of ${total}`}
        </span>
        <button class="dr-icon-btn" data-action="cancel-download" title="Cancel download">
          ${icon('close', { size: 18 })}
        </button>
      </div>

      <div class="dr-transfer-bar">
        <div class="dr-transfer-fill${scanning ? ' is-indeterminate' : ''}"
             style="${scanning ? '' : `width:${percent}%`}"></div>
      </div>

      <div class="dr-transfer-meta">
        <span class="dr-transfer-label" title="${esc(transfer.label || '')}">
          ${esc(transfer.label || transfer.name || '')}
        </span>
        ${transfer.bytes ? `<span class="dr-transfer-bytes">${esc(formatFileSize(transfer.bytes))}</span>` : ''}
      </div>
    </div>`;
}
