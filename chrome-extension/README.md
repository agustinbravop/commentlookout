# Feed Study for Zernio

Independent demo extension, not an official Zernio product. The extension icon is the [official Zernio square icon](https://zernio.com/press), resized without altering the artwork.

Interface rules: [DESIGN.md](DESIGN.md). The original ten user requests and direct links: [FEATURES.md](FEATURES.md).

A local, read-only Chrome/Brave extension that adds a **Feed preview** control next to the view buttons on `https://zernio.com/dashboard/posts-all`. Start with nine illustrated sample tiles, **not your Zernio posts**, or choose up to nine of your own images (PNG, JPG, WebP, GIF; under 20 MB each). Images stay in this browser tab, are never uploaded, and disappear on reload. Drag tiles, focus one and use the left/right arrow keys, or select one and use the arrow buttons. Reset restores the current image order; Show sample discards local images. Nothing is saved to Zernio or scheduled.

## Install locally

1. In Brave open `brave://extensions` (Chrome: `chrome://extensions`).
2. Enable **Developer mode**, choose **Load unpacked**, and select this `chrome-extension` folder.
3. Open or reload `https://zernio.com/dashboard/posts-all` and click **Feed preview** beside the grid/table/calendar controls.

If the button is missing, reload the page after installing. This version needs no API key, permissions beyond access to the matching Zernio page, or build step.

## Check

Run `node --test chrome-extension/content.test.cjs` from the submission root. On the dashboard, open the preview, choose local images, drag a tile, use arrow keys on a focused tile, reset, and close it. Check that Zernio's post list and scheduling are unchanged.

Live Instagram posts, cross-device persistence, and applying schedule changes are **not** implemented. The injection point is based on the current signed-in Posts page; Zernio UI changes may require updating it.
