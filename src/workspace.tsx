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
type Connection = { connected: boolean; accounts: Account[] };
type SavedComment = { id: string; accountId: string; platform: string; postId: string; postContent: string | null; parentId: string | null; message: string; author: string; createdAt: string; isHidden: boolean; isBackfill: boolean; category: string | null; reason: string | null; replyStatus: string | null };
type BackfillProgress = { accountId: string; selected: number; posts: number; completedPosts: number; expectedComments: number; savedComments: number };

function backfillStatus(progress?: BackfillProgress) {
  if (!progress?.selected) return 'Finding recent posts…';
  if (!progress.posts) return 'No recent posts to scan';
  return `${progress.completedPosts}/${progress.posts} posts scanned · ${progress.savedComments} comments saved`;
}

function ReplyComposer({ comment, onSent }: { comment: SavedComment; onSent: (status: 'sent' | 'unknown') => void }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (comment.replyStatus === 'sent') return <Badge variant="secondary">Replied</Badge>;
  if (comment.replyStatus) return <p role="alert">Reply delivery is unconfirmed. Check Zernio before replying again.</p>;
  if (comment.isHidden) return null;
  if (!open) return <Button variant="outline" type="button" onClick={() => setOpen(true)}>Reply</Button>;
  return <form className="workspace-editor" onSubmit={async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/comments/${encodeURIComponent(comment.accountId)}/${encodeURIComponent(comment.id)}/reply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }),
      });
      const result = await response.json() as { status?: string; error?: string };
      if (!response.ok) {
        if (result.error?.startsWith('Delivery unconfirmed')) onSent('unknown');
        throw new Error(result.error || 'Could not send reply');
      }
      onSent('sent');
      setOpen(false);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not send reply'); }
    finally { setBusy(false); }
  }}><label htmlFor={`reply-${comment.accountId}-${comment.id}`}>{comment.platform === 'youtube' && comment.parentId ? 'Reply in this YouTube thread' : `Reply to ${comment.author}`}</label>
    <textarea id={`reply-${comment.accountId}-${comment.id}`} value={message} maxLength={2000} required onChange={(event) => setMessage(event.target.value)} />
    <div className="workspace-reply-actions"><Button type="submit" disabled={busy || !message.trim()}>{busy ? 'Sending…' : 'Send reply'}</Button>
      <Button variant="ghost" type="button" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button></div>
    {error && <p role="alert">{error}</p>}
  </form>;
}

