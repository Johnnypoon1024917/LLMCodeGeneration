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

import i18next, { type i18n as I18n } from 'i18next';
import en from './locales/en.json';

/**
 * The single i18next instance used by all extension-host code. We use
 * the global default instance rather than creating a separate instance
 * per call site — i18next is designed for global singleton use.
 */
let initialized = false;

/**
 * Supported locales. Add new ones here and create a JSON file under
 * `src/i18n/locales/<locale>.json`. The TypeScript will then enforce
 * that every translation key present in `en.json` exists in the new
 * locale's file (via the `Resources` type).
 *
 * 'zh-CN' added in Sprint 2 PR 2.3 alongside the i18n completion pass.
 * Loaded dynamically by setLocale() — kept out of the initial bundle
 * so en-only users don't pay the parse cost.
 */
export type Locale = 'en' | 'vi' | 'id' | 'th' | 'zh-CN';

/**
 * Initialize the i18next instance. Idempotent — safe to call from
 * multiple entry points (extension activate, CLI bootstrap, tests).
 */
export async function initI18n(initialLocale: Locale = 'en'): Promise<I18n> {
    if (initialized) {
        if (i18next.language !== initialLocale) {
            await i18next.changeLanguage(initialLocale);
        }
        return i18next;
    }

    await i18next.init({
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
            en: { translation: en }
        },
        // Don't load missing keys from a server (we ship JSON in the bundle)
        partialBundledLanguages: false,
        // Log missing keys via i18next's hook so we route to our logger
        saveMissing: false
    });

    // Hook into i18next's missing-key event to surface in our logs.
    // Silent fallback: i18next still returns the fallback string; we
    // just log so devs notice unwrapped keys during development.
    i18next.on('missingKey', (lngs: readonly string[], _ns, key) => {
        console.warn(`[i18n] Missing translation key: "${key}" (locales tried: ${lngs.join(', ')})`);
    });

    initialized = true;
    return i18next;
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
export function t(key: string, params?: Record<string, string | number>): string {
    if (!initialized) {
        // Allow t() to be called before initI18n() finished — fall back
        // to the key string itself rather than throwing. Catches the edge
        // case of code that runs before activate() completes init.
        return key;
    }
    // i18next's `t()` return type is unnecessarily wide; we narrow.
    // Conditional spread because `exactOptionalPropertyTypes: true` rejects
    // passing `undefined` explicitly to a parameter typed as `Record<...>`.
    const result = params !== undefined ? i18next.t(key, params) : i18next.t(key);
    return typeof result === 'string' ? result : key;
}

/** Switch to a new locale. Loads its resources lazily on first use. */
export async function setLocale(locale: Locale): Promise<void> {
    if (!initialized) {
        await initI18n(locale);
        return;
    }
    if (i18next.language === locale) {
        return;
    }
    // Dynamically import the locale resources only when first switched to.
    // Keeps the en.json baseline always loaded, others on demand.
    if (locale !== 'en' && !i18next.hasResourceBundle(locale, 'translation')) {
        try {
            const mod = (await import(`./locales/${locale}.json`)) as { default: Record<string, unknown> };
            i18next.addResourceBundle(locale, 'translation', mod.default);
        } catch (e: unknown) {
            console.warn(`[i18n] Failed to load locale '${locale}':`, e);
            // Stay on current locale; don't switch to a half-loaded language.
            return;
        }
    }
    await i18next.changeLanguage(locale);
}

/** Read the currently-active locale. */
export function getLocale(): Locale {
    return (i18next.language as Locale) || 'en';
}