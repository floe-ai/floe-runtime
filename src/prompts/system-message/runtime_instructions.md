---
action: vendor
reason: Keeps background notification and file-reading guidance. Removes the vendor session-folder path, git co-author trailer, and CLI progress-update habits. Copilot adds the persistence and editing-safety blocks only for models that need more guidance (the GPT/codex tool set); Floe keeps that targeting but swaps in its own wording from blocks/.
strip:
  - session_context
  - user_progress_updates
  - git_commit_trailer
rewrite:
  - editing_constraints
  - autonomy_and_persistence
---
