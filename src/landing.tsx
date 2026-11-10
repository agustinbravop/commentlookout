import { useEffect, useState } from 'react';
import './landing.css';
import { AccountMenu, type SignedInUser } from './account-menu';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export function Brand() {
  return <span className="brand-lockup" translate="no">
    <svg className="brand-icon" viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <g transform="translate(0 2.5) rotate(-8 24 25)">
        <path d="M10 9 A4.5 4.5 0 0 1 19 9 C20 11 23 13 25 19 L25 24 Q25 33 14.5 33 Q4 33 4 24 L4 19 C6 13 9 11 10 9 Z" fill="currentColor" />
        <path d="M29 9 A4.5 4.5 0 0 1 38 9 C39 11 42 13 44 19 L44 24 Q44 33 33.5 33 Q23 33 23 24 L23 19 C25 13 28 11 29 9 Z" fill="currentColor" />
        <path d="M21 22h6" stroke="currentColor" strokeWidth="6" strokeLinecap="round" />
        <ellipse cx="13" cy="25" rx="11" ry="12.1" fill="currentColor" />
        <ellipse cx="35" cy="25" rx="11" ry="12.1" fill="currentColor" />
        <ellipse cx="13" cy="25" rx="6" ry="6.6" fill="#fff9f4" />
        <ellipse cx="35" cy="25" rx="6" ry="6.6" fill="#fff9f4" />
      </g>
    </svg>
    <span>comment lookout<span className="brand-period">.</span></span>
  </span>;
}

export function SiteFooter() {
  return <footer id="page-end"><Brand /><span>Built on top of <a href="https://zernio.com/">Zernio</a></span><span>by <a href="https://agusbravo.dev/">agustinbravop</a></span></footer>;
}

export function App() {
  const [user, setUser] = useState<SignedInUser | null>();
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/me', { signal: controller.signal }).then(async (response) => {
      if (response.status === 401) return null;
      if (!response.ok) throw new Error('Could not check session');
      return response.json() as Promise<SignedInUser>;
    }).then(setUser).catch(() => { if (!controller.signal.aborted) setUser(null); });
    return () => controller.abort();
  }, []);
  return <div className="site">
    <a className="skip-link" href="#top">Skip to content</a>
    <header className="site-header">
       <a href="/api/auth/home" aria-label="Comment Lookout home"><Brand /></a>
       {user ? <AccountMenu user={user} /> : user === null ? <a className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'header-action')} href="/api/auth/start">Get Started</a> : null}
    </header>

    <main id="top" tabIndex={-1}>
      <section className="hero" aria-labelledby="hero-title">
        <h1 id="hero-title">We hide spam comments.<br /><span>You reply to the ones that matter.</span></h1>
        <p>Keep your Instagram comment sections clean. We automatically remove the junk so you can send replies to meaningful comments in your own words.</p>
        <div className="hero-actions"><a className={buttonVariants({ size: 'lg' })} href="/api/auth/start">Get Started</a></div>
      </section>

      <section className="story" id="how-it-works" aria-labelledby="story-title">
        <h2 id="story-title">Get started in one minute</h2>
        <div className="steps">
          <Card className="step"><CardHeader><span className="step-number">1</span><CardTitle><h3>Connect Zernio</h3></CardTitle></CardHeader><CardContent><p>Sign in and connect your Zernio team. Your social accounts stay managed there.</p></CardContent></Card>
          <Card className="step"><CardHeader><span className="step-number">2</span><CardTitle><h3>Set preferences</h3></CardTitle></CardHeader><CardContent><p>Turn on automatic hiding for spam, scams and comments with profanity.</p></CardContent></Card>
          <Card className="step"><CardHeader><span className="step-number">3</span><CardTitle><h3>Reply</h3></CardTitle></CardHeader><CardContent><p>Respond to meaningful comments to stay connected to your audience.</p></CardContent></Card>
        </div>
      </section>

      <section className="workspace-section" id="workspace" aria-labelledby="workspace-title">
        <div className="workspace-intro"><h2 id="workspace-title">Never miss a relevant comment.</h2><p>Comment Lookout highlights comments that need a response and drafts a reply for you to review. You can customize a prompt so responses are drafted with brand-specific language and information.</p></div>
      </section>
      <section className="closing" aria-labelledby="closing-title">
        <h2 id="closing-title">Ready to keep up with your comments?</h2>
         <a className={buttonVariants({ size: 'lg' })} href="/api/auth/start">Get Started</a>
      </section>
    </main>
    <SiteFooter />
  </div>;
}
