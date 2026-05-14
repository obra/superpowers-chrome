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
  } else if (s.kind === 'device-chooser') {
    const kindLabel = { usb: 'USB', bluetooth: 'Bluetooth', serial: 'Serial', hid: 'HID' }[s.payload.deviceKind] || s.payload.deviceKind;
    const lines = [
      `# Dialog: device-chooser (${s.payload.deviceKind})`,
      `Origin requested a ${kindLabel} device.`,
      ``,
    ];
    if (s.payload.devices.length === 0) {
      lines.push(`(No devices visible.)`);
    } else {
      lines.push(`Devices:`);
      for (const d of s.payload.devices) {
        lines.push(`  - dialog::device[id="${d.id}"]   "${d.name}"`);
      }
    }
    lines.push(``, `Buttons:`, `  - dialog::dismiss   (Cancel)`);
    markdown = lines.join('\n');
  } else if (s.kind === 'permission') {
    markdown = [
      `# Dialog: permission`,
      `Origin ${s.payload.origin} requested: ${s.payload.name}`,
      `JS API: ${s.payload.jsApi}`,
      ``,
      `Buttons:`,
      `  - dialog::accept   (grant for this origin)`,
      `  - dialog::dismiss  (deny for this origin)`,
    ].join('\n');
  } else if (s.kind === 'basic-auth') {
    const header = s.payload.realm
      ? `Origin ${s.payload.origin} — realm "${s.payload.realm}"`
      : `Origin ${s.payload.origin}`;
    markdown = [
      `# Dialog: basic-auth`,
      header,
      ``,
      `Inputs:`,
      `  dialog::username`,
      `  dialog::password`,
      ``,
      `Buttons:`,
      `  - dialog::accept`,
      `  - dialog::dismiss`,
    ].join('\n');
  } else {
    markdown = `# Dialog: ${s.kind}\n(unsupported in this render path)`;
  }

  const htmlParts = [
    '<!doctype html>',
    '<html><head><title>Dialog</title></head><body>',
    `<h1>Dialog: ${s.kind}</h1>`,
  ];
  if (s.kind === 'prompt') {
    htmlParts.push('<input id="dialog-prompt" type="text">');
  }
  if (s.kind === 'basic-auth') {
    htmlParts.push('<input id="dialog-username" type="text">');
    htmlParts.push('<input id="dialog-password" type="password">');
  }
  if (s.kind === 'device-chooser') {
    for (const d of s.payload.devices) {
      htmlParts.push(`<button data-device-id="${d.id}">${d.name}</button>`);
    }
  }
  const acceptKinds = new Set(['alert', 'confirm', 'prompt', 'beforeunload', 'permission', 'basic-auth']);
  const dismissKinds = new Set(['confirm', 'prompt', 'beforeunload', 'device-chooser', 'permission', 'basic-auth']);
  if (acceptKinds.has(s.kind)) htmlParts.push('<button id="dialog-accept">Accept</button>');
  if (dismissKinds.has(s.kind)) htmlParts.push('<button id="dialog-dismiss">Dismiss</button>');
  htmlParts.push('</body></html>');
  const html = htmlParts.join('\n');

  return { markdown, html, consoleSnapshot: '' };
}

function renderResponseSummary(s, tabIndex) {
  const lines = [];
  lines.push(`Dialog open on tab ${tabIndex}: ${s.kind}`);
  if (s.payload.message) lines.push(`  Message: "${s.payload.message}"`);
  if (s.kind === 'alert') {
    lines.push(`  Handle with: click dialog::accept`);
  } else if (s.kind === 'device-chooser') {
    lines.push(`  Handle with: click dialog::device[id="..."] | click dialog::dismiss`);
  } else if (s.kind === 'basic-auth') {
    lines.push(`  Handle with: type dialog::username, type dialog::password, click dialog::accept | click dialog::dismiss`);
  } else if (s.kind === 'prompt') {
    lines.push(`  Handle with: type dialog::prompt, click dialog::accept | click dialog::dismiss`);
  } else {
    lines.push(`  Handle with: click dialog::accept | click dialog::dismiss`);
  }
  lines.push(`(no screenshot — dialog overlay is browser-native UI)`);
  return lines.join('\n');
}

module.exports = { renderSyntheticArtifacts, renderResponseSummary };
