# Browser checklist

The logic is tested in code. These checks need a real browser: layout, taps and drags, notifications.
Use three accounts (an admin, a parent, a child), ideally on two devices at once.

## Admin
- [ ] **Admin → Backups:** tap *Back up now*. A new row appears. Download it; the file opens in any SQLite viewer.
- [ ] **Menu:** the account menu says *Manage* (not *Manage people*).
- [ ] **Factory reset (try on a copy, or after a download):** Admin → Backups → *Reset the app…*.
  - *Delete everything* stays disabled until you type RESET; a wrong password is refused.
  - Afterwards you land on first-time setup, and other devices are signed out.
  - A *Before reset* backup is listed after you set up again.
- [ ] **Admin → People:** correct a child's points (+5 with a reason). Their Rewards page shows it in *Your points history*.
- [ ] **Calendar:** in the sidebar, open a calendar's edit form and tap *Export*. Then tap *Export .ics* at the bottom.
  Import the files into Google, Apple or Outlook calendar: repeats and skipped dates come across.

## Parent
- [ ] **Repeating event, editor:** open one occurrence. Pick *This event* (the Repeat options hide), change the time and save.
  Only that day moves. Ctrl/⌘+Z puts it back.
- [ ] **This and following:** change the title from the third occurrence on. The first two keep the old title.
  A repeat set to end after N times still totals N.
- [ ] **Drag** a repeating event in week view. A *This event / This and following / All events* box appears; Cancel changes nothing.
- [ ] **Delete this & following** on a later occurrence. Earlier ones stay. Then *Undo* in the message.
- [ ] **Who can see a calendar:** add a calendar and pick *Only me and…*, ticking Dad. Then on Dad's device:
  - The calendar appears live, with a lock that says it's yours, shared with him (view only).
  - He can't drag or edit its events, and it isn't offered when he adds an event.
- [ ] **Changing who sees it:** edit the calendar later and untick Dad. It disappears from his device without a refresh.
  Pick *Everyone*, and it's back for everybody.
- [ ] **On someone else's calendar:** the edit form shows who sees it, but not the choice.
- [ ] **Delete a calendar**, then Ctrl/⌘+Z. It comes back in the same place, with its events.
- [ ] **Chore repeats:** add a chore with *Repeat → Custom…*. The summary line under the form updates as you go.
  - *Every 2 weeks* on Tue + Thu.
  - *Every month* on the 3rd Tuesday or the last Friday (these choices depend on the due date).
  - *Every 3 days*, counting from when it was done.
  - *Ends after 3 times*: after the third one is finished, the chore disappears.
- [ ] **Chores:**
  - *Skip* a repeating chore (with a reason). The next one is due; no points are given.
  - **Review → Recently reviewed → Change:** give different points. The child's balance and history update.
  - Chores appear on the calendar as amber blocks ending at the deadline. Clicking one opens Chores.
- [ ] **Nav badge:** when a child marks a chore done, *Chores* shows a count on the parent's device without a refresh.
- [ ] **Groceries:**
  - Type `2 milk`, then `milk` again: one row shows *3×*. The − / + buttons work, and Undo reverses each step.
  - Turn on *Group by aisle*: headings appear in store order.
  - Tap a name to rename it or pick a different aisle. Click away to save; Esc cancels.
- [ ] **Language/region:** with the device set to a 24-hour or Monday-first region, times and the week start follow it.

## Child
- [ ] **Chores:** mark a chore done. When it's reviewed and the app is in the background, a notification shows.
  Notifications only work over HTTPS or on localhost; turn them on in *Account*.
- [ ] **Due soon:** a reminder shows about 30 minutes before a deadline, once (HTTPS only).
- [ ] **Calendar:** can split and move their own repeating event. On parents' events nothing is draggable.
- [ ] **Groceries:** can bump the quantity on their own items. On others' items, only the quantity badge shows.

## Kiosk (sign the tablet in with a Kiosk account)
- [ ] **First sign-in:** each person signing in on their own device is asked to choose a PIN. `1234` and `1111` are refused.
- [ ] **Locked tablet:** a grey bar says it's shared. Adding a grocery item works without a PIN.
- [ ] **Chores:** tap ✓ on Sam's chore. The PIN pad asks only for Sam's PIN.
  - It then waits for review; tapping ✓ on it again asks for a parent's PIN and approves it.
- [ ] **Review:** the tab is locked until a parent's or admin's PIN; Sam isn't offered. When it locks itself, the page hides again.
- [ ] **Rewards:** tap *Get it* → *Yes*, then pick who's getting it and enter their PIN. Their points go down.
- [ ] **Calendar:**
  - Tap Dad's event. It shows read-only, with *Enter Dad's PIN*. After the PIN, it can be edited and dragged.
  - Drag on an empty slot to add an event: Save asks *Who's adding this?*.
  - The sidebar has no add/subscribe/import buttons. Only calendars shared with everyone, or with the tablet, show.
- [ ] **Unlock bar:** after a PIN, a green bar shows *Unlocked for …* with a countdown. It locks itself after 90 s idle; *Lock* locks at once.
- [ ] **Wrong PINs:** 5 wrong PINs in a row → "try again in 5 minutes" for that person.
- [ ] **Admin → People:**
  - Kiosk is a role choice; a kiosk account has no points box.
  - *Reset PIN* makes that person choose a new one.
  - The activity log shows "Sam (kiosk)".

## Wall tablet / phones
- [ ] **/today:** the clock ticks; events, chores and groceries update live when changed on another device.
  The screen stays on. *Full screen* works (on iPad, add the app to the Home Screen instead).
- [ ] **Install:** on a phone, add the app to the home screen. It opens without browser bars and the icon looks right.
  The top bar sits below the clock and notch and every button can be tapped. Turn the phone sideways: nothing hides behind the notch.

## Offline (needs the https address through nginx)
- [ ] Open the app once with signal, visiting Calendar, Chores and Groceries.
- [ ] Turn on Airplane Mode, then close and reopen the app.
  - It opens, with an amber *Offline · showing what was saved …* bar.
  - The calendar, chores and grocery list are there as last seen; chore buttons are greyed out.
- [ ] **Groceries offline:** check off and add items. They change straight away, and the header says *Offline · N to send*.
  Close the app, reopen it (still offline): the changes are still there.
- [ ] Turn Airplane Mode off. Within a few seconds the bar goes away, the changes reach other devices, and *to send* disappears.
- [ ] **Signing out** on a phone removes the saved copy: in Airplane Mode afterwards the app has nothing to show.

