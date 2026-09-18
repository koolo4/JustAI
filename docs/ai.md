# JustAI AI Architecture

## Provider layer

JustAI separates provider transport from agent execution.

Implemented providers:

- Mock
- OpenAI
- Anthropic

Each provider receives:

- system instructions;
- user/IDE prompt;
- context;
- filtered tool definitions.

The browser never receives provider API keys.

## Agent profiles

### General Agent

Can use local workspace and connected external services.

### Code Agent

Can inspect and edit local workspace files.

### Office Agent

Can read and edit connected Word documents.

Profiles restrict which tools the model can call.

## Agent loop

```text
user prompt
    |
    v
AIService
    |
    +--> provider
    |      |
    |      +--> final answer
    |      |
    |      +--> tool call
    |
    v
ToolExecutor
    |
    v
ToolRegistry
    |
    v
tool result
    |
    v
provider again
    |
    v
final answer
```

The loop is bounded by `JUSTAI_MAX_AGENT_STEPS`.

## Tool contract

Every tool exposes:

- `name`
- `description`
- `parameters`
- `execute(args)`

This allows the same tools to be described to different AI providers.

## Local tools

- `read_file`
- `list_files`
- `edit_file`

Local tools are constrained to the workspace root.

## Microsoft Word

The Office Agent uses:

```text
Microsoft OAuth
    |
    v
Microsoft Graph
    |
    +-- download OneDrive file
    |
    v
OOXML .docx editor
    |
    v
upload updated file
    |
    v
Word / OneDrive link
```

Microsoft Graph is used for OneDrive file storage and permissions. The `.docx` itself is edited as OOXML before it is uploaded again.

The current Word editor deliberately performs exact text replacement and refuses ambiguous/cross-run replacements. This is safer than silently changing the wrong content.

## Extending the platform

A new integration should add:

1. connection/auth service;
2. API client;
3. one or more tools;
4. integration routes;
5. UI connection card.

The AIService and core ToolRegistry do not need to know integration-specific details.
