import { expect, test } from 'bun:test';

Bun.env.DATABASE_PATH = ':memory:';
Bun.env.OPENAI_API_KEY = 'test-key';
const { db, createSession } = await import('./db');
const { zernio } = await import('./zernio');
const { analyzeComments, decide } = await import('./analyze');
const { archiveOldComments } = await import('./sync');

test('only safe comments get drafts; jobs retry, isolate workspaces and preserve edits', async () => {
  expect(decide({ spam: false, scam: false, profanity: false, suspicious_link: true, question: true, mentions_account: false, enthusiastic: false, uncertain: false, reason: 'Unknown link' }))
    .toEqual({ category: 'suspicious_link', reason: 'Unknown link', needsReply: false });
  expect(decide({ spam: true, scam: false, profanity: false, suspicious_link: false, question: true, mentions_account: false, enthusiastic: false, uncertain: true, reason: 'Quoted example' }))
    .toEqual({ category: 'review', reason: 'Quoted example', needsReply: false });
  expect(decide({ spam: false, scam: false, profanity: true, suspicious_link: false, question: false, mentions_account: false, enthusiastic: false, uncertain: false, reason: 'Explicit' }).category).toBe('profanity');
  const alice = createSession('analysis-alice', 'alice@example.com', 'Alice');
  const bob = createSession('analysis-bob', 'bob@example.com', 'Bob');
  const account = '111111111111111111111111';
  for (const session of [alice, bob]) {
    db.prepare('INSERT INTO zernio_connections VALUES (?, ?, ?, ?, ?)').run(session.user.id, session.user.id, 'token', 'token', 9999999999);
    db.prepare('INSERT INTO monitored_accounts VALUES (?, ?, ?, ?)').run(session.user.id, account, 'instagram', new Date().toISOString());
    db.prepare('INSERT INTO monitored_posts (user_id, account_id, post_id, content, pending) VALUES (?, ?, ?, ?, 0)').run(session.user.id, account, 'post', 'Caption');
    db.prepare('INSERT INTO synced_comments VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 0)')
      .run(session.user.id, account, 'post', session === alice ? 'question' : 'link', session === alice ? 'Can you help?' : 'Visit https://bad.example', 'Visitor', new Date().toISOString());
  }
  const aliceHeaders = { Cookie: `cl_session=${alice.token}`, Origin: 'http://localhost' };
  expect((await zernio.request('/api/accounts/*/voice', { method: 'PUT', headers: aliceHeaders, body: JSON.stringify({ instructions: 'Default voice' }) })).status).toBe(400);
  expect((await zernio.request(`/api/accounts/${account}/voice`, { method: 'PUT', headers: aliceHeaders, body: JSON.stringify({ instructions: 'Alice voice' }) })).status).toBe(200);
  expect(db.prepare('SELECT count(*) AS count FROM brand_voices WHERE user_id = ?').get(bob.user.id)).toEqual({ count: 0 });
  const originalFetch = globalThis.fetch;
  let fail = true;
  let draftCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe('https://api.openai.com/v1/responses');
    const request = JSON.parse(String(init?.body)) as { input: string; text: unknown; store: boolean };
    expect(request.store).toBe(false);
    expect(request.text).toBeTruthy();
    const data = JSON.parse(request.input) as { comment: string; brand_voice?: string };
    if (fail) return Response.json({}, { status: 503 });
    const isDraft = 'brand_voice' in data;
    if (isDraft) expect(data.brand_voice).toBe('Alice voice');
    if (isDraft) draftCalls++;
    const output = isDraft ? { draft: 'Happy to help!' } : { spam: false, scam: false, profanity: false, suspicious_link: data.comment.includes('https://'),
      question: data.comment.includes('?'), mentions_account: false, enthusiastic: false, uncertain: false, reason: 'Checked' };
    return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(output) }] }] });
  }) as typeof fetch;
  try {
    await analyzeComments();
    expect(db.prepare('SELECT count(*) AS count FROM comment_assessments WHERE user_id IN (?, ?)').get(alice.user.id, bob.user.id)).toEqual({ count: 2 });
    db.prepare('UPDATE comment_assessments SET next_attempt_at = 0 WHERE user_id IN (?, ?)').run(alice.user.id, bob.user.id);
    fail = false;
    await analyzeComments();
    expect(draftCalls).toBe(1);
    const headers = aliceHeaders;
    const inbox = await (await zernio.request('/api/comments?view=replies', { headers })).json() as { comments: { id: string }[] };
    expect(inbox.comments.map((comment) => comment.id)).toContain('question');
    expect(db.prepare('SELECT draft FROM comment_assessments WHERE user_id = ? AND comment_id = ?').get(alice.user.id, 'question')).toEqual({ draft: 'Happy to help!' });
    expect(inbox.comments[0]).toMatchObject({ id: 'question', draft: 'Happy to help!' });
    expect((await (await zernio.request('/api/comments?view=all', { headers })).json() as { comments: { id: string }[] }).comments.map((comment) => comment.id)).toContain('question');
    expect((await (await zernio.request('/api/comments?view=hidden', { headers })).json() as { comments: unknown[] }).comments).toEqual([]);
    const saved = await zernio.request(`/api/comments/${account}/question/draft`, { method: 'PUT', headers,
      body: JSON.stringify({ draft: 'My own answer' }) });
    expect(saved.status).toBe(200);
    expect((await zernio.request(`/api/comments/${account}/link/draft`, { method: 'PUT', headers,
      body: JSON.stringify({ draft: 'Wrong account' }) })).status).toBe(404);
    db.prepare('UPDATE synced_comments SET message = ? WHERE user_id = ? AND comment_id = ?').run('Can you help now?', alice.user.id, 'question');
    expect((await (await zernio.request('/api/comments?view=replies', { headers })).json() as { comments: { id: string }[] }).comments.map((comment) => comment.id)).not.toContain('question');
    await analyzeComments();
    expect(db.prepare('SELECT draft FROM comment_assessments WHERE user_id = ? AND comment_id = ?').get(alice.user.id, 'question')).toEqual({ draft: 'My own answer' });
    db.prepare('UPDATE synced_comments SET is_hidden = 1 WHERE user_id = ? AND comment_id = ?').run(bob.user.id, 'link');
    expect((await (await zernio.request('/api/comments?view=hidden', { headers: { Cookie: `cl_session=${bob.token}` } })).json() as { comments: { id: string; category: string }[] }).comments[0]).toMatchObject({ id: 'link', category: 'suspicious_link' });
    db.prepare('UPDATE synced_comments SET created_at = ? WHERE user_id = ? AND comment_id = ?').run('2020-01-01T00:00:00Z', alice.user.id, 'question');
    archiveOldComments();
    expect((await (await zernio.request('/api/archived-drafts', { headers })).json() as { drafts: Archived[] }).drafts[0].draft).toBe('My own answer');
    expect((await (await zernio.request('/api/archived-drafts', { headers: { Cookie: `cl_session=${bob.token}` } })).json() as { drafts: unknown[] }).drafts).toEqual([]);
    expect((await zernio.request(`/api/drafts/${account}/question`, { method: 'DELETE', headers: { Cookie: `cl_session=${bob.token}`, Origin: 'http://localhost' } })).status).toBe(404);
    expect((await zernio.request(`/api/drafts/${account}/question`, { method: 'DELETE', headers })).status).toBe(200);
    expect((await (await zernio.request('/api/archived-drafts', { headers })).json() as { drafts: unknown[] }).drafts).toEqual([]);
    db.prepare('INSERT INTO synced_comments VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 0)')
      .run(alice.user.id, account, 'post', 'new-question', 'What next?', 'Visitor', new Date().toISOString());
    db.prepare(`INSERT INTO comment_assessments (user_id, account_id, comment_id, classified_message, category, needs_reply, draft)
      VALUES (?, ?, ?, ?, 'safe', 1, ?)`).run(alice.user.id, account, 'new-question', 'What next?', 'A draft');
    expect((await zernio.request(`/api/drafts/${account}/new-question`, { method: 'DELETE', headers })).status).toBe(200);
    await analyzeComments();
    expect((await (await zernio.request('/api/comments?view=replies', { headers })).json() as { comments: { id: string }[] }).comments.map((comment) => comment.id)).not.toContain('new-question');
  } finally { globalThis.fetch = originalFetch; }
});

