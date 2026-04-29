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
// Usage in components:
//   import { useTranslation } from 'react-i18next';
//   const { t } = useTranslation();
//   return <span>{t('chat.input.placeholder')}</span>;

import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '@i18n-locales/en.json';

void i18next
    .use(initReactI18next)
    .init({
        lng: 'en',
        fallbackLng: 'en',
        keySeparator: '.',
        nsSeparator: false,
        returnNull: false,
        returnEmptyString: false,
        interpolation: { escapeValue: false },
        resources: {
            en: { translation: en }
        }
    });

export default i18next;