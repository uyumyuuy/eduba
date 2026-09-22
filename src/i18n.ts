import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en";
import ja from "./locales/ja";
import zhHans from "./locales/zh-Hans";
import zhHant from "./locales/zh-Hant";
import importResources from "./locales/importResources";

export const supportedLocales = ["en", "ja", "zh-Hans", "zh-Hant"] as const;
export type SupportedLocale = (typeof supportedLocales)[number];
export type LocalePreference = "auto" | SupportedLocale;

export const resources = {
  en: { translation: { ...en, ...importResources.en } },
  ja: { translation: { ...ja, ...importResources.ja } },
  "zh-Hans": { translation: { ...zhHans, ...importResources["zh-Hans"] } },
  "zh-Hant": { translation: { ...zhHant, ...importResources["zh-Hant"] } },
} as const;

/** Resolves the operating-system locale to one of the bundled translations. */
export function resolveLocale(locale: string | null | undefined): SupportedLocale {
  const parts = locale?.replace(/_/g, "-").split("-").filter(Boolean) ?? [];
  const language = parts[0]?.toLowerCase();

  if (language === "zh") {
    const subtags = parts.slice(1).map(part => part.toLowerCase());
    // Explicit script subtags take precedence over a region in malformed tags.
    if (subtags.includes("hant")) return "zh-Hant";
    if (subtags.includes("hans")) return "zh-Hans";
    if (subtags.some(part => part === "tw" || part === "hk" || part === "mo")) return "zh-Hant";
    return "zh-Hans";
  }
  if (language === "ja") return "ja";
  if (language === "en") return "en";
  return "en";
}

export function resolveLanguagePreference(
  preference: LocalePreference | string | null | undefined,
  osLocale: string | null | undefined,
): SupportedLocale {
  if (preference && preference !== "auto" && supportedLocales.includes(preference as SupportedLocale)) {
    return preference as SupportedLocale;
  }
  return resolveLocale(osLocale);
}

/** Resolves and applies a preference. Persistence belongs to the UI integration layer. */
export async function applyLanguage(
  preference: LocalePreference | string | null | undefined,
  osLocale: string | null | undefined,
): Promise<SupportedLocale> {
  const language = resolveLanguagePreference(preference, osLocale);
  await i18n.changeLanguage(language);
  return language;
}

void i18n.use(initReactI18next).init({
  resources,
  lng: "en",
  fallbackLng: "en",
  supportedLngs: supportedLocales,
  interpolation: { escapeValue: false },
  initAsync: false,
});

/** Translation helper for non-React modules. React components use `useTranslation`. */
export const t = i18n.t.bind(i18n);

export default i18n;
