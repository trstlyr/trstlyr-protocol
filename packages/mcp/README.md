# @trstlyr/mcp

MCP (Model Context Protocol) server for TrstLyr Protocol — gives AI agents the ability to check trust before acting.

Install it in Claude Desktop, Cursor, or any MCP-compatible host in minutes.

## Tools

| Tool | Description |
|------|-------------|
| `trust_query` | Full trust report: score, risk level, signals, and evidence |
| `should_proceed` | Binary go/no-go check with reasoning |
| `trust_explain` | Narrative explanation of why a subject has its trust rating |
| `trust_batch` | Batch trust query for up to 20 subjects at once |

## Quick Install (Claude Desktop)

**1. Clone and build:**
```bash
git clone https://github.com/trstlyr/trstlyr-protocol.git
cd trstlyr-protocol
pnpm install
pnpm -r build
```

**2. Add to Claude Desktop config** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "trstlyr": {
      "command": "node",
      "args": ["/path/to/trstlyr-protocol/packages/mcp/dist/index.js"],
      "env": {
        "GITHUB_TOKEN": "ghp_your_token_here"
      }
    }
  }
}
```

**3. Restart Claude Desktop.** Four new tools appear automatically.

## Subject Format

Use `namespace:id` format:

| Subject | Meaning |
|---------|---------|
| `github:tankcdr` | GitHub user |
| `github:trstlyr/trstlyr-protocol` | GitHub repository |
| `tankcdr/trstlyr-protocol` | Shorthand — defaults to `github` namespace |

## Example Prompts

> "Before I run this, check if `github:some-user/some-script` is trustworthy."

> "Should I install `github:modelcontextprotocol/servers`? Check trust first with action install."

> "Explain why `github:trstlyr/trstlyr-protocol` has its trust rating."

> "Check trust for `openai/openai-node` — I'm about to run it."

## Environment Variables

| Variable | Description |
|----------|-------------|
| `GITHUB_TOKEN` | GitHub personal access token. Increases rate limit from 60 to 5,000 req/hr. Optional but recommended. |

## How It Works

Each trust query runs through the TrstLyr 7-step pipeline:

1. **Identity resolution** — parse subject into canonical namespace:id
2. **Signal dispatch** — fan out to all eligible providers in parallel
3. **Fraud detection** — lightweight anomaly detection
4. **Subjective Logic fusion** — cumulative belief fusion (Josang, 2001)
5. **Ev-Trust adjustment** — evolutionary stability penalty on conflicting signals
6. **Risk mapping** — score to risk level to recommendation
7. **Cache** — results cached in-memory (TTL: 5 min default)

## License

Apache 2.0
