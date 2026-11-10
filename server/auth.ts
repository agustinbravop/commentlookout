import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import * as oidc from 'openid-client';
import { createSession, endSession, finishLogin, getUser, startLogin } from './db';

const redirectUri = Bun.env.GOOGLE_REDIRECT_URI;
const appOrigin = Bun.env.APP_ORIGIN;
const clientId = Bun.env.GOOGLE_CLIENT_ID;
const clientSecret = Bun.env.GOOGLE_CLIENT_SECRET;
if (redirectUri && !redirectUri.startsWith('https://') && !redirectUri.startsWith('http://localhost:')) {
  throw new Error('GOOGLE_REDIRECT_URI must use HTTPS or localhost');
}
if (appOrigin && !appOrigin.startsWith('https://') && !appOrigin.startsWith('http://localhost:')) {
  throw new Error('APP_ORIGIN must use HTTPS or localhost');
}
const secure = redirectUri?.startsWith('https://') ?? false;
const cookieOptions = { httpOnly: true, secure, sameSite: 'Lax' as const, path: '/' };
let config: Promise<oidc.Configuration> | undefined;
const google = () => config ??= oidc.discovery(new URL('https://accounts.google.com'), clientId!, clientSecret!);

export const auth = new Hono();
auth.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});

auth.get('/api/auth/start', (c) => getUser(getCookie(c, 'cl_session'))
  ? c.redirect(appOrigin ? `${new URL(appOrigin).origin}/home` : '/home')
  : c.redirect('/api/auth/google'));

auth.get('/api/auth/home', (c) => c.redirect(getUser(getCookie(c, 'cl_session')) ? '/home' : '/'));

auth.get('/api/auth/google', async (c) => {
  if (!clientId || !clientSecret || !redirectUri) return c.text('Google sign-in is not configured', 503);
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const verifier = oidc.randomPKCECodeVerifier();
  const challenge = await oidc.calculatePKCECodeChallenge(verifier);
  const url = oidc.buildAuthorizationUrl(await google(), {
    redirect_uri: redirectUri, scope: 'openid email profile', state, nonce,
    code_challenge: challenge, code_challenge_method: 'S256',
  });
  startLogin(state, verifier, nonce);
  setCookie(c, 'cl_oauth', state, { ...cookieOptions, maxAge: 600 });
  return c.redirect(url.href);
});

auth.get('/api/auth/google/callback', async (c) => {
  const state = c.req.query('state');
  if (!state || state !== getCookie(c, 'cl_oauth')) return c.text('Invalid sign-in attempt', 400);
  deleteCookie(c, 'cl_oauth', cookieOptions);
  const attempt = finishLogin(state);
  if (!attempt) return c.text('Sign-in expired; try again', 400);
  try {
    const callback = new URL(redirectUri!);
    callback.search = new URL(c.req.url).search;
    const tokens = await oidc.authorizationCodeGrant(await google(), callback, {
      expectedState: state, expectedNonce: attempt.nonce,
      pkceCodeVerifier: attempt.verifier, idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims?.sub || typeof claims.email !== 'string' || claims.email_verified !== true) return c.text('Verified Google email required', 403);
    const { token } = createSession(claims.sub, claims.email, typeof claims.name === 'string' ? claims.name : claims.email,
      typeof claims.picture === 'string' && /^https:\/\//i.test(claims.picture) ? claims.picture : null);
    setCookie(c, 'cl_session', token, { ...cookieOptions, maxAge: 60 * 60 * 24 * 7 });
    return c.redirect(appOrigin ? `${new URL(appOrigin).origin}/home` : '/home');
  } catch {
    return c.text('Google sign-in failed; try again', 400);
  }
});

auth.get('/api/me', (c) => {
  const user = getUser(getCookie(c, 'cl_session'));
  return user ? c.json(user) : c.json({ error: 'Unauthenticated' }, 401);
});

auth.post('/api/auth/logout', (c) => {
  if (c.req.header('origin') !== new URL(redirectUri || c.req.url).origin && c.req.header('origin') !== new URL(appOrigin || c.req.url).origin) return c.text('Invalid origin', 403);
  endSession(getCookie(c, 'cl_session'));
  deleteCookie(c, 'cl_session', cookieOptions);
  return c.redirect('/');
});
