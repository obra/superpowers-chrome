'use strict';

function renderSyntheticArtifacts(s) {
  let markdown;
  if (s.kind === 'alert') {
    markdown = [
      `# Dialog: alert`,
      `Tab origin: ${s.payload.url || '(unknown)'}`,
      ``,
      `> ${s.payload.message}`,
      ``,
      `Buttons:`,
      `  - dialog::accept   (OK)`,
      ``,
      `To interact:`,
      `  click selector="dialog::accept"`,
    ].join('\n');
  } else {
    markdown = `# Dialog: ${s.kind}\n(unsupported in this render path)`;
  }
  return { markdown, html: '', consoleSnapshot: '' };
}

module.exports = { renderSyntheticArtifacts };
