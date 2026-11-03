/** Shared Wiki-path extraction for host publication and plugin navigation.
 * Keep both sides on the same syntax; authorization is checked by the host. */
export function extractWikiLinks(contents: string): string[] {
  const links = new Set<string>();
  const markdownLinkPattern = /\[[^\]]+\]\(([^)]+)\)/g;
  for (const match of contents.matchAll(markdownLinkPattern)) {
    const target = match[1]?.split("#")[0]?.trim();
    if (target && (target.startsWith("wiki/") || target === "index.md" || target === "log.md" || target === "AGENTS.md" || target === "IDEA.md")) {
      links.add(target);
    }
  }
  const wikiTokenPattern = /\bwiki\/[A-Za-z0-9._/-]+\.md\b/g;
  for (const match of contents.matchAll(wikiTokenPattern)) {
    links.add(match[0]);
  }
  return [...links].sort();
}
