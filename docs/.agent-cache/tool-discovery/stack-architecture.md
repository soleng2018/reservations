# Tool Discovery: Next.js 16 Tech Stack
**Date:** 2026-10-04

## Skills by Technology

### Frontend & UI
- **Next.js 16**: clerk/skills@clerk-nextjs-patterns (NextAuth patterns)
- **shadcn/ui**: shadcn-ui/ui@shadcn (component library), google-labs-code/stitch-skills@shadcn-ui
- **Tailwind CSS v4**: heygen-com/hyperframes@tailwind, wshobson/agents@tailwind-design-system

### Authentication & Identity
- **Better Auth**: better-auth/skills@better-auth-best-practices
- **Authentik**: none found

### Email
- **React Email**: none found

### Infrastructure & Deployment
- **Cloudflare**: cloudflare/skills@cloudflare (core), cloudflare/skills@wrangler (CLI), cloudflare/skills@workers-best-practices
- **Gmail API / Google Calendar API**: Built-in claude.ai MCP servers

### Testing & Quality Assurance
- **Playwright**: microsoft/playwright-cli@playwright-cli, anthropics/skills@webapp-testing, currents-dev/playwright-best-practices-skill@playwright-best-practices
- **Vitest**: antfu/skills@vitest

### Utilities & Validation
- **Zod**: pproenca/dot-skills@zod
- **date-fns**: none found

## MCP Servers by Technology

### Authentication & Identity
- **Authentik**: https://github.com/Samik081/mcp-authentik, https://github.com/cdmx-in/authentik-mcp
- **Better Auth**: @better-auth/mcp (https://www.npmjs.com/package/@better-auth/mcp), https://mcp.better-auth.com/mcp
- **Gmail API**: Built-in claude.ai server (requires OAuth)
- **Google Calendar API**: Built-in claude.ai server (requires OAuth)

### Infrastructure & Deployment
- **Cloudflare Workers**: Official https://labs.cloudflare.dev/mcp/

### Testing & Quality Assurance
- **Playwright**: Official https://playwright.dev/mcp/, Playwright Test MCP

### Email
- **React Email / Email Tools**: Emailens MCP Server (https://github.com/emailens/mcp) - supports React Email, HTML, MJML

### Utilities & Validation
- **Zod**: Part of MCP server development patterns; no standalone server (used for schema validation in MCP servers)
- **date-fns**: none found
