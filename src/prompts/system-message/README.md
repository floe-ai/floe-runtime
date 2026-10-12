# Floe runtime base system message

One file per system-message section. `src/system-message.mjs` loads every
`<section>.md` here when it starts; `README.md` is not loaded. A section with
no file keeps the vendor's text unchanged.

Each file starts with a front-matter block:

| Field | Meaning |
|---|---|
| `action: remove` | Drop the section. The body must be empty. |
| `action: replace` | The body becomes the section text. |
| `action: vendor` | Keep the vendor's text, minus the `<tag>` blocks listed in `strip`. |
| `strip` | Vendor `<tag>` block names to remove (`vendor` only). |
| `reason` | Why the runtime does this. Not sent to the model. |

Application and actor layers apply on top of this base and can change any
section (see "System message layers" in the repository README).
