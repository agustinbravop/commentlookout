import { expect, test } from 'bun:test';

test('explicit webhook consent preserves default scopes, PKCE and strict opt-in without network calls', () => {
  const result = Bun.spawnSync([process.execPath, '-e', `
    import assert from 'node:assert/strict';
    globalThis.fetch=()=>{throw new Error('Network forbidden');};
    const {db,createSession}=await import('./server/db.ts');
    const {zernio}=await import('./server/zernio.ts');
    const {token,user}=createSession('consent-test','fixture@example.com','Fixture');
    db.prepare('INSERT INTO zernio_clients VALUES (?, ?)').run(Bun.env.ZERNIO_REDIRECT_URI,'fixture-client');
    const headers={Cookie:'cl_session='+token};
    for(const query of ['', '?webhooks=1']) {
      const response=await zernio.request('/api/zernio/connect'+query,{headers});
      assert.equal(response.status,302);
      const url=new URL(response.headers.get('location'));
      assert.equal(url.origin+url.pathname,'https://zernio.com/oauth/authorize');
      assert.equal(url.searchParams.get('scope'),'accounts:read posts:read messaging:write'+(query?' automations:write':''));
      assert.equal(url.searchParams.get('redirect_uri'),Bun.env.ZERNIO_REDIRECT_URI);
      assert.equal(url.searchParams.get('code_challenge_method'),'S256');
      const state=url.searchParams.get('state');
      const attempt=db.prepare('SELECT * FROM zernio_attempts WHERE state_hash=?').get(Bun.CryptoHasher.hash('sha256',state,'hex'));
      assert.equal(attempt.user_id,user.id);
      assert.equal(url.searchParams.get('code_challenge'),Bun.CryptoHasher.hash('sha256',attempt.verifier).toString('base64url'));
      assert.ok(response.headers.get('set-cookie').includes('cl_zernio_oauth='+state+';'));
    }
    const before=db.prepare('SELECT count(*) AS n FROM zernio_attempts').get().n;
    for(const query of ['webhooks=','webhooks=0','webhooks=true','webhooks=1&webhooks=1','webhooks=0&webhooks=1']) {
      assert.equal((await zernio.request('/api/zernio/connect?'+query,{headers})).status,400);
    }
    assert.equal(db.prepare('SELECT count(*) AS n FROM zernio_attempts').get().n,before);
    assert.equal(db.prepare('SELECT count(*) AS n FROM zernio_connections').get().n,0);
    const guest=await zernio.request('/api/zernio/connect?webhooks=1');
    assert.equal(guest.headers.get('location'),'/api/auth/google');
  `], { cwd: process.cwd(), env: { ...process.env, DATABASE_PATH: ':memory:',
    ZERNIO_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'),
    ZERNIO_REDIRECT_URI: 'http://localhost:3000/api/zernio/callback' }, stdout: 'pipe', stderr: 'pipe' });
  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toEqual({ exitCode: 0, stderr: '' });
});
