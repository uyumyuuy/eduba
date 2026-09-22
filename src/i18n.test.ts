import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { createInstance } from "i18next";
import { describe, expect, it } from "vitest";
import i18n, {
  applyLanguage,
  resolveLanguagePreference,
  resolveLocale,
  resources,
  supportedLocales,
  t,
} from "./i18n";

type Catalog = Record<string, unknown>;

type CatalogLeaf = {
  key: string;
  value: string;
};

function flattenCatalog(catalog: Catalog, prefix = ""): CatalogLeaf[] {
  return Object.entries(catalog).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") return [{ key: path, value }];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return flattenCatalog(value as Catalog, path);
    }
    throw new Error(`Translation ${path} must be a string`);
  });
}

function interpolationVariables(value: string): string[] {
  return [...value.matchAll(/{{\s*([^\s},]+)/g)].map(match => match[1]).sort();
}


type SourceTranslationReference = { file: string; key: string };

function collectSourceTranslationReferences(): SourceTranslationReference[] {
  const references: SourceTranslationReference[] = [];
  for (const file of readdirSync("src")) {
    if (!/\.tsx?$/.test(file) || file.includes(".test.")) continue;
    const source = ts.createSourceFile(file, readFileSync(join("src", file), "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        const callee = node.expression.getText(source);
        if (["t", "translate", "globalT", "i18n.t", "setNotice"].includes(callee)) {
          references.push({ file, key: node.arguments[0].text });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return references;
}

function englishResourceExists(key: string): boolean {
  return i18n.exists(key, { lng: "en", fallbackLng: false })
    || i18n.exists(`${key}_one`, { lng: "en", fallbackLng: false })
    || i18n.exists(`${key}_other`, { lng: "en", fallbackLng: false });
}
describe("resolveLocale", () => {
  it.each([
    ["zh-Hans", "zh-Hans"],
    ["zh_Hans_CN", "zh-Hans"],
    ["zh-Hant", "zh-Hant"],
    ["zh-TW", "zh-Hant"],
    ["zh-HK", "zh-Hant"],
    ["zh-MO", "zh-Hant"],
    ["zh-CN", "zh-Hans"],
    ["zh-SG", "zh-Hans"],
    ["zh", "zh-Hans"],
    ["zh-Hant-CN", "zh-Hant"],
    ["zh-Hans-TW", "zh-Hans"],
    ["ja-JP", "ja"],
    ["en-GB", "en"],
    ["ko-KR", "en"],
    [undefined, "en"],
  ] as const)("maps %s to %s", (locale, expected) => {
    expect(resolveLocale(locale)).toBe(expected);
  });

  it("uses an explicit preference and resolves auto from the OS locale", () => {
    expect(resolveLanguagePreference("ja", "zh-TW")).toBe("ja");
    expect(resolveLanguagePreference("auto", "zh-TW")).toBe("zh-Hant");
    expect(resolveLanguagePreference("invalid", "ja-JP")).toBe("ja");
  });
});

describe("bundled i18next resources", () => {
  it("initializes synchronously with English as default and fallback", () => {
    expect(i18n.isInitialized).toBe(true);
    expect(i18n.language).toBe("en");
    expect(supportedLocales).toEqual(["en", "ja", "zh-Hans", "zh-Hant"]);
    for (const locale of supportedLocales) {
      expect(i18n.getResourceBundle(locale, "translation")).toBeDefined();
    }
  });


  it("defines every static source translation key in the English catalog", () => {
    const missing = collectSourceTranslationReferences()
      .filter(reference => !englishResourceExists(reference.key))
      .map(reference => `${reference.file}: ${reference.key}`);
    expect(missing).toEqual([]);
  });
  it("keeps every locale catalog structurally and interpolation-compatible with English", () => {
    const english = flattenCatalog(resources.en.translation);
    const englishByKey = new Map(english.map(leaf => [leaf.key, leaf.value]));
    expect(english).not.toHaveLength(0);

    for (const locale of supportedLocales) {
      const leaves = flattenCatalog(resources[locale].translation);
      const byKey = new Map(leaves.map(leaf => [leaf.key, leaf.value]));
      expect([...byKey.keys()].sort()).toEqual([...englishByKey.keys()].sort());

      for (const { key, value } of leaves) {
        expect(value.trim(), `${locale}:${key} must not be empty`).not.toBe("");
        expect(interpolationVariables(value), `${locale}:${key} variables`).toEqual(
          interpolationVariables(englishByKey.get(key)!),
        );
      }
    }
  });

  it("falls back to the English bundled translation when a selected catalog lacks a key", async () => {
    const isolated = createInstance();
    await isolated.init({
      lng: "ja",
      fallbackLng: "en",
      initAsync: false,
      resources: {
        en: { translation: { message: "English fallback" } },
        ja: { translation: {} },
      },
    });
    expect(isolated.t("message")).toBe("English fallback");
  });

  it("applies an explicit language before OS locale and uses OS locale for auto", async () => {
    await applyLanguage("zh-Hant", "ja-JP");
    expect(i18n.language).toBe("zh-Hant");
    expect(t("language.ja")).toBe("日本語");

    await applyLanguage("en", "ja-JP");
    expect(i18n.language).toBe("en");
    await applyLanguage("auto", "zh-TW");
    expect(i18n.language).toBe("zh-Hant");
    await applyLanguage("auto", "ja-JP");
    expect(i18n.language).toBe("ja");
  });
});
