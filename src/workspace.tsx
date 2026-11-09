import { useEffect, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { InstagramIcon, Refresh01Icon, YoutubeIcon } from '@hugeicons/core-free-icons';
import { Brand } from './landing';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import './workspace.css';

type User = { id: string; email: string; name: string; picture: string | null };
type Account = { id: string; platform: string; username: string; profilePicture: string | null };
type Connection = { connected: boolean; accounts: Account[]; voices?: Record<string, string> };
type SavedComment = { id: string; accountId: string; platform: string; postId: string; postContent: string | null; parentId: string | null; message: string; author: string; createdAt: string; isHidden: boolean; isBackfill: boolean; category: string | null; reason: string | null; draft: string | null };
type ArchivedDraft = { accountId: string; commentId: string; draft: string };
type BackfillProgress = { accountId: string; selected: number; posts: number; completedPosts: number; expectedComments: number; savedComments: number };

function backfillStatus(progress?: BackfillProgress) {
  if (!progress?.selected) return 'Finding recent posts…';
  if (!progress.posts) return 'No recent posts to scan';
  return `${progress.completedPosts}/${progress.posts} posts scanned · ${progress.savedComments} comments saved`;
}

function DraftEditor({ comment, onDismiss }: { comment: SavedComment | ArchivedDraft; onDismiss: () => void }) {
  const [draft, setDraft] = useState(comment.draft || '');
  const [status, setStatus] = useState('');
  const archived = 'commentId' in comment;
  const commentId = archived ? comment.commentId : comment.id;
  return <div className="workspace-editor"><label htmlFor={`draft-${comment.accountId}-${commentId}`}>Suggested reply</label>
    {comment.draft ? <><textarea id={`draft-${comment.accountId}-${commentId}`} value={draft} maxLength={2000} onChange={(event) => { setDraft(event.target.value); setStatus(''); }} />
      <Button variant="outline" type="button" disabled={!draft.trim() || draft.trim() === comment.draft} onClick={async () => {
        setStatus('Saving…');
        try {
          const response = await fetch(archived ? `/api/archived-drafts/${encodeURIComponent(comment.accountId)}/${encodeURIComponent(commentId)}` : `/api/comments/${encodeURIComponent(comment.accountId)}/${encodeURIComponent(commentId)}/draft`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft }) });
          if (!response.ok) throw new Error();
          comment.draft = draft.trim();
          setDraft(comment.draft);
          setStatus('Saved');
        } catch { setStatus('Could not save. Try again.'); }
      }}>Save draft</Button>
      <Button variant="ghost" type="button" onClick={async () => {
        setStatus('Dismissing…');
        try {
          const response = await fetch(`/api/drafts/${encodeURIComponent(comment.accountId)}/${encodeURIComponent(commentId)}`, { method: 'DELETE' });
          if (!response.ok) throw new Error();
          onDismiss();
        } catch { setStatus('Could not dismiss. Try again.'); }
      }}>Dismiss</Button> <small role="status">{status}</small><p>Sending is not enabled yet.</p></> : <p>Draft pending. Refresh after analysis runs.</p>}
  </div>;
}

