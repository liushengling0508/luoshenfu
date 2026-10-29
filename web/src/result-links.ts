export type ResultSegment = { type: "text"; text: string } | { type: "url" | "file"; text: string; target: string };

const candidate = /\[([^\]\n]+)\]\(((?:https?:\/\/|file:\/\/\/|\/(?:Users|Volumes|private|tmp|var|Applications|Library)\/)[^)\n]+)\)|`((?:https?:\/\/|file:\/\/\/|\/(?:Users|Volumes|private|tmp|var|Applications|Library)\/)[^`\n]+)`|(https?:\/\/[^\s<>"'`]+|file:\/\/\/[^\s<>"'`]+|\/(?:Users|Volumes|private|tmp|var|Applications|Library)\/[^\s<>"'`]+)/g;

export function resultSegments(content: string): ResultSegment[] {
  const result: ResultSegment[] = [];
  let cursor = 0;
  for (const match of content.matchAll(candidate)) {
    if (match.index! > cursor) result.push({ type: "text", text: content.slice(cursor, match.index) });
    const raw = match[2] || match[3] || match[4];
    const clean = raw.replace(/[.,;!?，。；！？]+$/, "");
    const suffix = raw.slice(clean.length);
    const url = /^https?:\/\//i.test(clean);
    const target = url ? clean : (clean.startsWith("file://") ? decodeURIComponent(new URL(clean).pathname) : clean).replace(/:\d+(?::\d+)?$/, "");
    const name = url ? match[1] || target : target.split("/").filter(Boolean).at(-1) || target;
    result.push({ type: url ? "url" : "file", text: name, target });
    if (suffix) result.push({ type: "text", text: suffix });
    cursor = match.index! + match[0].length;
  }
  if (cursor < content.length) result.push({ type: "text", text: content.slice(cursor) });
  return result;
}
