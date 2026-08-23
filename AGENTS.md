## About This Project

Currently, the mail tool for the Pi Coding Agent is under development.

Include:

- ./extensions/pi-mail
- ./skills/pi-mail

## Code Map

> Updated: 2026-08-23. Keep this map in sync whenever file-level architecture changes (add / remove / rename / move files or shift module responsibilities).

Dependencies flow one way: entry → composition root → domain facade → storage.

```
extensions/pi-mail/
├── index.ts               Entry: registers pi commands / tool / events
├── session-runtime.ts     Composition root: mailbox + attention + presence + webUI, bound to session lifecycle
├── mail-service.ts        Domain facade: send / receive / wait / GC / delete (core logic)
├── fs-store.ts            Storage layout: peers/ presence/ messages/ (canonical) mailboxes/<id>/ (deliveries)
├── types.ts               Model collection (mail / identity / query results), pure shapes
├── peer-record.ts         Peer record shape + v1→v2 migration & validation (single owner)
├── identity.ts            Id string syntax (generate / shorten); identity archives live in peer-record.ts
├── project-root.ts        cwd → project root / mail root
├── attention-policy.ts    Reminder policy, pure logic
├── attention-runtime.ts   Reminder polling (bound to pi API)
├── reminder-settings.ts   Reminder settings loading
├── presence-runtime.ts    Heartbeat
├── tool-presentation.ts   Agent tool text formatting
└── web/
    ├── server.ts          Web HTTP server + API routes
    └── index.html         Static page
```

- Mail read/write path → `mail-service.ts` → `fs-store.ts`; GC / delete semantics → `mail-service.ts::deleteProjectMailboxes`, constraints in `SPEC.md`
- Reminder path → `reminder-settings.ts` → `attention-policy.ts` → `attention-runtime.ts`
- Tests in `test/*.test.ts` link straight to source files by topic (extension-entry tests link to `index.ts`)
