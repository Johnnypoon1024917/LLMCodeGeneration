"use strict";
// src/i18n/index.ts
//
// Internationalization for the extension-host runtime (Node).
//
// What this is:
//   A thin wrapper over i18next configured for our extension. Exposes
//   `t(key, params?)` for translation lookups, `setLocale(locale)` for
//   switching languages at runtime, and `getLocale()` for reading the
//   current setting.
//
// Why i18next over a custom solution:
//   We picked i18next for being industry standard. The library itself is
//   zero-dep (~50KB) and works in both Node and browsers. The webview
//   uses `react-i18next` separately. Both share the same locale JSON
//   files via dynamic imports.
//
// Why this file is small (intentionally):
//   i18next does the heavy lifting. Our wrapper exists to:
//     1. Bootstrap with our default locale + resources
//     2. Provide a typed `t()` that returns `string` (i18next's return
//        type is wider than we want)
//     3. Centralize the missing-key fallback behavior
//   The wrapper means future swaps (to FormatJS, custom impl, etc.) only
//   touch this file, not the 200 call sites.
//
// Missing-key behavior:
//   Per the planning decision, we use silent fallback to English. If a
//   key isn't in the active locale's resource, i18next falls back to the
//   default ('en'). If it's not in 'en' either, it returns the key as-is
//   (we set `returnNull: false` and `returnEmptyString: false` to ensure
//   we always get a string back). A `console.warn` lets us notice missing
//   keys without breaking the user experience.
//
// Why console.warn (not the project logger):
//   This module is imported by both the extension host (which has the
//   vscode-backed logger) and the CLI (which doesn't have vscode at all).
//   Importing `../logger` from here would crash the CLI runtime because
//   logger transitively imports vscode. console.warn works in both
//   runtimes; the missing-key path is rare enough that lacking the
//   richer logger isn't a real loss.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initI18n = initI18n;
exports.t = t;
exports.setLocale = setLocale;
exports.getLocale = getLocale;
const i18next_1 = __importDefault(require("i18next"));
const en_json_1 = __importDefault(require("./locales/en.json"));
/**
 * The single i18next instance used by all extension-host code. We use
 * the global default instance rather than creating a separate instance
 * per call site — i18next is designed for global singleton use.
 */
let initialized = false;
/**
 * Initialize the i18next instance. Idempotent — safe to call from
 * multiple entry points (extension activate, CLI bootstrap, tests).
 */
async function initI18n(initialLocale = 'en') {
    if (initialized) {
        if (i18next_1.default.language !== initialLocale) {
            await i18next_1.default.changeLanguage(initialLocale);
        }
        return i18next_1.default;
    }
    await i18next_1.default.init({
        lng: initialLocale,
        fallbackLng: 'en',
        // Enables nested namespacing via dots: t('chat.input.placeholder')
        keySeparator: '.',
        // Disables namespace separator (we don't use multiple namespaces)
        nsSeparator: false,
        // Always return a string, never null/empty (keeps callers' types simple)
        returnNull: false,
        returnEmptyString: false,
        // Don't escape interpolation values — we render to native UI, not HTML
        interpolation: { escapeValue: false },
        // Pre-loaded resources. Additional locales loaded dynamically below.
        resources: {
            en: { translation: en_json_1.default }
        },
        // Don't load missing keys from a server (we ship JSON in the bundle)
        partialBundledLanguages: false,
        // Log missing keys via i18next's hook so we route to our logger
        saveMissing: false
    });
    // Hook into i18next's missing-key event to surface in our logs.
    // Silent fallback: i18next still returns the fallback string; we
    // just log so devs notice unwrapped keys during development.
    i18next_1.default.on('missingKey', (lngs, _ns, key) => {
        console.warn(`[i18n] Missing translation key: "${key}" (locales tried: ${lngs.join(', ')})`);
    });
    initialized = true;
    return i18next_1.default;
}
/**
 * Translate a key. Always returns a string.
 *
 * Examples:
 *   t('chat.input.placeholder')
 *     → "Ask a question or describe a task..."
 *
 *   t('errors.spec_not_found', { name: 'main' })
 *     → "Spec 'main' not found"
 *
 *   t('unknown.key')
 *     → "unknown.key"  (falls back to the key itself, with a warning logged)
 */
function t(key, params) {
    if (!initialized) {
        // Allow t() to be called before initI18n() finished — fall back
        // to the key string itself rather than throwing. Catches the edge
        // case of code that runs before activate() completes init.
        return key;
    }
    // i18next's `t()` return type is unnecessarily wide; we narrow.
    // Conditional spread because `exactOptionalPropertyTypes: true` rejects
    // passing `undefined` explicitly to a parameter typed as `Record<...>`.
    const result = params !== undefined ? i18next_1.default.t(key, params) : i18next_1.default.t(key);
    return typeof result === 'string' ? result : key;
}
/** Switch to a new locale. Loads its resources lazily on first use. */
async function setLocale(locale) {
    if (!initialized) {
        await initI18n(locale);
        return;
    }
    if (i18next_1.default.language === locale) {
        return;
    }
    // Dynamically import the locale resources only when first switched to.
    // Keeps the en.json baseline always loaded, others on demand.
    if (locale !== 'en' && !i18next_1.default.hasResourceBundle(locale, 'translation')) {
        try {
            const mod = (await import(`./locales/${locale}.json`));
            i18next_1.default.addResourceBundle(locale, 'translation', mod.default);
        }
        catch (e) {
            console.warn(`[i18n] Failed to load locale '${locale}':`, e);
            // Stay on current locale; don't switch to a half-loaded language.
            return;
        }
    }
    await i18next_1.default.changeLanguage(locale);
}
/** Read the currently-active locale. */
function getLocale() {
    return i18next_1.default.language || 'en';
}
//# sourceMappingURL=index.js.map