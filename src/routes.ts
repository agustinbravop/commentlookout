export const workspacePaths = { comments: '/app', posts: '/app/posts', settings: '/app/settings' } as const;

export function workspaceTab(path: string): keyof typeof workspacePaths {
  return path === workspacePaths.posts ? 'posts' : path === workspacePaths.settings ? 'settings' : 'comments';
}
