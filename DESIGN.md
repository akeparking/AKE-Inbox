# AKE Revenue CRM Design System

## 1. Visual Theme & Atmosphere

An operational control desk for an overseas B2B sales team: calm, precise, and evidence-led. The interface borrows Linear's surface hierarchy and dense product framing, plus Sentry's clear operational states, without copying either brand. The memorable element is the vertical acquisition-to-revenue signal rail that shows exactly where an ad lead sits and whether Qualified feedback reached the ad platform.

Design dials: variance 7, motion 5, density 6. Use asymmetry on desktop and a strict single column below 768px.

## 2. Color Palette & Roles

- Canvas: `#0d1110`
- Raised surface: `#131917`
- Hover surface: `#18211e`
- Hairline: `#26312d`
- Strong hairline: `#3a4742`
- Primary ink: `#edf3f0`
- Secondary ink: `#9eaaa5`
- Muted ink: `#6f7c77`
- Single accent / accepted / active: `#5da883`
- Warning: `#d2a85b`
- Error: `#c76f66`
- Information is expressed with contrast and shape first; semantic colors remain sparse.

No purple gradients, neon glows, pure black, or decorative multicolor charts.

## 3. Typography Rules

- UI and headings: Geist Sans, with a locally safe sans-serif fallback.
- IDs, timestamps, metrics, and platform identifiers: Geist Mono.
- Page title: 30–36px, weight 600, tight tracking.
- Section title: 18–22px, weight 600.
- Body: 14px, line height 1.5.
- Caption: 12px, muted.
- Dashboard text is always sans-serif; serif faces are forbidden.

## 4. Component Stylings

- Buttons and inputs use 8px radius; major panels use 12px.
- Default organization uses dividers and negative space. Cards are reserved for elevated context such as a selected lead or actionable failure.
- Status chips are compact and never use oversized pills.
- Labels sit above inputs; helper and error copy sit below.
- Tables use a 44px minimum row height and monospaced IDs.
- Buttons include hover, focus-visible, disabled, loading, and pressed states.
- Every data surface provides loading skeleton, empty, and inline error states.

## 5. Layout Principles

- Desktop shell: 232px navigation, flexible workspace, optional 360px contextual rail.
- Content width: `max-width: 1440px` with 24–32px gutters.
- Dashboard metrics form a 2fr/1fr asymmetric grid, not three identical cards.
- Lead lists remain scannable; the conversion delivery center uses a table plus a right-side event inspector.
- Chatwoot embed uses the same components in a narrower 360px layout.

## 6. Depth & Elevation

- Depth comes from a four-step dark surface ladder and 1px borders.
- Do not use broad outer shadows. Modals may use one tinted diffusion shadow.
- Focus uses a 2px accent outline with 35% opacity.

## 7. Do's and Don'ts

Do:

- Show source evidence, timestamps, owners, and diagnostic state near every decision.
- Separate API acceptance from platform matching.
- Use realistic AKE-adjacent sample companies and irregular metrics.
- Use one accent color for primary actions and healthy signal flow.

Don't:

- Hide failed feedback behind a generic success state.
- Use gradients, glowing borders, oversized hero headings, emojis, or generic avatar eggs.
- Fill the dashboard with equal-size cards.
- expose full ad identifiers or customer PII in the UI.

## 8. Responsive Behavior

- Below 1024px, hide the context rail behind a drawer.
- Below 768px, navigation becomes a top bar; grids become one column and tables switch to stacked rows.
- Touch targets are at least 44px.
- Avoid horizontal page overflow; identifier cells may scroll internally.

## 9. Agent Prompt Guide

Build a sober dark operations interface for an overseas B2B revenue team. Use Geist, charcoal green-tinted surfaces, a single desaturated emerald accent, monospaced evidence fields, divider-led grouping, and an asymmetric desktop layout. Emphasize the Lead-to-Qualified signal rail, source provenance, and conversion diagnostics. Avoid generic SaaS cards, purple gradients, neon, emojis, and fake-perfect metrics.

## Website widget branding

The restored legacy AKE website uses red `#da251d`. Its Chatwoot website channel,
launcher and brand mark follow that color. Use the supplied legacy AKE logo for
the installation header. The widget footer reads `Powered by AKE Parking` on a
single line, including at 320px. The Inbox installation title remains `AKE Inbox`.

## Reception and customer chat

The native Chatwoot reception desk retains its light workspace, existing conversation
columns and Chinese interface. Group channel navigation separately from customer and
channel settings; keep a clearly labelled online/pause control visible at every width.
Use white surfaces, slate text, fine gray dividers and the existing AKE red for selected
navigation. Online status uses restrained green plus text; failure uses amber plus text.
The separate revenue workbench keeps its dark design above.

Customer-facing chat is English only, independent of the browser and the staff account
locale. This includes the greeting, pre-chat and offline forms, validation, buttons,
delivery receipts, loading, error and success states. Staff-facing UI stays Chinese;
product names and terms such as API, CRM, CAPI and Ads retain their normal spelling.
Never translate customer messages or change identifiers, submitted field names, routing,
notification rules, account locales or existing conversations as a localization shortcut.

Customer forms use a compact red brand header, a white body, persistent field labels,
explicit optional fields, 14px body text and 12px supporting text. Inputs and primary
actions are at least 44px high. Inline errors are in English, announce failures and keep
entered values. A disabled sending action prevents duplicate submissions. The success
state confirms receipt without promising a response time. Existing threads remain
accessible when the team goes offline. Keep timestamps, sender identity and delivery
receipts readable without competing with the conversation.

Check the staff desk at 1440px, 1024px and 390px; below 1080px, channel links move into a
scrollable second row while the reception control stays visible. Check customer chat at
400px, 390px and 320px, including a Chinese browser locale, keyboard navigation, empty
and invalid forms, failed/successful submissions, and an existing conversation.
