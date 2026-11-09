import './landing.css';
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

export function App() {
  return <div className="site">
    <a className="skip-link" href="#top">Skip to content</a>
    <header className="site-header">
      <a href="#top" aria-label="Comment Lookout, back to top"><Brand /></a>
      <nav aria-label="Main navigation"><a href="#how-it-works">How it works</a><a href="#workspace">The workspace</a></nav>
       <a className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'header-action')} href="/api/auth/start">Get Started</a>
    </header>

    <main id="top" tabIndex={-1}>
      <section className="hero" aria-labelledby="hero-title">
        <h1 id="hero-title">Hide spam comments.<br /><span>Reply to the ones that matter.</span></h1>
        <p>Comment Lookout brings new Instagram and YouTube comments into one inbox through Zernio. Moderation and reply drafts are planned; nothing is hidden or sent automatically today.</p>
        <div className="hero-actions"><a className={buttonVariants({ size: 'lg' })} href="/api/auth/start">Get Started</a></div>
        <p className="hero-note">Built on top of <a href="https://zernio.com/">Zernio</a></p>
      </section>

      <section className="story" id="how-it-works" aria-labelledby="story-title">
        <h2 id="story-title">From connection to conversation.</h2>
        <div className="steps">
          <Card className="step"><CardHeader><span className="step-number">1</span><CardTitle><h3>Connect Zernio</h3></CardTitle></CardHeader><CardContent><p>Connect your Zernio team. Your Instagram and YouTube accounts stay managed there.</p></CardContent></Card>
          <Card className="step"><CardHeader><span className="step-number">2</span><CardTitle><h3>Approve moderation</h3></CardTitle></CardHeader><CardContent><p>Planned: after your confirmation, clear spam, scams, and explicit profanity can be hidden or rejected on new comments. Uncertain comments wait for you.</p></CardContent></Card>
          <Card className="step"><CardHeader><span className="step-number">3</span><CardTitle><h3>Review and reply</h3></CardTitle></CardHeader><CardContent><p>Planned: review flagged questions, edit a suggested reply, and click Send yourself when it sounds right.</p></CardContent></Card>
        </div>
      </section>

      <section className="workspace-section" id="workspace" aria-labelledby="workspace-title">
        <div className="workspace-intro"><h2 id="workspace-title">The comments that need you, in one place.</h2><p>The live inbox shows comments beside their posts. Moderation, drafts, and sending replies are still in development.</p></div>
        <div className="mock-app" aria-label="Illustrative preview of a comment review workspace">
          <div className="mock-top"><span className="mock-logo">◉ &nbsp;lookout</span><span>Overview &nbsp; / &nbsp; Review queue</span><span className="mock-avatar">AB</span></div>
          <div className="mock-body"><div className="mock-sidebar"><span className="active">◫ &nbsp; Review queue</span><span>◷ &nbsp; History</span><span>⚙ &nbsp; Settings</span></div><div className="mock-content"><div className="mock-heading"><div><small>Good morning</small><strong>Needs your eyes <span>✳</span></strong></div><span className="mock-pill">3 to review</span></div><div className="mock-comment"><div className="mock-comment-head"><span className="mock-initial">M</span><div><strong>maya.creates</strong><small>Instagram · 2 hours ago</small></div><span className="mock-tag">Question</span></div><p>Does this come in the smaller size too? I love the color!</p><div className="mock-reply"><small>Suggested reply · Edit before sending</small><span>It does! The smaller size is available in this color too.</span></div><div className="mock-controls"><span>Dismiss</span><span className="mock-send">Review draft</span></div></div><div className="mock-row"><span className="mock-initial second">J</span><span>jordan.and.co &nbsp; <small>“This was exactly what I needed…”</small></span><span className="mock-tag">Kind words</span></div></div></div>
        </div>
        <p className="workspace-footnote">Illustrative preview. The review queue and drafts shown above are not active yet.</p>
      </section>
      <section className="closing" aria-labelledby="closing-title">
        <h2 id="closing-title">Ready to keep up with your comments?</h2>
         <a className={buttonVariants({ size: 'lg' })} href="/api/auth/start">Get Started</a>
      </section>
    </main>
    <footer id="page-end"><Brand /><span>Sign in with Google. Connect your accounts through Zernio.</span><span>Read-only monitoring available now.</span></footer>
  </div>;
}
