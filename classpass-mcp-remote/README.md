# ClassPass Remote MCP Server

This is a remote HTTP MCP server for ClassPass. It exposes ClassPass browser automation tools over Streamable HTTP at:

```text
https://<host>/mcp
```

## Environment variables

- `PORT` - HTTP port for the server. Defaults to `3000`.
- `MCP_AUTH_TOKEN` - bearer token required for MCP requests. Generate one with:

  ```sh
  openssl rand -hex 32
  ```

- `CLASSPASS_EMAIL` - optional ClassPass email for automatic login.
- `CLASSPASS_PASSWORD` - optional ClassPass password for automatic login.

Always set `MCP_AUTH_TOKEN`; ClassPass credentials live on the host when automatic login is enabled.

## Claude custom connector

Add a custom connector with the MCP URL:

```text
https://<host>/mcp
```

Set the Authorization header to:

```text
Bearer <MCP_AUTH_TOKEN>
```

## Cursor `mcp.json`

Add an HTTP MCP server entry:

```json
{
  "mcpServers": {
    "classpass": {
      "url": "https://<host>/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_AUTH_TOKEN>"
      }
    }
  }
}
```

## Caveats

ClassPass does not provide a public API, so this server drives a headless Chromium browser with Playwright. Host it on a paid tier that supports long-running browser processes. Browser automation against ClassPass may violate ClassPass terms of service or break when the website changes. Protect the endpoint with `MCP_AUTH_TOKEN` and add `CLASSPASS_EMAIL` / `CLASSPASS_PASSWORD` only in a trusted host dashboard.
