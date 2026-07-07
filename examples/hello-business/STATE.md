# STATE — Hello Business

This file is the durable memory of the business between sessions. The brain
is amnesiac: everything it needs to pick up where it left off must be
written here (or in `journal/`, `LEDGER.csv`, `queue/`) before a session ends.

## Status

Not yet started. Run `mainspring run` to have EchoBrain take its first
session — it writes a journal heartbeat and a $0 ledger line, then commits.

## Next up

- (nothing queued — this is a heartbeat-only example)

## Open questions / blockers

- (none)
