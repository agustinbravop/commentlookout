import { expect, test } from 'bun:test';
import { postLabel } from '../src/post-label';

test('YouTube post labels show only the title while Instagram captions stay intact', () => {
  for (const separator of ['\n\n', '\r\n\r\n', '\r']) {
    expect(postLabel('youtube', `Video title${separator}Video description`)).toBe('Video title');
  }
  expect(postLabel('youtube', 'Title only')).toBe('Title only');
  expect(postLabel('youtube', null)).toBe('Untitled video');
  expect(postLabel('youtube', '  ')).toBe('Untitled video');
  expect(postLabel('instagram', 'Caption\n\nMore caption')).toBe('Caption\n\nMore caption');
  expect(postLabel('instagram', null)).toBe('Post without a caption');
});
