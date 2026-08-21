import ReactMarkdown from 'react-markdown';

/**
 * Lightweight markdown renderer for assistant chat blocks.
 * react-markdown does not use dangerouslySetInnerHTML; raw HTML in model
 * output is not executed. Element classes match the existing chat theme.
 */
export function AssistantMarkdown({ markdown }: { markdown: string }) {
  const source = typeof markdown === 'string' ? markdown : '';
  if (!source.trim()) return null;

  return (
    <div className="max-w-none space-y-2 text-sm text-foreground [&_p]:my-2 [&_p]:leading-relaxed [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_strong]:font-semibold [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.85em] [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-medium">
      <ReactMarkdown
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
