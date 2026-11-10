import { Fragment, useEffect, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { InstagramIcon, LinkOffIcon, Refresh01Icon, SortByDown01Icon, YoutubeIcon } from '@hugeicons/core-free-icons';
import { Brand, SiteFooter } from './landing';
import { workspacePaths, workspaceTab } from './routes';
import { AccountMenu, type SignedInUser } from './account-menu';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { commentThreads } from './comment-threads';
import './workspace.css';

type Account = { id: string; platform: string; username: string; profilePicture: string | null };
type Connection = { connected: boolean; accounts: Account[]; moderation?: Record<string, boolean> };
type SavedComment = { id: string; accountId: string; platform: string; postId: string; postContent: string | null; postPicture: string | null; postCreatedAt: string | null; parentId: string | null; message: string; author: string; createdAt: string; isHidden: boolean; isBackfill: boolean; category: string | null; reason: string | null; draft: string | null; needsReply: boolean; replyStatus: string | null; replyMessage: string | null; replyAttempt: string | null; moderationStatus: string | null; restoreAttempt: string | null; hideAttempt: string | null; visibilityUncertain: boolean };
type BackfillProgress = { accountId: string; selected: number; posts: number; completedPosts: number; expectedComments: number; savedComments: number };
type SavedPost = { accountId: string; id: string; platform: string; content: string | null; picture: string | null; createdAt: string | null; commentCount: number; hiddenCount: number; needsReplyCount: number };

function backfillStatus(progress?: BackfillProgress) {
  if (!progress?.selected) return 'Finding recent posts…';
  if (!progress.posts) return 'No recent posts to scan';
  return progress.completedPosts >= progress.posts ? 'Recent posts scanned' : 'Scanning recent posts…';
}

function ModerationSetting({ account, initial }: { account: Account; initial: boolean | undefined }) {
  const [enabled, setEnabled] = useState(initial ?? true);
  const [confirmed, setConfirmed] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <form className="workspace-moderation" onSubmit={async (event) => {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/accounts/${encodeURIComponent(account.id)}/moderation`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || 'Could not save your choice.');
      setConfirmed(enabled);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save your choice.'); }
    finally { setBusy(false); }
  }}>
    <div className="workspace-moderation-choice"><Checkbox id={`moderation-${account.id}`} checked={enabled} disabled={busy} onCheckedChange={setEnabled} aria-describedby={`moderation-help-${account.id}`} />
      <label htmlFor={`moderation-${account.id}`}>Auto-hide spam, scams and profanity comments</label></div>
    <p id={`moderation-help-${account.id}`}>Includes up to three recent posts.{account.platform === 'youtube' && ' YouTube moderation is not active yet.'}</p>
    <Button type="submit" variant="outline" disabled={busy || confirmed === enabled}>{busy ? 'Saving…' : confirmed === undefined ? 'Confirm choice' : 'Save choice'}</Button>
    <span className="sr-only" role="status">{confirmed !== undefined && confirmed === enabled ? 'Moderation choice saved.' : ''}</span>
    {error && <p role="alert">{error}</p>}
  </form>;
}

function RestoreButton({ comment, onRestored, onRefresh }: { comment: SavedComment; onRestored: () => void; onRefresh: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (comment.moderationStatus === 'restore_pending' || comment.moderationStatus === 'restore_unknown') return <div className="workspace-editor"><p role="alert">Restoration is unconfirmed. Check Instagram before deciding.</p>
    {comment.restoreAttempt && <div className="workspace-reply-actions">{(['restored', 'hidden'] as const).map((resolution) => <Button key={resolution} type="button" variant="outline" disabled={busy} onClick={async () => {
      setBusy(true); setError('');
      try {
        const response = await fetch(`/api/comments/${encodeURIComponent(comment.accountId)}/${encodeURIComponent(comment.id)}/restore/resolve`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resolution, attempt: comment.restoreAttempt }),
        });
        const result = await response.json() as { error?: string };
        if (!response.ok) throw new Error(result.error || 'Could not resolve restoration.');
        if (resolution === 'restored') onRestored(); else onRefresh();
      } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not resolve restoration.'); }
      finally { setBusy(false); }
    }}>{resolution === 'restored' ? 'I checked; it is visible' : 'I checked; it is still hidden'}</Button>)}</div>}
    {error && <p role="alert">{error}</p>}</div>;
  return <div className="workspace-editor"><Button variant="outline" type="button" disabled={busy} onClick={async () => {
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/comments/${encodeURIComponent(comment.accountId)}/${encodeURIComponent(comment.id)}/restore`, { method: 'POST' });
      const result = await response.json() as { error?: string; status?: string };
      if (result.status === 'restore_unknown') { onRefresh(); return; }
      if (!response.ok) throw new Error(result.error || 'Could not restore comment.');
      onRestored();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not restore comment.'); }
    finally { setBusy(false); }
  }}>{busy ? 'Restoring…' : 'Restore comment'}</Button>{error && <p role="alert">{error}</p>}</div>;
}

