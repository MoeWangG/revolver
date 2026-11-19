# Examples

A minimal, sanitized teammate profile. It contains **no personal data** — no
real memory, no absolute paths, no credentials.

```
examples/assistant/
├── waker.yaml      # role, model, workspace, policy
├── SOUL.md         # stable personality and judgement
├── identity.md     # who it is and who it serves
├── persona.md      # working style and output preferences
├── bible.md        # red lines and actions that need human confirmation
└── MEMORY.md       # long-term memory (starts empty)
```

## Use it

```bash
# copy the example into your own agent directory, then edit it
waker agent new assistant          # creates agents/assistant/ from scratch
# or:
cp -r examples/assistant agents/assistant
waker compile assistant
waker chat assistant
```

`agents/` is git-ignored: everything you write there stays on your machine.

## Rules of thumb

- Put stable traits in `SOUL.md`, task-specific instructions in `persona.md`.
- Never put secrets in these files — use `agents/<id>/secrets.json` (also ignored).
- `MEMORY.md` is versioned by you; the optional memory server keeps a separate,
  searchable store.
