---
version: 1
slug: "localhost"
primary_target: "http://localhost:8788"
related_targets: []
---

# Mail

scope: `#/mail` and nested mailbox/folder/email hashes
mode: Operate
audience: Felix, daily, using D1 Desk as the site mailbox
job: scan unread, open, reply or archive, next
action: shorter inbox path across mailboxes, Agent, and settings
constraints: LEDGER world; no D1/KV/Workers/login; Token stays in the session cookie

## Direction contract

THESIS: Mail is a three-column ledger. The category default of an always-on fourth Agent column is refused; Agent is a sheet over the open letter.

OWN-WORLD: Charcoal #171820, lime #d8f848 on ink #090b09, IBM Plex Mono, Petrona only on empty titles, 1px #2a2c38 hairlines, LEDGER top bar.

STORY: A developer opens mail, sees which address is live, scans unread by weight and lime sender, and either replies or archives without hunting chrome.

FIRST VIEWPORT: Top bar unchanged. Left ~200px mailbox rail, current address the only lime reversed row, folders below. Center dense list. Right thread with 回复 and 归档 as equal primary actions. Agent closed until a letter is open, then a right sheet covering part of the reader.

FORM: Overlay three-pane, candidate 3 of 7, seed 6eaac874. Signature motion: the Agent sheet steps in from the right in ~180ms.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

Approved comp: `.impeccable/mocks/decision/mail-assigned.webp`
