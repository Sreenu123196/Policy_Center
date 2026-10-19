# Languages and accessibility

## Hindi and Telugu screens

The language chooser in the top bar switches the screens between English, हिन्दी and తెలుగు. The choice is remembered in the
browser. The page language (`<html lang>`) changes with it, so a screen reader uses the right voice.

How it works (`public/i18n.js`): the app is written in English. After each screen is drawn, the fixed words on it (menus,
headings, buttons, table headers, field labels, statuses, hints) are matched, word for word, against a dictionary and replaced.
Words that carry a name, a number, a date or money (for example "Claim CL-0000001", "Rs 1,351.12") and everything a customer
typed stay as they are. To add a word, add one line to the dictionary; `test/i18n.test.js` checks the scripts, the end
punctuation, stale entries, and that at least 90% of menus, table headers, field labels and buttons are covered.

**The translations have not been reviewed by a native speaker.** They use common Indian insurance usage (policy, premium
and claim as people say them) but a reviewer who knows insurance must read them before customers see them. Not translated yet:
sentences that are built from data (for example "Loss on 01-03-2026 at Columbus"), the browser tab title, server error messages,
documents and messages to customers (those have their own languages in the messaging templates).

## Accessibility (WCAG 2.2 AA)

Built in and tested without a browser (`test/accessibility.test.js`):

- Colour contrast of every text and background pair in the stylesheet is at least 4.5 to 1 (success and warning colours were
  darkened to pass).
- A "Skip to main content" link, landmarks (header, labelled main menu, main), the page language, and a title that names the screen.
- Visible keyboard focus (3 pixel outline) on links, buttons and fields, white on the dark top bar.
- Buttons and links are at least 24 by 24 pixels.
- Movement stops for people who ask for reduced motion.
- Dialogs name themselves, keep Tab inside, close with Escape and give focus back to the button that opened them.
- Table headers are real headers (`scope="col"`); form errors are announced (`role="alert"`); toasts are a polite live region.
- After a new screen loads, the keyboard starts at its top.

Checked by hand in the browser: switching language on the policy and ticket screens, the dialog opening and closing with the
keyboard, focus returning, the skip link hidden until focused.

**Still to do by a person** (these need a screen reader and real use, not a test):

1. Walk every screen with the keyboard only and with NVDA or JAWS; fix any control that cannot be reached or named.
2. Zoom the browser to 400% and check that nothing is cut off or needs sideways scrolling (reflow).
3. Check the charts on Sales and Insights have a text alternative (the tables beside them do; the pie chart needs a summary).
4. Check form fields in the quote screens (vehicles, drivers, locations) are all labelled; they use the shared field helper, but a
   few controls are built by hand.
5. Run an automated scanner (axe or Lighthouse) on a few screens and keep the report with the release.
