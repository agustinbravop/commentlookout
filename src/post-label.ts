export function postLabel(platform: string, content: string | null) {
  // Zernio's saved YouTube content has the title before the description's newline.
  const label = platform === 'youtube' ? content?.trim().split(/\r\n|\r|\n/, 1)[0] : content;
  return label || (platform === 'youtube' ? 'Untitled video' : 'Post without a caption');
}
