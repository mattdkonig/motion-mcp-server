# ClassPass Remote MCP Server

This is a remote HTTP MCP server for ClassPass. It exposes ClassPass browser automation tools over Streamable HTTP at:

```text
https://<host>/mcp
```

## Environment variables

- `PORT` - HTTP port for the server. Defaults to `3000`.
- `AUTH_PASSWORD` - password shown in the OAuth authorization form. Required for Claude/Cursor OAuth login.
- `MCP_AUTH_TOKEN` - optional legacy static bearer token for direct MCP requests. Generate one with:

  ```sh
  openssl rand -hex 32
  ```

- `CLASSPASS_EMAIL` - optional ClassPass email for automatic login.
- `CLASSPASS_PASSWORD` - optional ClassPass password for automatic login.

Always set `AUTH_PASSWORD`; ClassPass credentials live on the host when automatic login is enabled.

## OAuth endpoints

The MCP endpoint is protected by OAuth 2.1 with PKCE and dynamic client registration:

- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-authorization-server`
- `POST /register`
- `GET /authorize`
- `POST /authorize`
- `POST /token`

The authorization endpoint renders a simple password form. Enter `AUTH_PASSWORD` to approve the OAuth client. The server stores OAuth clients, authorization codes, and tokens in memory, which is intended for a single-user personal service.

## Claude custom connector

Add a custom connector with the MCP URL:

```text
https://<host>/mcp
```

Claude discovers OAuth metadata from the server, dynamically registers a public PKCE client, and opens the authorization page. Enter the `AUTH_PASSWORD` value in the form.

## Cursor `mcp.json`

For OAuth-capable Cursor clients, add the remote MCP URL and complete the authorization flow in the browser:

```json
{
  "mcpServers": {
    "classpass": {
      "url": "https://<host>/mcp"
    }
  }
}
```

For legacy static-token clients, `MCP_AUTH_TOKEN` is still accepted:

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

ClassPass does not provide a public API, so this server drives a headless Chromium browser with Playwright. Host it on a paid tier that supports long-running browser processes. Browser automation against ClassPass may violate ClassPass terms of service or break when the website changes. Protect the endpoint with OAuth and `AUTH_PASSWORD`, and add `CLASSPASS_EMAIL` / `CLASSPASS_PASSWORD` only in a trusted host dashboard.