export function Workspace() {
  const [activeTab, setActiveTab] = useState<'all' | 'hidden' | 'replies'>('all');
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState(false);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const [backfill, setBackfill] = useState<BackfillProgress[]>([]);
  const [backfillError, setBackfillError] = useState(false);
  const [comments, setComments] = useState<SavedComment[]>([]);
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

  useEffect(() => { if (user) { setComments([]); setNextCursor(null); void loadComments(undefined, activeTab); } }, [user, activeTab]);
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
          <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as 'all' | 'hidden' | 'replies')} className="workspace-tabs">
            <TabsList variant="line" className="workspace-nav" aria-label="Comment views">
              <TabsTrigger value="all">All comments</TabsTrigger>
              <TabsTrigger value="hidden">Hidden comments</TabsTrigger>
              <TabsTrigger value="replies">Needs a reply</TabsTrigger>
            </TabsList>
            <TabsContent value={activeTab}>
              <div className="workspace-heading">
                <div><h1>{activeTab === 'all' ? 'All comments' : activeTab === 'hidden' ? 'Hidden comments' : 'Needs a reply'}</h1><p>{activeTab === 'hidden' ? 'Comments currently hidden on the platform, with a reason when known.' : activeTab === 'replies' ? 'Comments without a recorded reply. Write and send one yourself.' : 'Every saved comment, including unreviewed and historical ones.'}</p></div>
                <Button variant="outline" size="icon-lg" type="button" aria-label="Refresh comments" title="Refresh comments" disabled={commentsLoading} onClick={() => loadComments()}><HugeiconsIcon icon={Refresh01Icon} /></Button>
              </div>
              {comments.length > 0 && <Card className="workspace-inbox">
                <CardHeader className="workspace-inbox-head"><CardTitle>Comment</CardTitle><span>Post</span></CardHeader>
                <CardContent className="workspace-inbox-content"><ul className="workspace-comment-list">{comments.map((comment) => <li key={`${comment.accountId}:${comment.id}`}>
                  <div className="workspace-comment-body">
                    <div className="workspace-comment-byline"><Avatar size="lg"><AvatarFallback>{comment.author.slice(0, 1).toUpperCase()}</AvatarFallback></Avatar><div><strong>{comment.author}</strong><small>{connection.accounts.find((account) => account.id === comment.accountId)?.username || comment.platform} · {comment.platform === 'instagram' ? 'Instagram' : 'YouTube'}{comment.parentId ? ' · Reply' : ''}</small></div></div>
                     <p>{comment.message}</p><time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString()}</time>{comment.isHidden && <Badge variant="secondary">Hidden on platform</Badge>}{comment.isBackfill && <Badge variant="outline">Historical · review only</Badge>}
                     {activeTab === 'hidden' && <div className="workspace-assessment">{comment.category && ['spam', 'scam', 'profanity', 'suspicious_link'].includes(comment.category) ? <><Badge variant="secondary">{comment.category.replaceAll('_', ' ')}</Badge>{comment.reason && <span>{comment.reason}</span>}</> : <span>Reason unavailable</span>}</div>}
                     {activeTab !== 'hidden' && <ReplyComposer comment={comment} onSent={(status) => setComments((current) => activeTab === 'replies' && status === 'sent' ? current.filter((item) => item.accountId !== comment.accountId || item.id !== comment.id) : current.map((item) => item.accountId === comment.accountId && item.id === comment.id ? { ...item, replyStatus: status } : item))} />}
                  </div>
                  <aside><span>On this post</span><p>{comment.postContent || 'Post without a caption'}</p></aside>
                </li>)}</ul></CardContent>
              </Card>}
               {!commentsLoading && !commentsError && comments.length === 0 && <Empty className="workspace-empty-note"><EmptyHeader><EmptyTitle><h2>No comments here yet</h2></EmptyTitle><EmptyDescription>{activeTab === 'all' ? connection.connected ? 'We’re scanning up to three recent posts per account and watching new posts. Zernio may take up to 10 minutes to show new comments. Only comments from the past 90 days are retained.' : 'Connect Zernio to start scanning comments.' : activeTab === 'hidden' ? 'No saved comments are hidden on the platform.' : 'No comments need a manual reply right now.'}</EmptyDescription></EmptyHeader></Empty>}
              {commentsLoading && <div className="workspace-loading" role="status" aria-label="Loading comments"><Skeleton className="h-28 w-full" /><Skeleton className="h-28 w-full" /></div>}
              {commentsError && <Alert variant="destructive"><AlertDescription>{commentsError} <Button variant="outline" type="button" onClick={() => loadComments(nextCursor || undefined)}>Retry</Button></AlertDescription></Alert>}
               {nextCursor && !commentsError && <Button className="workspace-load-more" variant="outline" type="button" disabled={commentsLoading} onClick={() => loadComments(nextCursor)}>Load more</Button>}
               {activeTab === 'all' && <Card className="workspace-next">
                <CardHeader><CardTitle><h2>{connection.connected ? 'Your accounts' : 'Connect Zernio'}</h2></CardTitle><CardDescription>{connection.connected ? 'Instagram and YouTube accounts connected through Zernio.' : 'Sign in as your Zernio team owner to connect your accounts.'}</CardDescription></CardHeader>
                  <CardContent>
                     {connection.connected && <Alert className="workspace-backfill"><AlertDescription>Historical scan starts automatically and stays review-only. {backfill.length ? `Estimated volume: ${estimatedComments} comments across up to three recent posts per account.` : 'Estimating comment volume…'} AI analysis and drafting are paused during the Zernio reply test, so there are no new OpenAI charges. Comments older than 90 days are not retained.</AlertDescription></Alert>}
                    {connection.connected ? connection.accounts.length ? <ul className="workspace-accounts">{connection.accounts.map((account) => <li key={account.id}>
                    <Avatar size="lg"><AvatarImage src={account.profilePicture || undefined} alt={`${account.username} profile picture`} referrerPolicy="no-referrer" /><AvatarFallback><HugeiconsIcon icon={account.platform === 'instagram' ? InstagramIcon : YoutubeIcon} aria-hidden="true" /></AvatarFallback></Avatar>
                      <span><strong>{account.username}</strong><small>{account.platform}</small></span>
                      <p className="workspace-backfill-status">{backfillStatus(backfill.find((item) => item.accountId === account.id))}</p>
                  </li>)}</ul> : <p>No Instagram or YouTube accounts connected yet. <a href="https://zernio.com" target="_blank" rel="noopener noreferrer">Connect one in Zernio</a>, then refresh this page.</p> : <a className={buttonVariants()} href="/api/zernio/connect">Connect Zernio</a>}
                  {connectionError && <Alert variant="destructive"><AlertDescription>{connectionError}</AlertDescription></Alert>}
                  {backfillError && <p role="alert">Could not load scan progress. <Button variant="outline" type="button" onClick={() => loadBackfill()}>Retry</Button></p>}
                </CardContent>
                 <CardFooter className="workspace-account-footer"><p>{connection.connected ? 'Manual replies post only after you click Send reply. No moderation is automatic.' : 'Read-only monitoring begins when you connect.'}</p>{connection.connected && <Button variant="outline" type="button" onClick={disconnect}>Disconnect Zernio</Button>}</CardFooter>
               </Card>}
            </TabsContent>
            <p className="workspace-session">Signed in as {user.email}</p>
          </Tabs>}
      </main>
    </div>
  );
}