function VoiceEditor({ accountId, initial }: { accountId: string; initial: string }) {
  const [voice, setVoice] = useState(initial);
  const [status, setStatus] = useState('');
  return <div className="workspace-editor"><label htmlFor={`voice-${accountId}`}>Account reply style</label>
    <textarea id={`voice-${accountId}`} value={voice} maxLength={2000} placeholder="Friendly, brief, and direct" onChange={(event) => { setVoice(event.target.value); setStatus(''); }} />
    <Button variant="outline" type="button" onClick={async () => {
      setStatus('Saving…');
      try {
        const response = await fetch(`/api/accounts/${encodeURIComponent(accountId)}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instructions: voice }) });
        if (!response.ok) throw new Error();
        setStatus('Saved for future drafts');
      } catch { setStatus('Could not save. Try again.'); }
    }}>Save style</Button> <small role="status">{status}</small>
  </div>;
}

export function Workspace() {
  const [activeTab, setActiveTab] = useState<'all' | 'review' | 'replies'>('all');
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState(false);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const [backfill, setBackfill] = useState<BackfillProgress[]>([]);
  const [backfillError, setBackfillError] = useState(false);
  const [comments, setComments] = useState<SavedComment[]>([]);
  const [archivedDrafts, setArchivedDrafts] = useState<ArchivedDraft[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [commentsError, setCommentsError] = useState('');
  const requestId = useRef(0);

  useEffect(() => {
    fetch('/api/me').then(async (response) => {
      if (response.status === 401) {
        location.replace('/api/auth/google');
        return;
      }
      if (!response.ok) throw new Error('Unable to load session');
      setUser(await response.json() as User);
      const accounts = await fetch('/api/zernio');
      if (!accounts.ok) throw new Error((await accounts.json() as { error?: string }).error || 'Could not read Zernio accounts');
      setConnection(await accounts.json() as Connection);
    }).catch(() => setError(true));
  }, []);

  useEffect(() => { if (user) { setComments([]); setArchivedDrafts([]); setNextCursor(null); void loadComments(undefined, activeTab); } }, [user, activeTab]);
  useEffect(() => {
    if (!connection?.connected) return;
    void loadBackfill();
    const interval = setInterval(() => { void loadBackfill(); }, 15_000);
    return () => clearInterval(interval);
  }, [connection?.connected]);

  async function loadBackfill() {
    try {
      const response = await fetch('/api/backfill');
      if (!response.ok) throw new Error();
      setBackfill((await response.json() as { accounts: BackfillProgress[] }).accounts);
      setBackfillError(false);
    } catch { setBackfillError(true); }
  }

  async function loadComments(cursor?: string, view = activeTab) {
    const request = ++requestId.current;
    setCommentsLoading(true);
    setCommentsError('');
    try {
      const response = await fetch(`/api/comments?${new URLSearchParams({ view, ...(cursor ? { before: cursor } : {}) })}`);
      if (!response.ok) throw new Error('Could not load saved comments');
      const page = await response.json() as { comments: SavedComment[]; nextCursor: string | null };
      if (request !== requestId.current) return;
      setComments((current) => cursor ? [...current, ...page.comments] : page.comments);
      setNextCursor(page.nextCursor);
      if (view === 'replies' && !cursor) {
        const archived = await fetch('/api/archived-drafts');
        if (!archived.ok) throw new Error('Could not load archived drafts');
        const data = await archived.json() as { drafts: ArchivedDraft[] };
        if (request === requestId.current) setArchivedDrafts(data.drafts);
      }
    } catch { if (request === requestId.current) setCommentsError('Could not load comments. Try again.'); }
    finally { if (request === requestId.current) setCommentsLoading(false); }
  }

  async function disconnect() {
    setConnectionError('');
    try {
      const response = await fetch('/api/zernio/disconnect', { method: 'POST' });
      if (!response.ok) throw new Error('Could not disconnect Zernio');
      setConnection({ connected: false, accounts: [] });
    } catch { setConnectionError('Could not disconnect Zernio. Try again.'); }
  }

  const estimatedComments = backfill.reduce((sum, progress) => sum + progress.expectedComments, 0);
  return (
    <div className="workspace">
      <header className="workspace-header">
        <a href="/" aria-label="Comment Lookout home"><Brand /></a>
        {user && <>
          <form id="workspace-sign-out" action="/api/auth/logout" method="post" />
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-lg" className="rounded-full" aria-label="Account menu" />}>
              <Avatar size="lg"><AvatarImage src={user.picture || undefined} alt="" referrerPolicy="no-referrer" /><AvatarFallback>{user.name.trim().charAt(0).toUpperCase() || '?'}</AvatarFallback></Avatar>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end"><DropdownMenuItem render={<button type="submit" form="workspace-sign-out" />}>Sign out</DropdownMenuItem></DropdownMenuContent>
          </DropdownMenu>
        </>}
      </header>
      <main className="workspace-main">
        {error ? <Alert variant="destructive"><AlertDescription>We couldn't load your workspace. Refresh the page to try again.</AlertDescription></Alert> : !user || !connection ? <p role="status">Checking your session…</p> :
          <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as 'all' | 'review' | 'replies')} className="workspace-tabs">
            <TabsList variant="line" className="workspace-nav" aria-label="Comment views">
              <TabsTrigger value="all">All comments</TabsTrigger>
              <TabsTrigger value="review">Review flags</TabsTrigger>
              <TabsTrigger value="replies">Needs a reply</TabsTrigger>
            </TabsList>
            <TabsContent value={activeTab}>
              <div className="workspace-heading">
                <div><h1>{activeTab === 'all' ? 'All comments' : activeTab === 'review' ? 'Review flags' : 'Needs a reply'}</h1><p>{activeTab === 'review' ? 'Potential issues to review. No automatic moderation is enabled.' : activeTab === 'replies' ? 'Edit suggested replies. Sending is not enabled yet.' : 'Newest first, with the post beside each comment.'}</p></div>
                <Button variant="outline" size="icon-lg" type="button" aria-label="Refresh comments" title="Refresh comments" disabled={commentsLoading} onClick={() => loadComments()}><HugeiconsIcon icon={Refresh01Icon} /></Button>
              </div>
              {comments.length > 0 && <Card className="workspace-inbox">
                <CardHeader className="workspace-inbox-head"><CardTitle>Comment</CardTitle><span>Post</span></CardHeader>
                <CardContent className="workspace-inbox-content"><ul className="workspace-comment-list">{comments.map((comment) => <li key={`${comment.accountId}:${comment.id}`}>
                  <div className="workspace-comment-body">
                    <div className="workspace-comment-byline"><Avatar size="lg"><AvatarFallback>{comment.author.slice(0, 1).toUpperCase()}</AvatarFallback></Avatar><div><strong>{comment.author}</strong><small>{connection.accounts.find((account) => account.id === comment.accountId)?.username || comment.platform} · {comment.platform === 'instagram' ? 'Instagram' : 'YouTube'}{comment.parentId ? ' · Reply' : ''}</small></div></div>
                     <p>{comment.message}</p><time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString()}</time>{comment.isHidden && <Badge variant="secondary">Hidden on platform</Badge>}{comment.isBackfill && <Badge variant="outline">Historical · review only</Badge>}
                     <div className="workspace-assessment">{comment.category ? <><Badge variant="secondary">{comment.category.replaceAll('_', ' ')}</Badge>{comment.reason && <span>{comment.reason}</span>}</> : <span>Analysis pending</span>}</div>
                     {activeTab === 'all' && comment.draft && <p className="workspace-draft-preview">Draft: {comment.draft}</p>}
                     {activeTab === 'replies' && <DraftEditor key={comment.draft || 'pending'} comment={comment} onDismiss={() => setComments((current) => current.filter((item) => item.accountId !== comment.accountId || item.id !== comment.id))} />}
                  </div>
                  <aside><span>On this post</span><p>{comment.postContent || 'Post without a caption'}</p></aside>
                </li>)}</ul></CardContent>
              </Card>}
               {!commentsLoading && !commentsError && comments.length === 0 && (activeTab !== 'replies' || !archivedDrafts.length) && <Empty className="workspace-empty-note"><EmptyHeader><EmptyTitle><h2>No comments here yet</h2></EmptyTitle><EmptyDescription>{activeTab === 'all' ? connection.connected ? 'We’re scanning up to three recent posts per account and watching new posts. Zernio may take up to 10 minutes to show new comments. Only comments from the past 90 days are retained.' : 'Connect Zernio to start scanning comments.' : activeTab === 'review' ? 'No comments have been flagged for review.' : 'No reply suggestions yet. Analysis runs in the background.'}</EmptyDescription></EmptyHeader></Empty>}
              {commentsLoading && <div className="workspace-loading" role="status" aria-label="Loading comments"><Skeleton className="h-28 w-full" /><Skeleton className="h-28 w-full" /></div>}
              {commentsError && <Alert variant="destructive"><AlertDescription>{commentsError} <Button variant="outline" type="button" onClick={() => loadComments(nextCursor || undefined)}>Retry</Button></AlertDescription></Alert>}
               {nextCursor && !commentsError && <Button className="workspace-load-more" variant="outline" type="button" disabled={commentsLoading} onClick={() => loadComments(nextCursor)}>Load more</Button>}
               {activeTab === 'replies' && archivedDrafts.length > 0 && <section className="workspace-archived"><h2>Older saved drafts</h2><p>The original comments have passed the 90-day retention period. Review these drafts before using them.</p><ul>{archivedDrafts.map((draft) => <li key={`${draft.accountId}:${draft.commentId}`}><DraftEditor comment={draft} onDismiss={() => setArchivedDrafts((current) => current.filter((item) => item.accountId !== draft.accountId || item.commentId !== draft.commentId))} /></li>)}</ul></section>}
               {activeTab === 'all' && <Card className="workspace-next">
                <CardHeader><CardTitle><h2>{connection.connected ? 'Your accounts' : 'Connect Zernio'}</h2></CardTitle><CardDescription>{connection.connected ? 'Instagram and YouTube accounts connected through Zernio.' : 'Sign in as your Zernio team owner to connect your accounts.'}</CardDescription></CardHeader>
                  <CardContent>
                    {connection.connected && <Alert className="workspace-backfill"><AlertDescription>Historical scan starts automatically and stays review-only. {backfill.length ? `Estimated volume: ${estimatedComments} comments across up to three recent posts per account; OpenAI classification roughly $${(estimatedComments * 0.00022).toFixed(4)} plus any reply drafts.` : 'Estimating comment volume…'} Counts and costs may change; comments older than 90 days are not retained.</AlertDescription></Alert>}
                    {connection.connected ? connection.accounts.length ? <ul className="workspace-accounts">{connection.accounts.map((account) => <li key={account.id}>
                    <Avatar size="lg"><AvatarImage src={account.profilePicture || undefined} alt={`${account.username} profile picture`} referrerPolicy="no-referrer" /><AvatarFallback><HugeiconsIcon icon={account.platform === 'instagram' ? InstagramIcon : YoutubeIcon} aria-hidden="true" /></AvatarFallback></Avatar>
                      <span><strong>{account.username}</strong><small>{account.platform}</small></span>
                      <p className="workspace-backfill-status">{backfillStatus(backfill.find((item) => item.accountId === account.id))}</p>
                      <VoiceEditor accountId={account.id} initial={connection.voices?.[account.id] || ''} />
                  </li>)}</ul> : <p>No Instagram or YouTube accounts connected yet. <a href="https://zernio.com" target="_blank" rel="noopener noreferrer">Connect one in Zernio</a>, then refresh this page.</p> : <a className={buttonVariants()} href="/api/zernio/connect">Connect Zernio</a>}
                  {connectionError && <Alert variant="destructive"><AlertDescription>{connectionError}</AlertDescription></Alert>}
                  {backfillError && <p role="alert">Could not load scan progress. <Button variant="outline" type="button" onClick={() => loadBackfill()}>Retry</Button></p>}
                </CardContent>
                 <CardFooter className="workspace-account-footer"><p>{connection.connected ? 'Historical comments are review-only. No moderation or replies are automatic.' : 'Read-only monitoring begins when you connect.'}</p>{connection.connected && <Button variant="outline" type="button" onClick={disconnect}>Disconnect Zernio</Button>}</CardFooter>
               </Card>}
            </TabsContent>
            <p className="workspace-session">Signed in as {user.email}</p>
          </Tabs>}
      </main>
    </div>
  );
}