function HideRecovery({ comment, onRefresh }: { comment: SavedComment; onRefresh: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <div className="workspace-editor"><p role="alert">Hide unconfirmed. Check Instagram. If still visible, choosing that option allows automatic retry.</p>
    {comment.hideAttempt && <div className="workspace-reply-actions">{(['hidden', 'visible'] as const).map((resolution) => <Button key={resolution} type="button" variant="outline" disabled={busy} onClick={async () => {
      setBusy(true); setError('');
      try {
        const response = await fetch(`/api/comments/${encodeURIComponent(comment.accountId)}/${encodeURIComponent(comment.id)}/hide/resolve`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resolution, attempt: comment.hideAttempt }),
        });
        const result = await response.json() as { error?: string };
        if (!response.ok) throw new Error(result.error || 'Could not resolve hide.');
        onRefresh();
      } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not resolve hide.'); }
      finally { setBusy(false); }
    }}>{resolution === 'hidden' ? 'I checked; it is hidden' : 'Still visible; allow retry'}</Button>)}</div>}
    {error && <p role="alert">{error}</p>}</div>;
}

function ReplyComposer({ comment, onSent, onResolved }: { comment: SavedComment; onSent: (status: 'sent' | 'unknown', attempt?: string, message?: string) => void; onResolved: (status: string | null) => void }) {
  const [open, setOpen] = useState(true);
  const [message, setMessage] = useState(comment.replyMessage || comment.draft || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const savedDraft = useRef(comment.draft || '');
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const latestMessage = useRef(message);
  latestMessage.current = message;
  // shortcut: manual replies remain local until sent; persist them if they must survive a refresh.
  const saveDraft = (draft: string) => {
    if (!comment.draft) return saveQueue.current;
    if (!draft.trim()) return Promise.reject(new Error('Enter a reply to save this draft.'));
    saveQueue.current = saveQueue.current.catch(() => {}).then(async () => {
      if (draft === savedDraft.current) return;
      setSaving(true);
      try {
        const response = await fetch(`/api/comments/${encodeURIComponent(comment.accountId)}/${encodeURIComponent(comment.id)}/draft`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft }) });
        if (!response.ok) throw new Error('Could not save draft. Try again.');
        savedDraft.current = draft;
        if (latestMessage.current === draft) { setSaved(true); setError(''); }
      } finally { setSaving(false); }
    });
    return saveQueue.current;
  };
  useEffect(() => {
    if (!comment.draft || comment.replyStatus || comment.isHidden || !message.trim() || message === savedDraft.current) return;
    const timer = setTimeout(() => { void saveDraft(message).catch((failure) => setError(failure instanceof Error ? failure.message : 'Could not save draft.')); }, 600);
    return () => clearTimeout(timer);
  }, [comment.draft, comment.isHidden, comment.replyStatus, message]);
  if (comment.replyStatus === 'sent' || comment.replyStatus === 'user_confirmed') return null;
  if (comment.replyStatus) return <div className="workspace-editor"><p role="alert">We couldn’t confirm your reply was sent. Check the platform first; new replies may take time to appear.</p>
    {comment.replyMessage && <p>Attempted reply: {comment.replyMessage}</p>}
    {comment.replyAttempt && <div className="workspace-reply-actions">{(['found', 'not_sent'] as const).map((resolution) => <Button key={resolution} type="button" variant="outline" disabled={busy} onClick={async () => {
      setBusy(true); setError('');
      try {
        const response = await fetch(`/api/comments/${encodeURIComponent(comment.accountId)}/${encodeURIComponent(comment.id)}/reply/resolve`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resolution, attempt: comment.replyAttempt }),
        });
        const result = await response.json() as { error?: string };
        if (!response.ok) throw new Error(result.error || 'Could not resolve reply.');
        onResolved(resolution === 'found' ? 'user_confirmed' : null);
      } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not resolve reply.'); }
      finally { setBusy(false); }
    }}>{resolution === 'found' ? 'I found my reply' : 'I checked; it was not sent'}</Button>)}</div>}
    {error && <p role="alert">{error}</p>}</div>;
  if (comment.isHidden) return null;
  if (!open) return <Button variant="outline" type="button" onClick={() => setOpen(true)}>Reply</Button>;
  return <form className="workspace-editor" onSubmit={async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await saveDraft(message);
      const response = await fetch(`/api/comments/${encodeURIComponent(comment.accountId)}/${encodeURIComponent(comment.id)}/reply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }),
      });
      const result = await response.json() as { status?: string; error?: string; attempt?: string };
      if (!response.ok) {
        if (result.status === 'unknown') onSent('unknown', result.attempt, message.trim());
        throw new Error(result.error || 'Could not send reply');
      }
      onSent('sent');
      setOpen(false);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not send reply'); }
    finally { setBusy(false); }
  }}><label htmlFor={`reply-${comment.accountId}-${comment.id}`}>Your reply:</label>
    <Textarea id={`reply-${comment.accountId}-${comment.id}`} value={message} maxLength={2000} required onChange={(event) => { setMessage(event.target.value); setError(''); setSaved(false); }} onBlur={() => { if (comment.draft && message.trim() && message !== savedDraft.current) void saveDraft(message).catch((failure) => setError(failure instanceof Error ? failure.message : 'Could not save draft.')); }} />
    <div className="workspace-reply-actions"><Button type="submit" disabled={busy || !message.trim()}>{busy ? 'Sending…' : 'Send reply'}</Button>
      <Button variant="ghost" type="button" disabled={busy} onClick={async () => {
        setBusy(true);
        try { await saveDraft(message); setOpen(false); }
        catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save draft.'); }
        finally { setBusy(false); }
      }}>Cancel</Button></div>
    {comment.draft && (saving ? <small role="status">Saving draft…</small> : saved && <small role="status">Draft saved</small>)}
    {error && <p role="alert">{error}</p>}
  </form>;
}

function CommentsTable({ comments, showPost = true, onRefresh, onSent, repliesFilter = false, hiddenOnly = false }: {
  comments: SavedComment[]; showPost?: boolean; onRefresh: () => void;
  onSent: (comment: SavedComment, status: 'sent' | 'unknown', attempt?: string, message?: string) => void;
  repliesFilter?: boolean; hiddenOnly?: boolean;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const byId = new Map(comments.map(comment => [`${comment.accountId}:${comment.id}`, comment]));
  const rows = showPost ? comments.map(comment => ({ comment, depth: comment.parentId ? 1 : 0 })) : commentThreads(comments);
  return <Table className={`workspace-comment-table${showPost ? '' : ' workspace-posts-table'}`} aria-label={showPost ? 'Comments' : 'Post comments'}>
    <TableHeader><TableRow><TableHead scope="col">Comment</TableHead>{showPost && <TableHead scope="col">Post</TableHead>}<TableHead scope="col">Date</TableHead><TableHead scope="col">Status</TableHead></TableRow></TableHeader>
    <TableBody>{rows.map(({ comment, depth }) => {
      const key = `${comment.accountId}:${comment.id}`, open = expanded === key;
      const parent = comment.parentId ? byId.get(`${comment.accountId}:${comment.parentId}`) : undefined;
      const toggle = () => setExpanded(current => current === key ? null : key);
      return <Fragment key={key}><TableRow className="workspace-comment-row" tabIndex={0} aria-label={`Comment by ${comment.author}`} aria-expanded={open} aria-controls={`comment-details-${comment.accountId}-${comment.id}`} onClick={toggle} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); } }}>
        <TableCell className="workspace-comment-body" data-label="Comment"><div className={depth ? 'workspace-thread-comment' : undefined} style={depth ? { marginInlineStart: `${Math.min(depth, 4) * 16}px` } : undefined}>
          {comment.parentId && <small className="workspace-reply-label">Reply{parent?.postId === comment.postId ? ` to ${parent.author}` : ''}</small>}
          <strong>{comment.author}</strong><p className={open ? 'workspace-comment-full' : 'workspace-truncate'}>{comment.message}</p></div></TableCell>
        {showPost && <TableCell className="workspace-post-cell" data-label="Post"><div className="workspace-post"><span className="workspace-thumbnail">{comment.postPicture && <img src={comment.postPicture} alt="" loading="lazy" referrerPolicy="no-referrer" onError={event => { event.currentTarget.style.display = 'none'; }} />}</span><p className="workspace-truncate">{comment.postContent || 'Post without a caption'}</p></div></TableCell>}
        <TableCell data-label="Date"><time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleDateString()}</time></TableCell>
        <TableCell data-label="Status"><div className="workspace-statuses">{(comment.visibilityUncertain || comment.isHidden || comment.moderationStatus === 'hide_unknown' || comment.moderationStatus === 'pending' || comment.moderationStatus === 'hiding' || !comment.category) && <Badge className={comment.visibilityUncertain || comment.moderationStatus === 'hide_unknown' ? 'workspace-status-check' : comment.isHidden ? 'workspace-status-hidden' : 'workspace-status-pending'}>{comment.visibilityUncertain ? 'Check visibility' : comment.isHidden ? 'Hidden' : comment.moderationStatus === 'hide_unknown' ? 'Check hide' : comment.moderationStatus === 'pending' || comment.moderationStatus === 'hiding' ? 'Hide pending' : 'Pending'}</Badge>}{comment.category && comment.category !== 'safe' && <Badge className="workspace-status-check">{comment.category.replaceAll('_', ' ')}</Badge>}{comment.replyStatus === 'sent' || comment.replyStatus === 'user_confirmed' ? <Badge className="workspace-status-replied">Replied</Badge> : comment.replyStatus ? <Badge className="workspace-status-check">Check reply</Badge> : comment.needsReply ? <Badge className="workspace-status-draft">Needs reply</Badge> : null}</div></TableCell>
      </TableRow><TableRow id={`comment-details-${comment.accountId}-${comment.id}`} hidden={!open} className="workspace-detail-row"><TableCell colSpan={showPost ? 4 : 3} className="workspace-action-cell"><div className="workspace-detail-stack">
        <div className="workspace-detail-source"><Badge variant="outline" className="workspace-source-tag"><HugeiconsIcon icon={comment.platform === 'instagram' ? InstagramIcon : YoutubeIcon} aria-hidden="true" />{comment.platform}{comment.parentId ? ' · Reply' : ''}</Badge></div>
        <time className="workspace-detail-time" dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleTimeString()}</time>
        {comment.visibilityUncertain && <p role="status">Visibility needs checking on Instagram.</p>}
        {(!comment.category || comment.reason) && <p className="workspace-assessment">{comment.reason || 'Waiting for review'}</p>}
        {comment.isHidden && comment.platform === 'instagram' && <RestoreButton comment={comment} onRefresh={onRefresh} onRestored={onRefresh} />}
        {comment.moderationStatus === 'pending' && <p role="status">Hide pending. We’ll retry.</p>}
        {comment.moderationStatus === 'hiding' && <p role="status">Hiding…</p>}
        {comment.moderationStatus === 'hide_unknown' && <HideRecovery comment={comment} onRefresh={onRefresh} />}
        {repliesFilter && comment.needsReply && !comment.draft && <p role="status">Draft pending. Refresh to check again.</p>}
        {!hiddenOnly && <ReplyComposer key={comment.draft || 'manual'} comment={comment} onResolved={onRefresh} onSent={(status, attempt, message) => onSent(comment, status, attempt, message)} />}
      </div></TableCell></TableRow></Fragment>;
    })}</TableBody></Table>;
}

function PostComments({ post }: { post: SavedPost }) {
  const [comments, setComments] = useState<SavedComment[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const requestId = useRef(0);
  const retryCursor = useRef<string | undefined>(undefined);
  async function load(before?: string) {
    const request = ++requestId.current;
    retryCursor.current = before;
    setLoading(true); setError('');
    try {
      const response = await fetch(`/api/comments?${new URLSearchParams({ accountId: post.accountId, postId: post.id, sort: 'oldest', ...(before ? { before } : {}) })}`);
      if (!response.ok) throw new Error();
      const page = await response.json() as { comments: SavedComment[]; nextCursor: string | null };
      if (request !== requestId.current) return;
      setComments(current => before ? [...current, ...page.comments] : page.comments); setCursor(page.nextCursor);
    } catch { if (request === requestId.current) setError('Could not load this post’s comments.'); }
    finally { if (request === requestId.current) setLoading(false); }
  }
  useEffect(() => { void load(); return () => { requestId.current++; }; }, [post.accountId, post.id]);
  return <div className="workspace-post-comments">
    {comments.length > 0 && <CommentsTable comments={comments} showPost={false} onRefresh={() => { void load(); }} onSent={(comment, status, attempt, message) => setComments(current => current.map(item => item.id === comment.id ? { ...item, replyStatus: status, replyAttempt: attempt ?? null, replyMessage: message ?? null, needsReply: false } : item))} />}
    {!loading && !error && !comments.length && <p className="workspace-post-note">No saved comments on this post yet.</p>}
    {loading && <p className="workspace-post-note" role="status">Loading comments…</p>}
    {error && <Alert variant="destructive"><AlertDescription>{error} <Button variant="outline" onClick={() => { void load(retryCursor.current); }}>Retry</Button></AlertDescription></Alert>}
    {cursor && !error && <Button className="workspace-load-more" variant="outline" disabled={loading} onClick={() => { void load(cursor); }}>Load more comments</Button>}
  </div>;
}

function PostRow({ post, accounts }: { post: SavedPost; accounts: Account[] }) {
  const [open, setOpen] = useState(false), [visited, setVisited] = useState(false);
  const id = `post-comments-${post.accountId}-${post.id}`;
  const toggle = () => { setOpen(current => !current); setVisited(true); };
  return <><TableRow className="workspace-comment-row workspace-post-row" tabIndex={0} aria-label={`Post: ${post.content || 'Post without a caption'}`} aria-expanded={open} aria-controls={id} onClick={toggle} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); } }}>
    <TableCell data-label="Post"><div className="workspace-post"><span className="workspace-thumbnail">{post.picture && <img src={post.picture} alt="" loading="lazy" referrerPolicy="no-referrer" onError={event => { event.currentTarget.style.display = 'none'; }} />}</span><p className="workspace-truncate">{post.content || 'Post without a caption'}</p></div></TableCell>
    <TableCell data-label="Account"><span className="workspace-post-account"><HugeiconsIcon icon={post.platform === 'instagram' ? InstagramIcon : YoutubeIcon} aria-hidden="true" />{accounts.find(account => account.id === post.accountId)?.username || post.platform}</span></TableCell>
    <TableCell data-label="Date">{post.createdAt ? <time dateTime={post.createdAt}>{new Date(post.createdAt).toLocaleDateString()}</time> : 'Date unavailable'}</TableCell>
    <TableCell data-label="Comments"><div className="workspace-statuses"><span>{post.commentCount} comments</span>{post.hiddenCount > 0 && <Badge className="workspace-status-hidden">{post.hiddenCount} hidden</Badge>}{post.needsReplyCount > 0 && <Badge className="workspace-status-draft">{post.needsReplyCount} need reply</Badge>}</div></TableCell>
  </TableRow><TableRow id={id} hidden={!open} className="workspace-post-detail"><TableCell colSpan={4}>{visited && <PostComments post={post} />}</TableCell></TableRow></>;
}

function PostsTable({ sort, filter, accounts, refresh }: { sort: string; filter: string; accounts: Account[]; refresh: number }) {
  const [posts, setPosts] = useState<SavedPost[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState('');
  const requestId = useRef(0);
  const retryCursor = useRef<string | undefined>(undefined);
  async function load(before?: string) {
    const request = ++requestId.current; setLoading(true); setError('');
    retryCursor.current = before;
    try {
      const response = await fetch(`/api/posts?${new URLSearchParams({ sort, view: filter || 'all', ...(before ? { before } : {}) })}`);
      if (!response.ok) throw new Error();
      const page = await response.json() as { posts: SavedPost[]; nextCursor: string | null };
      if (request !== requestId.current) return;
      setPosts(current => before ? [...current, ...page.posts] : page.posts); setCursor(page.nextCursor);
    } catch { if (request === requestId.current) setError('Could not load posts.'); }
    finally { if (request === requestId.current) setLoading(false); }
  }
  useEffect(() => { setPosts([]); setCursor(null); void load(); return () => { requestId.current++; }; }, [sort, filter, refresh]);
  return <>
    {posts.length > 0 && <Card className="workspace-inbox"><CardContent className="workspace-inbox-content"><Table className="workspace-comment-table workspace-post-list" aria-label="Posts">
      <TableHeader><TableRow><TableHead scope="col">Post</TableHead><TableHead scope="col">Account</TableHead><TableHead scope="col">Date</TableHead><TableHead scope="col">Comments</TableHead></TableRow></TableHeader>
      <TableBody>{posts.map(post => <PostRow key={JSON.stringify([post.accountId, post.id])} post={post} accounts={accounts} />)}</TableBody>
    </Table></CardContent></Card>}
    {!loading && !error && !posts.length && <Empty className="workspace-empty-note"><EmptyHeader><EmptyTitle>{filter ? 'No matching posts' : 'No posts yet'}</EmptyTitle><EmptyDescription>{filter ? 'No posts have comments matching these statuses.' : 'Monitored posts will appear here as they are discovered.'}</EmptyDescription></EmptyHeader></Empty>}
    {loading && <div className="workspace-loading" role="status" aria-label="Loading posts"><Skeleton className="h-28 w-full" /></div>}
    {error && <Alert variant="destructive"><AlertDescription>{error} <Button variant="outline" onClick={() => { void load(retryCursor.current); }}>Retry</Button></AlertDescription></Alert>}
    {cursor && !error && <Button className="workspace-load-more" variant="outline" disabled={loading} onClick={() => { void load(cursor); }}>Load more posts</Button>}
  </>;
}

export function Workspace() {
  const [postsRefresh, setPostsRefresh] = useState(0);
  const [activeTab, setActiveTab] = useState(() => workspaceTab(location.pathname));
  const [filter, setFilter] = useState<('hidden' | 'replies')[]>([]);
  const [commentSort, setCommentSort] = useState<'newest' | 'oldest'>('newest');
  const [postSort, setPostSort] = useState<'newest' | 'oldest'>('newest');
  const [user, setUser] = useState<SignedInUser | null>(null);
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
    const onPopState = () => setActiveTab(workspaceTab(location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    fetch('/api/me').then(async (response) => {
      if (response.status === 401) {
        location.replace('/api/auth/google');
        return;
      }
      if (!response.ok) throw new Error('Unable to load session');
       setUser(await response.json() as SignedInUser);
      try {
        const accounts = await fetch('/api/zernio');
        if (!accounts.ok) throw new Error();
        setConnection(await accounts.json() as Connection);
      } catch {
        setConnection({ connected: false, accounts: [] });
        setConnectionError('Could not load your Zernio connection. Try again or reconnect Zernio.');
      }
    }).catch(() => setError(true));
  }, []);

  useEffect(() => { if (user && activeTab === 'comments') { setComments([]); setNextCursor(null); void loadComments(); } else { requestId.current++; setCommentsLoading(false); } }, [user, activeTab, filter, commentSort]);
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

  async function loadComments(cursor?: string) {
    const request = ++requestId.current;
    setCommentsLoading(true);
    setCommentsError('');
    try {
      const response = await fetch(`/api/comments?${new URLSearchParams({ view: filter.length ? filter.join(',') : 'all', sort: commentSort, ...(cursor ? { before: cursor } : {}) })}`);
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

  const currentSort = activeTab === 'posts' ? postSort : commentSort;
  return (
    <Tabs value={activeTab} onValueChange={(value) => { const tab = value as keyof typeof workspacePaths; history.pushState(null, '', workspacePaths[tab]); setActiveTab(tab); }} className="workspace gap-0">
       <header className="workspace-header">
          <a href="/api/auth/home" aria-label="Comment Lookout home"><Brand /></a>
          <TabsList variant="line" className="workspace-nav" aria-label="Workspace views">
             <TabsTrigger value="comments"><span>Comments</span></TabsTrigger>
             <TabsTrigger value="posts"><span>Posts</span></TabsTrigger>
             <TabsTrigger value="settings"><span>Settings</span></TabsTrigger>
          </TabsList>
          {user && <AccountMenu user={user} />}
       </header>
       <main className="workspace-main">
         {error ? <Alert variant="destructive"><AlertDescription>We couldn't load your workspace. Refresh the page to try again.</AlertDescription></Alert> :
             <>
             {activeTab !== 'settings' && <TabsContent value={activeTab}>
               <div className="workspace-heading">
                   <h1>{activeTab === 'posts' ? 'Posts' : 'Comments'}</h1>
                  <ToggleGroup multiple value={filter.length ? filter : ['all']} onValueChange={(values) => setFilter(filter.length && values.includes('all') ? [] : (['hidden', 'replies'] as const).filter((item) => values.includes(item)))} variant="outline" size="sm" aria-label={`Filter ${activeTab} by status`} className="workspace-filter-chips">
                    <ToggleGroupItem value="all">All</ToggleGroupItem><ToggleGroupItem value="hidden">Hidden</ToggleGroupItem><ToggleGroupItem value="replies">Needs reply</ToggleGroupItem>
                  </ToggleGroup>
                  <div className="workspace-heading-actions">
                   <DropdownMenu modal={false}>
                     <DropdownMenuTrigger render={<button className="workspace-sort-trigger" type="button" aria-label={`Sort ${activeTab} by ${currentSort === 'newest' ? 'recent' : 'oldest'}`} />}><HugeiconsIcon icon={SortByDown01Icon} aria-hidden="true" />{currentSort === 'newest' ? 'Recent' : 'Oldest'}</DropdownMenuTrigger>
                     <DropdownMenuContent align="end" className="w-[100px] min-w-0"><DropdownMenuGroup><DropdownMenuRadioGroup value={currentSort} onValueChange={(value) => { if (activeTab === 'posts') setPostSort(value as typeof postSort); else setCommentSort(value as typeof commentSort); }}><DropdownMenuRadioItem value="newest">Recent</DropdownMenuRadioItem><DropdownMenuRadioItem value="oldest">Oldest</DropdownMenuRadioItem></DropdownMenuRadioGroup></DropdownMenuGroup></DropdownMenuContent>
                   </DropdownMenu>
                    <Button variant="outline" type="button" disabled={activeTab === 'comments' && commentsLoading} onClick={() => { if (activeTab === 'posts') setPostsRefresh(current => current + 1); else void loadComments(); }}><HugeiconsIcon icon={Refresh01Icon} data-icon="inline-start" aria-hidden="true" />Refresh</Button></div>
              </div>
               {activeTab === 'posts' && user && <PostsTable sort={postSort} filter={filter.join(',')} accounts={connection?.accounts || []} refresh={postsRefresh} />}
               {activeTab === 'comments' && <>
               {comments.length > 0 && <Card className="workspace-inbox"><CardContent className="workspace-inbox-content"><CommentsTable comments={comments} onRefresh={() => { void loadComments(); }} repliesFilter={filter.includes('replies')} hiddenOnly={filter.length === 1 && filter[0] === 'hidden'} onSent={(comment, status, attempt, message) => setComments(current => filter.includes('replies') && status === 'sent' ? current.filter(item => item.accountId !== comment.accountId || item.id !== comment.id) : current.map(item => item.accountId === comment.accountId && item.id === comment.id ? { ...item, replyStatus: status, replyAttempt: attempt ?? null, replyMessage: message ?? null, needsReply: false } : item))} /></CardContent></Card>}
                  {connection && !commentsLoading && !commentsError && comments.length === 0 && <Empty className="workspace-empty-note"><EmptyHeader><EmptyTitle><h2>{filter.length === 1 && filter[0] === 'hidden' ? 'No hidden comments' : filter.length === 1 && filter[0] === 'replies' ? 'No replies to review' : filter.length ? 'No matching comments' : 'No comments yet'}</h2></EmptyTitle><EmptyDescription>{filter.length ? filter.length > 1 ? 'No comments match the selected statuses.' : filter[0] === 'hidden' ? 'Hidden comments will appear here when available.' : 'Comments selected for a reply will appear here.' : connection.connected ? 'We’re scanning recent posts. New comments can take up to 10 minutes to appear.' : connectionError ? 'Check your Zernio connection and try again.' : 'Connect Zernio to start seeing your comments.'}</EmptyDescription></EmptyHeader></Empty>}
              {commentsLoading && <div className="workspace-loading" role="status" aria-label="Loading comments"><Skeleton className="h-28 w-full" /><Skeleton className="h-28 w-full" /><Skeleton className="h-28 w-full" /></div>}
              {commentsError && <Alert variant="destructive"><AlertDescription>{commentsError} <Button variant="outline" type="button" onClick={() => loadComments(nextCursor || undefined)}>Retry</Button></AlertDescription></Alert>}
                {nextCursor && !commentsError && <Button className="workspace-load-more" variant="outline" type="button" disabled={commentsLoading} onClick={() => loadComments(nextCursor)}>Load more</Button>}
               </>}
              </TabsContent>}
              {activeTab === 'settings' && <TabsContent value="settings">
                <div className="workspace-heading"><h1>Settings</h1></div>
                {user && connection ? <Card id="accounts" className="workspace-next">
                <CardHeader><CardTitle><h2>{connection.connected ? 'Your accounts' : 'Connect Zernio'}</h2></CardTitle><CardDescription>{connection.connected ? 'We monitor new posts published after your accounts are connected. We also scan the three most recent posts from before you connected them. Comments are kept for 365 days.' : 'Sign in as your Zernio team owner to connect your accounts.'}</CardDescription></CardHeader>
                  <CardContent>
                    {connection.connected ? connection.accounts.length ? <ul className="workspace-accounts">{connection.accounts.map((account) => <li key={account.id}>
                    <Avatar size="lg"><AvatarImage src={account.profilePicture || undefined} alt={`${account.username} profile picture`} referrerPolicy="no-referrer" /><AvatarFallback><HugeiconsIcon icon={account.platform === 'instagram' ? InstagramIcon : YoutubeIcon} aria-hidden="true" /></AvatarFallback></Avatar>
                      <span><strong>{account.username}</strong><small>{account.platform}</small></span>
                       <p className="workspace-backfill-status">{backfillStatus(backfill.find((item) => item.accountId === account.id))}</p>
                       <ModerationSetting account={account} initial={connection.moderation?.[account.id]} />
                  </li>)}</ul> : <p>No Instagram or YouTube accounts connected yet. <a href="https://zernio.com" target="_blank" rel="noopener noreferrer">Connect one in Zernio</a>, then refresh this page.</p> : !connectionError && <a className={buttonVariants()} href="/api/zernio/connect">Connect Zernio</a>}
                  {connectionError && <Alert variant="destructive"><AlertDescription>{connectionError} <Button variant="outline" type="button" onClick={() => location.reload()}>Retry</Button></AlertDescription></Alert>}
                  {backfillError && <p role="alert">Could not load scan progress. <Button variant="outline" type="button" onClick={() => loadBackfill()}>Retry</Button></p>}
                </CardContent>
                 <CardFooter className="workspace-account-footer">{connection.connected ? <Button variant="outline" type="button" onClick={disconnect}><HugeiconsIcon icon={LinkOffIcon} data-icon="inline-start" aria-hidden="true" />Disconnect Zernio</Button> : <p>Read-only monitoring begins when you connect.</p>}</CardFooter>
                </Card> : <div className="workspace-loading" role="status" aria-label="Loading settings"><Skeleton className="h-56 w-full" /><Skeleton className="h-36 w-full" /></div>}
              </TabsContent>}
             </>}
       </main>
       <SiteFooter />
    </Tabs>
  );
}
