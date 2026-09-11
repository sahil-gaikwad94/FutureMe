/**
 * Markdown renderer for agent replies.
 *
 * Replaces `streamdown`, which was pulling in mermaid, cytoscape and roughly
 * twenty shiki language grammars — about 1.5 MB of bundle — to render a few
 * paragraphs of coaching prose. The agents are instructed not to emit code
 * blocks or diagrams, so none of that was reachable.
 */

import { cn } from "@/lib/utils";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("text-sm leading-6 text-white/75", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="mb-2.5 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="mb-2.5 ml-4 list-disc space-y-1 last:mb-0">{children}</ul>,
          ol: ({ children }) => <ol className="mb-2.5 ml-4 list-decimal space-y-1 last:mb-0">{children}</ol>,
          li: ({ children }) => <li className="leading-6">{children}</li>,
          strong: ({ children }) => <strong className="font-semibold text-white/90">{children}</strong>,
          em: ({ children }) => <em className="text-[#ffb18e]/90 not-italic">{children}</em>,
          h1: ({ children }) => <p className="mb-2 text-base font-semibold text-white/90">{children}</p>,
          h2: ({ children }) => <p className="mb-2 text-base font-semibold text-white/90">{children}</p>,
          h3: ({ children }) => <p className="mb-2 text-sm font-semibold text-white/90">{children}</p>,
          blockquote: ({ children }) => <blockquote className="mb-2.5 border-l-2 border-[#ffb18e]/40 pl-3 text-white/55">{children}</blockquote>,
          code: ({ children }) => <code className="rounded bg-white/[.07] px-1 py-0.5 font-mono text-[12px] text-white/80">{children}</code>,
          pre: ({ children }) => <pre className="mb-2.5 overflow-x-auto rounded-xl bg-black/30 p-3 font-mono text-[12px] last:mb-0">{children}</pre>,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer" className="text-[#ffb18e] underline underline-offset-2">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="mb-2.5 overflow-x-auto">
              <table className="w-full border-collapse text-[12px]">{children}</table>
            </div>
          ),
          th: ({ children }) => <th className="border border-white/10 px-2 py-1 text-left font-medium text-white/70">{children}</th>,
          td: ({ children }) => <td className="border border-white/10 px-2 py-1 text-white/60">{children}</td>,
          hr: () => <hr className="my-3 border-white/10" />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
