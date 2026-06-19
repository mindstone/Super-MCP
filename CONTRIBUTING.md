# Contributing to Super MCP Router

Thank you for your interest in contributing to Super MCP Router! This document provides guidelines for contributing to the project.

## Development Setup

1. **Clone and install dependencies:**
   ```bash
   git clone https://github.com/your-username/super-mcp-router.git
   cd super-mcp-router
   npm install
   ```

2. **Create your configuration:**
   ```bash
   cp super-mcp-config.example.json super-mcp-config.json
   # Edit super-mcp-config.json with your MCP packages
   ```

3. **Build and test:**
   ```bash
   npm run build
   npm run dev
   ```

## Project Structure

```
src/
├── cli.ts              # CLI entry point
├── server.ts           # MCP server with meta-tools
├── registry.ts         # Config loading & package management
├── catalog.ts          # Tool caching & discovery
├── summarize.ts        # Tool summaries & arg skeletons
├── validator.ts        # Argument validation
├── logging.ts          # Structured logging
├── types.ts            # TypeScript definitions
├── auth/
│   ├── manager.ts      # Token storage (keychain + file fallback)
│   ├── deviceCode.ts   # Device code OAuth flow
│   ├── browserOAuthProvider.ts # Browser-based OAuth provider
│   ├── callbackServer.ts # OAuth callback server
│   └── globalOAuthLock.ts # OAuth flow coordination
└── clients/
    ├── stdioClient.ts  # Stdio MCP client
    └── httpClient.ts   # HTTP MCP client (supports SSE and Streamable HTTP)
```

## Making Changes

1. **Create a feature branch:**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes following the existing patterns:**
   - Use TypeScript for type safety
   - Follow existing error handling patterns
   - Add logging for debugging
   - Update types if needed

3. **Test your changes:**
   ```bash
   npm run build
   npm run dev
   ```

4. **Commit with clear messages:**
   ```bash
   git commit -m "feat: add support for X"
   # or
   git commit -m "fix: resolve issue with Y"
   ```

## Code Style

- Use TypeScript strict mode
- Follow existing naming conventions
- Add JSDoc comments for public APIs
- Use structured logging via the logging module
- Validate inputs with Ajv schemas

## Security

- This is a public, MIT-licensed repository — treat everything you add as public.
- Never commit credentials or API keys
- Use environment variables for sensitive data
- Sanitize/redact tokens in logs
- Use secure file permissions (0600) for token files
- Keep private data out of source, docs, examples, fixtures, and commit messages — no PII (names, email addresses, conversation excerpts), no real customer / design-partner / prospect company names, and no internal hostnames, endpoint URLs, or ticket references. Illustrative content must use fictional placeholders (`Acme Corp`, `jane@example.com`) — never a real name.

## Testing

When adding new features:
- Test with both stdio and HTTP MCPs
- Verify error handling works correctly
- Test authentication flows if applicable
- Ensure logging doesn't leak sensitive data

## Submitting Changes

1. Push your branch to GitHub
2. Create a Pull Request with:
   - Clear description of changes
   - Any breaking changes noted
   - Test instructions if applicable

## Questions?

Feel free to open an issue for:
- Bug reports
- Feature requests
- Questions about contributing
- Architecture discussions

Thank you for contributing!