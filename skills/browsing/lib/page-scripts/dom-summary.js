// Page-side script: token-efficient page summary used by auto-capture.
// Loaded as a string at attachCapture setup and embedded in CDP
// Runtime.evaluate. Tested directly against jsdom in
// test/lib/page-scripts/dom-summary.test.mjs.
module.exports = `
  (() => {
    const buttons = document.querySelectorAll('button, input[type="button"], input[type="submit"]').length;
    const inputs = document.querySelectorAll('input:not([type="button"]):not([type="submit"]), textarea, select').length;
    const links = document.querySelectorAll('a[href]').length;

    const title = document.title.slice(0, 60);
    const allH1s = Array.from(document.querySelectorAll('h1')).map(h => h.textContent.trim().slice(0, 40)).filter(Boolean);
    const h1s = allH1s.slice(0, 3);
    const h1Extra = allH1s.length > 3 ? allH1s.length - 3 : 0;

    const main = document.querySelector('main, [role="main"], .main, #main, .content, #content');
    const mainTag = main ? main.tagName.toLowerCase() + (main.id ? '#' + main.id : main.className ? '.' + main.className.split(' ')[0] : '') : 'body';

    const forms = document.querySelectorAll('form');
    const formInfo = forms.length > 0 ? \`\${forms.length} form\${forms.length > 1 ? 's' : ''}\` : '';

    const nav = document.querySelector('nav, [role="navigation"], .nav, #nav') ? 'nav' : '';

    return [
      \`\${title}\`,
      \`Interactive: \${buttons} buttons, \${inputs} inputs, \${links} links\`,
      h1s.length > 0 ? \`Headings: \${h1s.map(h => '"' + h + '"').join(', ')}\${h1Extra > 0 ? ', and ' + h1Extra + ' more' : ''}\` : '',
      \`Layout: \${nav ? 'nav + ' : ''}\${mainTag}\${formInfo ? ' + ' + formInfo : ''}\`
    ].filter(Boolean).join('\\n');
  })()
`;
