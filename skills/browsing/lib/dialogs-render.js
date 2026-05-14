'use strict';

function renderSyntheticArtifacts(s) {
  const origin = s.payload.url || '(unknown)';
  let markdown;

  if (s.kind === 'alert') {
    markdown = [
      `# Dialog: alert`,
      `Tab origin: ${origin}`,
      ``,
      `> ${s.payload.message}`,
      ``,
      `Buttons:`,
      `  - dialog::accept   (OK)`,
      ``,
      `To interact:`,
      `  click selector="dialog::accept"`,
    ].join('\n');
  } else if (s.kind === 'confirm') {
    markdown = [
      `# Dialog: confirm`,
      `Tab origin: ${origin}`,
      ``,
      `> ${s.payload.message}`,
      ``,
      `Buttons:`,
      `  - dialog::accept   (OK)`,
      `  - dialog::dismiss  (Cancel)`,
      ``,
      `To interact:`,
      `  click selector="dialog::accept"`,
      `  click selector="dialog::dismiss"`,
    ].join('\n');
  } else if (s.kind === 'prompt') {
    const lines = [
      `# Dialog: prompt`,
      `Tab origin: ${origin}`,
      ``,
      `> ${s.payload.message}`,
    ];
    if (s.payload.defaultPrompt) lines.push(`Default: "${s.payload.defaultPrompt}"`);
    lines.push(``, `Input: dialog::prompt   (type text here, then click dialog::accept)`);
    lines.push(`Buttons:`, `  - dialog::accept`, `  - dialog::dismiss`);
    markdown = lines.join('\n');
  } else if (s.kind === 'beforeunload') {
    markdown = [
      `# Dialog: beforeunload`,
      `Tab origin: ${origin}`,
      ``,
      `> ${s.payload.message || 'The page wants to confirm you really want to leave.'}`,
      ``,
      `Buttons:`,
      `  - dialog::accept   (Leave)`,
      `  - dialog::dismiss  (Stay)`,
      ``,
      `To interact:`,
      `  click selector="dialog::accept"`,
      `  click selector="dialog::dismiss"`,
    ].join('\n');
  } else {
    markdown = `# Dialog: ${s.kind}\n(unsupported in this render path)`;
  }

  return { markdown, html: '', consoleSnapshot: '' };
}

module.exports = { renderSyntheticArtifacts };
