import { describe, it, expect } from "vitest";
import { ILinkFormatConverter, markdownToPlainText } from "./format-converter.js";

const converter = new ILinkFormatConverter();

describe("ILinkFormatConverter", () => {
  describe("toAst", () => {
    it("parses plain text", () => {
      const ast = converter.toAst("Hello world");
      expect(ast.type).toBe("root");
      expect(ast.children).toHaveLength(1);
    });

    it("parses bold text", () => {
      const ast = converter.toAst("**bold**");
      const para = ast.children[0];
      if (para.type === "paragraph") {
        const strong = para.children[0];
        expect(strong.type).toBe("strong");
      }
    });
  });

  describe("fromAst", () => {
    it("renders plain text", () => {
      const ast = converter.toAst("Hello world");
      const result = converter.fromAst(ast);
      expect(result).toBe("Hello world");
    });

    it("strips tables to plain text", () => {
      const result = converter.fromAst(converter.toAst("| a | b |\n| --- | --- |\n| 1 | 2 |"));
      expect(result).not.toContain("|");
      expect(result).toContain("a");
      expect(result).toContain("b");
    });
  });

  describe("renderPostable", () => {
    it("renders plain text", () => {
      const result = converter.renderPostable("Hello");
      expect(result).toBe("Hello");
    });

    it("renders card fallback text", () => {
      const result = converter.renderPostable({
        card: {
          type: "card",
          title: "Test Card",
          children: [],
        },
      });
      expect(result).toContain("Test Card");
    });
  });
});

describe("markdownToPlainText", () => {
  it("strips markdown formatting", () => {
    expect(markdownToPlainText("**bold**")).toBe("bold");
  });

  it("strips inline code", () => {
    expect(markdownToPlainText("`code`")).toBe("code");
  });

  it("collapses table rows to space-separated cells", () => {
    const result = markdownToPlainText("| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |");
    expect(result).toBe("abc123");
  });
});
