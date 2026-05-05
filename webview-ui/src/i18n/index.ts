// webview-ui/src/i18n/index.ts
//
// i18n bootstrap for the webview (React side).
//
// This is a separate i18next instance from the extension-side one in
// src/i18n/index.ts because the extension and webview run in different
// runtimes and don't share memory. They DO share the locale JSON files
// via the `@i18n-locales` Vite alias defined in webview-ui/vite.config.ts —
// both runtimes import from src/i18n/locales/ as the single source of truth.
//
// Locale detection (PR 2.3):
//   - VS Code sets document.documentElement.lang on every webview based
//     on vscode.env.language. SidebarProvider's HTML template includes
//     <html lang="{locale}"> via the locale param.
//   - We map the detected lang to a supported locale: 'zh-CN', 'zh-TW',
//     'zh' all collapse to 'zh-CN' (Mainland/HK/TW share simplified
//     resource fallback today; future PR can split if needed).
//   - Anything else falls back to 'en'.
//   - The detection runs once at module load. Locale switching at runtime
//     would need a manual `i18next.changeLanguage()` call — not exposed
//     in PR 2.3 because VS Code doesn't expose runtime locale change
//     to webviews anyway.
//
// Usage in components:
//   import { useTranslation } from 'react-i18next';
//   const { t } = useTranslation();
//   return <span>{t('chat.input.placeholder')}</span>;

import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '@i18n-locales/en.json';
import zhCN from '@i18n-locales/zh-CN.json';

/** Map a raw lang attribute (or VS Code locale) to a supported i18n
 *  resource bundle. Defaults to 'en' for unknown values. */
function resolveLocale(raw: string | null | undefined): 'en' | 'zh-CN' {
    if (!raw) { return 'en'; }
    const lower = raw.toLowerCase();
    // Match all Chinese variants today. Future PR may split SC/TC.
    if (lower === 'zh-cn' || lower === 'zh' || lower.startsWith('zh-')) {
        return 'zh-CN';
    }
    return 'en';
}

const documentLang = typeof document !== 'undefined'
    ? document.documentElement.getAttribute('lang')
    : null;

const detectedLocale = resolveLocale(documentLang);

void i18next
    .use(initReactI18next)
    .init({
        lng: detectedLocale,
        fallbackLng: 'en',
        keySeparator: '.',
        nsSeparator: false,
        returnNull: false,
        returnEmptyString: false,
        interpolation: { escapeValue: false },
        resources: {
            en: { translation: en },
            'zh-CN': { translation: zhCN }
        }
    });

export default i18next;