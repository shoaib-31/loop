// Renders Claude's markdown. On the web this is just react-markdown + remark-gfm
// with styling in CSS (the `.md` block in index.css) — no per-element style map,
// which is what the React Native version needed.
//
// Deliberately NOT sanitizing/allowing raw HTML: rehype-raw is not installed, so
// react-markdown escapes HTML in the source. Claude's output is trusted-ish, but
// it routinely contains code samples with tags in them, and rendering those as
// live markup would be both wrong and an XSS vector.

import { memo, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

// memo because a streaming session re-renders the whole turn list on every new
// frame, and re-parsing every historical markdown block each time is wasteful.
export const Markdown = memo(function Markdown({ content }: { content: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Links to anywhere but here open in a new tab; noreferrer because the
          // daemon URL is a private tailnet address we shouldn't leak.
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}>
        {content}
      </ReactMarkdown>
    </div>
  );
});

// Every block element becomes an inline span followed by a space, so a message
// keeps its bold/italic/code/links but flows as ONE paragraph that `line-clamp`
// can cut. Rendering real blocks in a two-line card would show the first line of
// a table or a heading and nothing else.
const flow = ({ children }: { children?: ReactNode }) => <span>{children} </span>;
const INLINE: Components = {
  p: flow,
  h1: ({ children }) => <strong>{children} </strong>,
  h2: ({ children }) => <strong>{children} </strong>,
  h3: ({ children }) => <strong>{children} </strong>,
  h4: ({ children }) => <strong>{children} </strong>,
  h5: ({ children }) => <strong>{children} </strong>,
  h6: ({ children }) => <strong>{children} </strong>,
  blockquote: flow,
  ul: flow,
  ol: flow,
  li: ({ children }) => <span>• {children} </span>,
  table: flow,
  thead: flow,
  tbody: flow,
  tr: flow,
  th: flow,
  td: flow,
  // A fenced block is usually long and never the gist — keep it a mark, not the content.
  pre: () => <code>code</code>,
  hr: () => null,
  img: () => null,
  // NOT an <a>: previews sit inside a row that is itself a link, and a nested anchor
  // is invalid HTML that iOS resolves by navigating to the inner one.
  a: ({ children }) => <span className="underline underline-offset-2">{children}</span>,
};

/** Markdown for a one- or two-line preview: inline formatting kept, blocks flattened. */
export const InlineMarkdown = memo(function InlineMarkdown({ content }: { content: string }) {
  return (
    <span className="md-inline">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={INLINE}>
        {content}
      </ReactMarkdown>
    </span>
  );
});
