# Single conversation design

The owner requested one simulated WeChat conversation on 2026-09-30: the counterpart's messages and the user's pending reply are the main content; AI advice appears inside that conversation. The alternative of a separate conversation with an AI coach was explicitly declined. The owner also requested day and night colors and deferred email, login and website authorization work for the local demo.

## Reference and scope

Read-only source: [LYNCA Design Standard 1.3.0](https://linear.app/lynca/document/infralynca-design-standard-505c197ca09a), effective 2026-09-29, canonical `updatedAt` `2026-09-29T14:13:47.813Z`. Its less-is-more hierarchy, truthful states, typography roles, keyboard access, minimum touch targets and restrained composition apply here. The implementation reference is the owner-export-checked Nocturne snapshot of 2026-09-07 and LYNCA overlays.

The personal project's visual values have one implementation home, `web/styles.css`. Night base roles, spacing, radii and font stacks follow the reference. The day palette and accent-tinted speaker bubbles are scoped product decisions for this chat demo, rather than changes to the company's design system. The same hierarchy and controls apply to both themes. Chat bubbles and compact controls use the UI font stack; long reading/display retains the serif role. No remote font dependency or glass chrome is required.

## Composition and behavior

- One conversation surface: counterpart messages on the left, self messages and editable pending replies on the right. AI analysis, direction choices and next-step advice are identified as advice within the thread.
- A small header selects the counterpart and opens supplementary actions. No always-visible directory, heat dashboard, questionnaire or separate assistant pane.
- Personal profile, counterpart background, meeting arrangements and feedback open only when needed, inside the same conversation. Unknown observations remain unknown; lower-weight directions remain selectable.
- The composer records pasted messages; generated suggestions require explicit action. A recorded message is a user statement, not a claim that the software sent anything to WeChat.
- Day/night switching preserves the current conversation and unsaved drafts. Only the theme preference belongs in browser local storage; private profiles, chats, tokens and API credentials do not.
- Local demo stays explicitly fictional and loopback-only, with separate private data. Its automatic session never becomes a public authentication bypass. Public access and personal email delivery remain deferred.

## Acceptance

Check the actual rendered day and night conversation on desktop and narrow mobile sizes. Exercise object selection/intake, profile completion, message insertion, direction selection, editable reply, manual sent confirmation, feedback and meeting details. Check keyboard controls, focus visibility, minimum touch targets, overflow, reload and error recovery. Synthetic browser checks use a temporary database and knowledge copy and make no paid calls. Source merge, the live local page and chat effectiveness are separate evidence classes.

## Bubble color amendment — 2026-10-01

The owner explicitly rejected green self-message bubbles. Self messages and editable pending replies now use the Nocturne accent scale: a pale lavender fill in day mode and a brighter blue-violet fill in night mode. The owner also requested obvious differentiation: counterpart bubbles retain the neutral surface, self bubbles remain right-aligned with a distinct label, inline AI cards retain their AI identifier, and pending replies add a dashed outline beside the explicit pending/sent label. This applies to this personal chat product; it does not remove semantic success colors from unrelated surfaces or amend the company standard. Both versions retain legible text, speaker alignment and explicit sent/pending labels.
