---
worktree:
  integration_branch: main
  push_model: pr
  worktree_path: "../super-mcp-{date}_{slug}"
  branch_name: "{date}_{slug}"
---

# Contributor worktrees

Configuration for the shared worktree initializer when it is available beside
this repository. Worktrees start from `origin/main` and publish their own branch
for a pull request. Initialization does not install dependencies; follow
[CONTRIBUTING.md](../../CONTRIBUTING.md) when development needs them.
