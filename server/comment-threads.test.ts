import { expect, test } from 'bun:test';
import { commentThreads } from '../src/comment-threads';

const comment = (id: string, parentId: string | null = null, postId = 'post') => ({ id, parentId, postId, accountId: 'account' });
test('threads put parents before replies while preserving root and sibling order', () => {
  expect(commentThreads([comment('reply', 'parent'), comment('other'), comment('parent'), comment('nested', 'reply'), comment('sibling', 'parent')])
    .map(({ comment, depth }) => [comment.id, depth])).toEqual([['other', 0], ['parent', 0], ['reply', 1], ['nested', 2], ['sibling', 1]]);
});
test('missing parents, cross-post IDs and cycles never hide or duplicate comments', () => {
  const items = [comment('a', 'b'), comment('b', 'a'), comment('orphan', 'absent'), comment('child', 'parent', 'other-post'), comment('parent')];
  const result = commentThreads(items);
  expect(result).toHaveLength(items.length);
  expect(new Set(result.map(item => item.comment.id)).size).toBe(items.length);
  expect(result.find(item => item.comment.id === 'child')?.depth).toBe(1);
});
