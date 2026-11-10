import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { App } from '../src/landing';

const file = Bun.file('dist/index.html');
const html = await file.text();
const seo = /<!-- public-seo-start -->[\s\S]*?<!-- public-seo-end -->/;
const root = '<div id="root"></div>';
if (!seo.test(html) || !html.includes(root)) throw new Error('Built HTML template changed; update prerender script');

const workspace = html
  .replace(seo, '<meta name="robots" content="noindex" />')
  .replace('<title>Comment Lookout | Hide Instagram Spam & Reply to Comments</title>', '<title>Workspace | Comment Lookout</title>');
const landing = html.replace(root, `<div id="root">${renderToString(createElement(App))}</div>`);
if (!landing.includes('We hide spam comments') || !landing.includes('rel="canonical"') ||
    !workspace.includes('content="noindex"') || workspace.includes('rel="canonical"')) throw new Error('SEO prerender failed');
await Bun.write('dist/app.html', workspace);
await Bun.write('dist/index.html', landing);
