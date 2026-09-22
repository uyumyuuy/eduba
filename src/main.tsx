import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyLanguage, type LocalePreference, supportedLocales } from "./i18n";
import { invokeCommand, isTauri } from "./tauri";
import "./styles.css";

function rememberLanguageError(kind: "load" | "menu", error: unknown) {
  window.sessionStorage.setItem(
    "eduba-language-error",
    JSON.stringify({ kind, error: error instanceof Error ? error.message : String(error) }),
  );
}

async function initializeLanguage(): Promise<{ preference: LocalePreference; osLocale: string | null }> {
  let preference: LocalePreference = isTauri ? "en" : "auto";
  let osLocale: string | null = typeof navigator === "undefined" ? null : navigator.language;
  try {
    if (isTauri) {
      const prefs = await invokeCommand("get_user_preferences");
      preference = prefs.language === "auto" || supportedLocales.includes(prefs.language as typeof supportedLocales[number])
        ? prefs.language as LocalePreference : "en";
      osLocale = prefs.osLocale;
    }
  } catch (error) {
    rememberLanguageError("load", error);
  }
  const resolved = await applyLanguage(preference, osLocale);
  document.documentElement.lang = resolved;
  if (isTauri) {
    try { await invokeCommand("set_ui_language", { language: resolved }); }
    catch (error) { rememberLanguageError("menu", error); }
  }
  return { preference, osLocale };
}

void initializeLanguage().catch(async (error): Promise<{ preference: LocalePreference; osLocale: string | null }> => {
  rememberLanguageError("load", error);
  try {
    const resolved = await applyLanguage("en", null);
    document.documentElement.lang = resolved;
  } catch {
    document.documentElement.lang = "en";
  }
  return { preference: "en", osLocale: null };
}).then(({ preference, osLocale }) => {
  ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><App initialLanguage={preference} initialOsLocale={osLocale} /></React.StrictMode>);
});
