export type ResourceKind = "Community" | "Example" | "Guide" | "Reference" | "Template";

export interface Resource {
  description: string;
  href: string;
  kind: ResourceKind;
  title: string;
}

export const resources: Resource[] = [
  {
    kind: "Guide",
    title: "Build your first agent",
    description:
      "Follow the tutorial from a first agent through warehouse tools, spend approval, and a deployable chat UI.",
    href: "/docs/tutorial/first-agent",
  },
  {
    kind: "Guide",
    title: "Frontend guides",
    description:
      "Use React, Vue, Svelte, Next.js, Nuxt, or SvelteKit helpers to put a durable eve session behind your own UI.",
    href: "/docs/guides/frontend/overview",
  },
  {
    kind: "Guide",
    title: "TypeScript client",
    description:
      "Drive the default HTTP channel from scripts, tests, backend jobs, or custom server-side integrations.",
    href: "/docs/guides/client/overview",
  },
  {
    kind: "Template",
    title: "eve Chat Template",
    description:
      "A persisted Next.js chat app with Better Auth, Neon, Upstash Redis, Notion MCP, and durable eve session state.",
    href: "https://github.com/vercel-labs/eve-chat-template",
  },
  {
    kind: "Guide",
    title: "eve Slack Agent Starter",
    description:
      "Provision a Slack connector on Vercel and deploy an eve agent that can answer DMs and mentions.",
    href: "https://vercel.com/kb/guide/eve-slack-agent-starter",
  },
  {
    kind: "Template",
    title: "eve Slack Agent Template",
    description:
      "A minimal Slack channel project with an eve agent, deploy button, and Vercel Connect-backed credentials.",
    href: "https://github.com/vercel-labs/eve-slack-agent-template",
  },
  {
    kind: "Example",
    title: "Weather Agent Fixture",
    description:
      "A small representative eve app with agent config, instructions, a typed weather tool, and a markdown skill.",
    href: "https://github.com/vercel/eve/tree/main/apps/fixtures/weather-agent",
  },
  {
    kind: "Reference",
    title: "Integrations gallery",
    description:
      "Browse built-in channels and connections, including setup steps for Slack, Linear, GitHub, Notion, and more.",
    href: "/integrations",
  },
  {
    kind: "Community",
    title: "GitHub Discussions",
    description:
      "Ask questions, share what you're building, and follow framework conversations with the eve community.",
    href: "https://github.com/vercel/eve/discussions",
  },
];
