import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

export interface WikiLinkAstNode {
  type?: string; value?: string; children?: WikiLinkAstNode[]; url?: string;
  identifier?: string; title?: string | null;
  data?: { hProperties?: Record<string,string> };
}
const ROOT_WIKI_LINK_PAGES=new Set(["WIKI.md","AGENTS.md","IDEA.md","index.md","log.md"]);

/** The Wiki UI and publication host share this exact target interpretation. */
export function normalizeWikiLinkPagePath(target:string,currentPagePath="wiki/index.md"):{path:string;fragment:string|null}|null {
  const trimmed=target.trim();
  if(!trimmed||/^[a-z][a-z\d+.-]*:/i.test(trimmed)||trimmed.startsWith("//"))return null;
  const hash=trimmed.indexOf("#"),raw=(hash>=0?trimmed.slice(0,hash):trimmed).trim().replace(/^\/+/,"");
  if(!raw||raw.includes("\\"))return null;
  let resolved=raw;
  const relative=/^\.\.?\//.test(raw);
  if(relative){
    try{
      const base="https://wiki.invalid/"+currentPagePath.split("/").map(encodeURIComponent).join("/");
      const url=new URL(raw,base);if(url.origin!=="https://wiki.invalid"||url.search)return null;
      resolved=decodeURIComponent(url.pathname.slice(1));
    }catch{return null;}
  }
  if(resolved.includes("\\")||resolved.split("/").some(part=>!part||part==="."||part===".."))return null;
  let path=resolved.toLowerCase().endsWith(".md")?resolved:resolved+".md";
  if(relative&&!path.startsWith("wiki/")&&!path.startsWith("raw/")&&!ROOT_WIKI_LINK_PAGES.has(path))return null;
  if(!path.startsWith("wiki/")&&!path.startsWith("raw/")&&!ROOT_WIKI_LINK_PAGES.has(path))path="wiki/"+path;
  return {path,fragment:hash>=0?trimmed.slice(hash+1).trim()||null:null};
}
function internalMarkdownTarget(value:string) {
  const target=value.trim();
  if(/^[a-z][a-z\d+.-]*:/i.test(target)||target.startsWith("/"))return false;
  const path=target.split("#")[0]??"";
  return /\.md$/i.test(path)||/^\/?(?:wiki|raw)\//.test(path);
}
const SKIP_PARENTS=new Set(["definition","image","imageReference","code","inlineCode","html"]);

/** Operate on the rendered Markdown AST, so URLs, code and link labels are not
 * scanned as prose. React Markdown and host extraction both invoke this walk. */
export function transformWikiLinks(tree:WikiLinkAstNode,resolveHref:(target:string,label:string)=>string|null|undefined) {
  const definitions=new Map<string,string>();
  function collect(node:WikiLinkAstNode){
    if(node.type==="definition"&&node.identifier&&node.url)definitions.set(node.identifier.toLowerCase(),node.url);
    for(const child of node.children??[])collect(child);
  }
  collect(tree);
  function label(node:WikiLinkAstNode):string{return node.value??(node.children??[]).map(label).join("");}
  function linked(target:string,text:string,children:WikiLinkAstNode[]):WikiLinkAstNode|null {
    const href=resolveHref(target,text);if(!href)return null;
    return {type:"link",url:href,title:null,data:{hProperties:{"data-paperclip-wiki-link":"true","data-paperclip-wiki-target":target}},children};
  }
  function walk(parent:WikiLinkAstNode){
    if(!parent.children||SKIP_PARENTS.has(parent.type??""))return;
    const next:WikiLinkAstNode[]=[];
    for(const child of parent.children){
      if(child.type==="link"||child.type==="linkReference"){
        const target=child.type==="link"?child.url:definitions.get(child.identifier?.toLowerCase()??"");
        if(target&&internalMarkdownTarget(target)){
          const link=linked(target,label(child),child.children??[]);
          next.push(link??child);
        }else next.push(child);
        continue;
      }
      if(child.type==="text"&&child.value?.includes("[[")){
        const value=child.value;let end=0;
        for(const match of value.matchAll(/\[\[([^\]\r\n]+)\]\]/g)){
          const start=match.index??0;
          if(start>end)next.push({type:"text",value:value.slice(end,start)});
          const [rawTarget,...parts]=(match[1]??"").split("|"),target=rawTarget?.trim()??"",text=parts.length?parts.join("|").trim()||target:target;
          const link=target&&!target.includes("[")&&!target.includes("]")?linked(target,text,[{type:"text",value:text}]):null;
          next.push(link??{type:"text",value:match[0]});end=start+match[0].length;
        }
        if(end<value.length)next.push({type:"text",value:value.slice(end)});
      }else{walk(child);next.push(child);}
    }
    parent.children=next;
  }
  walk(tree);
}
const markdown=unified().use(remarkParse).use(remarkGfm);
export function extractWikiLinks(contents:string,currentPagePath="wiki/index.md"):string[] {
  const links=new Set<string>(),tree=markdown.parse(contents) as WikiLinkAstNode;
  transformWikiLinks(tree,(target)=>{
    const parsed=normalizeWikiLinkPagePath(target,currentPagePath);if(!parsed)throw new Error("E_INVALID_WIKI_REFERENCE "+JSON.stringify({target,currentPagePath}));
    links.add(parsed.path);return parsed.path;
  });
  // Preserve existing plain Wiki-path references, but only in actual prose:
  // never inside external URLs/labels, code samples, definitions or HTML.
  function prose(node:WikiLinkAstNode){
    if(SKIP_PARENTS.has(node.type??"")||node.type==="link"||node.type==="linkReference")return;
    if(node.type==="text")for(const match of (node.value??"").matchAll(/\bwiki\/[A-Za-z0-9._/-]+\.md\b/g)){
      const parsed=normalizeWikiLinkPagePath(match[0]);if(parsed)links.add(parsed.path);
    }
    for(const child of node.children??[])prose(child);
  }
  prose(tree);return [...links].sort();
}

export function buildWikiSpacePrefix(spaceSlug:string):string {
  return spaceSlug&&spaceSlug!=="default"?"/wiki/spaces/"+encodeURIComponent(spaceSlug):"/wiki";
}
export function buildWikiPageHref(path:string,spaceSlug:string):string {
  const prefix=buildWikiSpacePrefix(spaceSlug),encoded=path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return encoded?prefix+"/page/"+encoded:prefix;
}
export function buildWikiReferenceHref(target:string,resolveHref:(path:string)=>string,context:{currentPagePath:string;spaceSlug:string}):string|null {
  const parsed=normalizeWikiLinkPagePath(target,context.currentPagePath);if(!parsed)return null;
  const href=resolveHref(buildWikiPageHref(parsed.path,context.spaceSlug));
  return parsed.fragment?href+"#"+encodeURIComponent(parsed.fragment):href;
}
