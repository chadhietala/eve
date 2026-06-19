import type { Metadata } from "next";
import Link from "next/link";
import { translations } from "@/geistdocs";
import { type Resource, resources, type ResourceKind } from "@/lib/resources/data";

const title = "Resources";
const description = "Guides, templates, and examples to help you build with eve.";

const kindClassName: Record<ResourceKind, string> = {
  Community: "bg-gray-200 text-gray-900 dark:bg-gray-300 dark:text-gray-1000",
  Example: "bg-gray-200 text-gray-900 dark:bg-gray-300 dark:text-gray-1000",
  Guide: "bg-gray-200 text-gray-900 dark:bg-gray-300 dark:text-gray-1000",
  Reference: "bg-gray-200 text-gray-900 dark:bg-gray-300 dark:text-gray-1000",
  Template: "bg-gray-200 text-gray-900 dark:bg-gray-300 dark:text-gray-1000",
};

export const metadata: Metadata = {
  title,
  description,
};

export const generateStaticParams = () => Object.keys(translations).map((lang) => ({ lang }));

const ResourceCard = ({ resource }: { resource: Resource }) => {
  const isExternal = resource.href.startsWith("https://");
  const className =
    "group flex min-h-[172px] flex-col rounded-xl border border-gray-alpha-400 bg-background-100 p-6 transition-colors hover:border-gray-alpha-500 hover:bg-gray-100 dark:bg-gray-100 dark:hover:bg-gray-200";
  const content = (
    <>
      <span
        className={`w-fit rounded-full px-3 py-1 font-medium text-sm ${kindClassName[resource.kind]}`}
      >
        {resource.kind}
      </span>
      <div className="mt-7 flex flex-col gap-5">
        <h2 className="line-clamp-2 font-medium text-2xl text-gray-1000 leading-tight tracking-tight">
          {resource.title}
        </h2>
        <p className="line-clamp-2 text-gray-900 text-lg leading-relaxed">{resource.description}</p>
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

const ResourcesPage = () => (
  <main className="mx-auto w-full max-w-[1908px] px-4 pt-12 pb-24 sm:px-8 lg:px-16">
    <header className="mb-16">
      <h1 className="font-semibold text-4xl text-gray-1000 tracking-tight">{title}</h1>
      <p className="mt-3 max-w-2xl text-gray-900 text-lg">{description}</p>
    </header>
    <div className="grid gap-5 sm:grid-cols-2 md:grid-cols-3">
      {resources.map((resource) => (
        <ResourceCard key={resource.title} resource={resource} />
      ))}
    </div>
  </main>
);

export default ResourcesPage;
