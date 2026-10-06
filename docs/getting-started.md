# Getting started

YelAxis Planner runs as a desktop website. Chromium can also install the same application as a PWA.
An account is optional; the first useful plan needs no backend or network after the application has
loaded.

## Start from source

Install the Node and pnpm versions declared in [package.json](../package.json): Node 24.18 or newer
within major 24, and pnpm 11.9 or newer within major 11. Clone the repository, then start the
application:

```sh
git clone https://github.com/abdumajitovelbek/YelAxis-Planner.git
cd YelAxis-Planner
pnpm install --frozen-lockfile
pnpm run dev
```

Open the local URL printed by Vite. Keep using that origin and browser profile to reopen the same
plan: storage belongs to an origin and profile, so a different port, hostname or browser has a
separate store. Development mode is for working on source; test installed/offline behavior with the
production build:

```sh
pnpm run build
pnpm run preview
```

No environment file is needed for local planning. [Self-hosting](self-hosting.md) explains optional
account configuration. Clean-clone and final public checks are tracked in
[verification](verification.md).

## Make a first plan

1. Choose local planning. Confirm the planning time zone, first weekday and time format; defaults
   come from your device. A display name is optional.
2. Name a direction as an Axis, describe one Outcome and capture a first Action. Setup can be saved
   and resumed; rerunning it keeps existing planning records.
3. Open **Inbox** to decide what to do, place later, keep as a lightweight Note or Project idea,
   archive, or leave undecided.
4. In **Plan**, place an Action on a Day or Week. Add a fixed block only when you want an exact
   time. Review any overlap and choose its resolution.
5. Open **Today**, choose up to three focus items, and use Focus mode if useful. Completing work is
   an explicit action; the timer changes no lifecycle state.
6. Finish with **End day** or a saved review, then make a JSON backup through **Settings → Data**.

The [user guide](user-guide.md) explains the objects and planning choices in more detail.

## Install the PWA

Open a production build in Chromium on a secure origin, then use the browser's install option when
it is offered. Installation provides a standalone window; it uses the same planning and persistence
rules as the website. Firefox desktop uses the normal website. Safari has not been verified as a
supported target.

Once the static shell has been loaded and cached, local planning can reopen offline. Account sync
waits for connectivity. A waiting update asks you to choose **Later** or **Update now**; save any
unfinished edits before activating it.

## Protect the plan

Use one active tab for each database. A second active tab fails safely instead of overwriting the
first. Close the other tab and retry if the database is busy.

Browser-managed storage can be removed or evicted even when persistence permission is granted. JSON
backups are readable private copies and are not encrypted. Check that your downloaded backup exists;
a download request cannot prove the operating system finished saving it. See
[data and recovery](data-and-privacy.md) before clearing site data, switching browsers or replacing
a plan.
