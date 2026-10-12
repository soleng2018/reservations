# Tool discovery: availability, booking rules

Date: 2026-10-11
Scope: read-only discovery. Nothing installed. Only this file was written.

Tools:
1. react-day-picker (v9), via shadcn Calendar
2. Base UI Combobox (@base-ui/react), shadcn base combobox
3. Date and timezone handling with Intl (no library), timezone-aware booking calendar

Method: `npx -y skills find <term>` for the eight terms, filtered to relevant names. Candidate repos checked with `npx -y skills add <owner>/<repo> --list`. Five web searches for MCP servers and Intl skills.

## 1. react-day-picker

Skills:
- impertio-studio/shadcn-ui-claude-skill-package (shadcn-errors-react-day-picker-v9): error and fix guide for react-day-picker v9 in shadcn. 6 installs. Confirmed by --list.
- impertio-studio/shadcn-ui-claude-skill-package (shadcn-syntax-calendar-datepicker): syntax for shadcn Calendar and date picker. Same repo, confirmed by --list. Install count not shown.

MCP: none found. A web search returned only the react-day-picker docs and unrelated servers.

## 2. Base UI Combobox (@base-ui/react)

Skills:
- shadcn-ui/ui (migrate-radix-to-base): official. Migrates Radix projects and components to Base UI. 38.8K installs. Confirmed by --list.
- mattbx/shadcn-skills (shadcn-component-review): reviews shadcn composition, including Radix and Base UI patterns. 606 installs. Confirmed by --list.
- thunderboltdev/shadcn-baseui (shadcn-baseui): stops Radix patterns such as asChild from appearing in Base UI code. 241 installs. Confirmed by --list.
- jackspace/claudeskillz (base-ui-react): Base UI React component guidance. 256 installs. Confirmed by --list. Repo has 256 skills, so the skill itself is not reviewed.
- secondsky/claude-skills (base-ui-react): Base UI React component guidance. 230 installs. Confirmed by --list.
- itechmeat/llm-code (base-ui): unstyled Base UI covering forms, menus, overlays, and composition. 223 installs. Confirmed by --list.
- pproenca/dot-skills (base-ui-migrator): migrates UI code to @base-ui/react, with a 37-component catalog. 127 installs. Confirmed by --list.
- Excluded: pproenca/dot-skills (mui-base). This is MUI Base, a different library.
- Noted from web search, not confirmed with --list: noklip-io/agent-skills (shadcn-base). Base UI styled components for shadcn. Combobox coverage not verified.

MCP:
- morksen123/base-ui-mcp-server: third party, not verified as MUI-affiliated. Tools include search_components and get_component_examples. Install is `npx base-ui-mcp-server@latest init --client claude`. Maintenance status not checked.

## 3. Date and timezone with Intl (no library)

Skills:
- No skill found for Intl.DateTimeFormat or IANA zone handling. The "timezone" and "intl" search results were unrelated (gsap, Lark, and similar).
- Unverified, not confirmed with --list:
  - henkisdabro/wookstar-claude-plugins (timezone-tools): 69 installs. Content not checked.
  - rampstackco/claude-skills (scheduler-and-booking-design): 240 installs. Booking design, may cover slot rules. Content not checked.
- Library-specific, so not a fit for no-library Intl: wottpal/skills (date-fns), 103 installs. dobroslavradosavljevic/skills (date-fns), 42 installs.
- Excluded: github/awesome-copilot (dotnet-timezone), which is .NET.

MCP: none found. A web search turned up general Intl guides only.

## Notes

- Install counts are as printed by `skills find`. Counts for skills not confirmed with --list are unverified.
- MCP results are from web search only. None were confirmed in use or maintained.
- Nothing was installed. Nothing in the project was changed except this file.
