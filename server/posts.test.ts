import { expect, test } from 'bun:test';

test('posts paginate independently of comments, include empty posts and isolate tenants and account IDs', () => {
  const result = Bun.spawnSync([process.execPath, '-e', `
    import assert from 'node:assert/strict';
    globalThis.fetch=()=>{throw new Error('Network forbidden');};
    const {db,createSession}=await import('./server/db.ts');
    const {zernio}=await import('./server/zernio.ts');
    const alice=createSession('posts-alice','a@example.com','Alice'), bob=createSession('posts-bob','b@example.com','Bob');
    for(const user of [alice.user,bob.user]) {
      for(const account of ['account','other']) db.prepare('INSERT INTO monitored_accounts VALUES (?, ?, ?, ?)').run(user.id,account,'instagram','2026-01-01T00:00:00Z');
      for(let i=0;i<53;i++) db.prepare('INSERT INTO monitored_posts (user_id,account_id,post_id,content,created_at) VALUES (?, ?, ?, ?, ?)').run(user.id,'account','post-'+i,'Caption '+i,i===52?null:'2026-01-01T00:00:00Z');
      db.prepare('INSERT INTO monitored_posts (user_id,account_id,post_id,content) VALUES (?, ?, ?, ?)').run(user.id,'other','post-0','Other account');
    }
    const insert=db.prepare('INSERT INTO synced_comments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for(let i=0;i<52;i++) insert.run(alice.user.id,'account','post-0','comment-'+String(i).padStart(2,'0'),i?'comment-00':null,'Message '+i,'Alice visitor','2026-01-02T00:00:00Z',i===51?1:0);
    insert.run(alice.user.id,'other','post-0','other-comment',null,'Other','Other','2026-01-02T00:00:00Z',0);
    insert.run(bob.user.id,'account','post-0','private-comment',null,'Private','Bob','2026-01-02T00:00:00Z',1);
    db.prepare("INSERT INTO comment_assessments (user_id,account_id,comment_id,classified_message,category,needs_reply) VALUES (?,'account','comment-00','Message 0','safe',1)").run(alice.user.id);
    const headers={Cookie:'cl_session='+alice.token};
    const get=async path=>{const r=await zernio.request(path,{headers});assert.equal(r.status,200);return r.json();};
    for(const sort of ['newest','oldest']) {
      const first=await get('/api/posts?sort='+sort);assert.equal(first.posts.length,50);assert.ok(first.nextCursor);
      const second=await get('/api/posts?sort='+sort+'&before='+encodeURIComponent(first.nextCursor));
      assert.equal(second.posts.length,4);assert.equal(second.nextCursor,null);
      const all=[...first.posts,...second.posts];
      assert.equal(new Set(all.map(p=>p.accountId+':'+p.id)).size,54);
      const summary=all.find(p=>p.accountId==='account'&&p.id==='post-0');
      assert.equal(summary.commentCount,52);assert.equal(summary.hiddenCount,1);assert.equal(summary.needsReplyCount,1);
      assert.ok(all.some(p=>p.commentCount===0));assert.equal(all.at(-1).createdAt,null);
    }
    for(const filter of ['hidden','replies','hidden,replies']) {
      const filtered=await get('/api/posts?view='+filter);assert.equal(filtered.posts.length,1);assert.equal(filtered.posts[0].accountId,'account');assert.equal(filtered.posts[0].id,'post-0');
    }
    const query='/api/comments?accountId=account&postId=post-0&sort=oldest';
    const first=await get(query),second=await get(query+'&before='+encodeURIComponent(first.nextCursor));
    assert.equal(first.comments.length,50);assert.equal(second.comments.length,2);assert.equal(second.nextCursor,null);
    assert.equal(new Set([...first.comments,...second.comments].map(c=>c.id)).size,52);
    assert.ok([...first.comments,...second.comments].every(c=>c.accountId==='account'&&c.postId==='post-0'));
    assert.equal(first.comments[0].id,'comment-00');assert.equal(second.comments[0].parentId,'comment-00');
    assert.equal((await get('/api/comments?accountId=foreign&postId=post-0')).comments.length,0);
    const bobPosts=await (await zernio.request('/api/posts?view=hidden',{headers:{Cookie:'cl_session='+bob.token}})).json();
    assert.equal(bobPosts.posts[0].commentCount,1);
    for(const path of ['/api/posts?before=bad','/api/posts?sort=invalid','/api/posts?view=invalid','/api/comments?accountId=account','/api/comments?postId=post-0','/api/comments?accountId=&postId=post-0']) assert.equal((await zernio.request(path,{headers})).status,400);
    assert.equal((await zernio.request('/api/posts')).status,401);
    assert.equal((await zernio.request(query)).status,401);
  `], { cwd: process.cwd(), env: { ...process.env, DATABASE_PATH: ':memory:', ZERNIO_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64') }, stdout: 'pipe', stderr: 'pipe' });
  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toEqual({ exitCode: 0, stderr: '' });
});
