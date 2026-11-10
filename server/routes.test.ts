import { expect, test } from 'bun:test';
import { workspacePaths, workspaceTab } from '../src/routes';

test('workspace routes select their corresponding views', () => {
  for (const tab of ['comments', 'posts', 'settings'] as const) expect(workspaceTab(workspacePaths[tab])).toBe(tab);
});
