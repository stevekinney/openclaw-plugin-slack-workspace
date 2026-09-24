# Ralph Pipeline Configuration

task_file: ROADMAP.md
base_branch: main
on_stuck: skip
max_parallel: 1
work_max_iterations: 15
worktree_dir: /Users/stevekinney/worktrees/openclaw-slack-workspace
branch_prefix: ralph/

verify:
  - npm test
  - npm run plugin:validate

reviewers:
  - copilot
