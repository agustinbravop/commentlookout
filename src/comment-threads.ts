type ThreadComment = { id: string; parentId: string | null; accountId: string; postId: string };

export function commentThreads<T extends ThreadComment>(comments: T[]) {
  const key = (comment: ThreadComment, id = comment.id) => JSON.stringify([comment.accountId, comment.postId, id]);
  const known = new Set(comments.map(comment => key(comment)));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const comment of comments) {
    if (!comment.parentId || comment.parentId === comment.id || !known.has(key(comment, comment.parentId))) roots.push(comment);
    else {
      const parent = key(comment, comment.parentId);
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent)!.push(comment);
    }
  }
  const result: { comment: T; depth: number }[] = [], visited = new Set<string>();
  const visit = (root: T) => {
    const stack = [{ comment: root, depth: root.parentId ? 1 : 0 }];
    while (stack.length) {
      const item = stack.pop()!;
      if (visited.has(key(item.comment))) continue;
      visited.add(key(item.comment)); result.push(item);
      for (const child of [...(children.get(key(item.comment)) || [])].reverse()) stack.push({ comment: child, depth: item.depth + 1 });
    }
  };
  roots.forEach(visit);
  comments.forEach(comment => { if (!visited.has(key(comment))) visit(comment); });
  return result;
}
