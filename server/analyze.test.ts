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
    db.prepare('INSERT INTO monitored_posts VALUES (?, ?, ?, ?, 0)').run(session.user.id, account, 'post', 'Caption');
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
    const inbox = await (await zernio.request('/api/comments?view=replies', { headers })).json() as { comments: { draft: string }[] };
    expect(inbox.comments[0].draft).toBe('Happy to help!');
    expect((await (await zernio.request('/api/comments?view=all', { headers })).json() as { comments: { id: string }[] }).comments.map((comment) => comment.id)).toContain('question');
    expect((await (await zernio.request('/api/comments?view=review', { headers })).json() as { comments: unknown[] }).comments).toEqual([]);
    const saved = await zernio.request(`/api/comments/${account}/question/draft`, { method: 'PUT', headers,
      body: JSON.stringify({ draft: 'My own answer' }) });
    expect(saved.status).toBe(200);
    expect((await zernio.request(`/api/comments/${account}/link/draft`, { method: 'PUT', headers,
      body: JSON.stringify({ draft: 'Wrong account' }) })).status).toBe(404);
    db.prepare('UPDATE synced_comments SET message = ? WHERE user_id = ? AND comment_id = ?').run('Can you help now?', alice.user.id, 'question');
    expect((await (await zernio.request('/api/comments?view=replies', { headers })).json() as { comments: unknown[] }).comments).toEqual([]);
    await analyzeComments();
    expect((await (await zernio.request('/api/comments?view=replies', { headers })).json() as { comments: { draft: string }[] }).comments[0].draft).toBe('My own answer');
    expect((await (await zernio.request('/api/comments?view=review', { headers: { Cookie: `cl_session=${bob.token}` } })).json() as { comments: { id: string }[] }).comments[0].id).toBe('link');
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
    expect((await (await zernio.request('/api/comments?view=replies', { headers })).json() as { comments: unknown[] }).comments).toEqual([]);
  } finally { globalThis.fetch = originalFetch; }
});

type Archived = { draft: string };
