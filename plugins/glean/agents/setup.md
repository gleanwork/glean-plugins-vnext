# Create your first Glean agent

You are a coding agent (Claude Code, Cursor, or similar) helping a user build their
first Glean **headless agent** from inside their coding environment. Read this file
top to bottom and drive the flow below, pausing for the user only where noted.

Your job is to take the user from zero to a working, tested agent — and, if they
want it, into a Git-based review loop. Keep momentum: prefer doing the next step
over asking, and only stop when you genuinely need input (an email, a prompt for
the agent, a publish decision).

> Scope: Headless building and Git ADLC support **autonomous (auto) agents only**.
> Workflow agents cannot be built this way.

## The flow at a glance

```
Install Glean plugin
  ↓
Authenticate (email only) & verify /glean_run works
  ↓
Confirm local agent directory (.glean/agents)
  ↓
Create a simple Q&A agent (tools, sub-agents, model choice)
  ↓
Preview / test on a real input
  ↓
Save or publish  → share web links back to the user
  ↓
(Optional) Enable Git ADLC for PR-based review & sync
```

## Step 1 — Install the Glean plugin

Detect the environment and use the matching path. Skip if already installed
(check whether `/glean_run` is available first — this whole step is a no-op if it is).

**Claude Code**

```
/plugin marketplace add gleanwork/glean-plugins-vnext
/plugin install glean-vnext@glean-plugins-vnext
/reload-plugins
```

Confirm `/glean_run` is now available.

**Cursor**

In Cursor's chat, run the `/add-plugin` command pointing at the repo:

```
/add-plugin glean-vnext
```

This adds the marketplace and installs the **glean-vnext** plugin. Then confirm
`/glean_run` is available. Or, via the UI:

1. Open Cursor Settings → Plugins → **Browse Marketplace**.
2. Search for **Glean vNext**, open it, and click **Add to Cursor**.
3. Verify the plugin appears in the Plugins list and is active.

## Step 2 — Authenticate and validate

Run the setup/verify path. If setup is required, **ask the user only for their
work email** — that is all that is needed; there is no need to open "About Glean"
or paste a server URL. Complete browser sign-in if prompted, then continue.

Validate, in order, that:

- the plugin loads without errors
- `/glean_run` is available
- you can initiate an agent-creation flow

The invocation pattern for early iterations is:

```
/glean_run agent_builder <your prompt>
```

## Step 3 — Confirm the local agent directory

Agents live as files on disk. Confirm with the user that saving agents under
`.glean/agents/` in the current workspace is fine (this is the recommended default
and is what Git ADLC expects). Each agent gets its own folder:

```
.glean/agents/
└── my_agent/
    ├── spec.yaml         # main agent specification (contains the agent `id`)
    ├── instructions.md   # system prompt / agent instructions
    ├── skills/           # optional: one folder per skill, each with SKILL.md
    └── subagents/        # optional: nested agents
```

Do not edit the `id` field in `spec.yaml` — it links the folder to the live agent
in Glean.

## Step 4 — Build a simple Q&A agent

Guide the user through one concrete example so they see the full shape of an
agent: **tools, sub-agents, and model choice**. Use the agent-builder entry point
and iterate until it behaves as expected. Example smoke sequence:

```
/glean_run agent_builder create an agent that summarizes new support issues from Slack and Zendesk
/glean_run agent_builder run support_summary_agent with input high-priority login failures from this week
/glean_run agent_builder save the created agent
```

Encourage this loop:

- build an agent
- preview it on a real input
- validate and publish if it looks right

## Step 5 — Preview, test, and publish

- **Preview/test** the agent on a real input and confirm behavior with the user.
- **Save** to keep the generated files on disk, or **publish** to make it live.
- Share the **web links** back to the user so they can review the work in Glean.

The agent URL has the form `https://<your-domain>.glean.com/chat/agents/<agent-id>`;
the same `<agent-id>` appears as the `id` field at the top of `spec.yaml`.

## Step 6 — (Optional) Enable Git ADLC

Offer this only if the user wants agent changes to flow through GitHub pull
requests and sync automatically back into Glean. When enabled:

- **On PR:** a draft preview is created for each changed agent, and the workflow
  comments with preview links so it can be tested before merge.
- **On merge:** the agent syncs into Glean as either `staged` (saved but not
  visible; publish manually from Agent Builder) or `published` (live immediately).

### One-time repo setup

1. Add the workflow file `.github/workflows/glean-agent-sync.yml`:

```yaml
name: Glean Agent Sync

on:
  pull_request:
    types: [opened, synchronize, reopened]
    paths:
      - '.glean/agents/**'
      - '.glean/common/**'
  push:
    branches: [<your-default-branch>]
    paths:
      - '.glean/agents/**'
      - '.glean/common/**'
  workflow_dispatch:
    inputs:
      agent_folder:
        description: 'Agent folder to sync (e.g. my_agent). Leave empty to sync all.'
        required: false
        default: ''
      is_draft:
        description: 'Trigger draft preview (true) or merge commit sync (false)'
        type: boolean
        required: false
        default: false

jobs:
  sync:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: askscio/glean-agent-import-action@v1
        with:
          instance-url-fe: https://<your-glean-subdomain>.glean.com
          instance-url-be: https://<your-glean-subdomain>-be.glean.com/
          api-token: ${{ secrets.GLEAN_AGENT_SYNC_TOKEN }}
          shared-root: .glean/common
          default-sync-mode: staged
```

   Notes:
   - `fetch-depth: 0` is required — the action uses Git history to detect which
     agent folders changed.
   - Keep both `.glean/agents/**` and `.glean/common/**` in `paths` so shared-resource
     changes also trigger a sync.
   - `default-sync-mode: staged` is the recommended default for private beta.

2. Create the GitHub secret (**must be done by a Glean Agent Moderator**):
   - In Glean: Admin Console → API Tokens → Create token, with the **AGENTS** scope.
   - In GitHub: Settings → Secrets and variables → Actions → New repository secret.
   - Name it exactly `GLEAN_AGENT_SYNC_TOKEN` and paste the token as the value.

3. (Optional but recommended) Require the sync check before merge via
   Settings → Branches → branch protection → **Require status checks to pass before
   merging**, and select the Glean Agent Sync check. The check only appears after
   it has run at least once, so open a test PR touching `.glean/agents/**` first.

### Add an agent to Git ADLC

Place each agent in its own folder under `.glean/agents/`, commit, push, and open a
PR. The action runs automatically when the PR touches `.glean/agents/**` or
`.glean/common/**`, then comments with a draft preview link per changed agent.
Review the preview, then merge — the agent syncs into Glean per its sync mode.

Shared skills, prompts, or sub-agents reused across agents should live once under
`.glean/common/` and be referenced via symlinks (symlinks resolving outside the repo
are rejected). When a shared file changes, every dependent agent re-syncs in the
same run.

## Troubleshooting

- **`/glean_run` not available after install:** reload plugins, confirm the install
  succeeded; in Cursor confirm setup completed and the server URL was configured.
- **Cursor says setup is required:** enter the work email when prompted, complete
  sign-in, and rerun `/glean_run agent_builder ...`.
