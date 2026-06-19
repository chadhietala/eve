import {
  ArrowUpRight,
  Blocks,
  BookOpenText,
  Library,
  MessageSquareText,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { DocsLayout } from "@/components/geistdocs/docs-layout";
import { translations } from "@/geistdocs";
import { source } from "@/lib/geistdocs/source";
import { type Resource, resources, type ResourceKind } from "@/lib/resources/data";

const title = "Resources";
const description = "Guides, templates, and examples to help you build with eve.";

const iconByKind: Record<ResourceKind, LucideIcon> = {
  Community: MessageSquareText,
  Example: Workflow,
  Guide: BookOpenText,
  Reference: Library,
  Template: Blocks,
};

const kindClassName: Record<ResourceKind, string> = {
  Community: "bg-gray-100 text-gray-900",
  Example: "bg-amber-100 text-amber-900",
  Guide: "bg-blue-100 text-blue-800",
  Reference: "bg-teal-100 text-teal-900",
  Template: "bg-violet-100 text-violet-900",
};

export const metadata: Metadata = {
  title,
  description,
};

export const generateStaticParams = () => Object.keys(translations).map((lang) => ({ lang }));

interface ResourcesPageProps {
  params: Promise<{
    lang: keyof typeof translations;
  }>;
}

const ResourceCard = ({ resource }: { resource: Resource }) => {
  const Icon = iconByKind[resource.kind];
  const isExternal = resource.href.startsWith("https://");
  const className =
    "group flex min-h-48 flex-col justify-between rounded-lg border bg-background-100 p-5 transition-colors hover:border-gray-400 hover:bg-gray-100";
  const content = (
    <>
      <div className="flex items-start justify-between gap-4">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-background text-gray-1000">
          <Icon aria-hidden className="size-5" />
        </span>
        <span
          className={`rounded-full px-2.5 py-0.5 font-medium text-xs ${kindClassName[resource.kind]}`}
        >
          {resource.kind}
        </span>
      </div>
      <div className="mt-8 flex flex-col gap-2">
        <h2 className="flex items-center gap-1.5 font-medium text-base text-gray-1000 tracking-tight">
          {resource.title}
          {isExternal ? (
            <ArrowUpRight
              aria-hidden
              className="size-4 text-gray-700 opacity-0 transition-opacity group-hover:opacity-100"
            />
          ) : null}
        </h2>
        <p className="text-gray-900 text-sm leading-relaxed">{resource.description}</p>
      </div>
    </>
  );

  if (isExternal) {
    return (
      <a className={className} href={resource.href} rel="noopener noreferrer" target="_blank">
        {content}
      </a>
    );
  }

  return (
    <Link className={className} href={resource.href}>
      {content}
    </Link>
  );
};

const ResourcesPage = async ({ params }: ResourcesPageProps) => {
  const { lang } = await params;

  return (
    <div className="bg-background-100">
      <DocsLayout tree={source.pageTree[lang]}>
        <main className="mx-auto w-full max-w-[920px] px-4 pt-12 pb-24 sm:px-6 lg:px-8">
          <header className="mb-10">
            <h1 className="font-semibold text-4xl text-gray-1000 tracking-tight">{title}</h1>
            <p className="mt-3 max-w-2xl text-gray-900 text-lg">{description}</p>
          </header>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {resources.map((resource) => (
              <ResourceCard key={resource.title} resource={resource} />
            ))}
          </div>
        </main>
      </DocsLayout>
    </div>
  );
};

export default ResourcesPage;
