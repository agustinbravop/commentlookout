const sample = [
  { id: 'morning', label: 'Morning ritual', art: 'morning', title: 'Slow mornings' },
  { id: 'studio', label: 'Studio notes', art: 'studio', title: 'In the making' },
  { id: 'coast', label: 'Coastal light', art: 'coast', title: 'A little further' },
  { id: 'objects', label: 'Favorite objects', art: 'objects', title: 'Collected things' },
  { id: 'pause', label: 'A moment to pause', art: 'pause', title: 'Take your time.' },
  { id: 'garden', label: 'Garden afternoon', art: 'garden', title: 'Green hours' },
  { id: 'shape', label: 'Forms and shadows', art: 'shape', title: 'A study in form' },
  { id: 'table', label: 'At the table', art: 'table', title: 'Gather around' },
  { id: 'evening', label: 'Evening light', art: 'evening', title: 'Stay a while' }
];

function moveTile(order, from, to) {
  if (from < 0 || from >= order.length || to < 0 || to >= order.length || from === to) return order;
  const next = [...order];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function mount() {
  if (location.pathname !== '/dashboard/posts-all') return;
  const views = document.querySelector('main [aria-label="Grid view"]');
  if (!views || document.getElementById('feed-study-extension')) return;

  const host = document.createElement('div');
  host.id = 'feed-study-extension';
  views.closest('[role="group"]')?.parentElement?.after(host);
  if (!host.isConnected) return;
  const root = host.attachShadow({ mode: 'open' });
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = chrome.runtime.getURL('feed.css');
  root.append(css);

  let tiles = sample;
  let order = tiles.map(tile => tile.id);
  let selected = order[0];
  let dragged = null;
  let open = false;
  let message = '';

  const panel = document.createElement('div');
  const announcement = document.createElement('div');
  announcement.className = 'sr-only';
  announcement.setAttribute('role', 'status');
  root.append(panel, announcement);
  host.cleanup = () => tiles.filter(tile => tile.url).forEach(tile => URL.revokeObjectURL(tile.url));

  function move(from, to) {
    if (to < 0 || to >= order.length || from === to) return;
    order = moveTile(order, from, to);
    announcement.textContent = `Moved ${tiles.find(tile => tile.id === selected).label} to position ${order.indexOf(selected) + 1}.`;
    render();
    root.querySelector(`[data-id="${selected}"]`).focus();
  }

  function render() {
    const chosen = tiles.find(tile => tile.id === selected);
    const position = order.indexOf(selected);
    const custom = tiles !== sample;
    panel.innerHTML = `
      <button class="launch" type="button" aria-expanded="${open}" aria-controls="feed-panel"><span aria-hidden="true">▦</span> Feed preview</button>
      ${open ? `<section id="feed-panel" class="panel" aria-label="Instagram feed preview">
        <header class="top"><h2>Feed preview</h2><button class="close" type="button" aria-label="Close feed preview">×</button></header>
        <div class="account"><span><strong>${custom ? 'Your images' : 'Sample feed'}</strong><small>${custom ? `${tiles.length} local image${tiles.length === 1 ? '' : 's'}` : 'Example images, not your posts'}</small></span><button class="pick" type="button">${custom ? 'Replace images' : 'Use your images'}</button><input id="feed-images" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple></div>
        <p class="grid-heading">Top left is newest</p>
        <div class="grid" role="list" aria-label="${custom ? 'Local image' : 'Sample'} post order">${order.map((id, index) => {
          const tile = tiles.find(item => item.id === id);
          return `<div role="listitem"><button type="button" draggable="true" class="tile ${tile.art || 'photo'}${id === selected ? ' selected' : ''}" data-id="${tile.id}" aria-label="${index + 1} of ${tiles.length}: ${tile.label}. Drag or use arrow keys to reorder.">${tile.url ? `<img src="${tile.url}" alt="">` : `<span class="tile-shape" aria-hidden="true"></span><span class="tile-title">${tile.title}</span>`}<span class="tile-no">${String(index + 1).padStart(2, '0')}</span></button></div>`;
        }).join('')}${Array.from({ length: 9 - order.length }, () => '<div role="listitem" class="slot" aria-label="Empty feed slot">+</div>').join('')}</div>
        <div class="detail"><span class="detail-index">${position + 1} / ${tiles.length}</span><strong class="detail-copy">${chosen.label}</strong><div class="move-controls"><button type="button" class="earlier" aria-label="Move ${chosen.label} earlier" ${position === 0 ? 'disabled' : ''}>←</button><button type="button" class="later" aria-label="Move ${chosen.label} later" ${position === order.length - 1 ? 'disabled' : ''}>→</button></div></div>
        <footer><div><span>Drag or use ← → to reorder. Not saved to Zernio.</span>${message ? `<span class="message" role="alert">${message}</span>` : ''}</div><div class="footer-actions"><button class="reset" type="button">Reset order</button>${custom ? '<button class="sample-reset" type="button">Show sample</button>' : ''}</div></footer>
      </section>` : ''}`;
  }

  root.addEventListener('click', event => {
    let focus = '';
    if (event.target.closest('.launch')) { open = !open; focus = '.launch'; }
    else if (event.target.closest('.close')) { open = false; focus = '.launch'; }
    else if (event.target.closest('.pick')) { root.querySelector('#feed-images').click(); return; }
    else if (event.target.closest('.reset')) {
      order = tiles.map(tile => tile.id);
      selected = order[0];
      announcement.textContent = 'Original order restored.';
      focus = '.reset';
    } else if (event.target.closest('.sample-reset')) {
      host.cleanup();
      tiles = sample;
      order = tiles.map(tile => tile.id);
      selected = order[0];
      message = '';
      focus = '.pick';
    } else if (event.target.closest('.earlier') || event.target.closest('.later')) {
      move(order.indexOf(selected), order.indexOf(selected) + (event.target.closest('.earlier') ? -1 : 1));
      return;
    } else {
      const tile = event.target.closest('.tile');
      if (tile) { selected = tile.dataset.id; focus = `[data-id="${selected}"]`; }
      else return;
    }
    render();
    root.querySelector(focus)?.focus();
  });

  root.addEventListener('change', event => {
    if (event.target.id !== 'feed-images') return;
    const files = [...event.target.files];
    if (!files.length) return;
    if (files.some(file => !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 20 * 1024 * 1024)) {
      message = 'Choose PNG, JPG, WebP or GIF images under 20 MB each.';
      render();
      return;
    }
    host.cleanup();
    tiles = files.slice(0, 9).map((file, index) => ({
      id: `local-${index}`, label: escapeHtml(file.name.replace(/\.[^.]+$/, '')),
      url: URL.createObjectURL(file)
    }));
    order = tiles.map(tile => tile.id);
    selected = order[0];
    message = files.length > 9 ? 'Showing the first 9 images.' : '';
    render();
    root.querySelector('.pick').focus();
  });

  root.addEventListener('keydown', event => {
    if (event.key === 'Escape' && open) {
      open = false;
      render();
      root.querySelector('.launch').focus();
    }
    const tile = event.target.closest('.tile');
    if (!tile || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    selected = tile.dataset.id;
    move(order.indexOf(selected), order.indexOf(selected) + (event.key === 'ArrowRight' ? 1 : -1));
  });

  root.addEventListener('dragstart', event => {
    const tile = event.target.closest('.tile');
    if (!tile) return;
    dragged = tile.dataset.id;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', dragged);
  });
  root.addEventListener('dragover', event => {
    if (dragged && event.target.closest('.tile')) event.preventDefault();
  });
  root.addEventListener('drop', event => {
    const tile = event.target.closest('.tile');
    if (!dragged || !tile) return;
    event.preventDefault();
    selected = dragged;
    const from = order.indexOf(dragged);
    const to = order.indexOf(tile.dataset.id);
    dragged = null;
    move(from, to);
  });
  root.addEventListener('dragend', () => { dragged = null; });
  render();
}

if (typeof document !== 'undefined') {
  mount();
  // shortcut: the dashboard is a SPA, observe DOM changes until a public extension hook exists.
  new MutationObserver(() => {
    if (location.pathname === '/dashboard/posts-all') mount();
    else {
      const host = document.getElementById('feed-study-extension');
      host?.cleanup();
      host?.remove();
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
}
