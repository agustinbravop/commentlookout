# Comment Lookout design

- **Direction:** Light, warm social-media product UI. Borrow Zernio's orange warmth and NapoleonCat's straightforward product presentation without copying either. Keep the page approachable, not editorial.
- **Logo:** The chosen Round binoculars: two black circular frames tilted 8° counterclockwise, with off-white lenses and subtle black rear barrels angled inward toward the center. Each lens is 10% taller than it is wide. No orange pupils. Pair with the lowercase `comment lookout.` wordmark.
- **Palette and type:** Peach hero/header `#fff3eb`, near-white page `#fffaf6`, charcoal text `#302c2a`, burnt-orange accent `#bc4e2c`. Use DM Sans; avoid serif display fonts and eyebrow labels.
- **Layout:** Short header matching the hero background. Center the hero copy with no large illustration. Keep “Reply to the ones that matter.” on one line, including at mobile sizes. Follow with a three-step workflow and a clearly illustrative review-queue preview.
- **Story:** Lead with the value: “Hide spam comments. Reply to the ones that matter.” Explain the problem and Lookout's role plainly. The plan is connect Zernio, explicitly approve automatic moderation, then review and send replies yourself. End with a second Get Started CTA. No vague hooks or invented performance claims.
- **Actions:** Get Started routes through `/api/auth/start` to Google sign-in or `/home` for an existing session. “Built on top of Zernio” links to `https://zernio.com/`.
- **Product truth:** Automatic actions cover only clear spam, scams, and explicit profanity after confirmation. Uncertain comments wait for review. No reply is sent without a Send click. The mock workspace is not connected to accounts.

The landing page is served at `/`. The workspace at `/home` shares its color, typography, and branding; `chrome-extension/` remains separate.
