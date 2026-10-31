import fs from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The skill is what an agent loads while deciding *whether* to use this CLI; the CLI's
 * own `--help` is what it reads while composing a command (see
 * docs/superpowers/specs/2026-10-31-help-skill-split-design.md). This suite keeps the
 * split from collapsing back into two copies of the same reference manual: it fails when
 * the skill grows a model id, a protocol name, an exit-code table or a response shape, and
 * when its frontmatter goes back to telling the agent which tool to route media requests to.
 */
const SKILL_URL = new URL("../skills/mediagen/SKILL.md", import.meta.url);
const raw = fs.readFileSync(SKILL_URL, "utf8");
const lines = raw.split("\n");

const frontMatterEnd = lines.indexOf("---", 1);
const frontMatter = lines.slice(1, frontMatterEnd).join("\n");
const body = lines.slice(frontMatterEnd + 1).join("\n");
const description = frontMatter.split("\n").find((line) => line.startsWith("description:")) ?? "";

describe("skills/mediagen/SKILL.md", () => {
  it("carries a name and a one-line description", () => {
    expect(lines[0]).toBe("---");
    expect(frontMatterEnd).toBeGreaterThan(1);
    expect(frontMatter).toContain("name: mediagen");
    expect(frontMatter.split("\n").filter((line) => line.startsWith("description:"))).toHaveLength(1);
    expect(description.length).toBeGreaterThan(80);
    expect(description.length).toBeLessThan(700);
  });

  it("describes what the tool does instead of claiming every media request", () => {
    expect(description).toMatch(/image/i);
    expect(description).toMatch(/video/i);
    expect(description).toMatch(/local file/i);
    expect(description).not.toMatch(/whenever the user wants/i);
    expect(description).not.toMatch(/you must use this skill/i);
    expect(description).not.toMatch(/any (?:image|video) request/i);
  });

  it("keeps vendor names out of the description: they cost tokens and the body names none", () => {
    for (const vendor of [
      /bailian/i,
      /volcengine/i,
      /\bark\b/i,
      /minimax/i,
      /qwen/i,
      /doubao/i,
      /seedream/i,
      /seedance/i,
    ]) {
      expect(description, `the description names a vendor: ${vendor}`).not.toMatch(vendor);
    }
  });

  it("stays on one screen", () => {
    expect(lines.length).toBeLessThanOrEqual(110);
  });

  it("keeps no reference material that the CLI's own help already carries", () => {
    for (const reference of [
      /qwen-image-\d/, // model ids, seeds and their dating
      /doubao-seedream/,
      /seedance-1-0/,
      /MiniMax-H3/,
      /\bapi_type\b/, // the protocol table
      /\b(?:openai|dashscope)\b/,
      /exit codes?:/i,
      /"partial"/, // the JSON envelope
      /\b(?:480p|1080p|2k)\b/, // resolution tiers
    ]) {
      expect(body, `the skill repeats reference material: ${reference}`).not.toMatch(reference);
    }
  });

  it("points at the help commands that do carry the reference", () => {
    expect(body).toContain("mediagen --help");
    expect(body).toContain("mediagen image generate --help");
    expect(body).toContain("mediagen video generate --help");
  });

  it("says to prefer a generation tool the project already has", () => {
    expect(body).toMatch(/already generates media/i);
    expect(body).toMatch(/one option among several/i);
  });

  it("keeps the rules whose cost is money or a lost file", () => {
    expect(body).toMatch(/never print an api key/i);
    expect(body).toMatch(/never re-run a request/i);
    expect(body).toMatch(/never re-submit a video task/i);
    expect(body).toMatch(/exactly as printed/i);
    expect(body).toMatch(/--no-wait/);
  });

  it("leaves four commands worth copying", () => {
    const commands = lines.filter((line) => /^mediagen (?:image|video) /.test(line));
    expect(commands.length).toBeGreaterThanOrEqual(4);
  });
});
