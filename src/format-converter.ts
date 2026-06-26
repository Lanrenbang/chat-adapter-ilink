/**
 * Markdown format converter for iLink adapter.
 * Strips WeChat-unsupported markdown syntax.
 * Ported from chat-adapter-weixin src/format-converter.ts.
 */
import {
  BaseFormatConverter,
  markdownToPlainText as sdkMarkdownToPlainText,
  parseMarkdown,
  stringifyMarkdown,
  type AdapterPostableMessage,
  type Root,
} from "chat";

export class ILinkFormatConverter extends BaseFormatConverter {
  toAst(platformText: string): Root {
    return parseMarkdown(platformText);
  }

  fromAst(ast: Root): string {
    return markdownToPlainText(stringifyMarkdown(ast));
  }

  renderPostable(message: AdapterPostableMessage): string {
    return markdownToPlainText(super.renderPostable(message));
  }
}

export function markdownToPlainText(text: string): string {
  return sdkMarkdownToPlainText(text)
    .replace(/^\|[\s:|-]+\|$/gm, "")
    .replace(/^\|(.+)\|$/gm, (_match: string, inner: string) =>
      inner
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join("  "),
    )
    .trim();
}