type Archived = { draft: string };

test('classifies without drafting neutral, unsafe, hidden or already answered comments', async () => {
  const { user } = createSession('analysis-cases', 'cases@example.com', 'Cases');
  const account = '999999999999999999999999';
  db.prepare('INSERT INTO zernio_connections VALUES (?, ?, ?, ?, ?)').run(user.id, 'cases-owner', 'token', 'token', 9999999999);
  db.prepare('INSERT INTO monitored_accounts VALUES (?, ?, ?, ?)').run(user.id, account, 'instagram', new Date().toISOString());
  db.prepare('INSERT INTO monitored_posts (user_id, account_id, post_id, content, pending) VALUES (?, ?, ?, ?, 0)').run(user.id, account, 'post', 'Caption');
  for (const id of ['neutral', 'spam', 'hidden', 'answered', 'question']) {
    db.prepare('INSERT INTO synced_comments VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)')
      .run(user.id, account, 'post', id, id, 'Visitor', new Date().toISOString(), Number(id === 'hidden'));
  }
  db.prepare('INSERT INTO owner_replies VALUES (?, ?, ?)').run(user.id, account, 'answered');
  const original = globalThis.fetch;
  const drafts: string[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).input) as { comment: string; brand_voice?: string };
    const draft = 'brand_voice' in data;
    if (draft) drafts.push(data.comment);
    const result = draft ? { draft: 'Thanks for asking!' } : { spam: data.comment === 'spam', scam: false, profanity: false, suspicious_link: false,
      question: !['spam', 'neutral'].includes(data.comment), mentions_account: false, enthusiastic: false, uncertain: false, reason: 'Checked' };
    return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(result) }] }] });
  }) as typeof fetch;
  try {
    await analyzeComments();
    expect(drafts).toEqual(['question']);
    const rows = db.prepare('SELECT comment_id, category, needs_reply, draft FROM comment_assessments WHERE user_id = ? ORDER BY comment_id').all(user.id);
    expect(rows).toEqual([
      { comment_id: 'answered', category: 'safe', needs_reply: 1, draft: null },
      { comment_id: 'hidden', category: 'safe', needs_reply: 1, draft: null },
      { comment_id: 'neutral', category: 'safe', needs_reply: 0, draft: null },
      { comment_id: 'question', category: 'safe', needs_reply: 1, draft: 'Thanks for asking!' },
      { comment_id: 'spam', category: 'spam', needs_reply: 0, draft: null },
    ]);
  } finally { globalThis.fetch = original; }
});
