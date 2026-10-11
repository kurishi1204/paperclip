import { expect, test } from "vitest";

import { parseBoundedWebResult } from "./bounded-output.js";

const init = { type: "system", subtype: "init", session_id: "cli-session" };
const use = { type: "tool_use", name: "web_search", input: { query: "public source" } };
const success = { type: "tool_result", name: "web_search", is_error: false,
  output: JSON.stringify({ success: true, data: { web: [{ url: "https://example.org/source" }] } }) };
const final = { type: "result", session_id: "cli-session", exit_code: 0, text: "Finding with source." };
const lines = (...events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n") + "\n";

test("accepts actual CLI evidence and returns only the final answer", () => {
  expect(parseBoundedWebResult(lines(init, use, success, final), { requireText: true })).toEqual({
    sessionId: "cli-session", text: "Finding with source.", searches: 1,
    sourceUrls: ["https://example.org/source"], rejectedSourceUrls: [],
  });
  expect(parseBoundedWebResult(lines(init, use, success, use, success, final), { requireText: true })?.searches).toBe(2);
  expect(parseBoundedWebResult(lines(init, use, success, use, success, final), { exactlyOneSearch: true })).toBeNull();
});

test("rejects missing, failed, spoofed, or incomplete web evidence", () => {
  const failure = { ...success, is_error: true };
  const privateUrl = { ...success, output: JSON.stringify({ success: true, data: { web: [{ url: "http://127.0.0.1/" }] } }) };
  const otherTool = { ...use, name: "web_extract" };
  const wrongSession = { ...final, session_id: "other" };
  const noText = { ...final, text: "" };
  for (const output of [
    lines(init, final), lines(init, use, failure, final), lines(init, use, privateUrl, final),
    lines(init, otherTool, success, final), lines(init, use, success, wrongSession),
    lines(init, use, success, noText), lines(init, use, success, final, use),
    "Model prose only\n", lines(init, use, final),
  ]) expect(parseBoundedWebResult(output, { requireText: true })).toBeNull();
});

const identifiedUse = (id: unknown) => ({ ...use, tool_call_id: id });
const identifiedResult = (id: unknown) => ({ ...success, tool_call_id: id });

test("correlates parallel searches by executor call ID, including reverse completion", () => {
  expect(parseBoundedWebResult(lines(init, identifiedUse("a"), identifiedUse("b"),
    identifiedResult("b"), identifiedResult("a"), final))?.searches).toBe(2);
});

test("rejects unknown, reused, absent, mixed, malformed, and unfinished call IDs", () => {
  for (const events of [
    [identifiedUse("a"), identifiedResult("b")],
    [identifiedUse("a"), identifiedUse("a"), identifiedResult("a")],
    [identifiedUse("a"), identifiedResult("a"), identifiedResult("a")],
    [identifiedUse("a"), identifiedResult("a"), identifiedUse("a"), identifiedResult("a")],
    [identifiedUse("a"), success], [use, identifiedResult("a")],
    [identifiedUse("a"), identifiedResult("a"), use, success],
    [use, success, identifiedUse("a"), identifiedResult("a")],
    [identifiedUse("a"), identifiedUse("b"), identifiedResult("a")],
    [identifiedUse(""), identifiedResult("")],
    [identifiedUse(null), identifiedResult(null)],
    [identifiedUse(7), identifiedResult(7)], [use, use, success, success],
  ]) expect(parseBoundedWebResult(lines(init, ...events, final))).toBeNull();
});

const emptySuccess = { ...success, output: JSON.stringify({success:true,data:{web:[]}}) };
test("accepts successful empty queries only when the completed run has real HTTPS evidence", () => {
  expect(parseBoundedWebResult(lines(init,identifiedUse("empty"),identifiedUse("found"),
    {...emptySuccess,tool_call_id:"empty"},identifiedResult("found"),final))?.searches).toBe(2);
  expect(parseBoundedWebResult(lines(init,use,emptySuccess,use,success,final))?.searches).toBe(2);
  expect(parseBoundedWebResult(lines(init,use,emptySuccess,final))).toBeNull();
});
test("rejects malformed or unsafe source rows even beside a valid HTTPS row", () => {
  for(const invalid of [null,7,{}, {url:7}, {url:"not a URL"}]) {
    const mixed={...success,output:JSON.stringify({success:true,data:{web:[{url:"https://example.org/source"},invalid]}})};
    expect(parseBoundedWebResult(lines(init,use,mixed,final))).toBeNull();
  }
  expect(parseBoundedWebResult(lines(init,use,success,final)+"[hermes] diagnostic\n")).toBeNull();
});

test("preserves every HTTP source as an explicit rejected disposition beside verified HTTPS sources", () => {
  const mixed={...success,output:JSON.stringify({success:true,data:{web:[{url:"http://example.org/unverified"},{url:"https://example.org/verified"}]}})};
  const result=parseBoundedWebResult(lines(init,use,mixed,final));
  expect(result?.sourceUrls).toEqual(["https://example.org/verified"]);
  expect(result?.rejectedSourceUrls).toEqual([{url:"http://example.org/unverified",reason:"non_https"}]);
  const onlyHttp={...success,output:JSON.stringify({success:true,data:{web:[{url:"http://example.org/unverified"}]}})};
  expect(parseBoundedWebResult(lines(init,use,onlyHttp,final))).toBeNull();
  for(const url of ["javascript:alert(1)","file:///tmp/private","data:text/plain,untrusted"]){
    const unsafe={...success,output:JSON.stringify({success:true,data:{web:[{url:"https://example.org/verified"},{url}]}})};
    expect(parseBoundedWebResult(lines(init,use,unsafe,final))).toBeNull();
  }
});
